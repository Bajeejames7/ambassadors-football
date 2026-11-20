/**
 * lib/security/rbac.ts: who may see and do what, enforced on the server.
 *
 * 1. Normalisation: Title Case names, lowercase emails, E.164 phones (per
 *    country prefix), player de-duplication keys. Call these before every write.
 * 2. Errors: one HttpError type, and translation of Prisma unique-constraint
 *    errors into plain "already exists" messages (zero duplicate profiles).
 * 3. Sessions: signed, revocable session tokens (httpOnly cookie or Bearer).
 * 4. The Actor: the signed-in person with their role, country, assignments,
 *    admin checkboxes, field privileges and verified children, loaded once per request.
 * 5. Capabilities: can(actor, capability, intramural), the single rule book.
 * 6. Query scoping: Prisma `where` filters that confine every list query to
 *    what the actor may see (country, assigned intramurals, own children).
 * 7. route(): App Router wrapper that authenticates, guards roles, and turns
 *    errors into JSON responses.
 *
 * Server-only: never import this file into a client component.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { cookies, headers } from "next/headers";
import { NextResponse } from "next/server";
import { Prisma, type AdminPermissions, type FieldPrivilegeType, type Role } from "@prisma/client";
import { ZodError } from "zod";
import { prisma } from "@/lib/db";

// =============================================================================
// 1. Normalisation
// =============================================================================

/**
 * Title Case every word of a person's name, the same way on the phone and the
 * server: "  jOHN  o'brien-smith " → "John O'Brien-Smith", "mcdonald" → "McDonald".
 */
export function titleCaseName(raw: string): string {
  return raw
    .normalize("NFC")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("en")
    .replace(/(^|[\s\-'’])(\p{L})/gu, (_m, sep: string, ch: string) => sep + ch.toLocaleUpperCase("en"))
    .replace(/\bMc(\p{L})/gu, (_m, ch: string) => "Mc" + ch.toLocaleUpperCase("en"));
}

export function normalizeEmail(raw: string): string {
  return raw.normalize("NFC").trim().toLowerCase();
}

/**
 * Any phone number → E.164, using the person's country prefix for local
 * numbers. Returns null when it cannot be a valid number.
 *   ("0712 345 678", "+254") → "+254712345678"
 *   ("712345678",    "+254") → "+254712345678"
 *   ("254712345678", "+254") → "+254712345678"
 *   ("0772 123456",  "+256") → "+256772123456"
 *   ("00 44 7700 900123", any) → "+447700900123"
 */
export function normalizePhone(raw: string, countryPrefix: string): string | null {
  let s = raw.trim().replace(/[\s().\-–]/g, "");
  if (!s) return null;
  if (s.startsWith("00")) s = "+" + s.slice(2);
  if (!/^\+?\d+$/.test(s)) return null;
  if (!s.startsWith("+")) {
    const cc = countryPrefix.replace("+", "");
    // Already includes the country code (e.g. 2547…), without the plus.
    if (s.startsWith(cc) && s.length - cc.length >= 8) s = "+" + s;
    else s = countryPrefix + s.replace(/^0+/, "");
  }
  return /^\+[1-9]\d{7,14}$/.test(s) ? s : null;
}

/** Daraja wants 2547XXXXXXXX / 2541XXXXXXXX (Safaricom Kenya) without the plus. */
export function toMpesaMsisdn(raw: string): string | null {
  const e164 = normalizePhone(raw, "+254");
  return e164 && /^\+254(7|1)\d{8}$/.test(e164) ? e164.slice(1) : null;
}

/**
 * Same child, same intramural → same key, whatever the casing or spacing.
 * Stored in players.dedupeKey under a unique index with intramuralId.
 */
export function playerDedupeKey(firstName: string, lastName: string, dateOfBirth?: Date | string | null): string {
  const part = (s: string) => s.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
  const dob = dateOfBirth ? new Date(dateOfBirth).toISOString().slice(0, 10) : "";
  return `${part(firstName)}|${part(lastName)}|${dob}`;
}

/** Normalises a person's identity fields in one go, before any create/update. */
export async function normalizeIdentity(input: { name: string; email: string; phone?: string | null; countryId: number }) {
  const country = await prisma.country.findUnique({ where: { id: input.countryId }, select: { phonePrefix: true, active: true } });
  if (!country) throw new HttpError(400, "Choose your country");
  const phone = input.phone ? normalizePhone(input.phone, country.phonePrefix) : null;
  if (input.phone && !phone) throw new HttpError(400, "That phone number does not look right");
  const name = titleCaseName(input.name);
  if (name.length < 2) throw new HttpError(400, "Enter your full name");
  return { name, email: normalizeEmail(input.email), phone };
}

// =============================================================================
// 2. Errors
// =============================================================================

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** Which unique index was hit → what to tell the person. */
const DUPLICATE_MESSAGES: Record<string, string> = {
  email: "An account with this email already exists. Sign in instead.",
  phone: "An account with this phone number already exists. Sign in instead.",
  dedupeKey: "This child is already registered in this intramural.",
  airtableRecordId: "That Airtable registration is already on the roster.",
  checkoutRequestId: "That payment was already recorded.",
  mpesaReceipt: "That M-PESA receipt was already recorded.",
  trainingKey: "There is already a training session on that day. Edit it instead.",
};

/** Any thrown value → a JSON Response with a message a person can act on. */
export function errorResponse(err: unknown): NextResponse {
  if (err instanceof HttpError) {
    return NextResponse.json({ error: err.message, ...err.body }, { status: err.status });
  }
  if (err instanceof ZodError) {
    return NextResponse.json({ error: err.issues[0]?.message ?? "Check what you entered", issues: err.issues }, { status: 400 });
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2002") {
      // Native engine: meta.target. Driver adapter (pg): meta.driverAdapterError.cause.
      const cause = (err.meta?.driverAdapterError as { cause?: { constraint?: { fields?: string[]; index?: string }; originalMessage?: string } } | undefined)?.cause;
      const target = [
        ...([] as string[]).concat((err.meta?.target as string[] | string | undefined) ?? []),
        ...(cause?.constraint?.fields ?? []),
        cause?.constraint?.index ?? "",
        cause?.originalMessage ?? "",
      ].join(",").replace(/"/g, "");
      const key = Object.keys(DUPLICATE_MESSAGES).find((k) => target.includes(k));
      return NextResponse.json({ error: key ? DUPLICATE_MESSAGES[key] : "That already exists." }, { status: 409 });
    }
    if (err.code === "P2025") return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (err.code === "P2003") return NextResponse.json({ error: "That refers to something that no longer exists." }, { status: 409 });
  }
  // A database CHECK constraint (see the integrity_checks migration).
  if (err instanceof Error && /violates check constraint "([^"]+)"/.test(err.message)) {
    const name = err.message.match(/check constraint "([^"]+)"/)![1];
    return NextResponse.json({ error: `That value is not allowed (${name}).` }, { status: 400 });
  }
  console.error("[api]", err);
  return NextResponse.json({ error: "Something went wrong on the server. Try again." }, { status: 500 });
}

// =============================================================================
// 3. Session tokens
//    {userId}.{tokenVersion}.{nonce}.{issuedAt}.{hmac}. Raising users.tokenVersion
//    (role change, password change, sign out everywhere, deletion) voids them all.
// =============================================================================

export const SESSION_COOKIE = "af_session";
const SESSION_DAYS = 60;

function sessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) throw new Error("SESSION_SECRET must be set to at least 32 random characters");
  return secret;
}

function sign(payload: string): string {
  return createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
}

export function issueSessionToken(userId: number, tokenVersion: number): string {
  const payload = `${userId}.${tokenVersion}.${randomBytes(12).toString("base64url")}.${Date.now()}`;
  return `${payload}.${sign(payload)}`;
}

export function readSessionToken(token: string): { userId: number; tokenVersion: number } | null {
  const parts = token.split(".");
  if (parts.length !== 5) return null;
  const expected = Buffer.from(sign(parts.slice(0, 4).join(".")));
  const given = Buffer.from(parts[4]);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  const [userId, tokenVersion, , issuedAt] = parts.map(Number);
  if (!Number.isInteger(userId) || !Number.isInteger(tokenVersion)) return null;
  if (!Number.isFinite(issuedAt) || Date.now() - issuedAt > SESSION_DAYS * 86_400_000) return null;
  return { userId, tokenVersion };
}

/** Sets the session cookie on a response (httpOnly, so page scripts can't read it). */
export function setSessionCookie(res: NextResponse, token: string | null): NextResponse {
  res.cookies.set(SESSION_COOKIE, token ?? "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: token ? SESSION_DAYS * 86_400 : 0,
  });
  return res;
}

/** Cookie first (browser, service worker); Bearer header for the Android shell or scripts. */
function tokenFromRequest(): string | null {
  const fromCookie = cookies().get(SESSION_COOKIE)?.value;
  if (fromCookie) return fromCookie;
  const auth = headers().get("authorization") ?? "";
  return auth.startsWith("Bearer ") ? auth.slice(7) : null;
}

// =============================================================================
// 4. The Actor
// =============================================================================

export interface Actor {
  id: number;
  name: string;
  email: string;
  role: Role;
  status: "PENDING" | "ACTIVE" | "SUSPENDED";
  countryId: number;
  isSuperAdmin: boolean;
  /** The Super Admin's checkboxes (admins only). */
  admin: AdminPermissions | null;
  /** Intramurals an admin/coach is assigned to. */
  assignedIntramuralIds: number[];
  /** Live (unexpired) field privileges granted to a coach. */
  fieldPrivileges: { intramuralId: number; privilege: FieldPrivilegeType; expiresAt: Date | null }[];
  /** Parents: verified children only. */
  childPlayerIds: number[];
  /** Parents: the intramurals those children play in. */
  childIntramuralIds: number[];
}

/** Super Admin by role, or by holding the CREATOR_EMAIL (the founder can never be locked out). */
export function isCreatorEmail(email: string): boolean {
  const creator = process.env.CREATOR_EMAIL?.trim().toLowerCase();
  return !!creator && normalizeEmail(email) === creator;
}

export async function loadActor(userId: number): Promise<(Actor & { tokenVersion: number }) | null> {
  const now = new Date();
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true, name: true, email: true, role: true, status: true, countryId: true, tokenVersion: true,
      adminPermissions: true,
      assignments: { select: { intramuralId: true } },
      fieldPrivileges: {
        where: { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        select: { intramuralId: true, privilege: true, expiresAt: true },
      },
      children: {
        where: { verifiedAt: { not: null } },
        select: { playerId: true, player: { select: { intramuralId: true, active: true } } },
      },
    },
  });
  if (!user) return null;
  const isSuperAdmin = user.role === "SUPER_ADMIN" || isCreatorEmail(user.email);
  const kids = user.role === "PARENT" ? user.children.filter((c) => c.player.active) : [];
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: isSuperAdmin ? "SUPER_ADMIN" : user.role,
    status: isSuperAdmin ? "ACTIVE" : user.status,
    countryId: user.countryId,
    tokenVersion: user.tokenVersion,
    isSuperAdmin,
    admin: user.role === "ADMIN" ? user.adminPermissions : null,
    assignedIntramuralIds: user.role === "PARENT" ? [] : user.assignments.map((a) => a.intramuralId),
    fieldPrivileges: user.role === "COACH" ? user.fieldPrivileges : [],
    childPlayerIds: kids.map((k) => k.playerId),
    childIntramuralIds: [...new Set(kids.map((k) => k.player.intramuralId))],
  };
}

/** The signed-in person for this request, or null. */
export async function getActor(): Promise<Actor | null> {
  const token = tokenFromRequest();
  const parsed = token ? readSessionToken(token) : null;
  if (!parsed) return null;
  const actor = await loadActor(parsed.userId);
  if (!actor || actor.tokenVersion !== parsed.tokenVersion) return null;
  const { tokenVersion: _v, ...rest } = actor;
  return rest;
}

export async function requireActor(): Promise<Actor> {
  const actor = await getActor();
  if (!actor) throw new HttpError(401, "Please sign in");
  if (actor.status === "SUSPENDED") throw new HttpError(403, "This account is suspended. Contact your coordinator.");
  return actor;
}

// =============================================================================
// 5. Capabilities: the rule book
// =============================================================================

export type Capability =
  // Every active coach and admin in their intramurals:
  | "roster.view"
  | "sessions.view"
  | "availability.answer"
  | "mentorship.write"
  | "match.log" // small-sided scores, sportsmanship and house points, awards
  | "virtues.score"
  | "feedback.write"
  | "welfare.report"
  // Admin checkboxes (and, for some, coach field privileges):
  | "schedules.edit"
  | "players.register"
  | "roles.assign"
  | "airtable.manage"
  | "parents.approve"
  | "payments.manage"
  | "reports.generate"
  | "privileges.grant"
  | "attendance.take"
  | "equipment.check";

const STAFF_BASE: ReadonlySet<Capability> = new Set([
  "roster.view", "sessions.view", "availability.answer", "mentorship.write", "match.log", "virtues.score", "feedback.write", "welfare.report",
]);

/** Capability → the Super Admin's checkbox for admins. */
const ADMIN_FLAG: Partial<Record<Capability, keyof AdminPermissions>> = {
  "schedules.edit": "canEditSchedules",
  "players.register": "canRegisterPlayers",
  "roles.assign": "canAssignCoachRoles",
  "airtable.manage": "canManageAirtable",
  "parents.approve": "canApproveParents",
  "payments.manage": "canManagePayments",
  "reports.generate": "canGenerateReports",
  "privileges.grant": "canGrantFieldPrivileges",
};

/** Coordinators run sessions themselves: always allowed for an active admin. */
const ADMIN_ALWAYS: ReadonlySet<Capability> = new Set(["attendance.take", "equipment.check"]);

/** Capability → the field privilege that gives it to a coach. Nothing else is grantable. */
export const COACH_PRIVILEGE_FOR: Partial<Record<Capability, FieldPrivilegeType>> = {
  "attendance.take": "TAKE_ATTENDANCE",
  "players.register": "REGISTER_WALK_INS",
  "equipment.check": "EQUIPMENT_CHECK",
  "reports.generate": "GENERATE_REPORTS",
};

/** Field privilege → the power the granting admin must hold themselves. */
const PRIVILEGE_NEEDS: Record<FieldPrivilegeType, Capability> = {
  TAKE_ATTENDANCE: "attendance.take",
  REGISTER_WALK_INS: "players.register",
  EQUIPMENT_CHECK: "equipment.check",
  GENERATE_REPORTS: "reports.generate",
};

export interface IntramuralRef {
  id: number;
  countryId: number;
}

/** Can this person see this intramural at all? */
export function canSeeIntramural(actor: Actor, ref: IntramuralRef): boolean {
  if (actor.isSuperAdmin) return true;
  if (actor.status !== "ACTIVE") return false;
  if (actor.role === "PARENT") return actor.childIntramuralIds.includes(ref.id);
  if (!actor.assignedIntramuralIds.includes(ref.id)) return false;
  // Country isolation: assigned is not enough; it must be in their country
  // unless a Super Admin ticked canOverrideCountry.
  return ref.countryId === actor.countryId || actor.admin?.canOverrideCountry === true;
}

/** Can this person do `capability` in this intramural? */
export function can(actor: Actor, capability: Capability, ref: IntramuralRef): boolean {
  if (actor.isSuperAdmin) return true;
  if (actor.role === "PARENT" || !canSeeIntramural(actor, ref)) return false;
  if (STAFF_BASE.has(capability)) return true;
  if (actor.role === "ADMIN") {
    if (ADMIN_ALWAYS.has(capability)) return true;
    const flag = ADMIN_FLAG[capability];
    return !!flag && actor.admin?.[flag] === true;
  }
  // Coach: only through an unexpired field privilege for this intramural.
  const privilege = COACH_PRIVILEGE_FOR[capability];
  return !!privilege && actor.fieldPrivileges.some((p) => p.intramuralId === ref.id && p.privilege === privilege);
}

/** Every capability the actor holds in one intramural (sent to the UI to show/hide controls). */
export function capabilitiesIn(actor: Actor, ref: IntramuralRef): Capability[] {
  const all: Capability[] = [...STAFF_BASE, ...(Object.keys(ADMIN_FLAG) as Capability[]), ...ADMIN_ALWAYS];
  return [...new Set(all)].filter((c) => can(actor, c, ref));
}

const refCache = new Map<number, IntramuralRef>();

/** An intramural's country. Cached: an intramural never changes country. */
export async function intramuralRef(intramuralId: number): Promise<IntramuralRef> {
  const hit = refCache.get(intramuralId);
  if (hit) return hit;
  const row = await prisma.intramural.findUnique({ where: { id: intramuralId }, select: { id: true, countryId: true } });
  if (!row) throw new HttpError(404, "That intramural does not exist");
  refCache.set(intramuralId, row);
  return row;
}

export async function requireSeeIntramural(actor: Actor, intramuralId: number): Promise<IntramuralRef> {
  const ref = await intramuralRef(intramuralId);
  if (!canSeeIntramural(actor, ref)) throw new HttpError(403, "You do not have access to this intramural");
  return ref;
}

export async function requireCapability(actor: Actor, capability: Capability, intramuralId: number): Promise<IntramuralRef> {
  const ref = await requireSeeIntramural(actor, intramuralId);
  if (!can(actor, capability, ref)) throw new HttpError(403, "You don't have permission to do this here. Ask your coordinator.");
  return ref;
}

/** Players: parents only their own verified children; staff only players in intramurals they can see. */
export async function requirePlayer(actor: Actor, playerId: number): Promise<{ id: number; intramuralId: number; ref: IntramuralRef }> {
  const player = await prisma.player.findUnique({ where: { id: playerId }, select: { id: true, intramuralId: true } });
  if (!player) throw new HttpError(404, "That player does not exist");
  const ref = await intramuralRef(player.intramuralId);
  if (actor.role === "PARENT") {
    if (actor.status !== "ACTIVE" || !actor.childPlayerIds.includes(playerId)) throw new HttpError(403, "You can only see your own children");
  } else if (!canSeeIntramural(actor, ref)) {
    throw new HttpError(403, "You do not have access to this player");
  }
  return { ...player, ref };
}

export function requireStaff(actor: Actor): void {
  if (actor.role === "PARENT") throw new HttpError(403, "This is for coaches and coordinators");
  if (actor.status !== "ACTIVE") throw new HttpError(403, "Your account is waiting for approval");
}

/** Master Control: Super Admins only. Everyone else gets 404, so the console's existence isn't revealed. */
export function requireSuperAdmin(actor: Actor): void {
  if (!actor.isSuperAdmin) throw new HttpError(404, "Not found");
}

/**
 * An admin may grant a coach only privileges they hold themselves, only in an
 * intramural where they also hold `privileges.grant`, and only to a coach
 * assigned there (the database enforces the last one too).
 */
export async function assertCanGrant(actor: Actor, intramuralId: number, privileges: FieldPrivilegeType[], coachId: number): Promise<void> {
  const ref = await requireCapability(actor, "privileges.grant", intramuralId);
  for (const p of privileges) {
    if (!can(actor, PRIVILEGE_NEEDS[p], ref)) throw new HttpError(403, `You can't grant ${p.toLowerCase().replace(/_/g, " ")} because you don't hold it`);
  }
  const coach = await prisma.user.findFirst({
    where: { id: coachId, role: "COACH", assignments: { some: { intramuralId } } },
    select: { id: true },
  });
  if (!coach) throw new HttpError(400, "Field privileges are for coaches assigned to this intramural");
}

// =============================================================================
// 6. Query scoping: use these in every list query
//    prisma.player.findMany({ where: { AND: [playerScope(actor), { active: true }] } })
// =============================================================================

/** Intramurals this person may see. */
export function intramuralScope(actor: Actor): Prisma.IntramuralWhereInput {
  if (actor.isSuperAdmin) return {};
  if (actor.status !== "ACTIVE") return { id: { in: [] } };
  if (actor.role === "PARENT") return { id: { in: actor.childIntramuralIds } };
  return {
    id: { in: actor.assignedIntramuralIds },
    ...(actor.admin?.canOverrideCountry ? {} : { countryId: actor.countryId }),
  };
}

/** Players this person may see: parents get only their verified children. */
export function playerScope(actor: Actor): Prisma.PlayerWhereInput {
  if (actor.isSuperAdmin) return {};
  if (actor.role === "PARENT") {
    return actor.status === "ACTIVE" ? { id: { in: actor.childPlayerIds } } : { id: { in: [] } };
  }
  return { intramural: intramuralScope(actor) };
}

export function sessionScope(actor: Actor): Prisma.SessionWhereInput {
  return actor.isSuperAdmin ? {} : { intramural: intramuralScope(actor) };
}

/** Staff-only data (mentorship logs): never for parents. Coaches see their own; admins see all in scope. */
export function mentorshipScope(actor: Actor): Prisma.MentorshipLogWhereInput {
  if (actor.isSuperAdmin) return {};
  if (actor.role === "PARENT") return { id: { in: [] } };
  return actor.role === "ADMIN" ? { intramural: intramuralScope(actor) } : { intramural: intramuralScope(actor), coachId: actor.id };
}

/** Feedback: parents only see notes marked visible, about their own children. */
export function feedbackScope(actor: Actor): Prisma.CoachFeedbackWhereInput {
  if (actor.role === "PARENT") return { visibleToParent: true, player: playerScope(actor) };
  return { player: playerScope(actor) };
}

/** People an admin may look up (to add coaches, approve parents): same country only. */
export function userDirectoryScope(actor: Actor): Prisma.UserWhereInput {
  if (actor.isSuperAdmin) return {};
  if (actor.role !== "ADMIN") return { id: actor.id };
  return actor.admin?.canOverrideCountry ? {} : { countryId: actor.countryId };
}

/**
 * Fields a parent may receive about their own child. Use as `select` in parent
 * queries so staff-only columns (other contacts, retention data) never leave the server.
 */
export const PARENT_PLAYER_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  category: true,
  team: true,
  intramuralId: true,
  intramural: { select: { id: true, name: true, shortCode: true, color: true, logoPath: true, sessionWeekday: true, sessionStartMin: true, sessionEndMin: true } },
} satisfies Prisma.PlayerSelect;

// =============================================================================
// 7. Route wrapper for App Router handlers
// =============================================================================

type Access = "public" | "user" | "staff" | "super_admin";
type Params = Record<string, string | string[]>;

interface RouteContext<A extends Access> {
  req: Request;
  params: Params;
  actor: A extends "public" ? Actor | null : Actor;
}

/**
 * export const POST = route("staff", async ({ actor, req, params }) => { … return data; });
 * - "public": no sign-in needed (onboarding, M-PESA callback); actor may be null
 * - "user": any signed-in, non-suspended person
 * - "staff": coaches, admins, super admins (parents get 403)
 * - "super_admin": Master Control (everyone else gets 404)
 * Returning a plain value sends it as JSON; returning a Response sends it as is.
 */
export function route<A extends Access>(access: A, handler: (ctx: RouteContext<A>) => Promise<unknown>) {
  return async (req: Request, context: { params?: Params | Promise<Params> } = {}): Promise<Response> => {
    try {
      const params = (await context.params) ?? {};
      const actor = access === "public" ? await getActor() : await requireActor();
      if (access === "staff") requireStaff(actor!);
      if (access === "super_admin") requireSuperAdmin(actor!);
      const result = await handler({ req, params, actor: actor as RouteContext<A>["actor"] });
      if (result instanceof Response) return result;
      return NextResponse.json(result ?? { ok: true }, { headers: { "Cache-Control": "no-store" } });
    } catch (err) {
      return errorResponse(err);
    }
  };
}

/** Reads a numeric route param or fails with 400. */
export function intParam(params: Params, name: string): number {
  const n = Number(params[name]);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `Invalid ${name}`);
  return n;
}

// =============================================================================
// Audit & account deletion helpers
// =============================================================================

export async function audit(actorId: number | null, action: string, detail: Record<string, unknown> = {}): Promise<void> {
  await prisma.auditLog.create({ data: { actorId, action, detail: detail as Prisma.InputJsonValue } });
}

/**
 * "Delete My Account": purge the person's PII in one transaction.
 * - The user row goes (cascades: sessions-of-access, consents, notifications,
 *   parent links, availability, privileges, assignments, sync ledger).
 * - Records they authored stay, with the author set to NULL (SetNull FKs).
 * - Payments are kept for the accounts, with the payer and phone erased.
 * - A salted hash of the email is logged as proof the request was honoured.
 */
export async function purgeAccount(userId: number, channel: "in_app" | "web_request" | "admin"): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, role: true, createdAt: true } });
  if (!user) throw new HttpError(404, "That account does not exist");
  if (isCreatorEmail(user.email)) throw new HttpError(400, "The creator account can't be deleted. Change CREATOR_EMAIL first.");
  const emailHash = createHash("sha256").update(`${process.env.SESSION_SECRET ?? ""}:${user.email}`).digest("hex");
  await prisma.$transaction([
    prisma.payment.updateMany({ where: { payerId: userId }, data: { payerId: null, phone: null } }),
    prisma.user.delete({ where: { id: userId } }),
    prisma.accountDeletion.create({ data: { emailHash, role: user.role, channel, requestedAt: new Date() } }),
  ]);
}
