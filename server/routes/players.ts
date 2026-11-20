import { Router } from "express";
import { z } from "zod";
import { HttpError, can, me, requirePermission, requirePlayer, requireSee, requireStaff } from "../auth.js";
import { one, query } from "../db.js";
import { isDate, normalizeEmail, normalizePhone, seasonOf, titleCaseName, today } from "../util.js";
import {
  playerInput, registerPlayer, recordAttendance, attendanceInput, injuryInput, reportInjury,
} from "../lib/field.js";

export const playerRoutes = Router();

const PLAYER_FIELDS = `p.id, p.intramural_id AS "intramuralId", p.first_name AS "firstName", p.last_name AS "lastName",
  p.date_of_birth AS "dateOfBirth", p.category, p.team, p.source, p.active, p.airtable_record_id AS "airtableRecordId", p.created_at AS "createdAt"`;
const GUARDIAN_FIELDS = `p.guardian_name AS "guardianName", p.guardian_email AS "guardianEmail", p.guardian_phone AS "guardianPhone", p.medical_notes AS "medicalNotes"`;

/** The roster (cached on phones for offline check-in). */
playerRoutes.get("/intramurals/:id/players", async (req, res) => {
  const user = me(req);
  requireStaff(user);
  const id = Number(req.params.id);
  await requirePermission(user, "roster.view", id);
  const q = String(req.query.q ?? "").trim().toLowerCase();
  res.json(
    await query(
      `SELECT ${PLAYER_FIELDS}, ${GUARDIAN_FIELDS},
              EXISTS (SELECT 1 FROM parent_children pc WHERE pc.player_id = p.id AND pc.verified_at IS NOT NULL) AS "hasParentAccount"
         FROM players p WHERE p.intramural_id = $1 AND p.active
          AND ($2 = '' OR lower(p.first_name || ' ' || p.last_name) LIKE '%' || $2 || '%')
        ORDER BY p.category, p.first_name, p.last_name`,
      [id, q],
    ),
  );
});

playerRoutes.post("/intramurals/:id/players", async (req, res) => {
  const result = await registerPlayer(me(req), playerInput.parse({ ...req.body, intramuralId: Number(req.params.id) }));
  res.status(result.duplicate ? 200 : 201).json(result);
});

const editInput = z.object({
  firstName: z.string().trim().min(1).max(60),
  lastName: z.string().trim().max(60),
  dateOfBirth: z.string().refine(isDate).nullable(),
  category: z.string().max(40),
  team: z.string().max(40),
  guardianName: z.string().max(100),
  guardianEmail: z.string().max(200),
  guardianPhone: z.string().max(30),
  medicalNotes: z.string().max(1000),
  active: z.boolean(),
}).partial();

playerRoutes.patch("/players/:id", async (req, res) => {
  const user = me(req);
  const p = await requirePlayer(user, Number(req.params.id));
  await requirePermission(user, "players.register", p.intramuralId);
  const e = editInput.parse(req.body);
  const phone = e.guardianPhone ? normalizePhone(e.guardianPhone) : e.guardianPhone;
  if (e.guardianPhone && !phone) throw new HttpError(400, "The parent's phone number does not look right");
  const cols: Record<string, unknown> = {
    first_name: e.firstName && titleCaseName(e.firstName), last_name: e.lastName !== undefined ? titleCaseName(e.lastName) : undefined,
    date_of_birth: e.dateOfBirth, category: e.category, team: e.team,
    guardian_name: e.guardianName !== undefined ? titleCaseName(e.guardianName) : undefined,
    guardian_email: e.guardianEmail !== undefined ? normalizeEmail(e.guardianEmail) : undefined, guardian_phone: phone,
    medical_notes: e.medicalNotes, active: e.active,
  };
  const set = Object.entries(cols).filter(([, v]) => v !== undefined);
  if (set.length) {
    await query(`UPDATE players SET ${set.map(([k], n) => `${k} = $${n + 2}`).join(", ")} WHERE id = $1`, [p.id, ...set.map(([, v]) => v)]).catch((err) => {
      if (err.code === "23505") throw new HttpError(409, "Another player with this name and birthday is already registered here");
      throw err;
    });
  }
  res.json({ ok: true });
});

/**
 * Everything about one child's progress: the heart of the Parent Dashboard.
 * Parents get only their own verified children (requirePlayer); coach-only
 * mentorship notes are never included.
 */
playerRoutes.get("/players/:id/progress", async (req, res) => {
  const user = me(req);
  const p = await requirePlayer(user, Number(req.params.id));
  const staff = user.role !== "parent";
  const season = String(req.query.season ?? seasonOf(today()));
  const player = await one(
    `SELECT ${PLAYER_FIELDS}${staff ? `, ${GUARDIAN_FIELDS}` : ""}, i.name AS "intramuralName", i.color, i.short_code AS "shortCode"
       FROM players p JOIN intramurals i ON i.id = p.intramural_id WHERE p.id = $1`,
    [p.id],
  );
  const [attendance, history, feedback, virtues, virtueTrend, awards, injuries, seasons] = await Promise.all([
    one(
      `SELECT count(*) FILTER (WHERE a.status IN ('present','late')) AS attended, count(*) AS recorded,
              round(100.0 * count(*) FILTER (WHERE a.status IN ('present','late')) / nullif(count(*),0)) AS rate
         FROM attendance a JOIN sessions s ON s.id = a.session_id WHERE a.player_id = $1 AND to_char(s.date,'YYYY') = $2`,
      [p.id, season],
    ),
    query(
      `SELECT s.id AS "sessionId", s.date, s.kind, s.title, a.status, a.checked_in_at AS "checkedInAt"
         FROM attendance a JOIN sessions s ON s.id = a.session_id WHERE a.player_id = $1 ORDER BY s.date DESC LIMIT 30`,
      [p.id],
    ),
    query(
      `SELECT f.id, f.category, f.rating, f.note, f.created_at AS "createdAt", u.name AS coach, s.date AS "sessionDate"
         FROM coach_feedback f LEFT JOIN users u ON u.id = f.coach_id LEFT JOIN sessions s ON s.id = f.session_id
        WHERE f.player_id = $1 ${staff ? "" : "AND f.visible_to_parent"} ORDER BY f.created_at DESC LIMIT 50`,
      [p.id],
    ),
    query(
      `SELECT virtue, round(avg(score)::numeric, 1) AS average, count(*) AS entries
         FROM virtue_scores WHERE player_id = $1 AND season = $2 GROUP BY virtue`,
      [p.id, season],
    ),
    // Month-by-month average, to show growth across the season.
    query(
      `SELECT to_char(created_at, 'YYYY-MM') AS month, virtue, round(avg(score)::numeric, 1) AS average
         FROM virtue_scores WHERE player_id = $1 AND season = $2 GROUP BY 1, 2 ORDER BY 1`,
      [p.id, season],
    ),
    query(
      `SELECT a.id, a.award, a.virtue, a.reason, a.week_of AS "weekOf", u.name AS "awardedBy"
         FROM character_awards a LEFT JOIN users u ON u.id = a.awarded_by WHERE a.player_id = $1 ORDER BY a.week_of DESC LIMIT 20`,
      [p.id],
    ),
    query(
      `SELECT j.id, j.severity, j.body_part AS "bodyPart", j.description, j.action_taken AS "actionTaken",
              j.created_at AS "createdAt", j.parent_acknowledged_at AS "acknowledgedAt", u.name AS "reportedBy"
         FROM injuries j LEFT JOIN users u ON u.id = j.reported_by WHERE j.player_id = $1 ORDER BY j.created_at DESC LIMIT 20`,
      [p.id],
    ),
    query(`SELECT DISTINCT season FROM virtue_scores WHERE player_id = $1 ORDER BY season DESC`, [p.id]),
  ]);
  const VIRTUES = ["temperance", "wisdom", "fortitude", "justice", "teamwork", "discipline"];
  const byVirtue = new Map(virtues.map((v) => [v.virtue, v]));
  res.json({
    player,
    season,
    seasons: [...new Set([season, ...seasons.map((s) => s.season)])],
    attendance: { attended: attendance?.attended ?? 0, recorded: attendance?.recorded ?? 0, rate: attendance?.rate ?? null, history },
    feedback,
    feedbackByCategory: Object.values(
      feedback.reduce<Record<string, { category: string; average: number; count: number; latest: string }>>((acc, f) => {
        const a = (acc[f.category] ??= { category: f.category, average: 0, count: 0, latest: f.note });
        if (f.rating) { a.average = (a.average * a.count + f.rating) / (a.count + 1); a.count += 1; }
        return acc;
      }, {}),
    ).map((c) => ({ ...c, average: Math.round(c.average * 10) / 10 })),
    virtues: VIRTUES.map((v) => ({ virtue: v, average: byVirtue.get(v)?.average ?? 0, entries: byVirtue.get(v)?.entries ?? 0 })),
    virtueTrend,
    awards,
    injuries,
  });
});

const feedbackInput = z.object({
  sessionId: z.number().int().nullable().optional(),
  category: z.string().trim().min(2).max(40),
  rating: z.number().int().min(1).max(5).nullable().optional(),
  note: z.string().max(2000).default(""),
  visibleToParent: z.boolean().default(true),
});

playerRoutes.post("/players/:id/feedback", async (req, res) => {
  const user = me(req);
  requireStaff(user);
  const p = await requirePlayer(user, Number(req.params.id));
  await requirePermission(user, "feedback.write", p.intramuralId);
  const f = feedbackInput.parse(req.body);
  const row = await one(
    `INSERT INTO coach_feedback (player_id, session_id, category, rating, note, coach_id, visible_to_parent)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [p.id, f.sessionId ?? null, f.category, f.rating ?? null, f.note, user.id, f.visibleToParent],
  );
  res.status(201).json(row);
});

const virtueInput = z.object({
  sessionId: z.number().int().nullable().optional(),
  scores: z.partialRecord(z.enum(["temperance", "wisdom", "fortitude", "justice", "teamwork", "discipline"]), z.number().int().min(1).max(10)),
});

playerRoutes.post("/players/:id/virtues", async (req, res) => {
  const user = me(req);
  requireStaff(user);
  const p = await requirePlayer(user, Number(req.params.id));
  await requirePermission(user, "virtues.score", p.intramuralId);
  const { sessionId, scores } = virtueInput.parse(req.body);
  const entries = Object.entries(scores);
  if (!entries.length) throw new HttpError(400, "Score at least one virtue");
  const season = seasonOf(today());
  for (const [virtue, score] of entries) {
    await query(`INSERT INTO virtue_scores (player_id, session_id, virtue, score, season, recorded_by) VALUES ($1,$2,$3,$4,$5,$6)`, [
      p.id, sessionId ?? null, virtue, score, season, user.id,
    ]);
  }
  res.status(201).json({ saved: entries.length });
});

playerRoutes.post("/players/:id/injuries", async (req, res) => {
  res.status(201).json(await reportInjury(me(req), injuryInput.parse({ ...req.body, playerId: Number(req.params.id) })));
});

/** A parent confirms they have seen an injury alert. */
playerRoutes.post("/injuries/:id/acknowledge", async (req, res) => {
  const user = me(req);
  const j = await one(`SELECT player_id AS "playerId" FROM injuries WHERE id = $1`, [Number(req.params.id)]);
  if (!j) throw new HttpError(404, "Not found");
  await requirePlayer(user, j.playerId);
  if (user.role !== "parent") throw new HttpError(403, "Only the child's parent acknowledges this");
  await query(`UPDATE injuries SET parent_acknowledged_at = coalesce(parent_acknowledged_at, now()) WHERE id = $1`, [Number(req.params.id)]);
  res.json({ ok: true });
});

// ---- attendance ---------------------------------------------------------------------

/** The roll call for one session: every active player with their status. */
playerRoutes.get("/sessions/:id/attendance", async (req, res) => {
  const user = me(req);
  requireStaff(user);
  const s = await one(`SELECT intramural_id AS "intramuralId" FROM sessions WHERE id = $1`, [Number(req.params.id)]);
  if (!s) throw new HttpError(404, "That session does not exist");
  const ref = await requirePermission(user, "roster.view", s.intramuralId);
  const rows = await query(
    `SELECT p.id AS "playerId", p.first_name AS "firstName", p.last_name AS "lastName", p.category, p.team,
            a.status, a.checked_in_at AS "checkedInAt", a.recorded_at AS "recordedAt"
       FROM players p LEFT JOIN attendance a ON a.player_id = p.id AND a.session_id = $1
      WHERE p.intramural_id = $2 AND (p.active OR a.status IS NOT NULL)
      ORDER BY p.category, p.first_name`,
    [Number(req.params.id), s.intramuralId],
  );
  res.json({ canTake: can(user, "attendance.take", ref), entries: rows });
});

playerRoutes.put("/sessions/:id/attendance", async (req, res) => {
  res.json(await recordAttendance(me(req), attendanceInput.parse({ ...req.body, sessionId: Number(req.params.id) })));
});

export { requireSee };
