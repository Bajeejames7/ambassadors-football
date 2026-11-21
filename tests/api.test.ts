import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../server/app.js";
import { migrate } from "../server/migrations.js";
import { closePool, getPool, one, query } from "../server/db.js";
import { titleCaseName, normalizePhone, mpesaPhone, formatTime12, sessionDayLabel } from "../server/util.js";

/**
 * What the API must do. Runs against a real Postgres (TEST_DATABASE_URL) and
 * wipes it first.
 */

const app = createApp();
const api = () => request(app);
type Who = { token: string; id: number };

async function signup(body: Record<string, unknown>): Promise<Who> {
  const res = await api().post("/api/auth/signup").send(body);
  if (res.status !== 201) throw new Error(`${res.status} ${JSON.stringify(res.body)}`);
  return { token: res.body.token, id: res.body.me.id };
}
const auth = (w: Who) => ({ Authorization: `Bearer ${w.token}` });

let KE: number;
let UG: number;
let rafiki: number;
let daniels: number;
let kampala: number;
let creator: Who, admin: Who, coach: Who, otherCoach: Who, ugCoach: Who, parent: Who, strangerParent: Who;
let childId: number, otherChildId: number, sessionId: number;

beforeAll(async () => {
  await getPool().query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate();
  KE = (await one(`SELECT id FROM countries WHERE code = 'KE'`)).id;
  rafiki = (await one(`SELECT id FROM intramurals WHERE slug = 'rafiki'`)).id;
  daniels = (await one(`SELECT id FROM intramurals WHERE slug = 'daniels'`)).id;

  creator = await signup({ countryId: KE, role: "coach", name: "abel creator", email: "Creator@Test.org", phone: "0700000001", password: "password1" });
  // Super admin adds Uganda and an intramural there.
  UG = (await api().post("/api/creator/countries").set(auth(creator)).send({ code: "ug", name: "Uganda", currency: "UGX", timeZone: "Africa/Kampala", phonePrefix: "+256" })).body.id;
  kampala = (await api().post("/api/creator/intramurals").set(auth(creator)).send({ countryId: UG, name: "Kampala Hope", shortCode: "KH", sessionWeekday: 4 })).body.id;

  admin = await signup({ countryId: KE, role: "coach", name: "kate agosa", email: "kate@test.org", phone: "0700000002", password: "password1" });
  coach = await signup({ countryId: KE, role: "coach", name: "john o'brien-smith", email: "john@test.org", phone: "0700000003", password: "password1" });
  otherCoach = await signup({ countryId: KE, role: "coach", name: "mary wanjiru", email: "mary@test.org", phone: "0700000004", password: "password1" });
  ugCoach = await signup({ countryId: UG, role: "coach", name: "peter okello", email: "peter@test.org", phone: "0772000005", password: "password1" });

  await api().patch(`/api/creator/users/${admin.id}`).set(auth(creator)).send({ role: "admin" }).expect(200);
  // Role change voids old tokens: sign in again.
  admin.token = (await api().post("/api/auth/login").send({ identifier: "kate@test.org", password: "password1" })).body.token;
  await api().put(`/api/creator/users/${admin.id}/intramurals`).set(auth(creator)).send({ intramuralIds: [rafiki] }).expect(200);
  await api().put(`/api/creator/users/${coach.id}/intramurals`).set(auth(creator)).send({ intramuralIds: [rafiki] }).expect(200);
  await api().put(`/api/creator/users/${otherCoach.id}/intramurals`).set(auth(creator)).send({ intramuralIds: [daniels] }).expect(200);
  await api().put(`/api/creator/users/${ugCoach.id}/intramurals`).set(auth(creator)).send({ intramuralIds: [kampala] }).expect(200);

  childId = (await api().post(`/api/intramurals/${rafiki}/players`).set(auth(admin))
    .send({ firstName: "amani", lastName: "otieno", category: "U9", guardianEmail: "Parent@Test.org", guardianPhone: "0711 111 111" })).body.id;
  otherChildId = (await api().post(`/api/intramurals/${rafiki}/players`).set(auth(admin))
    .send({ firstName: "baraka", lastName: "kip", category: "U9", guardianEmail: "someone@else.org" })).body.id;

  parent = await signup({ countryId: KE, role: "parent", name: "grace otieno", email: "parent@test.org", phone: "+254711111111", password: "password1" });
  strangerParent = await signup({ countryId: KE, role: "parent", name: "eve", email: "eve@test.org", phone: "0722999999", password: "password1" });

  const sessions = (await api().get(`/api/intramurals/${rafiki}/sessions`).set(auth(admin))).body;
  sessionId = sessions[0].id;
});

afterAll(async () => {
  await closePool();
});

describe("helpers", () => {
  it("title-cases names and formats times with AM/PM", () => {
    expect(titleCaseName("  jOHN  o'brien-smith ")).toBe("John O'Brien-Smith");
    expect(titleCaseName("mcdonald wanjiru")).toBe("McDonald Wanjiru");
    expect(formatTime12("15:15")).toBe("3:15 PM");
    expect(formatTime12("09:00:00")).toBe("9:00 AM");
    expect(formatTime12("00:30")).toBe("12:30 AM");
    expect(formatTime12("12:05")).toBe("12:05 PM");
    expect(sessionDayLabel(6)).toBe("Saturday Session");
    expect(normalizePhone("0712 345 678")).toBe("+254712345678");
    expect(normalizePhone("254712345678")).toBe("+254712345678");
    expect(mpesaPhone("+254 712 345678")).toBe("254712345678");
    expect(mpesaPhone("+256772000000")).toBeNull();
  });
});

describe("accounts", () => {
  it("stores names title-cased and prevents duplicate profiles by email and phone", async () => {
    const me = (await api().get("/api/me").set(auth(coach))).body;
    expect(me.name).toBe("John O'Brien-Smith");
    const dupEmail = await api().post("/api/auth/signup").send({ countryId: KE, role: "coach", name: "x y", email: "JOHN@test.org", phone: "0799999999", password: "password1" });
    expect(dupEmail.status).toBe(409);
    const dupPhone = await api().post("/api/auth/signup").send({ countryId: KE, role: "coach", name: "x y", email: "new@test.org", phone: "+254 700 000 003", password: "password1" });
    expect(dupPhone.status).toBe(409);
    expect(dupPhone.body.error).toMatch(/phone/);
  });

  it("signs in by email or phone", async () => {
    expect((await api().post("/api/auth/login").send({ identifier: "0700000003", password: "password1" })).status).toBe(200);
    expect((await api().post("/api/auth/login").send({ identifier: "john@test.org", password: "nope" })).status).toBe(401);
  });

  it("the creator email is a super admin", async () => {
    const me = (await api().get("/api/me").set(auth(creator))).body;
    expect(me.role).toBe("super_admin");
    expect(me.isSuperAdmin).toBe(true);
  });
});

describe("RBAC", () => {
  it("Creator Control: open to admins and super admins, hidden from coaches and parents", async () => {
    for (const who of [coach, parent]) {
      expect((await api().get("/api/creator/users").set(auth(who))).status).toBe(403);
      expect((await api().get("/api/creator/parents").set(auth(who))).status).toBe(403);
    }
    expect((await api().get("/api/creator/users").set(auth(creator))).status).toBe(200);
    expect((await api().get("/api/creator/users").set(auth(admin))).status).toBe(200);
    expect((await api().get("/api/creator/metrics").set(auth(admin))).status).toBe(200);
  });

  it("restricts coaches to their assigned intramurals", async () => {
    const list = (await api().get("/api/intramurals").set(auth(coach))).body;
    expect(list.map((i: { id: number }) => i.id)).toEqual([rafiki]);
    expect((await api().get(`/api/intramurals/${daniels}`).set(auth(coach))).status).toBe(403);
    expect((await api().get(`/api/intramurals/${daniels}/players`).set(auth(coach))).status).toBe(403);
  });

  it("enforces country isolation even when assigned, unless a super admin overrides", async () => {
    // A Kenyan coach assigned to a Ugandan intramural still cannot see it…
    await api().put(`/api/creator/users/${coach.id}/intramurals`).set(auth(creator)).send({ intramuralIds: [rafiki, kampala] }).expect(200);
    expect((await api().get(`/api/intramurals/${kampala}`).set(auth(coach))).status).toBe(403);
    // …until a super admin grants the country override.
    await api().put(`/api/creator/users/${coach.id}/permissions`).set(auth(creator)).send({ permissions: ["country.override"] }).expect(200);
    expect((await api().get(`/api/intramurals/${kampala}`).set(auth(coach))).status).toBe(200);
    await api().put(`/api/creator/users/${coach.id}/permissions`).set(auth(creator)).send({ permissions: [] }).expect(200);
    await api().put(`/api/creator/users/${coach.id}/intramurals`).set(auth(creator)).send({ intramuralIds: [rafiki] }).expect(200);
    // Admins have the same reach as super admins: every school, every country.
    expect((await api().get(`/api/intramurals/${kampala}`).set(auth(admin))).status).toBe(200);
    expect((await api().post(`/api/intramurals/${rafiki}/coaches`).set(auth(admin)).send({ userId: ugCoach.id })).status).toBe(200);
    await api().delete(`/api/intramurals/${rafiki}/coaches/${ugCoach.id}`).set(auth(admin)).expect(200);
  });

  it("coaches cannot take attendance or register players until an admin grants it", async () => {
    const entry = { entries: [{ playerId: childId, status: "present" }] };
    expect((await api().put(`/api/sessions/${sessionId}/attendance`).set(auth(coach)).send(entry)).status).toBe(403);
    expect((await api().post(`/api/intramurals/${rafiki}/players`).set(auth(coach)).send({ firstName: "x" })).status).toBe(403);
    expect((await api().patch(`/api/intramurals/${rafiki}`).set(auth(coach)).send({ location: "x" })).status).toBe(403);

    await api().put(`/api/intramurals/${rafiki}/coaches/${coach.id}/privileges`).set(auth(admin))
      .send({ privileges: [{ permission: "attendance.take" }, { permission: "players.register", expiresAt: new Date(Date.now() + 86400000).toISOString() }] })
      .expect(200);
    expect((await api().put(`/api/sessions/${sessionId}/attendance`).set(auth(coach)).send(entry)).status).toBe(200);
    // Setup is still off-limits: it is not grantable.
    expect((await api().patch(`/api/intramurals/${rafiki}`).set(auth(coach)).send({ location: "x" })).status).toBe(403);
    // Admins cannot grant admin-level permissions to coaches.
    const bad = await api().put(`/api/intramurals/${rafiki}/coaches/${coach.id}/privileges`).set(auth(admin)).send({ privileges: [{ permission: "schedules.edit" }] });
    expect(bad.status).toBe(400);
  });

  it("admins and super admins have exactly the same powers", async () => {
    // Even with every checkbox cleared, an admin can still do everything.
    await api().put(`/api/creator/users/${admin.id}/permissions`).set(auth(creator)).send({ permissions: [] }).expect(200);
    expect((await api().patch(`/api/intramurals/${daniels}`).set(auth(admin)).send({ location: "Daniels Field" })).status).toBe(200);
    await api().patch(`/api/intramurals/${rafiki}`).set(auth(admin)).send({ location: "Rafiki Field" }).expect(200);
    expect((await api().put(`/api/intramurals/${rafiki}/airtable`).set(auth(admin))
      .send({ formUrl: "https://airtable.com/appQFwbjGiTPwZQxc/shr1ZecAArGDFOWSQ", baseId: "", tableName: "", viewName: "", pushWalkIns: false, fieldMap: {} })).status).toBe(200);
    expect((await api().get(`/api/intramurals/${daniels}/players`).set(auth(admin))).status).toBe(200);
    expect((await api().put(`/api/intramurals/${rafiki}/coaches/${coach.id}/privileges`).set(auth(admin)).send({ privileges: [{ permission: "attendance.take" }, { permission: "players.register" }] })).status).toBe(200);
    const list = (await api().get("/api/intramurals").set(auth(admin))).body;
    expect(list.length).toBe((await api().get("/api/intramurals").set(auth(creator))).body.length);
  });
});

describe("parents", () => {
  it("sees nothing until an admin verifies the child link", async () => {
    const before = (await api().get("/api/parent/children").set(auth(parent))).body;
    expect(before.pending).toBe(true);
    expect((await api().get(`/api/players/${childId}/progress`).set(auth(parent))).status).toBe(403);
    const requests = (await api().get(`/api/intramurals/${rafiki}/parent-requests`).set(auth(admin))).body;
    expect(requests.find((r: { id: number }) => r.id === parent.id).children[0].playerId).toBe(childId);
    expect((await api().post("/api/parent-links/approve").set(auth(coach)).send({ parentId: parent.id, playerIds: [childId] })).status).toBe(403);
    await api().post("/api/parent-links/approve").set(auth(admin)).send({ parentId: parent.id, playerIds: [childId] }).expect(200);
    const after = (await api().get("/api/parent/children").set(auth(parent))).body;
    expect(after.children.map((c: { id: number }) => c.id)).toEqual([childId]);
  });

  it("only ever sees their own child", async () => {
    expect((await api().get(`/api/players/${childId}/progress`).set(auth(parent))).status).toBe(200);
    expect((await api().get(`/api/players/${otherChildId}/progress`).set(auth(parent))).status).toBe(403);
    expect((await api().get(`/api/players/${childId}/progress`).set(auth(strangerParent))).status).toBe(403);
    expect((await api().get(`/api/intramurals/${rafiki}/players`).set(auth(parent))).status).toBe(403);
    expect((await api().get(`/api/intramurals/${rafiki}/mentorship`).set(auth(parent))).status).toBe(403);
    expect((await api().get(`/api/intramurals/${daniels}`).set(auth(parent))).status).toBe(403);
    expect((await api().get(`/api/players/${otherChildId}/account`).set(auth(parent))).status).toBe(403);
    // Session logistics yes, coach roles no.
    const s = (await api().get(`/api/sessions/${sessionId}`).set(auth(parent))).body;
    expect(s.location).toBe("Rafiki Field");
    expect(s.roles).toBeUndefined();
    expect(s.poll).toBeUndefined();
  });

  it("gets progress with a virtue radar, feedback and an injury alert", async () => {
    await api().post(`/api/players/${childId}/virtues`).set(auth(coach)).send({ sessionId, scores: { wisdom: 8, fortitude: 9, teamwork: 7 } }).expect(201);
    await api().post(`/api/players/${childId}/feedback`).set(auth(coach)).send({ category: "Teamwork", rating: 4, note: "Great passing" }).expect(201);
    await api().post(`/api/players/${childId}/feedback`).set(auth(coach)).send({ category: "Attitude", rating: 2, note: "Coach only", visibleToParent: false }).expect(201);
    await api().post(`/api/players/${childId}/injuries`).set(auth(coach)).send({ sessionId, severity: "moderate", bodyPart: "ankle", description: "Twisted ankle in a tackle", actionTaken: "Ice applied" }).expect(201);
    await api().post(`/api/intramurals/${rafiki}/mentorship`).set(auth(coach)).send({ sessionId, playerId: childId, prayerPoints: "Private prayer point" }).expect(201);

    const p = (await api().get(`/api/players/${childId}/progress`).set(auth(parent))).body;
    expect(p.attendance.rate).toBe(100);
    expect(p.virtues.find((v: { virtue: string }) => v.virtue === "fortitude").average).toBe(9);
    expect(p.virtues).toHaveLength(6);
    expect(p.feedback.map((f: { note: string }) => f.note)).toEqual(["Great passing"]);
    expect(p.player.guardianEmail).toBeUndefined();
    expect(JSON.stringify(p)).not.toContain("Private prayer point");
    const notes = (await api().get("/api/notifications").set(auth(parent))).body;
    const injury = notes.find((n: { kind: string }) => n.kind === "injury");
    expect(injury.urgent).toBe(true);
    expect(injury.title).toMatch(/Amani picked up a moderate injury \(ankle\)/);
  });

  it("can delete their account", async () => {
    const temp = await signup({ countryId: KE, role: "parent", name: "temp parent", email: "temp@test.org", phone: "0733000000", password: "password1" });
    expect((await api().delete("/api/me").set(auth(temp)).send({ password: "wrong" })).status).toBe(400);
    await api().delete("/api/me").set(auth(temp)).send({ password: "password1" }).expect(200);
    expect((await api().get("/api/me").set(auth(temp))).status).toBe(401);
    expect(await one(`SELECT id FROM users WHERE email = 'temp@test.org'`)).toBeUndefined();
    // The email can be used again.
    await signup({ countryId: KE, role: "parent", name: "temp parent", email: "temp@test.org", phone: "0733000000", password: "password1" });
  });
});

describe("players", () => {
  it("prevents registering the same child twice", async () => {
    const res = await api().post(`/api/intramurals/${rafiki}/players`).set(auth(admin)).send({ firstName: "AMANI", lastName: "Otieno" });
    expect(res.status).toBe(409);
    expect(res.body.playerId).toBe(childId);
  });
});

describe("sessions", () => {
  it("uses each intramural's own day and moves untouched sessions when the day changes", async () => {
    const list = (await api().get("/api/intramurals").set(auth(creator))).body;
    expect(list.find((i: { id: number }) => i.id === rafiki).dayLabel).toBe("Tuesday Session");
    expect(list.find((i: { id: number }) => i.id === daniels).dayLabel).toBe("Saturday Session");
    await api().patch(`/api/intramurals/${daniels}`).set(auth(creator)).send({ sessionWeekday: 3, sessionStart: "14:00", sessionEnd: "15:30" }).expect(200);
    const sessions = (await api().get(`/api/intramurals/${daniels}/sessions?from=2020-01-01&to=2100-01-01`).set(auth(creator))).body;
    const future = sessions.filter((s: { date: string }) => s.date > new Date().toISOString().slice(0, 10));
    expect(future.length).toBeGreaterThan(0);
    for (const s of future) {
      expect(s.dayLabel).toBe("Wednesday");
      expect(s.timeLabel).toBe("2:00 PM – 3:30 PM");
    }
  });

  it("refuses a stale edit instead of overwriting", async () => {
    const s = (await api().get(`/api/sessions/${sessionId}`).set(auth(admin))).body;
    await api().patch(`/api/sessions/${sessionId}`).set(auth(admin)).send({ version: s.version, title: "First" }).expect(200);
    const stale = await api().patch(`/api/sessions/${sessionId}`).set(auth(admin)).send({ version: s.version, title: "Second" });
    expect(stale.status).toBe(409);
    expect(stale.body.latest.title).toBe("First");
  });
});

describe("offline sync", () => {
  it("applies a queued batch once, even when sent twice, and reports rejected ops", async () => {
    const ops = [
      { id: "op-walkin-000001", type: "walk_in", payload: { intramuralId: rafiki, firstName: "zawadi", lastName: "njeri", walkIn: true, checkIn: { sessionId, status: "present" } } },
      { id: "op-tally-0000001", type: "tally", payload: { intramuralId: rafiki, sessionId, kind: "match", team: "Lions", opponent: "Eagles", points: 3, opponentPoints: 1 } },
      { id: "op-attend-000001", type: "attendance", payload: { sessionId, entries: [{ playerId: otherChildId, status: "late", recordedAt: new Date().toISOString() }] } },
      { id: "op-other-0000001", type: "tally", payload: { intramuralId: daniels, kind: "sportsmanship", team: "x", points: 1 } },
    ];
    const first = (await api().post("/api/sync").set(auth(coach)).send({ ops })).body.results;
    if (!first.slice(0, 3).every((r: { ok: boolean }) => r.ok)) console.log(first);
    expect(first.slice(0, 3).every((r: { ok: boolean }) => r.ok)).toBe(true);
    expect(first[3]).toMatchObject({ ok: false, status: 403 });
    const again = (await api().post("/api/sync").set(auth(coach)).send({ ops })).body.results;
    expect(again[0].result.duplicate).toBe(true);
    expect(again[1].result.duplicate).toBe(true);
    expect((await one(`SELECT count(*) AS n FROM players WHERE first_name = 'Zawadi'`)).n).toBe(1);
    expect((await one(`SELECT a.status FROM attendance a JOIN players p ON p.id = a.player_id WHERE p.first_name = 'Zawadi'`)).status).toBe("present");
    expect((await one(`SELECT count(*) AS n FROM tally_events WHERE client_id = 'op-tally-0000001'`)).n).toBe(1);
  });

  it("an older attendance tap does not overwrite a newer one", async () => {
    const newer = new Date().toISOString();
    const older = new Date(Date.now() - 60000).toISOString();
    await api().put(`/api/sessions/${sessionId}/attendance`).set(auth(coach)).send({ entries: [{ playerId: childId, status: "present", recordedAt: newer }] }).expect(200);
    const r = (await api().put(`/api/sessions/${sessionId}/attendance`).set(auth(coach)).send({ entries: [{ playerId: childId, status: "absent", recordedAt: older }] })).body;
    expect(r.skipped).toBe(1);
  });
});

describe("M-PESA", () => {
  it("runs an STK push and completes via the (mock) callback", async () => {
    await api().post(`/api/players/${childId}/fees`).set(auth(admin)).send({ kind: "subscription", title: "Term 1 subscription", amount: 1500, dueDate: "2027-01-15" }).expect(201);
    let account = (await api().get(`/api/players/${childId}/account`).set(auth(parent))).body;
    expect(account.balance).toBe(1500);
    expect((await api().post("/api/payments/mpesa").set(auth(parent)).send({ playerId: childId, phone: "+256772000000", amount: 1500 })).status).toBe(400);
    expect((await api().post("/api/payments/mpesa").set(auth(strangerParent)).send({ playerId: childId, phone: "0711111111", amount: 1500 })).status).toBe(403);
    const start = await api().post("/api/payments/mpesa").set(auth(parent)).send({ playerId: childId, phone: "0711 111 111", amount: 1500, feeItemId: account.fees[0].id });
    expect(start.status).toBe(201);
    // A double tap does not send a second prompt.
    expect((await api().post("/api/payments/mpesa").set(auth(parent)).send({ playerId: childId, phone: "0711111111", amount: 1500 })).status).toBe(409);
    await new Promise((r) => setTimeout(r, 300));
    const status = (await api().get(`/api/payments/${start.body.paymentId}`).set(auth(parent))).body;
    expect(status.status).toBe("completed");
    expect(status.receipt).toMatch(/^MCK/);
    account = (await api().get(`/api/players/${childId}/account`).set(auth(parent))).body;
    expect(account.balance).toBe(0);
  });

  it("handles a real-shaped Daraja callback: secret, idempotency, amount check", async () => {
    const pay = await one(
      `INSERT INTO payments (player_id, payer_id, amount, phone, status, checkout_request_id) VALUES ($1,$2,500,'254711111111','pending','ws_CO_TEST_1') RETURNING id`,
      [childId, parent.id],
    );
    const body = (amount: number, code = 0) => ({
      Body: { stkCallback: { MerchantRequestID: "m1", CheckoutRequestID: "ws_CO_TEST_1", ResultCode: code, ResultDesc: "ok",
        CallbackMetadata: { Item: [{ Name: "Amount", Value: amount }, { Name: "MpesaReceiptNumber", Value: "RKT1234567" }, { Name: "PhoneNumber", Value: 254711111111 }] } } },
    });
    expect((await api().post("/api/mpesa/callback/wrong-secret").send(body(500))).status).toBe(404);
    await api().post("/api/mpesa/callback/cb-secret-123").send(body(500)).expect(200);
    await api().post("/api/mpesa/callback/cb-secret-123").send(body(500)).expect(200); // retry: no change
    const row = await one(`SELECT status, mpesa_receipt FROM payments WHERE id = $1`, [pay.id]);
    expect(row).toEqual({ status: "completed", mpesa_receipt: "RKT1234567" });

    const short = await one(`INSERT INTO payments (player_id, amount, status, checkout_request_id) VALUES ($1,500,'pending','ws_CO_TEST_2') RETURNING id`, [childId]);
    const b = body(1);
    b.Body.stkCallback.CheckoutRequestID = "ws_CO_TEST_2";
    b.Body.stkCallback.CallbackMetadata.Item[1].Value = "RKT7654321";
    await api().post("/api/mpesa/callback/cb-secret-123").send(b).expect(200);
    expect((await one(`SELECT status FROM payments WHERE id = $1`, [short.id])).status).toBe("failed");
  });
});

describe("reports", () => {
  it("generates the matchday PDF for admins only", async () => {
    await api().put(`/api/sessions/${sessionId}/equipment/before`).set(auth(admin)).send({ items: [{ itemId: 1, counted: 12 }] }).expect(200);
    await api().put(`/api/sessions/${sessionId}/equipment/after`).set(auth(admin)).send({ items: [{ itemId: 1, counted: 10 }] }).expect(200);
    expect((await api().get(`/api/sessions/${sessionId}/report.pdf`).set(auth(otherCoach))).status).toBe(403);
    expect((await api().get(`/api/sessions/${sessionId}/report.pdf`).set(auth(parent))).status).toBe(403);
    const res = await api().get(`/api/sessions/${sessionId}/report.pdf`).set(auth(admin)).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on("data", (c: Buffer) => chunks.push(c));
      r.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect((res.body as Buffer).subarray(0, 5).toString()).toBe("%PDF-");
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync("tmp", { recursive: true });
    writeFileSync("tmp/sample-report.pdf", res.body as Buffer);
  });
});

describe("Nov 2026 updates", () => {
  it("admins create parent accounts with linked children and temporary passwords", async () => {
    const created = await api().post("/api/creator/parents").set(auth(admin))
      .send({ name: "wanjiru kamau", email: "Wanjiru@Test.org", phone: "0744 555 666", playerIds: [otherChildId], password: "welcome2026" });
    expect(created.status).toBe(201);
    expect(created.body.temporaryPassword).toBe("welcome2026");
    const login = await api().post("/api/auth/login").send({ identifier: "0744555666", password: "welcome2026" });
    expect(login.status).toBe(200);
    expect(login.body.me.mustChangePassword).toBe(true);
    expect(login.body.me.children).toEqual([otherChildId]);
    const parents = (await api().get("/api/creator/parents").set(auth(admin))).body;
    expect(parents.find((p: { email: string }) => p.email === "wanjiru@test.org").name).toBe("Wanjiru Kamau");
    // Staff list and parents list never mix.
    const staff = (await api().get("/api/creator/users?kind=staff").set(auth(admin))).body;
    expect(staff.some((u: { role: string }) => u.role === "parent")).toBe(false);
    // Reset to a generated temporary password.
    const reset = await api().post(`/api/creator/users/${created.body.id}/password`).set(auth(admin)).send({});
    expect(reset.body.temporaryPassword.length).toBeGreaterThanOrEqual(8);
    expect((await api().post("/api/auth/login").send({ identifier: "0744555666", password: "welcome2026" })).status).toBe(401);
  });

  it("assigns coaches to schools and age groups; their Players tab follows", async () => {
    await api().put(`/api/creator/users/${otherCoach.id}/assignments`).set(auth(admin))
      .send({ assignments: [{ intramuralId: rafiki, ageGroups: ["U9"] }, { intramuralId: daniels, ageGroups: [] }] }).expect(200);
    const me = (await api().get("/api/me").set(auth(otherCoach))).body;
    expect(me.intramurals.sort()).toEqual([rafiki, daniels].sort());
    const detail = (await api().get(`/api/intramurals/${rafiki}`).set(auth(otherCoach))).body;
    expect(detail.myAgeGroups).toEqual(["U9"]);
    const mine = (await api().get(`/api/intramurals/${rafiki}/players?mine=1`).set(auth(otherCoach))).body;
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((p: { category: string }) => p.category === "U9")).toBe(true);
    await api().put(`/api/intramurals/${rafiki}/coaches/${otherCoach.id}/age-groups`).set(auth(admin)).send({ ageGroups: ["U11", "U13"] }).expect(200);
    expect((await api().get(`/api/intramurals/${rafiki}`).set(auth(otherCoach))).body.myAgeGroups).toEqual(["U11", "U13"]);
  });

  it("birth year puts a player in the right age group", async () => {
    const year = new Date().getFullYear();
    const r = await api().post(`/api/intramurals/${rafiki}/players`).set(auth(admin)).send({ firstName: "kioko", lastName: "mwende", birthYear: year - 10 });
    const p = (await api().get(`/api/intramurals/${rafiki}/players?q=kioko`).set(auth(admin))).body[0];
    expect(p.id).toBe(r.body.id);
    expect(p.birthYear).toBe(year - 10);
    expect(p.category).toBe("U11");
  });

  it("only Rafiki (school mode) uses the Virtue Teams; clubs run camps", async () => {
    const list = (await api().get("/api/intramurals").set(auth(creator))).body;
    const rafikiRow = list.find((i: { id: number }) => i.id === rafiki);
    expect(rafikiRow.programMode).toBe("school");
    expect(rafikiRow.teams.length).toBe(4);
    const rosslynRow = list.find((i: { slug: string }) => i.slug === "rosslyn");
    expect(rosslynRow.programMode).toBe("club");
    expect(rosslynRow.teams).toEqual([]);
    const camp = await api().post(`/api/intramurals/${rosslynRow.id}/sessions`).set(auth(admin))
      .send({ kind: "camp", title: "Summer Camp", date: "2026-12-16", endDate: "2026-12-18", startTime: "09:00", endTime: "15:00" });
    expect(camp.status).toBe(201);
    const s = (await api().get(`/api/sessions/${camp.body.id}`).set(auth(creator))).body;
    expect(s.kind).toBe("camp");
    expect(s.endDate).toBe("2026-12-18");
  });

  it("coaches send post-session reports to admins (also offline)", async () => {
    const r = await api().post(`/api/sessions/${sessionId}/reports`).set(auth(coach))
      .send({ ageGroup: "U9", presentCount: 5, rosterCount: 6, attendanceSummary: "Good turnout", pitchNotes: "Muddy goal mouth" });
    expect(r.status).toBe(201);
    const sync = (await api().post("/api/sync").set(auth(coach)).send({ ops: [{ id: "op-report-0000001", type: "session_report", payload: { sessionId, playerProgress: "Offline note" } }] })).body;
    expect(sync.results[0].ok).toBe(true);
    const adminView = (await api().get(`/api/intramurals/${rafiki}/reports`).set(auth(admin))).body;
    expect(adminView.length).toBe(2);
    const notes = (await api().get("/api/notifications").set(auth(admin))).body;
    expect(notes.some((n: { title: string }) => n.title.startsWith("Session report"))).toBe(true);
    expect((await api().get(`/api/intramurals/${rafiki}/reports`).set(auth(parent))).status).toBe(403);
  });

  it("emergency info: medical notes and parent numbers, for staff only", async () => {
    await api().patch(`/api/players/${childId}`).set(auth(admin)).send({ medicalNotes: "Asthma: inhaler in bag" }).expect(200);
    const e = (await api().get(`/api/players/${childId}/emergency`).set(auth(coach))).body;
    expect(e.medicalNotes).toMatch(/inhaler/);
    expect(e.contacts[0].phone).toBe("+254711111111");
    expect((await api().get(`/api/players/${childId}/emergency`).set(auth(parent))).status).toBe(403);
    expect((await api().get(`/api/players/${childId}/emergency`).set(auth(ugCoach))).status).toBe(403);
  });

  it("unpaid alerts reach the parent and can be cleared", async () => {
    expect((await api().post("/api/unpaid-alerts").set(auth(coach)).send({ playerIds: [childId], title: "Summer Camp" })).status).toBe(403);
    await api().post("/api/unpaid-alerts").set(auth(admin)).send({ playerIds: [childId], title: "Summer Camp", amount: 2500, note: "Due Friday" }).expect(201);
    const kids = (await api().get("/api/parent/children").set(auth(parent))).body.children;
    expect(kids.find((k: { id: number }) => k.id === childId).unpaidAlerts).toBe(1);
    const mine = (await api().get(`/api/players/${childId}/unpaid-alerts`).set(auth(parent))).body;
    expect(mine[0].title).toBe("Summer Camp");
    expect((await api().get(`/api/players/${otherChildId}/unpaid-alerts`).set(auth(parent))).status).toBe(403);
    const open = (await api().get(`/api/intramurals/${rafiki}/unpaid-alerts`).set(auth(admin))).body;
    await api().post(`/api/unpaid-alerts/${open[0].id}/resolve`).set(auth(admin)).expect(200);
    expect((await api().get("/api/parent/children").set(auth(parent))).body.children.find((k: { id: number }) => k.id === childId).unpaidAlerts).toBe(0);
  });

  it("parents can see every school's registration form (public details only)", async () => {
    const programs = (await api().get("/api/parent/programs").set(auth(parent))).body;
    expect(programs.find((p: { mine: boolean }) => p.mine).id).toBe(rafiki);
    expect(programs.find((p: { slug?: string; name: string }) => p.name === "Rosslyn Academy").formUrl).toMatch(/airtable\.com/);
    expect(programs[0].players).toBeUndefined();
  });
});

describe("super admin metrics", () => {
  it("reports impact per country", async () => {
    const m = (await api().get("/api/creator/metrics").set(auth(creator))).body;
    const ke = m.find((c: { code: string }) => c.code === "KE");
    expect(ke.players).toBeGreaterThanOrEqual(3);
    expect(ke.collected).toBeGreaterThan(0);
    expect(m.find((c: { code: string }) => c.code === "UG").intramurals).toBe(1);
    void query;
  });
});
