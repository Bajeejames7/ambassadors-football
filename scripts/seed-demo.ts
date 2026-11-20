/**
 * Demo data for trying the app (never run against production).
 *   DATABASE_URL=… CREATOR_EMAIL=… npx tsx scripts/seed-demo.ts
 * Creates: an admin, two coaches and a parent (password "ambassadors1"),
 * 18 Rafiki players, last month's attendance, virtue scores, feedback, awards,
 * a fee, a match, and an injury, so every screen has something to show.
 */
import bcrypt from "bcryptjs";
import { migrate } from "../server/migrations.js";
import { closePool, one, query } from "../server/db.js";
import { addDays, nextWeekday, today, seasonOf } from "../server/util.js";
import { ensureUpcomingSessions } from "../server/routes/intramurals.js";
import { ADMIN_PERMISSIONS } from "../server/auth.js";

await migrate();
const ke = (await one(`SELECT id FROM countries WHERE code = 'KE'`)).id;
const rafiki = (await one(`SELECT id FROM intramurals WHERE slug = 'rafiki'`)).id;
await query(`UPDATE intramurals SET location = 'Rafiki main field', dress_code = 'Navy training top, shorts, shin guards, water bottle' WHERE id = $1`, [rafiki]);
const hash = await bcrypt.hash("ambassadors1", 10);

async function user(email: string, name: string, phone: string, role: string, status = "active") {
  const row = await one(
    `INSERT INTO users (email, phone, name, password_hash, role, status, country_id) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (lower(email)) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    [email, phone, name, hash, role, status, ke],
  );
  return row.id as number;
}
const creator = await user(process.env.CREATOR_EMAIL ?? "creator@example.org", "Abel Kamau", "+254700100100", "super_admin");
const admin = await user("kate@example.org", "Kate Agosa", "+254700100101", "admin");
const coachA = await user("denilson@example.org", "Denilson Mwenjwa", "+254700100102", "coach");
const coachB = await user("faith@example.org", "Faith Wambui", "+254700100103", "coach");
const parent = await user("grace@example.org", "Grace Otieno", "+254711111111", "parent");
for (const u of [admin, coachA, coachB]) await query(`INSERT INTO user_intramurals VALUES ($1,$2) ON CONFLICT DO NOTHING`, [u, rafiki]);
await query(`INSERT INTO user_permissions (user_id, permission) SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING`, [admin, [...ADMIN_PERMISSIONS]]);
await query(`INSERT INTO user_permissions (user_id, permission, intramural_id, granted_by) VALUES ($1,'attendance.take',$2,$3),($1,'players.register',$2,$3),($1,'equipment.check',$2,$3) ON CONFLICT DO NOTHING`, [coachA, rafiki, admin]);

const names = [
  ["Amani", "Otieno", "Under 9", "wisdom"], ["Neema", "Otieno", "Under 7", "justice"], ["Baraka", "Kiprop", "Under 9", "fortitude"], ["Zawadi", "Njeri", "Under 11", "temperance"],
  ["Imani", "Mwangi", "Under 11", "wisdom"], ["Jabari", "Ochieng", "Under 13", "justice"], ["Wanjiku", "Kamau", "Under 9", "fortitude"], ["Tumaini", "Kariuki", "Under 7", "temperance"],
  ["Kito", "Mutua", "Under 13", "wisdom"], ["Nia", "Wekesa", "Under 11", "justice"], ["Malik", "Odhiambo", "Under 9", "fortitude"], ["Ayana", "Chebet", "Under 7", "temperance"],
  ["Jelani", "Kibet", "Under 13", "wisdom"], ["Makena", "Nyambura", "Under 11", "justice"], ["Omari", "Juma", "Under 9", "fortitude"], ["Shani", "Atieno", "Under 13", "temperance"],
  ["Tendai", "Muriuki", "Under 7", "wisdom"], ["Eshe", "Langat", "Under 11", "justice"],
];
const ids: number[] = [];
for (const [first, last, cat, team] of names) {
  const guardian = last === "Otieno" ? ["Grace Otieno", "grace@example.org", "+254711111111"] : [`Parent ${last}`, "", ""];
  const r = await one(
    `INSERT INTO players (intramural_id, first_name, last_name, category, team, guardian_name, guardian_email, guardian_phone, created_by, medical_notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING RETURNING id`,
    [rafiki, first, last, cat, team, ...guardian, admin, first === "Kito" ? "Asthma: inhaler in bag" : ""],
  );
  ids.push(r?.id ?? (await one(`SELECT id FROM players WHERE first_name = $1 AND last_name = $2`, [first, last])).id);
}
const [amani, neema] = ids;
for (const kid of [amani, neema]) {
  await query(`INSERT INTO parent_children (parent_id, player_id, verified_by, verified_at) VALUES ($1,$2,$3,now()) ON CONFLICT DO NOTHING`, [parent, kid, admin]);
}
// A parent waiting for approval.
const pending = await user("peter@example.org", "Peter Kiprop", "+254722222222", "parent", "pending");
await query(`INSERT INTO parent_children (parent_id, player_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [pending, ids[2]]);

// Past Tuesday sessions with attendance and scores.
const t = today();
const lastTuesday = addDays(nextWeekday(2, t), -7);
const VIRTUES = ["temperance", "wisdom", "fortitude", "justice", "teamwork", "discipline"];
for (let w = 6; w >= 1; w--) {
  const date = addDays(lastTuesday, -7 * (w - 1));
  const s = await one(
    `INSERT INTO sessions (intramural_id, date, kind, start_time, end_time, location, dress_code, schedule, roles, version)
     SELECT id, $2, 'training', session_start, session_end, location, dress_code, default_schedule,
            (SELECT jsonb_agg(jsonb_build_object('role', r, 'userId', $3::int)) FROM jsonb_array_elements_text(default_roles) r), 2
       FROM intramurals WHERE id = $1
     ON CONFLICT (intramural_id, date) WHERE kind = 'training' DO UPDATE SET version = 2 RETURNING id`,
    [rafiki, date, coachA],
  );
  for (const [k, pid] of ids.entries()) {
    const status = (k + w) % 7 === 0 ? "absent" : (k + w) % 5 === 0 ? "late" : "present";
    await query(
      `INSERT INTO attendance (session_id, player_id, status, checked_in_at, recorded_by, recorded_at) VALUES ($1,$2,$3,($4::date + time '15:18') AT TIME ZONE 'Africa/Nairobi',$5,now())
       ON CONFLICT DO NOTHING`,
      [s.id, pid, status, date, coachA],
    );
  }
  for (const pid of [amani, neema, ids[4]]) {
    for (const v of VIRTUES) {
      const base = pid === neema ? 5 : 4;
      const score = Math.min(10, base + Math.round((6 - w) * 0.7) + (v.length % 3));
      await query(`INSERT INTO virtue_scores (player_id, session_id, virtue, score, season, recorded_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7::date)`,
        [pid, s.id, v, score, seasonOf(date), coachA, date]);
    }
  }
  await query(`INSERT INTO tally_events (intramural_id, session_id, kind, team, opponent, points, opponent_points, category, recorded_by) VALUES ($1,$2,'match','Wisdom','Justice',$3,$4,'Under 9',$5)`, [rafiki, s.id, w % 3, (w + 1) % 2, coachA]);
  for (const team of ["wisdom", "justice", "fortitude", "temperance"]) {
    await query(`INSERT INTO tally_events (intramural_id, session_id, kind, team, points, recorded_by) VALUES ($1,$2,'virtue_points',$3,$4,$5)`, [rafiki, s.id, team, (team.length + w) % 4 + 1, coachA]);
  }
  if (w === 1) {
    await query(`INSERT INTO injuries (player_id, session_id, severity, body_part, description, action_taken, reported_by) VALUES ($1,$2,'minor','right knee','Fell on the hard ground during the small-sided match.','Cleaned and plastered; rested 10 minutes, then played on.',$3)`, [amani, s.id, coachA]);
    await query(`INSERT INTO character_awards (intramural_id, player_id, session_id, week_of, award, virtue, reason, awarded_by) VALUES ($1,$2,$3,$4,'Fortitude Award','fortitude','Kept encouraging his team after going 2–0 down.',$5)`, [rafiki, amani, s.id, addDays(date, -1), coachA]);
    await query(`INSERT INTO mentorship_logs (intramural_id, session_id, coach_id, discussion_notes, scripture, scripture_milestone, prayer_points) VALUES ($1,$2,$3,'Talked about courage when things go wrong on the pitch.','Joshua 1:9','Under 11s memorised Joshua 1:9','Families travelling over the holidays')`, [rafiki, s.id, coachA]);
  }
}
await query(`INSERT INTO coach_feedback (player_id, category, rating, note, coach_id) VALUES
  ($1,'Teamwork',5,'Always looks for the pass and celebrates his teammates.',$3),
  ($1,'Technical',4,'Much better first touch with his left foot.',$3),
  ($1,'Attitude',4,'Listens well and is first to help pack the cones.',$4),
  ($2,'Teamwork',4,'Lovely energy with the younger players.',$3)`, [amani, neema, coachA, coachB]);
await query(`INSERT INTO fee_items (player_id, kind, title, amount, currency, due_date, created_by) VALUES
  ($1,'subscription','Term 1 2027 subscription',3500,'KES',$3,$4),
  ($1,'tournament','Christmas tournament',800,'KES',$5,$4),
  ($2,'subscription','Term 1 2027 subscription',3500,'KES',$3,$4)`, [amani, neema, addDays(t, 40), admin, addDays(t, 12)]);
await query(`INSERT INTO payments (player_id, payer_id, method, amount, currency, phone, status, mpesa_receipt, completed_at, created_at)
  VALUES ($1,$2,'mpesa',2000,'KES','254711111111','completed','SKL4XYZ12A', now() - interval '9 days', now() - interval '9 days')
  ON CONFLICT DO NOTHING`, [neema, parent]);
await ensureUpcomingSessions(rafiki);
await query(`INSERT INTO sessions (intramural_id, date, kind, title, opponent, start_time, end_time, location, dress_code, travel_notes, roles, version)
  VALUES ($1,$2,'match','','Daniels School',time '09:30',time '12:00','Daniels School main pitch','Full navy match kit','Bus leaves the Rafiki front gate at 8:15 AM. Pick-up back at Rafiki at 12:45 PM.','[]',2)
  ON CONFLICT DO NOTHING`, [rafiki, nextWeekday(6, addDays(t, 1))]);
await query(`INSERT INTO notifications (user_id, kind, title, body, link, urgent) VALUES
  ($1,'award','Amani received the Fortitude Award! 🏅','Kept encouraging his team after going 2–0 down.','/child/' || $2::text, false),
  ($1,'schedule','Match vs Daniels School on Saturday','9:30 AM – 12:00 PM\nDaniels School main pitch','/schedule', false)`, [parent, amani]);
console.log("Demo data ready. Password for every demo account: ambassadors1", { creator, admin, coachA, parent });
await closePool();
