import { Router } from "express";
import { z } from "zod";
import { HttpError, me, requirePermission, requirePlayer, requireSee, requireStaff } from "../auth.js";
import { one, query } from "../db.js";
import { isDate, today, addDays, weekdayOf } from "../util.js";
import {
  addMentorshipLog, mentorshipInput, addTally, tallyInput, saveEquipmentCheck, equipmentInput, sessionReportInput, submitSessionReport,
} from "../lib/field.js";
import { notify, parentsOf } from "../lib/notify.js";

/** Mentorship logs, tally & awards, equipment checks, notifications. */
export const coachingRoutes = Router();

// ---- mentorship (coach-only) ----------------------------------------------------------------

/**
 * Coaches see their own logs; admins (and super admins) see every log in
 * their intramurals. Parents never reach this route (requireStaff).
 */
coachingRoutes.get("/intramurals/:id/mentorship", async (req, res) => {
  const user = me(req);
  requireStaff(user);
  const id = Number(req.params.id);
  await requirePermission(user, "mentorship.write", id);
  const seeAll = user.isSuperAdmin || user.role === "admin";
  const playerId = req.query.playerId ? Number(req.query.playerId) : null;
  res.json(
    await query(
      `SELECT m.id, m.session_id AS "sessionId", s.date AS "sessionDate", m.player_id AS "playerId",
              p.first_name || ' ' || p.last_name AS "playerName", u.name AS coach, m.coach_id AS "coachId",
              m.discussion_notes AS "discussionNotes", m.scripture, m.scripture_milestone AS "scriptureMilestone",
              m.prayer_points AS "prayerPoints", m.welfare_observation AS "welfareObservation", m.created_at AS "createdAt"
         FROM mentorship_logs m LEFT JOIN users u ON u.id = m.coach_id LEFT JOIN players p ON p.id = m.player_id
         LEFT JOIN sessions s ON s.id = m.session_id
        WHERE m.intramural_id = $1 AND ($2 OR m.coach_id = $3) AND ($4::int IS NULL OR m.player_id = $4)
        ORDER BY m.created_at DESC LIMIT 100`,
      [id, seeAll, user.id, playerId],
    ),
  );
});

coachingRoutes.post("/intramurals/:id/mentorship", async (req, res) => {
  res.status(201).json(await addMentorshipLog(me(req), mentorshipInput.parse({ ...req.body, intramuralId: Number(req.params.id) })));
});

// ---- tally & awards ---------------------------------------------------------------------------

coachingRoutes.get("/intramurals/:id/tally", async (req, res) => {
  const user = me(req);
  const id = Number(req.params.id);
  await requireSee(user, id);
  const intramural = await one(`SELECT CASE WHEN program_mode = 'school' THEN teams ELSE '[]'::jsonb END AS teams FROM intramurals WHERE id = $1`, [id]);
  const since = isDate(String(req.query.since ?? "")) ? String(req.query.since) : `${today().slice(0, 4)}-01-01`;
  const [standings, sportsmanship, matches, awards] = await Promise.all([
    query(
      `SELECT team, sum(points) AS points FROM tally_events WHERE intramural_id = $1 AND kind = 'virtue_points' AND created_at >= $2 GROUP BY team`,
      [id, since],
    ),
    query(
      `SELECT team, sum(points) AS points FROM tally_events WHERE intramural_id = $1 AND kind = 'sportsmanship' AND created_at >= $2 GROUP BY team ORDER BY 2 DESC`,
      [id, since],
    ),
    query(
      `SELECT t.id, t.team, t.opponent, t.points, t.opponent_points AS "opponentPoints", t.category, t.note, t.created_at AS "createdAt",
              s.date AS "sessionDate", u.name AS "recordedBy"
         FROM tally_events t LEFT JOIN sessions s ON s.id = t.session_id LEFT JOIN users u ON u.id = t.recorded_by
        WHERE t.intramural_id = $1 AND t.kind = 'match' ORDER BY t.created_at DESC LIMIT 30`,
      [id],
    ),
    query(
      `SELECT a.id, a.player_id AS "playerId", p.first_name || ' ' || p.last_name AS "playerName", a.award, a.virtue, a.reason,
              a.week_of AS "weekOf", u.name AS "awardedBy"
         FROM character_awards a JOIN players p ON p.id = a.player_id LEFT JOIN users u ON u.id = a.awarded_by
        WHERE a.intramural_id = $1 ORDER BY a.week_of DESC, a.id DESC LIMIT 30`,
      [id],
    ),
  ]);
  const points = new Map(standings.map((s) => [s.team, s.points]));
  const teams = (intramural.teams as { id: string; name: string; color: string }[]).map((t) => ({ ...t, points: points.get(t.id) ?? 0 }));
  // Parents see results and awards, not the per-coach detail.
  res.json({ teams, sportsmanship, matches: user.role === "parent" ? matches.map(({ recordedBy: _r, ...m }) => m) : matches, awards });
});

coachingRoutes.post("/intramurals/:id/tally", async (req, res) => {
  res.status(201).json(await addTally(me(req), tallyInput.parse({ ...req.body, intramuralId: Number(req.params.id) })));
});

const awardInput = z.object({
  playerId: z.number().int(),
  sessionId: z.number().int().nullable().optional(),
  award: z.string().trim().min(2).max(80),
  virtue: z.string().max(30).default(""),
  reason: z.string().max(500).default(""),
});

/** Weekly character award. The child's parents are told. */
coachingRoutes.post("/intramurals/:id/awards", async (req, res) => {
  const user = me(req);
  requireStaff(user);
  const id = Number(req.params.id);
  await requirePermission(user, "tally.write", id);
  const a = awardInput.parse(req.body);
  const p = await requirePlayer(user, a.playerId);
  if (p.intramuralId !== id) throw new HttpError(400, "That player is not in this intramural");
  const now = today();
  const weekOf = addDays(now, -((weekdayOf(now) + 6) % 7)); // Monday of this week
  const row = await one(
    `INSERT INTO character_awards (intramural_id, player_id, session_id, week_of, award, virtue, reason, awarded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [id, a.playerId, a.sessionId ?? null, weekOf, a.award, a.virtue, a.reason, user.id],
  );
  const first = (await one(`SELECT first_name FROM players WHERE id = $1`, [a.playerId])).first_name;
  await notify(await parentsOf(a.playerId), { kind: "award", title: `${first} received the ${a.award}! 🏅`, body: a.reason, link: `/child/${a.playerId}` });
  res.status(201).json(row);
});

// ---- equipment -------------------------------------------------------------------------------

coachingRoutes.get("/sessions/:id/equipment", async (req, res) => {
  const user = me(req);
  requireStaff(user);
  const s = await one(`SELECT intramural_id AS "intramuralId" FROM sessions WHERE id = $1`, [Number(req.params.id)]);
  if (!s) throw new HttpError(404, "That session does not exist");
  await requireSee(user, s.intramuralId);
  const [items, checks] = await Promise.all([
    query(`SELECT id, name, expected FROM equipment_items WHERE intramural_id = $1 AND active ORDER BY id`, [s.intramuralId]),
    query(
      `SELECT c.phase, c.items, c.notes, c.created_at AS "createdAt", u.name AS "recordedBy"
         FROM equipment_checks c LEFT JOIN users u ON u.id = c.recorded_by WHERE c.session_id = $1`,
      [Number(req.params.id)],
    ),
  ]);
  res.json({ items, checks });
});

coachingRoutes.put("/sessions/:id/equipment/:phase", async (req, res) => {
  res.json(await saveEquipmentCheck(me(req), equipmentInput.parse({ ...req.body, sessionId: Number(req.params.id), phase: req.params.phase })));
});

// ---- notifications --------------------------------------------------------------------------

coachingRoutes.get("/notifications", async (req, res) => {
  const user = me(req);
  res.json(
    await query(
      `SELECT id, kind, title, body, link, urgent, read_at AS "readAt", created_at AS "createdAt"
         FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 60`,
      [user.id],
    ),
  );
});

coachingRoutes.post("/notifications/read", async (req, res) => {
  const user = me(req);
  const { ids } = z.object({ ids: z.array(z.number().int()).max(200).optional() }).parse(req.body);
  await query(
    `UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL AND ($2::int[] IS NULL OR id = ANY($2))`,
    [user.id, ids ?? null],
  );
  res.json({ ok: true });
});

// ---- the parent's home --------------------------------------------------------------------

/** A parent's children with their intramural and balance. Staff get 403. */
coachingRoutes.get("/parent/children", async (req, res) => {
  const user = me(req);
  if (user.role !== "parent") throw new HttpError(403, "This is for parents");
  if (user.status !== "active") {
    res.json({ pending: true, children: [] });
    return;
  }
  const children = await query(
    `SELECT p.id, p.first_name AS "firstName", p.last_name AS "lastName", p.category, p.team,
            i.id AS "intramuralId", i.name AS "intramuralName", i.color, i.short_code AS "shortCode", i.logo,
            c.currency, c.mpesa,
            coalesce((SELECT sum(amount) FROM fee_items f WHERE f.player_id = p.id), 0)
              - coalesce((SELECT sum(amount) FROM payments y WHERE y.player_id = p.id AND y.status = 'completed'), 0) AS balance,
            (SELECT count(*) FROM injuries j WHERE j.player_id = p.id AND j.parent_acknowledged_at IS NULL) AS "unacknowledgedInjuries",
            (SELECT count(*) FROM unpaid_alerts u WHERE u.player_id = p.id AND u.resolved_at IS NULL) AS "unpaidAlerts",
            i.program_mode AS "programMode",
            a.form_url AS "registrationFormUrl"
       FROM players p JOIN intramurals i ON i.id = p.intramural_id JOIN countries c ON c.id = i.country_id
       LEFT JOIN airtable_configs a ON a.intramural_id = i.id
      WHERE p.id = ANY($1) ORDER BY p.first_name`,
    [user.children],
  );
  res.json({ pending: false, children });
});

export { requirePlayer };

// ---- post-session reports ----------------------------------------------------------------

coachingRoutes.post("/sessions/:id/reports", async (req, res) => {
  res.status(201).json(await submitSessionReport(me(req), sessionReportInput.parse({ ...req.body, sessionId: Number(req.params.id) })));
});

/** Reports for one school: admins see all; a coach sees their own. */
coachingRoutes.get("/intramurals/:id/reports", async (req, res) => {
  const user = me(req);
  requireStaff(user);
  const id = Number(req.params.id);
  await requireSee(user, id);
  res.json(
    await query(
      `SELECT r.id, r.session_id AS "sessionId", s.date AS "sessionDate", s.kind, r.age_group AS "ageGroup",
              r.present_count AS "presentCount", r.roster_count AS "rosterCount", r.attendance_summary AS "attendanceSummary",
              r.player_progress AS "playerProgress", r.pitch_notes AS "pitchNotes", r.created_at AS "createdAt", u.name AS coach
         FROM session_reports r JOIN sessions s ON s.id = r.session_id LEFT JOIN users u ON u.id = r.coach_id
        WHERE s.intramural_id = $1 AND ($2 OR r.coach_id = $3)
        ORDER BY r.created_at DESC LIMIT 100`,
      [id, user.isSuperAdmin, user.id],
    ),
  );
});

/**
 * The schools and clubs a parent can register with, each with its own Airtable
 * registration & M-PESA form. Only public details (no rosters), so parents
 * waiting for approval can register too.
 */
coachingRoutes.get("/parent/programs", async (req, res) => {
  const user = me(req);
  res.json(
    await query(
      `SELECT i.id, i.name, i.short_code AS "shortCode", i.color, i.logo, i.kind, i.program_mode AS "programMode",
              i.session_weekday AS "sessionWeekday", to_char(i.session_start,'HH24:MI') AS "sessionStart",
              to_char(i.session_end,'HH24:MI') AS "sessionEnd", i.location,
              a.form_url AS "formUrl", (i.id = ANY($2::int[])) AS "mine"
         FROM intramurals i LEFT JOIN airtable_configs a ON a.intramural_id = i.id
        WHERE NOT i.archived AND ($1::int IS NULL OR i.country_id = $1)
        ORDER BY (i.id = ANY($2::int[])) DESC, i.position, i.name`,
      [user.isSuperAdmin ? null : user.countryId, user.childIntramurals],
    ),
  );
});
