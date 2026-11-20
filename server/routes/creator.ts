import { Router } from "express";
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { ADMIN_PERMISSIONS, COUNTRY_OVERRIDE, HttpError, audit, isCreatorEmail, me, requireSuperAdmin } from "../auth.js";
import { one, query, transaction } from "../db.js";
import { normalizeEmail, normalizePhone, titleCaseName } from "../util.js";
import { notify } from "../lib/notify.js";

/**
 * Creator Control: Super Admins only. Every route checks requireSuperAdmin, so
 * admins, coaches and parents get 403 even if they find the URL.
 */
export const creatorRoutes = Router();

creatorRoutes.use("/creator", (req, _res, next) => {
  requireSuperAdmin(me(req));
  next();
});

creatorRoutes.get("/creator/users", async (req, res) => {
  const countryId = req.query.countryId ? Number(req.query.countryId) : null;
  const users = await query(
    `SELECT u.id, u.email, u.phone, u.name, u.role, u.status, u.country_id AS "countryId", c.name AS country, u.created_at AS "createdAt",
            coalesce((SELECT array_agg(intramural_id ORDER BY intramural_id) FROM user_intramurals WHERE user_id = u.id), '{}') AS intramurals,
            coalesce((SELECT json_agg(json_build_object('permission', permission, 'intramuralId', intramural_id, 'expiresAt', expires_at))
                        FROM user_permissions WHERE user_id = u.id AND (expires_at IS NULL OR expires_at > now())), '[]') AS grants,
            coalesce((SELECT array_agg(player_id) FROM parent_children WHERE parent_id = u.id AND verified_at IS NOT NULL), '{}') AS children
       FROM users u LEFT JOIN countries c ON c.id = u.country_id
      WHERE $1::int IS NULL OR u.country_id = $1
      ORDER BY CASE u.role WHEN 'super_admin' THEN 0 WHEN 'admin' THEN 1 WHEN 'coach' THEN 2 ELSE 3 END, u.name`,
    [countryId],
  );
  res.json(users.map((u) => ({ ...u, isCreator: isCreatorEmail(u.email) })));
});

const createInput = z.object({
  name: z.string().trim().min(2).max(100),
  email: z.email(),
  phone: z.string().trim().max(30).default(""),
  role: z.enum(["super_admin", "admin", "coach", "parent"]),
  countryId: z.number().int(),
});

/** Create an account with a temporary password (shown once) the person must change. */
creatorRoutes.post("/creator/users", async (req, res) => {
  const actor = me(req);
  const input = createInput.parse(req.body);
  const country = await one(`SELECT phone_prefix AS prefix FROM countries WHERE id = $1`, [input.countryId]);
  if (!country) throw new HttpError(400, "Choose a country");
  const phone = input.phone ? normalizePhone(input.phone, country.prefix) : null;
  if (input.phone && !phone) throw new HttpError(400, "That phone number does not look right");
  const temporary = randomBytes(6).toString("base64url");
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
  const target = await one(`SELECT email FROM users WHERE id = $1`, [id]);
  if (!target) throw new HttpError(404, "That person does not exist");
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
