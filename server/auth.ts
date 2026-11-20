import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { config } from "./config.js";
import { one, query } from "./db.js";

/**
 * Who may do what.
 *
 * Four roles:
 * - super_admin: everything, everywhere. The only role that sees Creator Control.
 * - admin: their country and their assigned intramurals, with the permissions a
 *   super admin has ticked for them.
 * - coach: their country and assigned intramurals; the coach basics, plus any
 *   field privileges an admin has granted.
 * - parent: only their own verified children, and those children's intramurals.
 *
 * Every check runs on the server. The web app hides what a person cannot use,
 * but hiding is never the protection.
 */

export type Role = "super_admin" | "admin" | "coach" | "parent";

/** Permissions a super admin toggles per admin (the checkboxes in Creator Control). */
export const ADMIN_PERMISSIONS = [
  "schedules.edit",     // Can edit schedules, sessions and the Setup tab
  "players.register",   // Can register players
  "roles.assign",       // Can assign coach roles (session roles and coaches to the intramural)
  "airtable.manage",    // Can manage Airtable links
  "parents.approve",    // Can approve parent accounts
  "attendance.take",    // Can take attendance
  "equipment.check",    // Can run the equipment checklist
  "payments.manage",    // Can add fees and record cash payments
  "reports.generate",   // Can generate matchday PDF reports
  "privileges.grant",   // Can grant field privileges to coaches
] as const;

/** Field privileges an admin can hand to a coach (never Setup or delete controls). */
export const COACH_GRANTABLE = ["attendance.take", "players.register", "equipment.check", "reports.generate"] as const;

/** Only a super admin can grant this: work outside one's own country. */
export const COUNTRY_OVERRIDE = "country.override";

/** What every active coach (and admin) can do in their intramurals. */
export const STAFF_BASE = [
  "sessions.view",
  "availability.answer",
  "roster.view",
  "mentorship.write",
  "tally.write",
  "virtues.score",
  "feedback.write",
  "injuries.report",
] as const;

export type Permission = (typeof ADMIN_PERMISSIONS)[number] | (typeof STAFF_BASE)[number] | typeof COUNTRY_OVERRIDE;

export interface Grant {
  permission: string;
  intramuralId: number | null;
  expiresAt: string | null;
}

export interface Me {
  id: number;
  email: string;
  phone: string | null;
  name: string;
  role: Role;
  status: "pending" | "active" | "suspended";
  countryId: number | null;
  mustChangePassword: boolean;
  isSuperAdmin: boolean;
  /** Intramurals an admin/coach is assigned to. */
  intramurals: number[];
  /** Live (unexpired) permission grants. */
  grants: Grant[];
  /** Parents: verified children's player ids. */
  children: number[];
  /** Parents: the intramurals their verified children play in. */
  childIntramurals: number[];
}

export class HttpError extends Error {
  constructor(public status: number, message: string, public body?: Record<string, unknown>) {
    super(message);
  }
}

// ---- tokens -------------------------------------------------------------------
// {userId}.{tokenVersion}.{nonce}.{issuedAt}.{hmac}. Raising a user's
// token_version (sign out everywhere, role change, deletion) voids old tokens.

const TOKEN_DAYS = 60;

function sign(payload: string): string {
  return createHmac("sha256", config.tokenSecret).update(payload).digest("base64url");
}

export function issueToken(userId: number, version: number): string {
  const payload = `${userId}.${version}.${randomBytes(12).toString("base64url")}.${Date.now()}`;
  return `${payload}.${sign(payload)}`;
}

export function readToken(token: string): { userId: number; version: number } | null {
  const parts = token.split(".");
  if (parts.length !== 5) return null;
  const expected = Buffer.from(sign(parts.slice(0, 4).join(".")));
  const given = Buffer.from(parts[4]);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  const userId = Number(parts[0]);
  const version = Number(parts[1]);
  const issued = Number(parts[3]);
  if (!Number.isInteger(userId) || !Number.isInteger(version) || !Number.isFinite(issued)) return null;
  if (Date.now() - issued > TOKEN_DAYS * 86_400_000) return null;
  return { userId, version };
}

// ---- loading the signed-in person ---------------------------------------------

export function isCreatorEmail(email: string): boolean {
  return config.creatorEmail !== "" && email.trim().toLowerCase() === config.creatorEmail;
}

export async function loadMe(userId: number): Promise<(Me & { tokenVersion: number }) | null> {
  const row = await one(
    `SELECT id, email, phone, name, role, status, country_id AS "countryId",
            must_change_password AS "mustChangePassword", token_version AS "tokenVersion"
       FROM users WHERE id = $1`,
    [userId],
  );
  if (!row) return null;
  const isSuperAdmin = row.role === "super_admin" || isCreatorEmail(row.email);
  const [assigned, grants, kids] = await Promise.all([
    query<{ id: number }>(`SELECT intramural_id AS id FROM user_intramurals WHERE user_id = $1`, [userId]),
    query<Grant>(
      `SELECT permission, intramural_id AS "intramuralId", expires_at AS "expiresAt"
         FROM user_permissions WHERE user_id = $1 AND (expires_at IS NULL OR expires_at > now())`,
      [userId],
    ),
    row.role === "parent"
      ? query<{ id: number; intramuralId: number }>(
          `SELECT p.id, p.intramural_id AS "intramuralId" FROM parent_children pc
             JOIN players p ON p.id = pc.player_id
            WHERE pc.parent_id = $1 AND pc.verified_at IS NOT NULL`,
          [userId],
        )
      : Promise.resolve([]),
  ]);
  return {
    ...row,
    role: isSuperAdmin ? "super_admin" : row.role,
    isSuperAdmin,
    status: isSuperAdmin ? "active" : row.status,
    intramurals: assigned.map((a) => a.id),
    grants,
    children: kids.map((k) => k.id),
    childIntramurals: [...new Set(kids.map((k) => k.intramuralId))],
  };
}

export function me(req: Request): Me {
  const found = (req as Request & { me?: Me }).me;
  if (!found) throw new HttpError(401, "Please sign in");
  return found;
}

/** Every API route except sign-up, sign-in, public pages and the M-PESA callback sits behind this. */
export async function requireUser(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? readToken(header.slice(7)) : null;
  const found = token ? await loadMe(token.userId) : null;
  if (!found || found.tokenVersion !== token!.version) throw new HttpError(401, "Please sign in");
  if (found.status === "suspended") throw new HttpError(403, "This account is suspended. Contact your coordinator.");
  (req as Request & { me?: Me }).me = found;
  next();
}

// ---- the checks ----------------------------------------------------------------

export interface IntramuralRef {
  id: number;
  countryId: number;
}

const intramuralCache = new Map<number, IntramuralRef>();

/** An intramural's country (cached: intramurals never change country). */
export async function intramuralRef(id: number): Promise<IntramuralRef> {
  const cached = intramuralCache.get(id);
  if (cached) return cached;
  const row = await one<IntramuralRef>(`SELECT id, country_id AS "countryId" FROM intramurals WHERE id = $1`, [id]);
  if (!row) throw new HttpError(404, "That intramural does not exist");
  intramuralCache.set(id, row);
  return row;
}

function hasGrant(user: Me, permission: string, intramuralId: number | null): boolean {
  return user.grants.some((g) => g.permission === permission && (g.intramuralId === null || g.intramuralId === intramuralId));
}

/**
 * Can this person see this intramural at all?
 * - super admins: yes
 * - parents: only the intramurals of their verified children
 * - admins and coaches: only assigned intramurals in their own country
 *   (unless a super admin gave them the country override)
 */
export function canSeeIntramural(user: Me, ref: IntramuralRef): boolean {
  if (user.isSuperAdmin) return true;
  if (user.status !== "active") return false;
  if (user.role === "parent") return user.childIntramurals.includes(ref.id);
  if (!user.intramurals.includes(ref.id)) return false;
  return ref.countryId === user.countryId || hasGrant(user, COUNTRY_OVERRIDE, null);
}

/** Can this person do `permission` in this intramural? */
export function can(user: Me, permission: Permission, ref: IntramuralRef): boolean {
  if (user.isSuperAdmin) return true;
  if (user.role === "parent" || !canSeeIntramural(user, ref)) return false;
  if ((STAFF_BASE as readonly string[]).includes(permission)) return true;
  return hasGrant(user, permission, ref.id);
}

export async function requireSee(user: Me, intramuralId: number): Promise<IntramuralRef> {
  const ref = await intramuralRef(intramuralId);
  if (!canSeeIntramural(user, ref)) throw new HttpError(403, "You do not have access to this intramural");
  return ref;
}

export async function requirePermission(user: Me, permission: Permission, intramuralId: number): Promise<IntramuralRef> {
  const ref = await intramuralRef(intramuralId);
  if (!canSeeIntramural(user, ref)) throw new HttpError(403, "You do not have access to this intramural");
  if (!can(user, permission, ref)) throw new HttpError(403, `You need the "${permission}" permission for this`);
  return ref;
}

export function requireStaff(user: Me): void {
  if (user.role === "parent") throw new HttpError(403, "This is for coaches and admins");
  if (user.status !== "active") throw new HttpError(403, "Your account is waiting for approval");
}

export function requireSuperAdmin(user: Me): void {
  if (!user.isSuperAdmin) throw new HttpError(403, "Only a Super Admin can do this");
}

/**
 * Player-level access: parents only their own verified children; staff only
 * players in intramurals they can see.
 */
export async function requirePlayer(user: Me, playerId: number): Promise<{ id: number; intramuralId: number; ref: IntramuralRef }> {
  const row = await one<{ id: number; intramuralId: number }>(
    `SELECT id, intramural_id AS "intramuralId" FROM players WHERE id = $1`,
    [playerId],
  );
  if (!row) throw new HttpError(404, "That player does not exist");
  const ref = await intramuralRef(row.intramuralId);
  if (user.role === "parent" && !user.isSuperAdmin) {
    if (user.status !== "active" || !user.children.includes(playerId)) throw new HttpError(403, "You can only see your own children");
  } else if (!canSeeIntramural(user, ref)) {
    throw new HttpError(403, "You do not have access to this player");
  }
  return { ...row, ref };
}

/** The intramurals this person can see, for list queries. NULL means all (super admin). */
export function visibleIntramuralIds(user: Me): number[] | null {
  if (user.isSuperAdmin) return null;
  if (user.status !== "active") return [];
  if (user.role === "parent") return user.childIntramurals;
  return user.intramurals;
}

// ---- sign-in throttling ----------------------------------------------------------

const WINDOW_MS = 15 * 60 * 1000;
const failures = new Map<string, { count: number; since: number }>();

export function checkLoginAllowed(key: string): void {
  const entry = failures.get(key);
  if (entry && Date.now() - entry.since < WINDOW_MS && entry.count >= 10) {
    throw new HttpError(429, "Too many failed attempts. Wait 15 minutes and try again.");
  }
}

export function noteLoginFailure(key: string): void {
  const entry = failures.get(key);
  if (!entry || Date.now() - entry.since >= WINDOW_MS) failures.set(key, { count: 1, since: Date.now() });
  else entry.count += 1;
}

export function clearLoginFailures(key: string): void {
  failures.delete(key);
}

export async function audit(actorId: number | null, action: string, detail: Record<string, unknown> = {}): Promise<void> {
  await query(`INSERT INTO audit_log (actor_id, action, detail) VALUES ($1, $2, $3)`, [actorId, action, JSON.stringify(detail)]);
}
