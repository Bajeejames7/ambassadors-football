import { Router } from "express";
import { z } from "zod";
import { HttpError, audit, can, me, requirePermission, requireSee, requireStaff, visibleIntramuralIds, intramuralRef } from "../auth.js";
import { one, query } from "../db.js";
import { sessionDayLabel, today, addDays, nextWeekday, hhmm } from "../util.js";

export const intramuralRoutes = Router();

const INTRAMURAL_FIELDS = `
  i.id, i.slug, i.name, i.short_code AS "shortCode", i.kind, i.color, i.logo, i.coordinator_name AS "coordinatorName",
  i.session_weekday AS "sessionWeekday", to_char(i.session_start, 'HH24:MI') AS "sessionStart",
  to_char(i.session_end, 'HH24:MI') AS "sessionEnd", i.location, i.dress_code AS "dressCode",
  i.availability_options AS "availabilityOptions", i.default_roles AS "defaultRoles",
  i.default_schedule AS "defaultSchedule", i.teams, i.categories, i.archived,
  i.country_id AS "countryId", c.name AS "countryName", c.currency, c.time_zone AS "timeZone", c.mpesa`;

/**
 * Makes sure the next six regular sessions exist, on the intramural's own
 * weekday. If the weekday changed, untouched future sessions on the old day
 * are moved, so every label ("Tuesday Session", "Saturday Session") follows Setup.
 */
export async function ensureUpcomingSessions(intramuralId: number): Promise<void> {
  const i = await one(
    `SELECT i.session_weekday AS wd, i.session_start AS st, i.session_end AS en, i.location, i.dress_code AS dress,
            i.default_schedule AS sched, i.default_roles AS roles, c.time_zone AS tz
       FROM intramurals i JOIN countries c ON c.id = i.country_id WHERE i.id = $1`,
    [intramuralId],
  );
  if (!i) return;
  const now = today(i.tz);
  await query(
    `DELETE FROM sessions s WHERE s.intramural_id = $1 AND s.kind = 'training' AND s.date > $2 AND s.version = 1
        AND extract(dow FROM s.date) <> $3
        AND NOT EXISTS (SELECT 1 FROM attendance a WHERE a.session_id = s.id)
        AND NOT EXISTS (SELECT 1 FROM availability v WHERE v.session_id = s.id)`,
    [intramuralId, now, i.wd],
  );
  const first = nextWeekday(i.wd, now);
  const dates = Array.from({ length: 6 }, (_, k) => addDays(first, k * 7));
  const roles = (i.roles as string[]).map((role) => ({ role, userId: null }));
  await query(
    `INSERT INTO sessions (intramural_id, date, kind, start_time, end_time, location, dress_code, schedule, roles)
     SELECT $1, d::date, 'training', $3, $4, $5, $6, $7, $8 FROM unnest($2::text[]) d
     ON CONFLICT (intramural_id, date) WHERE kind = 'training' DO NOTHING`,
    [intramuralId, dates, i.st, i.en, i.location, i.dress, JSON.stringify(i.sched), JSON.stringify(roles)],
  );
}

/** The intramurals this person can see, each with its next session. */
intramuralRoutes.get("/intramurals", async (req, res) => {
  const user = me(req);
  const ids = visibleIntramuralIds(user);
  const rows = await query(
    `SELECT ${INTRAMURAL_FIELDS} FROM intramurals i JOIN countries c ON c.id = i.country_id
      WHERE NOT i.archived AND ($1::int[] IS NULL OR i.id = ANY($1))
      ORDER BY c.name, i.position, i.name`,
    [ids],
  );
  // Admins/coaches outside their country lose access unless overridden (checked per row).
  const out = [];
  for (const r of rows) {
    if (ids !== null) {
      try { await requireSee(user, r.id); } catch { continue; }
    }
    await ensureUpcomingSessions(r.id);
    const next = await one(
      `SELECT id, date, kind, title, opponent, cancelled, dress_code AS "dressCode", to_char(start_time,'HH24:MI') AS "startTime", to_char(end_time,'HH24:MI') AS "endTime", location
         FROM sessions WHERE intramural_id = $1 AND date >= $2 AND NOT cancelled ORDER BY date, start_time LIMIT 1`,
      [r.id, today(r.timeZone)],
    );
    out.push({ ...r, dayLabel: sessionDayLabel(r.sessionWeekday), nextSession: next ?? null, myPermissions: permissionsHere(user, r) });
  }
  res.json(out);
});

function permissionsHere(user: ReturnType<typeof me>, ref: { id: number; countryId: number }) {
  const all = ["schedules.edit", "players.register", "roles.assign", "airtable.manage", "parents.approve", "attendance.take",
    "equipment.check", "payments.manage", "reports.generate", "privileges.grant", "roster.view", "mentorship.write", "tally.write",
    "virtues.score", "feedback.write", "injuries.report", "availability.answer"] as const;
  return all.filter((p) => can(user, p, ref));
}

intramuralRoutes.get("/intramurals/:id", async (req, res) => {
  const user = me(req);
  const id = Number(req.params.id);
  const ref = await requireSee(user, id);
  const row = await one(`SELECT ${INTRAMURAL_FIELDS} FROM intramurals i JOIN countries c ON c.id = i.country_id WHERE i.id = $1`, [id]);
  const air = await one(
    `SELECT form_url AS "formUrl", base_id AS "baseId", table_name AS "tableName", view_name AS "viewName",
            field_map AS "fieldMap", push_walk_ins AS "pushWalkIns", api_token <> '' AS "hasToken"
       FROM airtable_configs WHERE intramural_id = $1`,
    [id],
  );
  const result: Record<string, unknown> = { ...row, dayLabel: sessionDayLabel(row.sessionWeekday), myPermissions: permissionsHere(user, ref) };
  // Parents get only the registration form link; staff see whether search is set up; Airtable managers see it all.
  result.airtable = can(user, "airtable.manage", ref)
    ? air
    : { formUrl: air?.formUrl ?? "", searchEnabled: Boolean(air?.baseId && air?.tableName && (air?.hasToken || process.env.AIRTABLE_API_KEY)) };
  if (user.role !== "parent") {
    result.equipment = await query(`SELECT id, name, expected, active FROM equipment_items WHERE intramural_id = $1 ORDER BY id`, [id]);
  }
  res.json(result);
});

const timeString = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a time like 15:15");

const setupInput = z.object({
  name: z.string().trim().min(2).max(80),
  shortCode: z.string().trim().min(1).max(6),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  coordinatorName: z.string().max(100),
  sessionWeekday: z.number().int().min(0).max(6),
  sessionStart: timeString,
  sessionEnd: timeString,
  location: z.string().max(200),
  dressCode: z.string().max(300),
  defaultSchedule: z.array(z.object({ time: timeString, activity: z.string().trim().min(1).max(200) })).max(40),
  defaultRoles: z.array(z.string().trim().min(1).max(60)).max(20),
  categories: z.array(z.string().trim().min(1).max(40)).max(20),
  teams: z.array(z.object({ id: z.string().min(1).max(30), name: z.string().min(1).max(40), color: z.string().max(9) })).max(12),
  availabilityOptions: z
    .array(z.object({ id: z.string().min(1).max(40), label: z.string().min(1).max(120), tone: z.enum(["good", "ok", "bad"]) }))
    .min(2)
    .max(6),
}).partial();

/** The Setup tab. */
intramuralRoutes.patch("/intramurals/:id", async (req, res) => {
  const user = me(req);
  const id = Number(req.params.id);
  await requirePermission(user, "schedules.edit", id);
  const s = setupInput.parse(req.body);
  if (s.sessionStart && s.sessionEnd && s.sessionEnd <= s.sessionStart) throw new HttpError(400, "The session must end after it starts");
  const cols: Record<string, unknown> = {
    name: s.name, short_code: s.shortCode?.toUpperCase(), color: s.color, coordinator_name: s.coordinatorName,
    session_weekday: s.sessionWeekday, session_start: s.sessionStart, session_end: s.sessionEnd, location: s.location,
    dress_code: s.dressCode,
    default_schedule: s.defaultSchedule && JSON.stringify([...s.defaultSchedule].sort((a, b) => a.time.localeCompare(b.time))),
    default_roles: s.defaultRoles && JSON.stringify(s.defaultRoles), categories: s.categories && JSON.stringify(s.categories),
    teams: s.teams && JSON.stringify(s.teams), availability_options: s.availabilityOptions && JSON.stringify(s.availabilityOptions),
  };
  const set = Object.entries(cols).filter(([, v]) => v !== undefined);
  if (set.length) {
    await query(`UPDATE intramurals SET ${set.map(([k], n) => `${k} = $${n + 2}`).join(", ")} WHERE id = $1`, [id, ...set.map(([, v]) => v)]);
    // Untouched upcoming trainings pick up the new defaults.
    await query(
      `UPDATE sessions s SET start_time = i.session_start, end_time = i.session_end, location = i.location, dress_code = i.dress_code,
              schedule = i.default_schedule
         FROM intramurals i WHERE i.id = s.intramural_id AND s.intramural_id = $1 AND s.kind = 'training'
          AND s.version = 1 AND s.date >= current_date`,
      [id],
    );
    await ensureUpcomingSessions(id);
  }
  await audit(user.id, "setup_updated", { intramuralId: id, fields: set.map(([k]) => k) });
  res.json({ ok: true });
});

const airtableInput = z.object({
  formUrl: z.union([z.literal(""), z.url().refine((u) => u.startsWith("https://"), "Use an https:// link")]),
  baseId: z.union([z.literal(""), z.string().regex(/^app[A-Za-z0-9]{14}$/, "Base IDs look like appXXXXXXXXXXXXXX")]),
  tableName: z.string().max(100),
  viewName: z.string().max(100),
  apiToken: z.string().max(200).optional(), // omitted = keep; "" = remove
  pushWalkIns: z.boolean(),
  fieldMap: z.record(z.string(), z.string().max(100)),
});

/** Per-intramural Airtable link (Setup tab). */
intramuralRoutes.put("/intramurals/:id/airtable", async (req, res) => {
  const user = me(req);
  const id = Number(req.params.id);
  await requirePermission(user, "airtable.manage", id);
  const a = airtableInput.parse(req.body);
  await query(
    `INSERT INTO airtable_configs (intramural_id, form_url, base_id, table_name, view_name, api_token, push_walk_ins, field_map, updated_by, updated_at)
     VALUES ($1,$2,$3,$4,$5,coalesce($6,''),$7,$8,$9,now())
     ON CONFLICT (intramural_id) DO UPDATE SET form_url = $2, base_id = $3, table_name = $4, view_name = $5,
       api_token = coalesce($6, airtable_configs.api_token), push_walk_ins = $7, field_map = $8, updated_by = $9, updated_at = now()`,
    [id, a.formUrl, a.baseId, a.tableName, a.viewName, a.apiToken ?? null, a.pushWalkIns, JSON.stringify(a.fieldMap), user.id],
  );
  await audit(user.id, "airtable_updated", { intramuralId: id, baseId: a.baseId, tokenChanged: a.apiToken !== undefined });
  res.json({ ok: true });
});

const equipmentInput = z.object({
  items: z.array(z.object({ id: z.number().int().optional(), name: z.string().trim().min(1).max(60), expected: z.number().int().min(0).max(10000), active: z.boolean().default(true) })).max(100),
});

/** The equipment list counted before and after every session. */
intramuralRoutes.put("/intramurals/:id/equipment", async (req, res) => {
  const user = me(req);
  const id = Number(req.params.id);
  await requirePermission(user, "schedules.edit", id);
  const { items } = equipmentInput.parse(req.body);
  for (const it of items) {
    if (it.id) {
      await query(`UPDATE equipment_items SET name = $3, expected = $4, active = $5 WHERE id = $1 AND intramural_id = $2`, [it.id, id, it.name, it.expected, it.active]);
    } else {
      await query(`INSERT INTO equipment_items (intramural_id, name, expected, active) VALUES ($1,$2,$3,$4)`, [id, it.name, it.expected, it.active]);
    }
  }
  res.json(await query(`SELECT id, name, expected, active FROM equipment_items WHERE intramural_id = $1 ORDER BY id`, [id]));
});

/** Staff dashboard counts for one intramural. */
intramuralRoutes.get("/intramurals/:id/summary", async (req, res) => {
  const user = me(req);
  requireStaff(user);
  const id = Number(req.params.id);
  const ref = await requireSee(user, id);
  const row = await one(
    `SELECT (SELECT count(*) FROM players WHERE intramural_id = $1 AND active) AS players,
            (SELECT count(*) FROM user_intramurals WHERE intramural_id = $1) AS coaches,
            (SELECT round(100.0 * count(*) FILTER (WHERE a.status IN ('present','late')) / nullif(count(*),0))
               FROM attendance a JOIN sessions s ON s.id = a.session_id WHERE s.intramural_id = $1 AND s.date >= current_date - 60) AS "attendanceRate",
            (SELECT count(*) FROM injuries j JOIN players p ON p.id = j.player_id WHERE p.intramural_id = $1 AND j.created_at > now() - interval '14 days') AS "recentInjuries"`,
    [id],
  );
  const pendingParents = can(user, "parents.approve", ref)
    ? (await one(
        `SELECT count(DISTINCT pc.parent_id) AS n FROM parent_children pc JOIN players p ON p.id = pc.player_id
          WHERE p.intramural_id = $1 AND pc.verified_at IS NULL`,
        [id],
      )).n
    : null;
  res.json({ ...row, pendingParents });
});

export { intramuralRef, hhmm };
