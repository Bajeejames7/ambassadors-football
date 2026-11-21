import { Router } from "express";
import { z } from "zod";
import {
  HttpError, RESTRICTIONS, audit, issuePreviewToken, me, requireAllowed, requirePlayer, requireRealSuperAdmin,
  requireSuperAdmin, visibleIntramuralIds, type Restriction,
} from "../auth.js";
import { one, query, transaction } from "../db.js";
import { isDate, today } from "../util.js";
import { CONFIG_FIELDS, ensureTermFees, paymentCard } from "../lib/termfees.js";

/** Public: the "Register a Child" link for the parent login page. */
export const publicControlRoutes = Router();
/** Signed in: Privilege Control, Payment Configuration, previews, analytics, the parent overview. */
export const controlRoutes = Router();

// ---- "Register a Child" link --------------------------------------------------------------

async function registrationInfo() {
  const setting = await one(`SELECT value FROM app_settings WHERE key = 'registration_url'`);
  const programs = await query(
    `SELECT i.id, i.name, i.program_mode AS "programMode", a.form_url AS "formUrl"
       FROM intramurals i LEFT JOIN airtable_configs a ON a.intramural_id = i.id
      WHERE NOT i.archived ORDER BY i.position, i.name`,
  );
  return { url: setting?.value ?? "", programs: programs.filter((p) => p.formUrl) };
}

publicControlRoutes.get("/registration", async (_req, res) => {
  res.json(await registrationInfo());
});

const httpsUrl = z.union([z.literal(""), z.url().refine((u) => u.startsWith("https://"), "Use an https:// link")]);

controlRoutes.put("/control/registration", async (req, res) => {
  const user = me(req);
  requireRealSuperAdmin(user);
  const { url } = z.object({ url: httpsUrl }).parse(req.body);
  await query(
    `INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES ('registration_url', $1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [url, user.id],
  );
  await audit(user.id, "registration_link_set", { url });
  res.json(await registrationInfo());
});

// ---- Privilege Control (Super Admin only) ------------------------------------------------------

controlRoutes.get("/control/privileges", async (req, res) => {
  requireRealSuperAdmin(me(req));
  const admins = await query(
    `SELECT u.id, u.name, u.email, u.status,
            coalesce((SELECT array_agg(restriction ORDER BY restriction) FROM admin_restrictions r WHERE r.user_id = u.id), '{}') AS restrictions
       FROM users u WHERE u.role = 'admin' ORDER BY u.name`,
  );
  res.json({
    options: Object.entries(RESTRICTIONS).map(([key, v]) => ({ key, label: v.label })),
    admins,
  });
});

controlRoutes.put("/control/privileges/:userId", async (req, res) => {
  const actor = me(req);
  requireRealSuperAdmin(actor);
  const id = Number(req.params.userId);
  const keys = Object.keys(RESTRICTIONS) as [Restriction, ...Restriction[]];
  const { restrictions } = z.object({ restrictions: z.array(z.enum(keys)).max(keys.length) }).parse(req.body);
  const target = await one(`SELECT role FROM users WHERE id = $1`, [id]);
  if (!target) throw new HttpError(404, "That person does not exist");
  if (target.role !== "admin") throw new HttpError(400, "Privilege Control applies to Admins only");
  await transaction(async (c) => {
    await c.query(`DELETE FROM admin_restrictions WHERE user_id = $1`, [id]);
    if (restrictions.length) {
      await c.query(
        `INSERT INTO admin_restrictions (user_id, restriction, created_by) SELECT $1, unnest($2::text[]), $3`,
        [id, restrictions, actor.id],
      );
    }
  });
  await audit(actor.id, "admin_restrictions_set", { userId: id, restrictions });
  res.json({ ok: true });
});

// ---- Payment Configuration (Super Admin sets; Admins can read) ----------------------------------

controlRoutes.get("/control/payment-config", async (req, res) => {
  const user = me(req);
  requireSuperAdmin(user);
  const rows = await query(
    `SELECT i.id AS "intramuralId", i.name, i.short_code AS "shortCode", i.program_mode AS "programMode", c.currency,
            pc.term_label AS "termLabel", pc.fee_amount AS "feeAmount", coalesce(pc.method, 'paybill') AS method,
            coalesce(pc.paybill, '') AS paybill, coalesce(pc.till, '') AS till,
            coalesce(pc.account_ref_format, '{CODE}-{CHILD}') AS "accountRefFormat",
            to_char(pc.deadline, 'YYYY-MM-DD') AS deadline, coalesce(pc.instructions, '') AS instructions, pc.updated_at AS "updatedAt",
            coalesce(a.form_url, '') AS "formUrl"
       FROM intramurals i JOIN countries c ON c.id = i.country_id
       LEFT JOIN payment_configs pc ON pc.intramural_id = i.id
       LEFT JOIN airtable_configs a ON a.intramural_id = i.id
      WHERE NOT i.archived ORDER BY i.position, i.name`,
  );
  res.json({ canEdit: user.isRealSuperAdmin, configs: rows, registration: await registrationInfo() });
});

const configInput = z.object({
  termLabel: z.string().trim().max(60),
  feeAmount: z.number().int("Use whole shillings").positive().max(10_000_000).nullable(),
  method: z.enum(["paybill", "till"]),
  paybill: z.string().trim().regex(/^\d{0,10}$/, "Paybill numbers are digits only"),
  till: z.string().trim().regex(/^\d{0,10}$/, "Till numbers are digits only"),
  accountRefFormat: z.string().trim().max(40),
  deadline: z.string().refine(isDate, "Pick a date").nullable(),
  instructions: z.string().max(1000),
  formUrl: httpsUrl.optional(),
});

controlRoutes.put("/control/payment-config/:intramuralId", async (req, res) => {
  const user = me(req);
  requireRealSuperAdmin(user);
  const id = Number(req.params.intramuralId);
  const c = configInput.parse(req.body);
  if (c.feeAmount && !c.termLabel) throw new HttpError(400, "Name the term (for example Term 1 2027) so parents know what the fee is for");
  if (c.method === "paybill" && c.feeAmount && !c.paybill) throw new HttpError(400, "Enter the Paybill number");
  if (c.method === "till" && c.feeAmount && !c.till) throw new HttpError(400, "Enter the Till number");
  const exists = await one(`SELECT id FROM intramurals WHERE id = $1`, [id]);
  if (!exists) throw new HttpError(404, "That school or club does not exist");
  await query(
    `INSERT INTO payment_configs (intramural_id, term_label, fee_amount, method, paybill, till, account_ref_format, deadline, instructions, updated_by, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
     ON CONFLICT (intramural_id) DO UPDATE SET term_label = EXCLUDED.term_label, fee_amount = EXCLUDED.fee_amount, method = EXCLUDED.method,
       paybill = EXCLUDED.paybill, till = EXCLUDED.till, account_ref_format = EXCLUDED.account_ref_format, deadline = EXCLUDED.deadline,
       instructions = EXCLUDED.instructions, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [id, c.termLabel, c.feeAmount, c.method, c.paybill, c.till, c.accountRefFormat || "{CODE}-{CHILD}", c.deadline, c.instructions, user.id],
  );
  if (c.formUrl !== undefined) {
    await query(
      `INSERT INTO airtable_configs (intramural_id, form_url, updated_by) VALUES ($1, $2, $3)
       ON CONFLICT (intramural_id) DO UPDATE SET form_url = EXCLUDED.form_url, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [id, c.formUrl, user.id],
    );
  }
  await ensureTermFees([id]);
  await audit(user.id, "payment_config_set", { intramuralId: id, termLabel: c.termLabel, feeAmount: c.feeAmount });
  const row = await one(`SELECT ${CONFIG_FIELDS} FROM payment_configs WHERE intramural_id = $1`, [id]);
  res.json(row);
});

// ---- View as Parent -----------------------------------------------------------------------------

/** A 30-minute, read-only token to open the parent portal exactly as this parent sees it. */
controlRoutes.post("/creator/parents/:id/preview-token", async (req, res) => {
  const user = me(req);
  requireAllowed(user, "parents.preview");
  const parent = await one(`SELECT id, name, role FROM users WHERE id = $1`, [Number(req.params.id)]);
  if (!parent || parent.role !== "parent") throw new HttpError(404, "That parent does not exist");
  await audit(user.id, "parent_preview_opened", { parentId: parent.id });
  res.json({ token: issuePreviewToken(parent.id, user.id), name: parent.name });
});

// ---- the parent's view of one child ----------------------------------------------------------------

/**
 * Everything on a child's progress dashboard that /players/:id/progress does not
 * already give: placement (program, team, age group, coaches), attendance with
 * dates, a coach timeline and the payment card. requirePlayer keeps a parent to
 * their own verified children (403 for any other id).
 */
controlRoutes.get("/players/:id/overview", async (req, res) => {
  const user = me(req);
  const p = await requirePlayer(user, Number(req.params.id));
  await ensureTermFees([p.intramuralId]);
  const player = await one(
    `SELECT p.id, p.first_name AS "firstName", p.last_name AS "lastName", p.category AS "ageGroup", p.team,
            i.id AS "intramuralId", i.name AS "intramuralName", i.program_mode AS "programMode", i.teams,
            to_char(i.term_start, 'YYYY-MM-DD') AS "termStart", to_char(i.term_end, 'YYYY-MM-DD') AS "termEnd"
       FROM players p JOIN intramurals i ON i.id = p.intramural_id WHERE p.id = $1`,
    [p.id],
  );
  const [coaches, attendance, timeline, camps, payment] = await Promise.all([
    // Coaches assigned to this school who cover this child's age group (no age groups = all).
    query(
      `SELECT u.name FROM user_intramurals ui JOIN users u ON u.id = ui.user_id
        WHERE ui.intramural_id = $1 AND u.status = 'active' AND u.role IN ('coach', 'admin')
          AND (cardinality(ui.age_groups) = 0 OR $2 = ANY(ui.age_groups))
        ORDER BY cardinality(ui.age_groups) = 0, u.name`,
      [p.intramuralId, player.ageGroup],
    ),
    query(
      `SELECT s.id AS "sessionId", to_char(s.date, 'YYYY-MM-DD') AS date, s.kind, s.title, a.status,
              EXISTS (SELECT 1 FROM injuries j WHERE j.player_id = a.player_id AND j.session_id = s.id) AS injured
         FROM attendance a JOIN sessions s ON s.id = a.session_id
        WHERE a.player_id = $1 AND NOT s.cancelled ORDER BY s.date DESC LIMIT 60`,
      [p.id],
    ),
    // Coach notes and virtue milestones, newest first.
    query(
      `SELECT * FROM (
         SELECT 'feedback' AS type, f.created_at AS at, to_char(s.date, 'YYYY-MM-DD') AS "sessionDate", f.category AS title,
                f.note AS body, f.rating, u.name AS coach
           FROM coach_feedback f LEFT JOIN users u ON u.id = f.coach_id LEFT JOIN sessions s ON s.id = f.session_id
          WHERE f.player_id = $1 AND (f.visible_to_parent OR $2)
         UNION ALL
         SELECT 'award', a.created_at, to_char(a.week_of, 'YYYY-MM-DD'), a.award, a.reason, NULL, u.name
           FROM character_awards a LEFT JOIN users u ON u.id = a.awarded_by WHERE a.player_id = $1
         UNION ALL
         SELECT 'virtue', v.created_at, to_char(s.date, 'YYYY-MM-DD'), v.virtue, '', v.score, u.name
           FROM virtue_scores v LEFT JOIN users u ON u.id = v.recorded_by LEFT JOIN sessions s ON s.id = v.session_id
          WHERE v.player_id = $1 AND v.score >= 8
       ) t ORDER BY at DESC LIMIT 60`,
      [p.id, user.role !== "parent"],
    ),
    // Upcoming camps and events at a club.
    query(
      `SELECT s.id, to_char(s.date, 'YYYY-MM-DD') AS date, to_char(s.end_date, 'YYYY-MM-DD') AS "endDate", s.kind, s.title
         FROM sessions s WHERE s.intramural_id = $1 AND s.kind IN ('camp', 'clinic', 'tournament') AND NOT s.cancelled
          AND coalesce(s.end_date, s.date) >= $2::date ORDER BY s.date LIMIT 5`,
      [p.intramuralId, today()],
    ),
    paymentCard(p.id),
  ]);
  const teams = (player.teams as { id: string; name: string; color: string }[]) ?? [];
  const team = player.programMode === "school" ? teams.find((t) => t.id === player.team || t.name === player.team) ?? null : null;
  const counts = attendance.reduce(
    (acc, a) => {
      if (a.status === "present" || a.status === "late") acc.attended += 1;
      else if (a.status === "excused" || a.injured) acc.excused += 1;
      else acc.missed += 1;
      return acc;
    },
    { attended: 0, missed: 0, excused: 0 },
  );
  const { teams: _t, ...rest } = player;
  res.json({
    player: { ...rest, team: team ?? (player.team ? { id: player.team, name: player.team, color: "#0f2147" } : null) },
    coaches: coaches.map((c) => c.name),
    attendance: { ...counts, total: attendance.length, sessions: attendance },
    timeline,
    camps,
    payment,
  });
});

// ---- attendance analytics ------------------------------------------------------------------------

const analyticsInput = z.object({
  view: z.enum(["term", "year"]).default("term"),
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  intramuralId: z.coerce.number().int().optional(),
  program: z.enum(["school", "club"]).optional(),
  ageGroup: z.string().max(10).optional(),
  coachId: z.coerce.number().int().optional(),
  format: z.enum(["json", "csv"]).default("json"),
});

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Attendance grouped on the server: by session date (Term) or by month (Year).
 * Present = present + late; Excused/Injury = excused, or absent with an injury
 * reported at that session; Absent = the rest. Unrecorded players are not counted.
 */
controlRoutes.get("/analytics/attendance", async (req, res) => {
  const user = me(req);
  requireAllowed(user, "analytics.view");
  const f = analyticsInput.parse(req.query);
  const now = today();
  const year = f.year ?? Number(now.slice(0, 4));
  const visible = visibleIntramuralIds(user);

  // Range: the selected school's term, else the span of the term dates set, else the last 16 weeks.
  let from: string;
  let to: string;
  let termLabel = "";
  if (f.view === "year") {
    from = `${year}-01-01`;
    to = `${year}-12-31`;
  } else {
    const term = await one(
      `SELECT to_char(min(term_start), 'YYYY-MM-DD') AS start, to_char(max(term_end), 'YYYY-MM-DD') AS "end"
         FROM intramurals WHERE term_start IS NOT NULL AND ($1::int IS NULL OR id = $1) AND ($2::text IS NULL OR program_mode = $2)`,
      [f.intramuralId ?? null, f.program ?? null],
    );
    if (term?.start) {
      from = term.start;
      to = term.end ?? now;
      termLabel = `${term.start} to ${term.end ?? "now"}`;
    } else {
      const d = new Date(`${now}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() - 16 * 7);
      from = d.toISOString().slice(0, 10);
      to = now;
      termLabel = "Last 16 weeks (no term dates set)";
    }
  }

  const params = [from, to, visible, f.intramuralId ?? null, f.program ?? null, f.ageGroup ?? null, f.coachId ?? null];
  const BASE = `
    SELECT s.id AS sid, s.date, s.intramural_id, a.status, p.category,
           (a.status = 'absent' AND EXISTS (SELECT 1 FROM injuries j WHERE j.player_id = a.player_id AND j.session_id = s.id)) AS injured
      FROM attendance a JOIN sessions s ON s.id = a.session_id JOIN players p ON p.id = a.player_id JOIN intramurals i ON i.id = s.intramural_id
     WHERE NOT s.cancelled AND s.date BETWEEN $1::date AND $2::date
       AND ($3::int[] IS NULL OR s.intramural_id = ANY($3::int[]))
       AND ($4::int IS NULL OR s.intramural_id = $4)
       AND ($5::text IS NULL OR i.program_mode = $5)
       AND ($6::text IS NULL OR p.category = $6)
       AND ($7::int IS NULL OR EXISTS (SELECT 1 FROM user_intramurals ui WHERE ui.user_id = $7 AND ui.intramural_id = s.intramural_id
                                         AND (cardinality(ui.age_groups) = 0 OR p.category = ANY(ui.age_groups))))`;
  const COUNTS = `
    count(*) FILTER (WHERE status IN ('present', 'late'))::int AS present,
    count(*) FILTER (WHERE status = 'absent' AND NOT injured)::int AS absent,
    count(*) FILTER (WHERE status = 'excused' OR injured)::int AS excused,
    count(DISTINCT sid)::int AS sessions`;

  const dates = await query(`WITH b AS (${BASE}) SELECT count(DISTINCT date)::int AS n FROM b`, params);
  // Many session dates in a term read better week by week.
  const weekly = f.view === "term" && (dates[0]?.n ?? 0) > 16;
  const bucket = f.view === "year" ? `to_char(date, 'MM')` : weekly ? `to_char(date_trunc('week', date), 'YYYY-MM-DD')` : `to_char(date, 'YYYY-MM-DD')`;

  const [grouped, totals, byAge, peak] = await Promise.all([
    query(`WITH b AS (${BASE}) SELECT ${bucket} AS bucket, ${COUNTS} FROM b GROUP BY 1 ORDER BY 1`, params),
    one(`WITH b AS (${BASE}) SELECT ${COUNTS} FROM b`, params),
    query(
      `WITH b AS (${BASE}) SELECT category AS "ageGroup", ${COUNTS} FROM b GROUP BY 1
        HAVING count(*) > 0 ORDER BY count(*) FILTER (WHERE status IN ('present','late'))::float / count(*) DESC, count(*) DESC`,
      params,
    ),
    one(
      `WITH b AS (${BASE}) SELECT to_char(date, 'YYYY-MM-DD') AS date, count(*) FILTER (WHERE status IN ('present','late'))::int AS present
         FROM b GROUP BY date ORDER BY 2 DESC, 1 DESC LIMIT 1`,
      params,
    ),
  ]);

  const rate = (r: { present: number; absent: number; excused: number }) => {
    const total = r.present + r.absent + r.excused;
    return total ? Math.round((1000 * r.present) / total) / 10 : null;
  };
  const label = (b: string) => {
    if (f.view === "year") return MONTHS[Number(b) - 1];
    const d = new Date(`${b}T00:00:00Z`);
    const text = d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
    return weekly ? `Wk of ${text}` : text;
  };

  let points = grouped.map((g) => ({ key: g.bucket, label: label(g.bucket), ...g, rate: rate(g) }));
  if (f.view === "year") {
    const have = new Map(points.map((p) => [p.key, p]));
    points = MONTHS.map((m, n) => {
      const key = String(n + 1).padStart(2, "0");
      return have.get(key) ?? { key, label: m, bucket: key, present: 0, absent: 0, excused: 0, sessions: 0, rate: null };
    });
  }

  if (f.format === "csv") {
    const scope = f.view === "year" ? `Year ${year}` : `Term ${termLabel}`;
    const lines = [
      `"Attendance report","${scope}"`,
      `${f.view === "year" ? "Month" : weekly ? "Week of" : "Date"},Present,Absent,Excused/Injury,Recorded,Attendance rate %,Sessions`,
      ...points.map((p) => [f.view === "year" ? p.label : p.key, p.present, p.absent, p.excused, p.present + p.absent + p.excused, p.rate ?? "", p.sessions].join(",")),
      ["Total", totals.present, totals.absent, totals.excused, totals.present + totals.absent + totals.excused, rate(totals) ?? "", totals.sessions].join(","),
    ];
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="attendance-${f.view === "year" ? year : "term"}.csv"`);
    res.send(lines.join("\n"));
    return;
  }

  const [intramurals, coaches] = await Promise.all([
    query(
      `SELECT id, name, program_mode AS "programMode", to_char(term_start, 'YYYY-MM-DD') AS "termStart", to_char(term_end, 'YYYY-MM-DD') AS "termEnd"
         FROM intramurals WHERE NOT archived AND ($1::int[] IS NULL OR id = ANY($1::int[])) ORDER BY position, name`,
      [visible],
    ),
    query(
      `SELECT DISTINCT u.id, u.name FROM users u JOIN user_intramurals ui ON ui.user_id = u.id
        WHERE u.role IN ('coach', 'admin') AND u.status = 'active' AND ($1::int[] IS NULL OR ui.intramural_id = ANY($1::int[])) ORDER BY u.name`,
      [visible],
    ),
  ]);

  res.json({
    view: f.view,
    year,
    from,
    to,
    termLabel,
    grouping: f.view === "year" ? "month" : weekly ? "week" : "session",
    points,
    kpis: {
      averageRate: rate(totals),
      sessionsHeld: totals.sessions,
      peakDay: peak?.present ? peak : null,
      topAgeGroup: byAge[0] ? { ageGroup: byAge[0].ageGroup, rate: rate(byAge[0]) } : null,
    },
    filters: { intramurals, coaches },
  });
});
