import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import {
  HttpError, audit, checkLoginAllowed, clearLoginFailures, isCreatorEmail, issueToken, loadMe, me, noteLoginFailure, requireUser,
} from "../auth.js";
import { one, query, transaction } from "../db.js";
import { normalizeEmail, normalizePhone, titleCaseName } from "../util.js";
import { notify, parentApprovers } from "../lib/notify.js";
import { config } from "../config.js";
import { DEMO_ACCOUNTS, DEMO_PASSWORD } from "../demo.js";

/** Public routes (no sign-in): countries for onboarding, sign-up, sign-in. */
export const publicAuthRoutes = Router();
/** Signed-in routes about your own account. */
export const accountRoutes = Router();

const password = z.string().min(8, "Use at least 8 characters for the password").max(200);

/** What the sign-in screen needs to know: demo mode and its accounts. */
publicAuthRoutes.get("/info", (_req, res) => {
  res.json(config.demo ? { demo: true, password: DEMO_PASSWORD, accounts: DEMO_ACCOUNTS } : { demo: false });
});

publicAuthRoutes.get("/countries", async (_req, res) => {
  res.json(
    await query(
      `SELECT id, code, name, currency, phone_prefix AS "phonePrefix", mpesa FROM countries WHERE active ORDER BY name`,
    ),
  );
});

const signupInput = z.object({
  countryId: z.number().int(),
  role: z.enum(["coach", "parent"]),
  name: z.string().trim().min(2, "Enter your full name").max(100),
  email: z.email("Enter a valid email address"),
  phone: z.string().trim().min(6, "Enter your phone number").max(30),
  password,
});

/** Turns Postgres unique-index errors into a clear "already exists" message. */
function duplicateMessage(err: unknown): never {
  const e = err as { code?: string; constraint?: string };
  if (e.code === "23505") {
    if (e.constraint === "users_email_uq") throw new HttpError(409, "An account with this email already exists. Sign in instead.");
    if (e.constraint === "users_phone_uq") throw new HttpError(409, "An account with this phone number already exists. Sign in instead.");
  }
  throw err;
}

publicAuthRoutes.post("/auth/signup", async (req, res) => {
  const input = signupInput.parse(req.body);
  const country = await one(`SELECT id, phone_prefix AS prefix FROM countries WHERE id = $1 AND active`, [input.countryId]);
  if (!country) throw new HttpError(400, "Choose your country");
  const email = normalizeEmail(input.email);
  const phone = normalizePhone(input.phone, country.prefix);
  if (!phone) throw new HttpError(400, "That phone number does not look right");
  const name = titleCaseName(input.name);
  const creator = isCreatorEmail(email);
  const role = creator ? "super_admin" : input.role;
  // Parents wait for an admin to confirm which children are theirs.
  const status = role === "parent" ? "pending" : "active";

  const user = await transaction(async (c) => {
    const row = (
      await c
        .query(
          `INSERT INTO users (email, phone, name, password_hash, role, status, country_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, token_version AS v`,
          [email, phone, name, await bcrypt.hash(input.password, 10), role, status, country.id],
        )
        .catch(duplicateMessage)
    ).rows[0];
    if (role === "parent") {
      // Suggest links to children registered with this parent email/phone. Not
      // visible to the parent until an admin verifies them.
      await c.query(
        `INSERT INTO parent_children (parent_id, player_id)
         SELECT $1, p.id FROM players p JOIN intramurals i ON i.id = p.intramural_id
          WHERE i.country_id = $4 AND (lower(p.guardian_email) = $2 OR p.guardian_phone = $3)
         ON CONFLICT DO NOTHING`,
        [row.id, email, phone, country.id],
      );
    }
    return row;
  });

  if (role === "parent") {
    const intramurals = await query<{ id: number }>(
      `SELECT DISTINCT p.intramural_id AS id FROM parent_children pc JOIN players p ON p.id = pc.player_id WHERE pc.parent_id = $1`,
      [user.id],
    );
    for (const i of intramurals) {
      await notify(await parentApprovers(i.id), {
        kind: "approval",
        title: `${name} signed up as a parent`,
        body: "Confirm which children are theirs so they can see their progress.",
        link: `/admin/${i.id}/people`,
      });
    }
  }
  await audit(user.id, "signup", { role });
  res.status(201).json({ token: issueToken(user.id, user.v), me: await loadMe(user.id) });
});

const loginInput = z.object({
  identifier: z.string().trim().min(3),
  password: z.string().min(1),
  /** Which door they used: the parent portal (/parents) or the staff sign-in. */
  portal: z.enum(["parents", "staff"]).optional(),
});

publicAuthRoutes.post("/auth/login", async (req, res) => {
  const input = loginInput.parse(req.body);
  const key = `${input.identifier.toLowerCase()}|${req.ip}`;
  checkLoginAllowed(key);
  const byEmail = input.identifier.includes("@");
  const phone = byEmail ? null : normalizePhone(input.identifier);
  const user = await one(
    byEmail
      ? `SELECT id, role, password_hash, token_version AS v FROM users WHERE lower(email) = $1`
      : `SELECT id, role, password_hash, token_version AS v FROM users WHERE phone = $1`,
    [byEmail ? normalizeEmail(input.identifier) : phone],
  );
  if (!user || !(await bcrypt.compare(input.password, user.password_hash))) {
    noteLoginFailure(key);
    throw new HttpError(401, "That email/phone and password do not match");
  }
  clearLoginFailures(key);
  // Parents and staff sign in through separate doors.
  if (input.portal === "parents" && user.role !== "parent") {
    throw new HttpError(403, "This is the parent portal. Coaches and admins sign in on the staff page.", { code: "use_staff_login" });
  }
  if (input.portal === "staff" && user.role === "parent") {
    throw new HttpError(403, "Parents sign in through the parent portal.", { code: "use_parent_portal" });
  }
  res.json({ token: issueToken(user.id, user.v), me: await loadMe(user.id) });
});

// ---- your own account --------------------------------------------------------------

accountRoutes.use(requireUser);

accountRoutes.get("/me", (req, res) => {
  const { tokenVersion: _v, ...rest } = me(req) as ReturnType<typeof me> & { tokenVersion?: number };
  res.json(rest);
});

const profileInput = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  phone: z.string().trim().min(6).max(30).optional(),
});

accountRoutes.patch("/me", async (req, res) => {
  const user = me(req);
  const input = profileInput.parse(req.body);
  const prefix = (await one(`SELECT phone_prefix AS p FROM countries WHERE id = $1`, [user.countryId]))?.p ?? "+254";
  const phone = input.phone ? normalizePhone(input.phone, prefix) : undefined;
  if (input.phone && !phone) throw new HttpError(400, "That phone number does not look right");
  await query(`UPDATE users SET name = coalesce($2, name), phone = coalesce($3, phone) WHERE id = $1`, [
    user.id,
    input.name ? titleCaseName(input.name) : null,
    phone ?? null,
  ]).catch(duplicateMessage);
  res.json(await loadMe(user.id));
});

accountRoutes.post("/me/password", async (req, res) => {
  const user = me(req);
  const input = z.object({ current: z.string(), next: password }).parse(req.body);
  const row = await one(`SELECT password_hash FROM users WHERE id = $1`, [user.id]);
  if (!(await bcrypt.compare(input.current, row.password_hash))) throw new HttpError(400, "Your current password is not right");
  const updated = await one(
    `UPDATE users SET password_hash = $2, must_change_password = false, token_version = token_version + 1
      WHERE id = $1 RETURNING token_version AS v`,
    [user.id, await bcrypt.hash(input.next, 10)],
  );
  res.json({ token: issueToken(user.id, updated.v) });
});

accountRoutes.post("/me/signout-everywhere", async (req, res) => {
  await query(`UPDATE users SET token_version = token_version + 1 WHERE id = $1`, [me(req).id]);
  res.json({ ok: true });
});

/**
 * Delete My Account (Google Play requirement). Removes the account, its
 * sign-in, links to children, notifications, availability answers and
 * permissions. Payment records are kept for the organisation's accounts (a
 * legal requirement) but the phone number on them is erased and they no
 * longer point to this person. Player records belong to the intramural and
 * are not deleted here; a parent can ask the coordinator to remove a child.
 */
accountRoutes.delete("/me", async (req, res) => {
  const user = me(req);
  const input = z.object({ password: z.string().min(1, "Enter your password to confirm") }).parse(req.body);
  if (isCreatorEmail(user.email)) throw new HttpError(400, "The creator account cannot be deleted from the app. Change CREATOR_EMAIL first.");
  const row = await one(`SELECT password_hash FROM users WHERE id = $1`, [user.id]);
  if (!(await bcrypt.compare(input.password, row.password_hash))) throw new HttpError(400, "That password is not right");
  await transaction(async (c) => {
    await c.query(`UPDATE payments SET phone = '', payer_id = NULL WHERE payer_id = $1`, [user.id]);
    await c.query(`DELETE FROM users WHERE id = $1`, [user.id]);
    await c.query(`INSERT INTO audit_log (actor_id, action, detail) VALUES (NULL, 'account_deleted', $1)`, [
      JSON.stringify({ userId: user.id, role: user.role }),
    ]);
  });
  res.json({ ok: true });
});
