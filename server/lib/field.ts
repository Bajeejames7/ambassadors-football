import { z } from "zod";
import { HttpError, type Me, requirePermission, requireStaff, requireSee, intramuralRef } from "../auth.js";
import { one, query, transaction } from "../db.js";
import { titleCaseName, normalizePhone, normalizeEmail, isDate } from "../util.js";
import { notify, parentsOf } from "./notify.js";

/**
 * Field actions coaches take on the pitch. Each can arrive live (REST) or late
 * from the phone's offline queue (POST /api/sync). Both paths call these same
 * functions, so the same permission checks apply, and every action is safe to
 * receive twice: it carries the phone's own id (clientId), or simply sets a
 * value where the newest write wins.
 */

const clientId = z.string().min(8).max(64).optional();
const isoTime = z.string().datetime({ offset: true }).optional();

async function sessionIntramural(sessionId: number): Promise<number> {
  const row = await one<{ intramuralId: number }>(`SELECT intramural_id AS "intramuralId" FROM sessions WHERE id = $1`, [sessionId]);
  if (!row) throw new HttpError(404, "That session does not exist");
  return row.intramuralId;
}

// ---- attendance ---------------------------------------------------------------------

export const attendanceInput = z.object({
  sessionId: z.number().int(),
  entries: z
    .array(
      z.object({
        playerId: z.number().int(),
        status: z.enum(["present", "late", "absent", "excused"]),
        recordedAt: isoTime, // when the coach tapped it; the newest tap wins
      }),
    )
    .min(1)
    .max(500),
});

export async function recordAttendance(me: Me, input: z.infer<typeof attendanceInput>) {
  requireStaff(me);
  const intramuralId = await sessionIntramural(input.sessionId);
  await requirePermission(me, "attendance.take", intramuralId);
  const playerIds = input.entries.map((e) => e.playerId);
  const valid = await query<{ id: number }>(`SELECT id FROM players WHERE id = ANY($1) AND intramural_id = $2`, [playerIds, intramuralId]);
  const ok = new Set(valid.map((v) => v.id));
  let saved = 0;
  for (const e of input.entries) {
    if (!ok.has(e.playerId)) continue;
    const at = e.recordedAt ?? new Date().toISOString();
    const res = await query(
      `INSERT INTO attendance (session_id, player_id, status, checked_in_at, recorded_by, recorded_at)
       VALUES ($1, $2, $3, CASE WHEN $3 IN ('present','late') THEN $5::timestamptz END, $4, $5)
       ON CONFLICT (session_id, player_id) DO UPDATE
         SET status = EXCLUDED.status,
             checked_in_at = coalesce(attendance.checked_in_at, EXCLUDED.checked_in_at),
             recorded_by = EXCLUDED.recorded_by, recorded_at = EXCLUDED.recorded_at
       WHERE attendance.recorded_at <= EXCLUDED.recorded_at
       RETURNING 1`,
      [input.sessionId, e.playerId, e.status, me.id, at],
    );
    saved += res.length;
  }
  return { saved, skipped: input.entries.length - saved };
}

// ---- registering a player (including walk-ins) -------------------------------------------

export const playerInput = z.object({
  intramuralId: z.number().int(),
  clientId,
  firstName: z.string().trim().min(1, "Enter the player's first name").max(60),
  lastName: z.string().trim().max(60).default(""),
  dateOfBirth: z.string().refine(isDate, "Date of birth must be YYYY-MM-DD").nullable().optional(),
  category: z.string().max(40).default(""),
  team: z.string().max(40).default(""),
  guardianName: z.string().max(100).default(""),
  guardianEmail: z.string().max(200).default(""),
  guardianPhone: z.string().max(30).default(""),
  medicalNotes: z.string().max(1000).default(""),
  walkIn: z.boolean().default(false),
  /** Walk-ins registered on the pitch are usually checked in at the same time (even offline). */
  checkIn: z.object({ sessionId: z.number().int(), status: z.enum(["present", "late"]), recordedAt: isoTime }).optional(),
});

export async function registerPlayer(me: Me, input: z.infer<typeof playerInput>) {
  requireStaff(me);
  await requirePermission(me, "players.register", input.intramuralId);
  if (input.clientId) {
    const existing = await one(`SELECT id FROM players WHERE client_id = $1`, [input.clientId]);
    if (existing) return { id: existing.id as number, duplicate: true };
  }
  const country = await one<{ prefix: string }>(
    `SELECT c.phone_prefix AS prefix FROM intramurals i JOIN countries c ON c.id = i.country_id WHERE i.id = $1`,
    [input.intramuralId],
  );
  const phone = input.guardianPhone ? normalizePhone(input.guardianPhone, country?.prefix) : null;
  if (input.guardianPhone && !phone) throw new HttpError(400, "The parent's phone number does not look right");
  const email = input.guardianEmail ? normalizeEmail(input.guardianEmail) : "";
  if (email && !z.email().safeParse(email).success) throw new HttpError(400, "The parent's email does not look right");

  const firstName = titleCaseName(input.firstName);
  const lastName = titleCaseName(input.lastName);
  const dupe = await one(
    `SELECT id FROM players WHERE intramural_id = $1 AND lower(first_name) = lower($2) AND lower(last_name) = lower($3)
        AND coalesce(date_of_birth, '1900-01-01') = coalesce($4::date, '1900-01-01')`,
    [input.intramuralId, firstName, lastName, input.dateOfBirth ?? null],
  );
  if (dupe) {
    throw new HttpError(409, `${firstName} ${lastName} is already registered here`.trim(), { playerId: dupe.id });
  }

  const row = await transaction(async (c) => {
    const created = (
      await c.query(
        `INSERT INTO players (intramural_id, first_name, last_name, date_of_birth, category, team, guardian_name,
                              guardian_email, guardian_phone, medical_notes, source, client_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [input.intramuralId, firstName, lastName, input.dateOfBirth ?? null, input.category, input.team,
         titleCaseName(input.guardianName), email, phone ?? "", input.medicalNotes, input.walkIn ? "walk_in" : "app",
         input.clientId ?? null, me.id],
      )
    ).rows[0];
    // Link any parent account already registered with this email/phone (still needs approval).
    if (email || phone) {
      await c.query(
        `INSERT INTO parent_children (parent_id, player_id)
         SELECT id, $1 FROM users WHERE role = 'parent' AND (lower(email) = $2 OR phone = $3)
         ON CONFLICT DO NOTHING`,
        [created.id, email || null, phone ?? null],
      );
    }
    // Walk-ins are copied to the intramural's Airtable base when it is set up to receive them.
    if (input.walkIn) {
      await c.query(
        `INSERT INTO airtable_outbox (player_id)
         SELECT $1 FROM airtable_configs WHERE intramural_id = $2 AND push_walk_ins AND base_id <> '' AND table_name <> ''`,
        [created.id, input.intramuralId],
      );
    }
    return created;
  });
  if (input.checkIn) {
    await recordAttendance(me, { sessionId: input.checkIn.sessionId, entries: [{ playerId: row.id, status: input.checkIn.status, recordedAt: input.checkIn.recordedAt }] });
  }
  return { id: row.id as number, duplicate: false };
}

// ---- tally ---------------------------------------------------------------------------------

export const tallyInput = z.object({
  intramuralId: z.number().int(),
  sessionId: z.number().int().nullable().optional(),
  clientId,
  kind: z.enum(["match", "sportsmanship", "virtue_points"]),
  team: z.string().max(60).default(""),
  opponent: z.string().max(60).default(""),
  points: z.number().int().min(-50).max(50).default(0),
  opponentPoints: z.number().int().min(0).max(50).default(0),
  category: z.string().max(40).default(""),
  note: z.string().max(500).default(""),
});

export async function addTally(me: Me, input: z.infer<typeof tallyInput>) {
  requireStaff(me);
  await requirePermission(me, "tally.write", input.intramuralId);
  if (input.sessionId && (await sessionIntramural(input.sessionId)) !== input.intramuralId) throw new HttpError(400, "That session is not in this intramural");
  const row = await one(
    `INSERT INTO tally_events (intramural_id, session_id, kind, team, opponent, points, opponent_points, category, note, recorded_by, client_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (client_id) DO NOTHING RETURNING id`,
    [input.intramuralId, input.sessionId ?? null, input.kind, input.team, input.opponent, input.points, input.opponentPoints,
     input.category, input.note, me.id, input.clientId ?? null],
  );
  return { id: row?.id ?? null, duplicate: !row };
}

// ---- equipment ---------------------------------------------------------------------------------

export const equipmentInput = z.object({
  sessionId: z.number().int(),
  phase: z.enum(["before", "after"]),
  clientId,
  notes: z.string().max(1000).default(""),
  items: z
    .array(
      z.object({
        itemId: z.number().int(),
        counted: z.number().int().min(0).max(10000),
        condition: z.enum(["good", "damaged", "missing"]).default("good"),
      }),
    )
    .max(200),
});

export async function saveEquipmentCheck(me: Me, input: z.infer<typeof equipmentInput>) {
  requireStaff(me);
  const intramuralId = await sessionIntramural(input.sessionId);
  await requirePermission(me, "equipment.check", intramuralId);
  const known = await query<{ id: number; name: string; expected: number }>(
    `SELECT id, name, expected FROM equipment_items WHERE intramural_id = $1`,
    [intramuralId],
  );
  const byId = new Map(known.map((k) => [k.id, k]));
  const items = input.items
    .filter((i) => byId.has(i.itemId))
    .map((i) => ({ ...i, name: byId.get(i.itemId)!.name, expected: byId.get(i.itemId)!.expected }));
  await query(
    `INSERT INTO equipment_checks (session_id, phase, items, notes, recorded_by, client_id)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (session_id, phase) DO UPDATE SET items = EXCLUDED.items, notes = EXCLUDED.notes,
       recorded_by = EXCLUDED.recorded_by, created_at = now()`,
    [input.sessionId, input.phase, JSON.stringify(items), input.notes, me.id, input.clientId ?? null],
  );
  return { saved: items.length };
}

// ---- mentorship ------------------------------------------------------------------------------------

export const mentorshipInput = z.object({
  intramuralId: z.number().int(),
  sessionId: z.number().int().nullable().optional(),
  playerId: z.number().int().nullable().optional(),
  clientId,
  discussionNotes: z.string().max(5000).default(""),
  scripture: z.string().max(300).default(""),
  scriptureMilestone: z.string().max(300).default(""),
  prayerPoints: z.string().max(3000).default(""),
  welfareObservation: z.string().max(3000).default(""),
});

export async function addMentorshipLog(me: Me, input: z.infer<typeof mentorshipInput>) {
  requireStaff(me);
  await requirePermission(me, "mentorship.write", input.intramuralId);
  if (input.playerId) {
    const p = await one(`SELECT intramural_id FROM players WHERE id = $1`, [input.playerId]);
    if (!p || p.intramural_id !== input.intramuralId) throw new HttpError(400, "That player is not in this intramural");
  }
  if (!input.discussionNotes && !input.prayerPoints && !input.welfareObservation && !input.scripture) {
    throw new HttpError(400, "Write at least one note");
  }
  const row = await one(
    `INSERT INTO mentorship_logs (intramural_id, session_id, player_id, coach_id, discussion_notes, scripture,
                                  scripture_milestone, prayer_points, welfare_observation, client_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (client_id) DO NOTHING RETURNING id`,
    [input.intramuralId, input.sessionId ?? null, input.playerId ?? null, me.id, input.discussionNotes, input.scripture,
     input.scriptureMilestone, input.prayerPoints, input.welfareObservation, input.clientId ?? null],
  );
  return { id: row?.id ?? null, duplicate: !row };
}

// ---- injuries --------------------------------------------------------------------------------------

export const injuryInput = z.object({
  playerId: z.number().int(),
  sessionId: z.number().int().nullable().optional(),
  clientId,
  severity: z.enum(["knock", "minor", "moderate", "serious"]),
  bodyPart: z.string().max(60).default(""),
  description: z.string().trim().min(3, "Describe what happened").max(2000),
  actionTaken: z.string().max(2000).default(""),
});

export async function reportInjury(me: Me, input: z.infer<typeof injuryInput>) {
  requireStaff(me);
  const player = await one(`SELECT intramural_id AS "intramuralId", first_name AS "firstName" FROM players WHERE id = $1`, [input.playerId]);
  if (!player) throw new HttpError(404, "That player does not exist");
  await requirePermission(me, "injuries.report", player.intramuralId);
  const row = await one(
    `INSERT INTO injuries (player_id, session_id, severity, body_part, description, action_taken, reported_by, client_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (client_id) DO NOTHING RETURNING id`,
    [input.playerId, input.sessionId ?? null, input.severity, input.bodyPart, input.description, input.actionTaken, me.id, input.clientId ?? null],
  );
  if (row) {
    const what = input.severity === "knock" ? "a knock" : `a ${input.severity} injury`;
    await notify(await parentsOf(input.playerId), {
      kind: "injury",
      urgent: input.severity === "moderate" || input.severity === "serious",
      title: `${player.firstName} picked up ${what}${input.bodyPart ? ` (${input.bodyPart})` : ""}`,
      body: [input.description, input.actionTaken && `Action taken: ${input.actionTaken}`].filter(Boolean).join("\n"),
      link: `/child/${input.playerId}`,
    });
  }
  return { id: row?.id ?? null, duplicate: !row };
}

// ---- availability poll ----------------------------------------------------------------------------

export const availabilityInput = z.object({ sessionId: z.number().int(), optionId: z.string().min(1).max(40) });

export async function answerAvailability(me: Me, input: z.infer<typeof availabilityInput>) {
  requireStaff(me);
  const s = await one(
    `SELECT s.intramural_id AS "intramuralId", i.availability_options AS options FROM sessions s
       JOIN intramurals i ON i.id = s.intramural_id WHERE s.id = $1`,
    [input.sessionId],
  );
  if (!s) throw new HttpError(404, "That session does not exist");
  await requirePermission(me, "availability.answer", s.intramuralId);
  if (!(s.options as { id: string }[]).some((o) => o.id === input.optionId)) throw new HttpError(400, "Pick one of the options");
  await query(
    `INSERT INTO availability (session_id, user_id, option_id) VALUES ($1,$2,$3)
     ON CONFLICT (session_id, user_id) DO UPDATE SET option_id = EXCLUDED.option_id, updated_at = now()`,
    [input.sessionId, me.id, input.optionId],
  );
  return { ok: true };
}

/** Used by routes that only need to confirm a person can see an intramural. */
export { requireSee, intramuralRef };
