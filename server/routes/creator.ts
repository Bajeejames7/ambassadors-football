import { Router } from "express";
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { ADMIN_PERMISSIONS, COUNTRY_OVERRIDE, HttpError, audit, isCreatorEmail, me, requireAllowed, requireSuperAdmin, type Restriction } from "../auth.js";
import { one, query, transaction } from "../db.js";
import { AGE_GROUPS, normalizeEmail, normalizePhone, titleCaseName } from "../util.js";
import { notify } from "../lib/notify.js";

/**
 * Creator Control: Admins and Super Admins (equal powers). Every route checks
 * requireSuperAdmin, which passes any active admin; coaches and parents get 403.
 * Two areas: Staff & Coaches (/creator/users) and Parents (/creator/parents).
 */
export const creatorRoutes = Router();

/** Which Privilege Control switch guards each area of Creator Control. */
function areaOf(path: string): Restriction | null {
  if (path.startsWith("/users")) return "coaches.manage";
  if (/^\/parents\/\d+\/preview/.test(path)) return "parents.preview";
  if (path.startsWith("/parents") || path.startsWith("/players")) return "parents.manage";
  if (path.startsWith("/countries") || path.startsWith("/intramurals")) return "intramurals.edit";
  return null;
}

creatorRoutes.use("/creator", (req, _res, next) => {
  const user = me(req);
  requireSuperAdmin(user);
  const area = areaOf(req.path);
  if (area) requireAllowed(user, area);
  next();
});

/** Only the real Super Admin hands out, changes or removes Admin and Super Admin accounts. */
function guardAdminAccounts(actor: ReturnType<typeof me>, roles: (string | undefined | null)[]): void {
  if (actor.isRealSuperAdmin) return;
  if (roles.some((r) => r === "admin" || r === "super_admin")) {
    throw new HttpError(403, "Only the Super Admin can add, change or remove Admin and Super Admin accounts");
  }
}

creatorRoutes.get("/creator/users", async (req, res) => {
  const countryId = req.query.countryId ? Number(req.query.countryId) : null;
  const users = await query(
    `SELECT u.id, u.email, u.phone, u.name, u.role, u.status, u.country_id AS "countryId", c.name AS country, u.created_at AS "createdAt",
            coalesce((SELECT array_agg(intramural_id ORDER BY intramural_id) FROM user_intramurals WHERE user_id = u.id), '{}') AS intramurals,
            coalesce((SELECT json_agg(json_build_object('intramuralId', ui.intramural_id, 'ageGroups', ui.age_groups) ORDER BY ui.intramural_id)
                        FROM user_intramurals ui WHERE ui.user_id = u.id), '[]') AS assignments,
            coalesce((SELECT json_agg(json_build_object('permission', permission, 'intramuralId', intramural_id, 'expiresAt', expires_at))
                        FROM user_permissions WHERE user_id = u.id AND (expires_at IS NULL OR expires_at > now())), '[]') AS grants,
            coalesce((SELECT array_agg(player_id) FROM parent_children WHERE parent_id = u.id AND verified_at IS NOT NULL), '{}') AS children
       FROM users u LEFT JOIN countries c ON c.id = u.country_id
      WHERE ($1::int IS NULL OR u.country_id = $1)
        AND ($2::text IS NULL OR ($2 = 'parents') = (u.role = 'parent'))
      ORDER BY CASE u.role WHEN 'super_admin' THEN 0 WHEN 'admin' THEN 1 WHEN 'coach' THEN 2 ELSE 3 END, u.name`,
    [countryId, req.query.kind === "staff" || req.query.kind === "parents" ? String(req.query.kind) : null],
  );
  res.json(users.map((u) => ({ ...u, isCreator: isCreatorEmail(u.email) })));
});

const createInput = z.object({
  name: z.string().trim().min(2).max(100),
  email: z.email(),
  phone: z.string().trim().max(30).default(""),
  role: z.enum(["super_admin", "admin", "coach", "parent"]),
  countryId: z.number().int(),
  /** Optional temporary password chosen by the admin (else one is generated). */
  password: z.string().min(8, "Temporary passwords need at least 8 characters").max(100).optional(),
});

/** Create an account with a temporary password (shown once) the person must change. */
creatorRoutes.post("/creator/users", async (req, res) => {
  const actor = me(req);
  const input = createInput.parse(req.body);
  guardAdminAccounts(actor, [input.role]);
  const country = await one(`SELECT phone_prefix AS prefix FROM countries WHERE id = $1`, [input.countryId]);
  if (!country) throw new HttpError(400, "Choose a country");
  const phone = input.phone ? normalizePhone(input.phone, country.prefix) : null;
  if (input.phone && !phone) throw new HttpError(400, "That phone number does not look right");
  const temporary = input.password ?? randomBytes(6).toString("base64url");
  const row = await one(
    `INSERT INTO users (email, phone, name, password_hash, role, status, country_id, must_change_password)
     VALUES ($1,$2,$3,$4,$5,'active',$6,true) RETURNING id`,
    [normalizeEmail(input.email), phone, titleCaseName(input.name), await bcrypt.hash(temporary, 10), input.role, input.countryId],
  ).catch((err) => {
    if (err.code === "23505") throw new HttpError(409, "An account with this email or phone already exists");
    throw err;
  });
  await audit(actor.id, "user_created", { userId: row.id, role: input.role });
  res.status(201).json({ id: row.id, temporaryPassword: temporary });
});

const updateInput = z.object({
  role: z.enum(["super_admin", "admin", "coach", "parent"]).optional(),
  status: z.enum(["pending", "active", "suspended"]).optional(),
  countryId: z.number().int().optional(),
});

/** Promote / demote, suspend, or move someone to another country. */
creatorRoutes.patch("/creator/users/:id", async (req, res) => {
  const actor = me(req);
  const id = Number(req.params.id);
  const input = updateInput.parse(req.body);
  const target = await one(`SELECT id, email, role FROM users WHERE id = $1`, [id]);
  if (!target) throw new HttpError(404, "That person does not exist");
  guardAdminAccounts(actor, [target.role, input.role]);
  if (isCreatorEmail(target.email) && (input.role || input.status)) throw new HttpError(400, "The creator's role is set by CREATOR_EMAIL and cannot be changed here");
  if (id === actor.id && input.role && input.role !== "super_admin") throw new HttpError(400, "Ask another Super Admin to change your own role");
  await transaction(async (c) => {
    await c.query(
      `UPDATE users SET role = coalesce($2, role), status = coalesce($3, status), country_id = coalesce($4, country_id),
              token_version = CASE WHEN $2 IS DISTINCT FROM NULL AND $2 <> role THEN token_version + 1 ELSE token_version END
        WHERE id = $1`,
      [id, input.role ?? null, input.status ?? null, input.countryId ?? null],
    );
    // A brand-new admin starts with every admin permission ticked; untick as needed.
    if (input.role === "admin" && target.role !== "admin") {
      await c.query(
        `INSERT INTO user_permissions (user_id, permission, granted_by)
         SELECT $1, unnest($2::text[]), $3 ON CONFLICT DO NOTHING`,
        [id, [...ADMIN_PERMISSIONS], actor.id],
      );
    }
    // Leaving admin removes admin-level permissions; coaches keep only field privileges an admin re-grants.
    if (input.role && input.role !== "admin" && target.role === "admin") {
      await c.query(`DELETE FROM user_permissions WHERE user_id = $1 AND permission <> $2`, [id, COUNTRY_OVERRIDE]);
    }
  });
  await audit(actor.id, "user_updated", { userId: id, ...input });
  if (input.role && input.role !== target.role) {
    await notify([id], { kind: "privileges", title: `Your role is now ${input.role.replace("_", " ")}`, body: "Sign in again to see the change." });
  }
  res.json({ ok: true });
});

const permissionsInput = z.object({
  permissions: z.array(z.enum([...ADMIN_PERMISSIONS, COUNTRY_OVERRIDE])).max(20),
});

/** The per-admin checkboxes. Replaces this person's account-wide permissions. */
creatorRoutes.put("/creator/users/:id/permissions", async (req, res) => {
  const actor = me(req);
  const id = Number(req.params.id);
  const { permissions } = permissionsInput.parse(req.body);
  const target = await one(`SELECT role FROM users WHERE id = $1`, [id]);
  if (!target) throw new HttpError(404, "That person does not exist");
  guardAdminAccounts(actor, [target.role]);
  if (target.role === "parent") throw new HttpError(400, "Parents cannot hold staff permissions");
  await transaction(async (c) => {
    await c.query(`DELETE FROM user_permissions WHERE user_id = $1 AND intramural_id IS NULL`, [id]);
    if (permissions.length) {
      await c.query(
        `INSERT INTO user_permissions (user_id, permission, granted_by) SELECT $1, unnest($2::text[]), $3`,
        [id, permissions, actor.id],
      );
    }
  });
  await audit(actor.id, "permissions_set", { userId: id, permissions });
  res.json({ ok: true });
});

/** Assign someone to intramurals (any country: the Super Admin decides). */
creatorRoutes.put("/creator/users/:id/intramurals", async (req, res) => {
  const actor = me(req);
  const id = Number(req.params.id);
  const { intramuralIds } = z.object({ intramuralIds: z.array(z.number().int()).max(200) }).parse(req.body);
  await transaction(async (c) => {
    await c.query(`DELETE FROM user_intramurals WHERE user_id = $1`, [id]);
    if (intramuralIds.length) {
      await c.query(`INSERT INTO user_intramurals (user_id, intramural_id) SELECT $1, unnest($2::int[]) ON CONFLICT DO NOTHING`, [id, intramuralIds]);
    }
  });
  await audit(actor.id, "intramurals_set", { userId: id, intramuralIds });
  res.json({ ok: true });
});

creatorRoutes.delete("/creator/users/:id", async (req, res) => {
  const actor = me(req);
  const id = Number(req.params.id);
  const target = await one(`SELECT email, role FROM users WHERE id = $1`, [id]);
  if (!target) throw new HttpError(404, "That person does not exist");
  guardAdminAccounts(actor, [target.role]);
  if (isCreatorEmail(target.email) || id === actor.id) throw new HttpError(400, "You cannot remove this account");
  await query(`UPDATE payments SET phone = '', payer_id = NULL WHERE payer_id = $1`, [id]);
  await query(`DELETE FROM users WHERE id = $1`, [id]);
  await audit(actor.id, "user_deleted", { userId: id });
  res.json({ ok: true });
});

// ---- countries and intramurals ------------------------------------------------------------

const countryInput = z.object({
  code: z.string().length(2).transform((s) => s.toUpperCase()),
  name: z.string().trim().min(2).max(80),
  currency: z.string().length(3).transform((s) => s.toUpperCase()).default("USD"),
  timeZone: z.string().min(3).max(60).refine((tz) => {
    try { new Intl.DateTimeFormat("en", { timeZone: tz }); return true; } catch { return false; }
  }, "Unknown time zone"),
  phonePrefix: z.string().regex(/^\+\d{1,4}$/, "Phone prefix looks like +254"),
  mpesa: z.boolean().default(false),
  active: z.boolean().default(true),
});

creatorRoutes.get("/creator/countries", async (_req, res) => {
  res.json(await query(`SELECT id, code, name, currency, time_zone AS "timeZone", phone_prefix AS "phonePrefix", mpesa, active FROM countries ORDER BY name`));
});

creatorRoutes.post("/creator/countries", async (req, res) => {
  const c = countryInput.parse(req.body);
  const row = await one(
    `INSERT INTO countries (code, name, currency, time_zone, phone_prefix, mpesa, active) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [c.code, c.name, c.currency, c.timeZone, c.phonePrefix, c.mpesa, c.active],
  ).catch((err) => {
    if (err.code === "23505") throw new HttpError(409, "That country already exists");
    throw err;
  });
  await audit(me(req).id, "country_created", c);
  res.status(201).json(row);
});

creatorRoutes.patch("/creator/countries/:id", async (req, res) => {
  const c = countryInput.partial().parse(req.body);
  await query(
    `UPDATE countries SET name = coalesce($2, name), currency = coalesce($3, currency), time_zone = coalesce($4, time_zone),
            phone_prefix = coalesce($5, phone_prefix), mpesa = coalesce($6, mpesa), active = coalesce($7, active) WHERE id = $1`,
    [Number(req.params.id), c.name ?? null, c.currency ?? null, c.timeZone ?? null, c.phonePrefix ?? null, c.mpesa ?? null, c.active ?? null],
  );
  res.json({ ok: true });
});

const intramuralInput = z.object({
  countryId: z.number().int(),
  name: z.string().trim().min(2).max(80),
  shortCode: z.string().trim().min(1).max(6),
  kind: z.enum(["intramural", "club"]).default("intramural"),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#2F5BD3"),
  sessionWeekday: z.number().int().min(0).max(6).default(2),
});

creatorRoutes.post("/creator/intramurals", async (req, res) => {
  const input = intramuralInput.parse(req.body);
  const slug = input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") + "-" + randomBytes(2).toString("hex");
  const row = await one(
    `INSERT INTO intramurals (country_id, slug, name, short_code, kind, color, session_weekday, position)
     VALUES ($1,$2,$3,$4,$5,$6,$7,(SELECT coalesce(max(position),0)+1 FROM intramurals)) RETURNING id`,
    [input.countryId, slug, input.name, input.shortCode.toUpperCase(), input.kind, input.color, input.sessionWeekday],
  );
  await query(`INSERT INTO airtable_configs (intramural_id) VALUES ($1)`, [row.id]);
  await query(
    `INSERT INTO equipment_items (intramural_id, name, expected)
     VALUES ($1,'Footballs',12),($1,'Cones',30),($1,'Bibs / Pinnies',24),($1,'First aid kit',1)`,
    [row.id],
  );
  await audit(me(req).id, "intramural_created", { id: row.id, ...input });
  res.status(201).json(row);
});

// ---- international impact metrics ----------------------------------------------------------

creatorRoutes.get("/creator/metrics", async (_req, res) => {
  const rows = await query(
    `SELECT c.id, c.code, c.name, c.currency,
       (SELECT count(*) FROM intramurals i WHERE i.country_id = c.id AND NOT i.archived) AS intramurals,
       (SELECT count(*) FROM players p JOIN intramurals i ON i.id = p.intramural_id WHERE i.country_id = c.id AND p.active) AS players,
       (SELECT count(*) FROM users u WHERE u.country_id = c.id AND u.role IN ('coach','admin') AND u.status = 'active') AS coaches,
       (SELECT count(*) FROM users u WHERE u.country_id = c.id AND u.role = 'parent' AND u.status = 'active') AS parents,
       (SELECT count(DISTINCT a.session_id) FROM attendance a JOIN sessions s ON s.id = a.session_id
          JOIN intramurals i ON i.id = s.intramural_id WHERE i.country_id = c.id AND s.date >= current_date - 30) AS "sessions30d",
       (SELECT round(100.0 * count(*) FILTER (WHERE a.status IN ('present','late')) / nullif(count(*),0))
          FROM attendance a JOIN sessions s ON s.id = a.session_id JOIN intramurals i ON i.id = s.intramural_id
         WHERE i.country_id = c.id AND s.date >= current_date - 90) AS "attendanceRate90d",
       (SELECT round(avg(v.score)::numeric, 1) FROM virtue_scores v JOIN players p ON p.id = v.player_id
          JOIN intramurals i ON i.id = p.intramural_id WHERE i.country_id = c.id) AS "virtueAverage",
       (SELECT count(*) FROM mentorship_logs m JOIN intramurals i ON i.id = m.intramural_id WHERE i.country_id = c.id) AS "mentorshipLogs",
       (SELECT coalesce(sum(pay.amount),0) FROM payments pay JOIN players p ON p.id = pay.player_id
          JOIN intramurals i ON i.id = p.intramural_id WHERE i.country_id = c.id AND pay.status = 'completed') AS collected
     FROM countries c ORDER BY c.name`,
  );
  res.json(rows);
});

creatorRoutes.get("/creator/audit", async (_req, res) => {
  res.json(
    await query(
      `SELECT a.id, a.action, a.detail, a.created_at AS "createdAt", u.name AS actor
         FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id ORDER BY a.id DESC LIMIT 200`,
    ),
  );
});

// ---- temporary passwords ------------------------------------------------------------

/** Set a temporary password (typed by the admin, or generated). The person must change it at next sign-in. */
creatorRoutes.post("/creator/users/:id/password", async (req, res) => {
  const actor = me(req);
  const id = Number(req.params.id);
  const { password } = z.object({ password: z.string().min(8, "Temporary passwords need at least 8 characters").max(100).optional() }).parse(req.body ?? {});
  const target = await one(`SELECT email, role FROM users WHERE id = $1`, [id]);
  if (!target) throw new HttpError(404, "That person does not exist");
  if (id !== actor.id) guardAdminAccounts(actor, [target.role]);
  if (isCreatorEmail(target.email) && id !== actor.id) throw new HttpError(400, "Only the creator can change the creator's password");
  const temporary = password ?? randomBytes(6).toString("base64url");
  await query(
    `UPDATE users SET password_hash = $2, must_change_password = true, token_version = token_version + 1 WHERE id = $1`,
    [id, await bcrypt.hash(temporary, 10)],
  );
  await audit(actor.id, "temporary_password_set", { userId: id });
  res.json({ temporaryPassword: temporary });
});

// ---- coach assignments (coaches rotate between schools, clubs and age groups) ---------

const assignmentsInput = z.object({
  assignments: z
    .array(z.object({ intramuralId: z.number().int(), ageGroups: z.array(z.enum(AGE_GROUPS)).max(AGE_GROUPS.length).default([]) }))
    .max(200),
});

/** Replace where someone coaches: schools/clubs, each optionally limited to age groups. */
creatorRoutes.put("/creator/users/:id/assignments", async (req, res) => {
  const actor = me(req);
  const id = Number(req.params.id);
  const { assignments } = assignmentsInput.parse(req.body);
  const target = await one(`SELECT role FROM users WHERE id = $1`, [id]);
  if (!target) throw new HttpError(404, "That person does not exist");
  guardAdminAccounts(actor, [target.role]);
  if (target.role === "parent") throw new HttpError(400, "Parents are linked to children, not assigned to schools");
  await transaction(async (c) => {
    await c.query(`DELETE FROM user_intramurals WHERE user_id = $1`, [id]);
    for (const a of assignments) {
      await c.query(`INSERT INTO user_intramurals (user_id, intramural_id, age_groups) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [id, a.intramuralId, a.ageGroups]);
    }
    // Field privileges for schools they no longer coach at go with the assignment.
    await c.query(
      `DELETE FROM user_permissions WHERE user_id = $1 AND intramural_id IS NOT NULL AND NOT (intramural_id = ANY($2::int[]))`,
      [id, assignments.map((a) => a.intramuralId)],
    );
  });
  await notify([id], { kind: "privileges", title: "Your coaching assignments changed", link: "/" });
  await audit(actor.id, "assignments_set", { userId: id, assignments });
  res.json({ ok: true });
});

// ---- Parents tab: parent accounts, managed by admins ----------------------------------

creatorRoutes.get("/creator/parents", async (_req, res) => {
  res.json(
    await query(
      `SELECT u.id, u.name, u.email, u.phone, u.status, u.country_id AS "countryId", u.created_at AS "createdAt",
              u.must_change_password AS "mustChangePassword",
              coalesce((SELECT json_agg(json_build_object('playerId', p.id, 'name', p.first_name || ' ' || p.last_name,
                         'category', p.category, 'intramuralName', i.name, 'verified', pc.verified_at IS NOT NULL) ORDER BY p.first_name)
                FROM parent_children pc JOIN players p ON p.id = pc.player_id JOIN intramurals i ON i.id = p.intramural_id
               WHERE pc.parent_id = u.id), '[]') AS children
         FROM users u WHERE u.role = 'parent' ORDER BY u.status = 'pending' DESC, u.name`,
    ),
  );
});

/** Players to link to a parent (search by child or guardian name). */
creatorRoutes.get("/creator/players", async (req, res) => {
  const q = String(req.query.q ?? "").trim().toLowerCase();
  res.json(
    await query(
      `SELECT p.id, p.first_name || ' ' || p.last_name AS name, p.category, p.guardian_name AS "guardianName",
              p.guardian_phone AS "guardianPhone", i.name AS "intramuralName"
         FROM players p JOIN intramurals i ON i.id = p.intramural_id
        WHERE p.active AND ($1 = '' OR lower(p.first_name || ' ' || p.last_name || ' ' || p.guardian_name) LIKE '%' || $1 || '%')
        ORDER BY i.position, p.first_name LIMIT 100`,
      [q],
    ),
  );
});

const parentInput = z.object({
  name: z.string().trim().min(2, "Enter the parent's full name").max(100),
  email: z.email("Enter a valid email"),
  phone: z.string().trim().min(6, "Enter the parent's phone").max(30),
  countryId: z.number().int().optional(),
  password: z.string().min(8, "Temporary passwords need at least 8 characters").max(100).optional(),
  playerIds: z.array(z.number().int()).max(20).default([]),
});

/** Create a ready-to-use parent account, already linked (and verified) to their children. */
creatorRoutes.post("/creator/parents", async (req, res) => {
  const actor = me(req);
  const input = parentInput.parse(req.body);
  const country = input.countryId
    ? await one(`SELECT id, phone_prefix AS prefix FROM countries WHERE id = $1`, [input.countryId])
    : await one(`SELECT id, phone_prefix AS prefix FROM countries WHERE code = 'KE'`);
  if (!country) throw new HttpError(400, "Choose a country");
  const phone = normalizePhone(input.phone, country.prefix);
  if (!phone) throw new HttpError(400, "That phone number does not look right");
  const temporary = input.password ?? randomBytes(6).toString("base64url");
  const parent = await transaction(async (c) => {
    const row = (
      await c
        .query(
          `INSERT INTO users (email, phone, name, password_hash, role, status, country_id, must_change_password)
           VALUES ($1,$2,$3,$4,'parent','active',$5,true) RETURNING id`,
          [normalizeEmail(input.email), phone, titleCaseName(input.name), await bcrypt.hash(temporary, 10), country.id],
        )
        .catch((err) => {
          if (err.code === "23505") throw new HttpError(409, err.constraint === "users_phone_uq" ? "An account with this phone number already exists" : "An account with this email already exists");
          throw err;
        })
    ).rows[0];
    for (const pid of input.playerIds) {
      await c.query(
        `INSERT INTO parent_children (parent_id, player_id, verified_by, verified_at) VALUES ($1,$2,$3,now()) ON CONFLICT DO NOTHING`,
        [row.id, pid, actor.id],
      );
    }
    return row;
  });
  await audit(actor.id, "parent_created", { parentId: parent.id, playerIds: input.playerIds });
  res.status(201).json({ id: parent.id, temporaryPassword: temporary });
});

creatorRoutes.patch("/creator/parents/:id", async (req, res) => {
  const actor = me(req);
  const id = Number(req.params.id);
  const input = z
    .object({ name: z.string().trim().min(2).max(100), email: z.email(), phone: z.string().trim().min(6).max(30), status: z.enum(["pending", "active", "suspended"]) })
    .partial()
    .parse(req.body);
  const parent = await one(`SELECT u.id, c.phone_prefix AS prefix FROM users u LEFT JOIN countries c ON c.id = u.country_id WHERE u.id = $1 AND u.role = 'parent'`, [id]);
  if (!parent) throw new HttpError(404, "That parent account does not exist");
  const phone = input.phone ? normalizePhone(input.phone, parent.prefix ?? "+254") : null;
  if (input.phone && !phone) throw new HttpError(400, "That phone number does not look right");
  await query(
    `UPDATE users SET name = coalesce($2, name), email = coalesce($3, email), phone = coalesce($4, phone), status = coalesce($5, status) WHERE id = $1`,
    [id, input.name ? titleCaseName(input.name) : null, input.email ? normalizeEmail(input.email) : null, phone, input.status ?? null],
  ).catch((err) => {
    if (err.code === "23505") throw new HttpError(409, "Another account already uses that email or phone");
    throw err;
  });
  await audit(actor.id, "parent_updated", { parentId: id, ...input });
  res.json({ ok: true });
});

/** Replace a parent's linked children (all verified). */
creatorRoutes.put("/creator/parents/:id/children", async (req, res) => {
  const actor = me(req);
  const id = Number(req.params.id);
  const { playerIds } = z.object({ playerIds: z.array(z.number().int()).max(20) }).parse(req.body);
  const parent = await one(`SELECT id FROM users WHERE id = $1 AND role = 'parent'`, [id]);
  if (!parent) throw new HttpError(404, "That parent account does not exist");
  await transaction(async (c) => {
    await c.query(`DELETE FROM parent_children WHERE parent_id = $1 AND NOT (player_id = ANY($2::int[]))`, [id, playerIds]);
    for (const pid of playerIds) {
      await c.query(
        `INSERT INTO parent_children (parent_id, player_id, verified_by, verified_at) VALUES ($1,$2,$3,now())
         ON CONFLICT (parent_id, player_id) DO UPDATE SET verified_at = coalesce(parent_children.verified_at, now()), verified_by = coalesce(parent_children.verified_by, $3)`,
        [id, pid, actor.id],
      );
    }
    if (playerIds.length) await c.query(`UPDATE users SET status = 'active' WHERE id = $1 AND status = 'pending'`, [id]);
  });
  await audit(actor.id, "parent_children_set", { parentId: id, playerIds });
  res.json({ ok: true });
});

/** What a parent sees on their home screen (for the admin's read-only preview). */
creatorRoutes.get("/creator/parents/:id/children", async (req, res) => {
  const id = Number(req.params.id);
  const parent = await one(`SELECT id, name FROM users WHERE id = $1 AND role = 'parent'`, [id]);
  if (!parent) throw new HttpError(404, "That parent account does not exist");
  const children = await query(
    `SELECT p.id, p.first_name AS "firstName", p.last_name AS "lastName", p.category, p.team,
            i.id AS "intramuralId", i.name AS "intramuralName", i.color, i.short_code AS "shortCode", i.logo,
            c.currency, c.mpesa, i.program_mode AS "programMode",
            coalesce((SELECT sum(amount) FROM fee_items f WHERE f.player_id = p.id), 0)
              - coalesce((SELECT sum(amount) FROM payments y WHERE y.player_id = p.id AND y.status = 'completed'), 0) AS balance,
            (SELECT count(*) FROM injuries j WHERE j.player_id = p.id AND j.parent_acknowledged_at IS NULL) AS "unacknowledgedInjuries",
            (SELECT count(*) FROM unpaid_alerts u WHERE u.player_id = p.id AND u.resolved_at IS NULL) AS "unpaidAlerts",
            a.form_url AS "registrationFormUrl"
       FROM parent_children pc JOIN players p ON p.id = pc.player_id JOIN intramurals i ON i.id = p.intramural_id
       JOIN countries c ON c.id = i.country_id LEFT JOIN airtable_configs a ON a.intramural_id = i.id
      WHERE pc.parent_id = $1 AND pc.verified_at IS NOT NULL ORDER BY p.first_name`,
    [id],
  );
  res.json({ parent, children });
});
