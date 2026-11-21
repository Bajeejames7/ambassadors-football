import { Router } from "express";
import { z } from "zod";
import { HttpError, can, me, requirePermission, requireSee, intramuralRef } from "../auth.js";
import { one, query } from "../db.js";
import { isDate, today, addDays, weekdayOf, WEEKDAYS, formatTime12, hhmm } from "../util.js";
import { ensureUpcomingSessions } from "./intramurals.js";
import { answerAvailability, availabilityInput } from "../lib/field.js";
import { notify, parentsInIntramural } from "../lib/notify.js";

export const sessionRoutes = Router();

const SESSION_FIELDS = `s.id, s.intramural_id AS "intramuralId", s.date, s.kind, s.title,
  to_char(s.start_time,'HH24:MI') AS "startTime", to_char(s.end_time,'HH24:MI') AS "endTime",
  s.location, s.dress_code AS "dressCode", s.opponent, s.travel_notes AS "travelNotes",
  s.schedule, s.roles, s.cancelled, s.version, s.updated_at AS "updatedAt", s.end_date AS "endDate"`;

function decorate<T extends { date: string; startTime: string; endTime: string }>(s: T) {
  return { ...s, dayLabel: WEEKDAYS[weekdayOf(s.date)], timeLabel: `${formatTime12(s.startTime)} – ${formatTime12(s.endTime)}` };
}

/** Sessions in a date range. Parents get logistics only (no coach roles or polls). */
sessionRoutes.get("/intramurals/:id/sessions", async (req, res) => {
  const user = me(req);
  const id = Number(req.params.id);
  await requireSee(user, id);
  await ensureUpcomingSessions(id);
  const from = isDate(String(req.query.from ?? "")) ? String(req.query.from) : addDays(today(), -28);
  const to = isDate(String(req.query.to ?? "")) ? String(req.query.to) : addDays(today(), 60);
  const rows = await query(
    `SELECT ${SESSION_FIELDS},
       (SELECT count(*) FROM availability v WHERE v.session_id = s.id) AS "pollAnswers",
       (SELECT option_id FROM availability v WHERE v.session_id = s.id AND v.user_id = $4) AS "myAnswer"
       FROM sessions s WHERE s.intramural_id = $1 AND s.date BETWEEN $2 AND $3 ORDER BY s.date, s.start_time`,
    [id, from, to, user.id],
  );
  res.json(rows.map((r) => decorate(user.role === "parent" ? { ...r, roles: undefined, pollAnswers: undefined, myAnswer: undefined } : r)));
});

/** Upcoming sessions across every intramural the person can see (home screen, parent schedule). */
sessionRoutes.get("/sessions/upcoming", async (req, res) => {
  const user = me(req);
  const ids = user.isSuperAdmin ? null : user.role === "parent" ? user.childIntramurals : user.intramurals;
  const visible: number[] = [];
  for (const id of ids ?? (await query<{ id: number }>(`SELECT id FROM intramurals WHERE NOT archived`)).map((r) => r.id)) {
    try { await requireSee(user, id); visible.push(id); } catch { /* other country */ }
  }
  for (const id of visible) await ensureUpcomingSessions(id);
  const rows = await query(
    `SELECT ${SESSION_FIELDS}, i.name AS "intramuralName", i.color, i.short_code AS "shortCode"
       FROM sessions s JOIN intramurals i ON i.id = s.intramural_id
      WHERE s.intramural_id = ANY($1) AND s.date BETWEEN current_date - 1 AND current_date + 35
      ORDER BY s.date, s.start_time LIMIT 40`,
    [visible],
  );
  res.json(rows.map((r) => decorate(user.role === "parent" ? { ...r, roles: undefined } : r)));
});

sessionRoutes.get("/sessions/:id", async (req, res) => {
  const user = me(req);
  const s = await one(`SELECT ${SESSION_FIELDS} FROM sessions s WHERE s.id = $1`, [Number(req.params.id)]);
  if (!s) throw new HttpError(404, "That session does not exist");
  const ref = await requireSee(user, s.intramuralId);
  if (user.role === "parent") {
    res.json(decorate({ ...s, roles: undefined }));
    return;
  }
  const ids = (s.roles as { userId: number | null }[]).map((r) => r.userId).filter(Boolean);
  const names = new Map((await query(`SELECT id, name FROM users WHERE id = ANY($1)`, [ids])).map((u) => [u.id, u.name]));
  const poll = await query(
    `SELECT v.user_id AS "userId", u.name, v.option_id AS "optionId", v.updated_at AS "updatedAt"
       FROM availability v JOIN users u ON u.id = v.user_id WHERE v.session_id = $1 ORDER BY u.name`,
    [s.id],
  );
  const coaches = await query(
    `SELECT u.id, u.name FROM user_intramurals ui JOIN users u ON u.id = ui.user_id WHERE ui.intramural_id = $1 AND u.status = 'active' ORDER BY u.name`,
    [s.intramuralId],
  );
  res.json(
    decorate({
      ...s,
      roles: (s.roles as { role: string; userId: number | null }[]).map((r) => ({ ...r, name: r.userId ? names.get(r.userId) ?? "" : "" })),
      poll,
      coaches,
      myAnswer: poll.find((p) => p.userId === user.id)?.optionId ?? null,
      canEdit: can(user, "schedules.edit", ref),
      canAssignRoles: can(user, "roles.assign", ref),
    }),
  );
});

const timeString = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a time like 15:15");

const sessionInput = z.object({
  date: z.string().refine(isDate, "Pick a date"),
  kind: z.enum(["training", "match", "tournament", "camp", "clinic"]),
  endDate: z.string().refine(isDate, "Pick an end date").nullable().optional(),
  title: z.string().max(120).default(""),
  startTime: timeString,
  endTime: timeString,
  location: z.string().max(200).default(""),
  dressCode: z.string().max(300).default(""),
  opponent: z.string().max(120).default(""),
  travelNotes: z.string().max(1000).default(""),
  schedule: z.array(z.object({ time: timeString, activity: z.string().trim().min(1).max(200) })).max(40).default([]),
});

/** Add a match, tournament or extra training (matchday logistics). */
sessionRoutes.post("/intramurals/:id/sessions", async (req, res) => {
  const user = me(req);
  const id = Number(req.params.id);
  await requirePermission(user, "schedules.edit", id);
  const s = sessionInput.parse(req.body);
  if (s.endTime <= s.startTime) throw new HttpError(400, "The session must end after it starts");
  const defaults = await one(`SELECT default_roles AS roles FROM intramurals WHERE id = $1`, [id]);
  const row = await one(
    `INSERT INTO sessions (intramural_id, date, kind, title, start_time, end_time, location, dress_code, opponent, travel_notes, schedule, roles, updated_by, version, end_date)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,2,$14) RETURNING id`,
    [id, s.date, s.kind, s.title, s.startTime, s.endTime, s.location, s.dressCode, s.opponent, s.travelNotes,
     JSON.stringify(s.schedule), JSON.stringify((defaults.roles as string[]).map((role) => ({ role, userId: null }))), user.id,
     s.endDate && s.endDate >= s.date ? s.endDate : null],
  ).catch((err) => {
    if (err.code === "23505") throw new HttpError(409, "There is already a training on that day. Edit it instead.");
    throw err;
  });
  if (s.kind !== "training") {
    const label = s.kind === "match" ? `Match${s.opponent ? ` vs ${s.opponent}` : ""}`
      : s.title || (s.kind === "camp" ? "Camp" : s.kind === "clinic" ? "Clinic" : "Tournament");
    await notify(await parentsInIntramural(id), {
      kind: "schedule",
      title: `${label} on ${WEEKDAYS[weekdayOf(s.date)]} ${s.date}${s.endDate && s.endDate > s.date ? ` to ${s.endDate}` : ""}`,
      body: [`${formatTime12(s.startTime)} – ${formatTime12(s.endTime)}`, s.location, s.dressCode && `Kit: ${s.dressCode}`, s.travelNotes]
        .filter(Boolean).join("\n"),
      link: "/schedule",
    });
  }
  res.status(201).json(row);
});

const updateInput = sessionInput.partial().extend({
  version: z.number().int(),
  cancelled: z.boolean().optional(),
  roles: z.array(z.object({ role: z.string().min(1).max(60), userId: z.number().int().nullable() })).max(20).optional(),
});

/**
 * Edit one session. `version` must match: if someone else saved first, the
 * change is refused (409) and the latest copy is returned, so nothing is lost silently.
 */
sessionRoutes.patch("/sessions/:id", async (req, res) => {
  const user = me(req);
  const id = Number(req.params.id);
  const current = await one(`SELECT ${SESSION_FIELDS} FROM sessions s WHERE s.id = $1`, [id]);
  if (!current) throw new HttpError(404, "That session does not exist");
  const input = updateInput.parse(req.body);
  const { version, roles, ...rest } = input;
  const touchesSchedule = Object.keys(rest).length > 0;
  if (touchesSchedule) await requirePermission(user, "schedules.edit", current.intramuralId);
  if (roles) await requirePermission(user, "roles.assign", current.intramuralId);
  if (!touchesSchedule && !roles) await requireSee(user, current.intramuralId);
  if (roles) {
    const assigned = new Set(
      (await query<{ id: number }>(`SELECT user_id AS id FROM user_intramurals WHERE intramural_id = $1`, [current.intramuralId])).map((r) => r.id),
    );
    for (const r of roles) if (r.userId && !assigned.has(r.userId)) throw new HttpError(400, "Only coaches of this intramural can take a role");
  }
  const start = rest.startTime ?? hhmm(current.startTime);
  const end = rest.endTime ?? hhmm(current.endTime);
  if (end <= start) throw new HttpError(400, "The session must end after it starts");

  const cols: Record<string, unknown> = {
    date: rest.date, kind: rest.kind, title: rest.title, end_date: rest.endDate, start_time: rest.startTime, end_time: rest.endTime, location: rest.location,
    dress_code: rest.dressCode, opponent: rest.opponent, travel_notes: rest.travelNotes, cancelled: rest.cancelled,
    schedule: rest.schedule && JSON.stringify([...rest.schedule].sort((a, b) => a.time.localeCompare(b.time))),
    roles: roles && JSON.stringify(roles),
  };
  const set = Object.entries(cols).filter(([, v]) => v !== undefined);
  const updated = await one(
    `UPDATE sessions SET ${set.map(([k], n) => `${k} = $${n + 3}`).join(", ")}${set.length ? "," : ""}
            version = version + 1, updated_by = $${set.length + 3}, updated_at = now()
      WHERE id = $1 AND version = $2 RETURNING id`,
    [id, version, ...set.map(([, v]) => v), user.id],
  );
  if (!updated) {
    const latest = await one(`SELECT ${SESSION_FIELDS} FROM sessions s WHERE s.id = $1`, [id]);
    throw new HttpError(409, "Someone else changed this session just now. Here is the latest version.", { latest: decorate(latest) });
  }
  // Tell parents when logistics change for an upcoming session.
  const logisticsChanged = ["date", "startTime", "endTime", "location", "dressCode", "cancelled", "travelNotes"].some((k) => k in rest);
  if (logisticsChanged && current.date >= today()) {
    const s = await one(`SELECT ${SESSION_FIELDS} FROM sessions s WHERE s.id = $1`, [id]);
    await notify(await parentsInIntramural(current.intramuralId), {
      kind: "schedule",
      urgent: Boolean(rest.cancelled),
      title: rest.cancelled ? `${WEEKDAYS[weekdayOf(s.date)]} session on ${s.date} is cancelled` : `${WEEKDAYS[weekdayOf(s.date)]} session on ${s.date} was updated`,
      body: rest.cancelled ? "" : [`${formatTime12(s.startTime)} – ${formatTime12(s.endTime)}`, s.location, s.dressCode && `Kit: ${s.dressCode}`].filter(Boolean).join("\n"),
      link: "/schedule",
    });
  }
  res.json({ ok: true });
});

sessionRoutes.delete("/sessions/:id", async (req, res) => {
  const user = me(req);
  const s = await one(`SELECT intramural_id AS "intramuralId", kind FROM sessions WHERE id = $1`, [Number(req.params.id)]);
  if (!s) throw new HttpError(404, "That session does not exist");
  await requirePermission(user, "schedules.edit", s.intramuralId);
  if (s.kind === "training") throw new HttpError(400, "Regular sessions are cancelled, not deleted");
  await query(`DELETE FROM sessions WHERE id = $1`, [Number(req.params.id)]);
  res.json({ ok: true });
});

sessionRoutes.put("/sessions/:id/availability", async (req, res) => {
  res.json(await answerAvailability(me(req), availabilityInput.parse({ ...req.body, sessionId: Number(req.params.id) })));
});

export { intramuralRef };
