/**
 * Checks lib/security/rbac.ts against a real Postgres (DATABASE_URL, wiped).
 *   DATABASE_URL=… SESSION_SECRET=… CREATOR_EMAIL=… npx tsx tests/rbac.check.ts
 */
import assert from "node:assert/strict";
import { prisma } from "@/lib/db";
import {
  assertCanGrant, can, canSeeIntramural, capabilitiesIn, errorResponse, feedbackScope, intramuralScope, issueSessionToken, loadActor,
  mentorshipScope, normalizeEmail, normalizeIdentity, normalizePhone, playerDedupeKey, playerScope, purgeAccount, readSessionToken,
  titleCaseName, toMpesaMsisdn, type Actor,
} from "@/lib/security/rbac";

let passed = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed++; console.log("  ✓", name); }
  catch (e) { console.error("  ✗", name, "\n", e); process.exitCode = 1; }
}
const actor = async (id: number) => (await loadActor(id))! as Actor;

console.log("Normalisation");
await check("Title Case names", () => {
  assert.equal(titleCaseName("  jOHN  o'brien-smith "), "John O'Brien-Smith");
  assert.equal(titleCaseName("mcdonald wanjiru"), "McDonald Wanjiru");
  assert.equal(titleCaseName("ÉMILE   zola"), "Émile Zola");
});
await check("E.164 phones per country", () => {
  assert.equal(normalizePhone("0712 345 678", "+254"), "+254712345678");
  assert.equal(normalizePhone("712345678", "+254"), "+254712345678");
  assert.equal(normalizePhone("254712345678", "+254"), "+254712345678");
  assert.equal(normalizePhone("0772 123456", "+256"), "+256772123456");
  assert.equal(normalizePhone("00 44 7700 900123", "+254"), "+447700900123");
  assert.equal(normalizePhone("(202) 555-0143", "+1"), "+12025550143");
  assert.equal(normalizePhone("hello", "+254"), null);
  assert.equal(normalizePhone("123", "+254"), null);
  assert.equal(toMpesaMsisdn("0712345678"), "254712345678");
  assert.equal(toMpesaMsisdn("+256772123456"), null);
});
await check("emails and player keys", () => {
  assert.equal(normalizeEmail("  Grace@Example.ORG "), "grace@example.org");
  assert.equal(playerDedupeKey(" Amani ", "OTIENO", "2017-03-04"), playerDedupeKey("amani", "otieno", new Date("2017-03-04")));
});
await check("session tokens", () => {
  const t = issueSessionToken(7, 3);
  assert.deepEqual(readSessionToken(t), { userId: 7, tokenVersion: 3 });
  assert.equal(readSessionToken(t.slice(0, -2) + "xx"), null);
});

// ---- data -------------------------------------------------------------------------------
await prisma.$executeRawUnsafe(`TRUNCATE countries, users, intramurals, account_deletions RESTART IDENTITY CASCADE`);
const KE = await prisma.country.create({ data: { code: "KE", name: "Kenya", currency: "KES", timeZone: "Africa/Nairobi", phonePrefix: "+254", mpesaEnabled: true } });
const UG = await prisma.country.create({ data: { code: "UG", name: "Uganda", currency: "UGX", timeZone: "Africa/Kampala", phonePrefix: "+256" } });
const rafiki = await prisma.intramural.create({ data: { countryId: KE.id, slug: "rafiki", name: "Rafiki Classical", shortCode: "RC", sessionWeekday: 2 } });
const daniels = await prisma.intramural.create({ data: { countryId: KE.id, slug: "daniels", name: "The Daniels Schools", shortCode: "DS", sessionWeekday: 6, sessionStartMin: 540, sessionEndMin: 660 } });
const kampala = await prisma.intramural.create({ data: { countryId: UG.id, slug: "kampala", name: "Kampala Hope", shortCode: "KH", sessionWeekday: 4 } });

async function person(name: string, email: string, phone: string, role: "ADMIN" | "COACH" | "PARENT" | "SUPER_ADMIN", countryId = KE.id, status: "ACTIVE" | "PENDING" = "ACTIVE") {
  const id = await normalizeIdentity({ name, email, phone, countryId });
  return prisma.user.create({ data: { ...id, role, status, countryId, passwordHash: "x" } });
}
const creator = await person("abel kamau", "Founder@Ambassadors.org", "0700000001", "COACH");
const admin = await person("kate agosa", "kate@test.org", "0700000002", "ADMIN");
const coach = await person("john o'brien", "john@test.org", "0700000003", "COACH");
const ugCoach = await person("peter okello", "peter@test.org", "0772000005", "COACH", UG.id);
const parent = await person("grace otieno", "grace@test.org", "0711111111", "PARENT");
await prisma.adminPermissions.create({ data: { userId: admin.id } });
await prisma.intramuralAssignment.createMany({ data: [
  { userId: admin.id, intramuralId: rafiki.id }, { userId: coach.id, intramuralId: rafiki.id },
  { userId: coach.id, intramuralId: kampala.id }, { userId: ugCoach.id, intramuralId: kampala.id },
] });
const mk = (intramuralId: number, f: string, l: string) => prisma.player.create({ data: { intramuralId, firstName: titleCaseName(f), lastName: titleCaseName(l), dedupeKey: playerDedupeKey(f, l), guardianEmail: "grace@test.org" } });
const amani = await mk(rafiki.id, "amani", "otieno");
const baraka = await mk(rafiki.id, "baraka", "kip");
const kampalaKid = await mk(kampala.id, "joy", "nakato");

console.log("Duplicates & database guarantees");
await check("names stored Title Cased, emails lowercased, phones E.164", () => {
  assert.equal(coach.name, "John O'Brien");
  assert.equal(creator.email, "founder@ambassadors.org");
  assert.equal(ugCoach.phone, "+256772000005");
});
await check("same email in other casing → 409 with a clear message", async () => {
  const id = await normalizeIdentity({ name: "x y", email: "KATE@TEST.ORG", phone: "0799000000", countryId: KE.id });
  const err = await prisma.user.create({ data: { ...id, countryId: KE.id, passwordHash: "x" } }).catch((e) => e);
  const res = errorResponse(err);
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /email already exists/);
});
await check("same phone typed differently → 409", async () => {
  const id = await normalizeIdentity({ name: "x y", email: "new@test.org", phone: "+254 700 000 003", countryId: KE.id });
  const res = errorResponse(await prisma.user.create({ data: { ...id, countryId: KE.id, passwordHash: "x" } }).catch((e) => e));
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /phone number already exists/);
});
await check("same child twice → 409", async () => {
  const res = errorResponse(await mk(rafiki.id, "AMANI ", " Otieno").catch((e) => e));
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /already registered/);
});
await check("the database itself refuses un-normalised emails and phones", async () => {
  await assert.rejects(prisma.$executeRawUnsafe(`INSERT INTO users (email, name, "passwordHash", "countryId", "updatedAt") VALUES ('Upper@X.org','Ab C','x',1,now())`), /users_email_normalised/);
  await assert.rejects(prisma.$executeRawUnsafe(`INSERT INTO users (email, phone, name, "passwordHash", "countryId", "updatedAt") VALUES ('a@x.org','0712345678','Ab C','x',1,now())`), /users_phone_e164/);
});
await check("a field privilege needs an assignment (foreign key)", async () => {
  await assert.rejects(prisma.fieldPrivilege.create({ data: { userId: coach.id, intramuralId: daniels.id, privilege: "TAKE_ATTENDANCE" } }));
});

console.log("Roles, countries, privileges");
await check("CREATOR_EMAIL is always a Super Admin", async () => {
  const a = await actor(creator.id);
  assert.equal(a.isSuperAdmin, true);
  assert.equal(can(a, "airtable.manage", { id: kampala.id, countryId: UG.id }), true);
});
await check("coaches see only assigned intramurals in their own country", async () => {
  const a = await actor(coach.id);
  assert.equal(canSeeIntramural(a, rafiki), true);
  assert.equal(canSeeIntramural(a, daniels), false); // not assigned
  assert.equal(canSeeIntramural(a, kampala), false); // assigned, but another country
  const rows = await prisma.intramural.findMany({ where: intramuralScope(a), select: { slug: true } });
  assert.deepEqual(rows.map((r) => r.slug), ["rafiki"]);
});
await check("coach basics yes; attendance/registration/setup no, until granted", async () => {
  const a = await actor(coach.id);
  assert.equal(can(a, "mentorship.write", rafiki), true);
  assert.equal(can(a, "match.log", rafiki), true);
  assert.equal(can(a, "attendance.take", rafiki), false);
  assert.equal(can(a, "schedules.edit", rafiki), false);
  const adm = await actor(admin.id);
  await assertCanGrant(adm, rafiki.id, ["TAKE_ATTENDANCE", "REGISTER_WALK_INS"], coach.id);
  await prisma.fieldPrivilege.createMany({ data: [
    { userId: coach.id, intramuralId: rafiki.id, privilege: "TAKE_ATTENDANCE", grantedById: admin.id },
    { userId: coach.id, intramuralId: rafiki.id, privilege: "REGISTER_WALK_INS", grantedById: admin.id, expiresAt: new Date(Date.now() - 1000) },
  ] });
  const after = await actor(coach.id);
  assert.equal(can(after, "attendance.take", rafiki), true);
  assert.equal(can(after, "players.register", rafiki), false, "expired privilege");
  assert.equal(can(after, "schedules.edit", rafiki), false, "setup is never grantable");
  assert.equal(can(after, "attendance.take", daniels), false, "privilege is per intramural");
});
await check("admin powers follow the Super Admin's checkboxes", async () => {
  await prisma.adminPermissions.update({ where: { userId: admin.id }, data: { canManageAirtable: false, canRegisterPlayers: false } });
  const a = await actor(admin.id);
  assert.equal(can(a, "airtable.manage", rafiki), false);
  assert.equal(can(a, "schedules.edit", rafiki), true);
  assert.equal(can(a, "attendance.take", rafiki), true);
  assert.ok(!capabilitiesIn(a, rafiki).includes("airtable.manage"));
  await assert.rejects(assertCanGrant(a, rafiki.id, ["REGISTER_WALK_INS"], coach.id), /don't hold it/);
  await assert.rejects(assertCanGrant(a, rafiki.id, ["TAKE_ATTENDANCE"], admin.id), /coaches assigned/);
});
await check("canOverrideCountry opens assigned intramurals abroad", async () => {
  await prisma.intramuralAssignment.create({ data: { userId: admin.id, intramuralId: kampala.id } });
  assert.equal(canSeeIntramural(await actor(admin.id), kampala), false);
  await prisma.adminPermissions.update({ where: { userId: admin.id }, data: { canOverrideCountry: true } });
  assert.equal(canSeeIntramural(await actor(admin.id), kampala), true);
});

console.log("Parent isolation");
await check("an unverified link shows nothing", async () => {
  await prisma.parentChild.create({ data: { parentId: parent.id, playerId: amani.id } });
  const p = await actor(parent.id);
  assert.deepEqual(p.childPlayerIds, []);
  assert.equal(await prisma.player.count({ where: playerScope(p) }), 0);
});
await check("verified: only their own child, never staff data", async () => {
  await prisma.parentChild.update({ where: { parentId_playerId: { parentId: parent.id, playerId: amani.id } }, data: { verifiedAt: new Date(), verifiedById: admin.id } });
  const p = await actor(parent.id);
  const kids = await prisma.player.findMany({ where: playerScope(p), select: { id: true } });
  assert.deepEqual(kids.map((k) => k.id), [amani.id]); // not Baraka, not the Kampala child (same guardian email!)
  assert.equal(canSeeIntramural(p, rafiki), true);
  assert.equal(canSeeIntramural(p, daniels), false);
  assert.equal(can(p, "roster.view", rafiki), false);
  await prisma.mentorshipLog.create({ data: { intramuralId: rafiki.id, playerId: amani.id, coachId: coach.id, prayerPoints: "private" } });
  assert.equal(await prisma.mentorshipLog.count({ where: mentorshipScope(p) }), 0);
  await prisma.coachFeedback.createMany({ data: [
    { playerId: amani.id, category: "Teamwork", note: "shared", coachId: coach.id },
    { playerId: amani.id, category: "Attitude", note: "coach only", visibleToParent: false, coachId: coach.id },
    { playerId: baraka.id, category: "Teamwork", note: "other child", coachId: coach.id },
  ] });
  const notes = await prisma.coachFeedback.findMany({ where: feedbackScope(p), select: { note: true } });
  assert.deepEqual(notes.map((n) => n.note), ["shared"]);
  void kampalaKid;
});
await check("coach mentorship: own logs only; admin sees all in scope", async () => {
  await prisma.mentorshipLog.create({ data: { intramuralId: rafiki.id, coachId: admin.id, discussionNotes: "admin note" } });
  assert.equal(await prisma.mentorshipLog.count({ where: mentorshipScope(await actor(coach.id)) }), 1);
  assert.equal(await prisma.mentorshipLog.count({ where: mentorshipScope(await actor(admin.id)) }), 2);
});

console.log("Delete My Account");
await check("purges the person, keeps anonymised payments and authored records", async () => {
  process.env.SESSION_SECRET ??= "x".repeat(40);
  await prisma.payment.create({ data: { playerId: amani.id, payerId: parent.id, amount: 1500, currency: "KES", phone: "254711111111", status: "COMPLETED", mpesaReceipt: "RKT123" } });
  await purgeAccount(parent.id, "in_app");
  assert.equal(await prisma.user.findUnique({ where: { id: parent.id } }), null);
  const pay = await prisma.payment.findFirstOrThrow({ where: { mpesaReceipt: "RKT123" } });
  assert.equal(pay.payerId, null);
  assert.equal(pay.phone, null);
  assert.equal(await prisma.parentChild.count({ where: { parentId: parent.id } }), 0);
  assert.equal(await prisma.accountDeletion.count(), 1);
  // Coach deletes: their logs stay, authorless.
  await purgeAccount(coach.id, "in_app");
  assert.equal(await prisma.mentorshipLog.count({ where: { coachId: null } }), 1);
  await assert.rejects(purgeAccount(creator.id, "in_app"), /creator account/);
});

console.log(`\n${passed} checks passed${process.exitCode ? ", some FAILED" : ""}`);
await prisma.$disconnect();
