import bcrypt from "bcryptjs";
import { one, query } from "./db.js";
import { addDays, nextWeekday, today, seasonOf } from "./util.js";
import { ensureUpcomingSessions } from "./routes/intramurals.js";
import { ADMIN_PERMISSIONS } from "./auth.js";

/**
 * Demo people and a season of activity for Rafiki, so every screen has
 * something to show. Runs only on an empty database (no users yet), so it
 * never touches real data. Every demo account's password is "ambassadors1".
 */
export const DEMO_PASSWORD = "ambassadors1";
export const DEMO_ACCOUNTS = [
  { role: "Super Admin", email: "director@demo.ambassadors" },
  { role: "Coordinator", email: "kate@demo.ambassadors" },
  { role: "Coach", email: "coach@demo.ambassadors" },
  { role: "Parent", email: "parent@demo.ambassadors" },
] as const;

export async function seedDemo(): Promise<boolean> {
  const existing = await one(`SELECT count(*) AS n FROM users`);
  if (Number(existing.n) > 0) return false;
  const ke = (await one(`SELECT id FROM countries WHERE code = 'KE'`)).id;
  const rafiki = (await one(`SELECT id FROM intramurals WHERE slug = 'rafiki'`)).id;
  await query(`UPDATE intramurals SET location = 'Rafiki main field', dress_code = 'Navy training top, shorts, shin guards, water bottle' WHERE id = $1`, [rafiki]);
  const hash = await bcrypt.hash(DEMO_PASSWORD, 10);

  async function user(email: string, name: string, phone: string, role: string, status = "active") {
    const row = await one(
      `INSERT INTO users (email, phone, name, password_hash, role, status, country_id) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (lower(email)) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [email, phone, name, hash, role, status, ke],
    );
    return row.id as number;
  }
  const creator = await user(DEMO_ACCOUNTS[0].email, "Abel Kamau", "+254700100100", "super_admin");
  const admin = await user(DEMO_ACCOUNTS[1].email, "Kate Agosa", "+254700100101", "admin");
  const coachA = await user(DEMO_ACCOUNTS[2].email, "Denilson Mwenjwa", "+254700100102", "coach");
  const coachB = await user("faith@demo.ambassadors", "Faith Wambui", "+254700100103", "coach");
  const parent = await user(DEMO_ACCOUNTS[3].email, "Grace Otieno", "+254711111111", "parent");
  for (const u of [admin, coachA, coachB]) await query(`INSERT INTO user_intramurals VALUES ($1,$2) ON CONFLICT DO NOTHING`, [u, rafiki]);
  await query(`INSERT INTO user_permissions (user_id, permission) SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING`, [admin, [...ADMIN_PERMISSIONS]]);
  await query(`INSERT INTO user_permissions (user_id, permission, intramural_id, granted_by) VALUES ($1,'attendance.take',$2,$3),($1,'players.register',$2,$3),($1,'equipment.check',$2,$3) ON CONFLICT DO NOTHING`, [coachA, rafiki, admin]);

  const names = [
    ["Amani", "Otieno", "U9", "wisdom"], ["Neema", "Otieno", "U7", "justice"], ["Baraka", "Kiprop", "U9", "fortitude"], ["Zawadi", "Njeri", "U11", "temperance"],
    ["Imani", "Mwangi", "U11", "wisdom"], ["Jabari", "Ochieng", "U13", "justice"], ["Wanjiku", "Kamau", "U9", "fortitude"], ["Tumaini", "Kariuki", "U7", "temperance"],
    ["Kito", "Mutua", "U13", "wisdom"], ["Nia", "Wekesa", "U11", "justice"], ["Malik", "Odhiambo", "U9", "fortitude"], ["Ayana", "Chebet", "U7", "temperance"],
    ["Jelani", "Kibet", "U13", "wisdom"], ["Makena", "Nyambura", "U11", "justice"], ["Omari", "Juma", "U9", "fortitude"], ["Shani", "Atieno", "U13", "temperance"],
    ["Tendai", "Muriuki", "U7", "wisdom"], ["Eshe", "Langat", "U11", "justice"],
  ];
  const ids: number[] = [];
  for (const [first, last, cat, team] of names) {
    const guardian = last === "Otieno" ? ["Grace Otieno", DEMO_ACCOUNTS[3].email, "+254711111111"] : [`Parent ${last}`, "", ""];
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
  const pending = await user("peter@demo.ambassadors", "Peter Kiprop", "+254722222222", "parent", "pending");
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
    await query(`INSERT INTO tally_events (intramural_id, session_id, kind, team, opponent, points, opponent_points, category, recorded_by) VALUES ($1,$2,'match','Wisdom','Justice',$3,$4,'U9',$5)`, [rafiki, s.id, w % 3, (w + 1) % 2, coachA]);
    for (const team of ["wisdom", "justice", "fortitude", "temperance"]) {
      await query(`INSERT INTO tally_events (intramural_id, session_id, kind, team, points, recorded_by) VALUES ($1,$2,'virtue_points',$3,$4,$5)`, [rafiki, s.id, team, (team.length + w) % 4 + 1, coachA]);
    }
    if (w === 1) {
      await query(`INSERT INTO injuries (player_id, session_id, severity, body_part, description, action_taken, reported_by) VALUES ($1,$2,'minor','right knee','Fell on the hard ground during the small-sided match.','Cleaned and plastered; rested 10 minutes, then played on.',$3)`, [amani, s.id, coachA]);
      await query(`INSERT INTO character_awards (intramural_id, player_id, session_id, week_of, award, virtue, reason, awarded_by) VALUES ($1,$2,$3,$4,'Fortitude Award','fortitude','Kept encouraging his team after going 2–0 down.',$5)`, [rafiki, amani, s.id, addDays(date, -1), coachA]);
      await query(`INSERT INTO mentorship_logs (intramural_id, session_id, coach_id, discussion_notes, scripture, scripture_milestone, prayer_points) VALUES ($1,$2,$3,'Talked about courage when things go wrong on the pitch.','Joshua 1:9','U11s memorised Joshua 1:9','Families travelling over the holidays')`, [rafiki, s.id, coachA]);
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
  return true;
}

/**
 * Demo examples for features added later (Nov 2026: age groups, camps, coach
 * reports, unpaid alerts). Runs once, on demo databases only: it does nothing
 * unless the demo accounts exist, and nothing twice (Rosslyn's Summer Camp is the marker).
 */
export async function seedDemoExtras(): Promise<void> {
  const coach = await one(`SELECT id FROM users WHERE email = $1`, [DEMO_ACCOUNTS[2].email]);
  const admin = await one(`SELECT id FROM users WHERE email = $1`, [DEMO_ACCOUNTS[1].email]);
  const parent = await one(`SELECT id FROM users WHERE email = $1`, [DEMO_ACCOUNTS[3].email]);
  const rafiki = await one(`SELECT id FROM intramurals WHERE slug = 'rafiki'`);
  const rosslyn = await one(`SELECT id FROM intramurals WHERE slug = 'rosslyn'`);
  if (!coach || !admin || !parent || !rafiki || !rosslyn) return;
  if (await one(`SELECT 1 FROM sessions WHERE intramural_id = $1 AND kind = 'camp'`, [rosslyn.id])) return;

  const season = Number(today().slice(0, 4));
  // Birth years matching each age group (U9 → 8 years old this season).
  await query(
    `UPDATE players SET birth_year = $1 - (substring(category from 2)::int - 1)
      WHERE birth_year IS NULL AND category ~ '^U[0-9]+$'`,
    [season],
  );
  // The demo coach rotates: Rafiki U9 and U11, plus every age at Rosslyn.
  await query(`UPDATE user_intramurals SET age_groups = '{U9,U11}' WHERE user_id = $1 AND intramural_id = $2`, [coach.id, rafiki.id]);
  await query(`INSERT INTO user_intramurals (user_id, intramural_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [coach.id, rosslyn.id]);
  await query(`INSERT INTO user_intramurals (user_id, intramural_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [admin.id, rosslyn.id]);

  // A few Rosslyn players and a Summer Camp.
  for (const [first, last, cat, med] of [
    ["Liam", "Wanyama", "U9", ""], ["Aisha", "Hassan", "U11", "Peanut allergy: EpiPen in her bag"], ["Daniel", "Kimani", "U11", ""],
    ["Zuri", "Achieng", "U13", ""], ["Noah", "Mbugua", "U7", ""], ["Imara", "Wambui", "U13", ""],
  ]) {
    await query(
      `INSERT INTO players (intramural_id, first_name, last_name, category, birth_year, guardian_name, guardian_phone, medical_notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
      [rosslyn.id, first, last, cat, season - (Number(cat.slice(1)) - 1), `Parent ${last}`, `+2547${String(10000000 + first.length * 1234567).slice(0, 8)}`, med, admin.id],
    );
  }
  const campStart = addDays(today(), 25);
  await query(
    `INSERT INTO sessions (intramural_id, date, end_date, kind, title, start_time, end_time, location, dress_code, travel_notes, schedule, roles, version)
     VALUES ($1,$2,$3,'camp','Summer Camp',time '09:00',time '15:00','Rosslyn Academy fields','Club kit, sun hat, water bottle, packed lunch',
             'Drop-off at the Rosslyn main gate from 8:45 AM. Pick-up 3:00 PM.',
             '[{"time":"09:00","activity":"Arrival & warm-up"},{"time":"10:00","activity":"Skills stations"},{"time":"12:00","activity":"Lunch"},{"time":"13:00","activity":"Mini tournament"},{"time":"14:45","activity":"Awards & prayer"}]',
             '[]', 2)`,
    [rosslyn.id, campStart, addDays(campStart, 2)],
  );
  await query(
    `INSERT INTO sessions (intramural_id, date, kind, title, start_time, end_time, location, roles, version)
     VALUES ($1,$2,'clinic','Goalkeeping Clinic',time '10:00',time '12:00','Rosslyn Academy fields','[]',2)`,
    [rosslyn.id, nextWeekday(0, addDays(today(), 3))],
  );

  // A post-session report from the coach on Rafiki's last session.
  const last = await one(`SELECT id FROM sessions WHERE intramural_id = $1 AND date < current_date AND kind = 'training' ORDER BY date DESC LIMIT 1`, [rafiki.id]);
  if (last) {
    await query(
      `INSERT INTO session_reports (session_id, coach_id, age_group, present_count, roster_count, attendance_summary, player_progress, pitch_notes)
       VALUES ($1,$2,'U9',5,6,'5 of 6 U9s came; Malik absent (family travel).',
               'Amani led the warm-up and encouraged the younger ones. Baraka''s first touch is improving.',
               'Goal mouth on the lower pitch is muddy; we used the upper pitch.')`,
      [last.id, coach.id],
    );
  }
  // Neema has an unpaid tournament fee.
  const neema = await one(`SELECT id FROM players WHERE first_name = 'Neema' AND last_name = 'Otieno'`);
  if (neema) {
    await query(`INSERT INTO unpaid_alerts (player_id, title, amount, note, created_by) VALUES ($1,'Christmas tournament',800,'Please pay before 12 December so we can register the team.',$2)`, [neema.id, admin.id]);
    await query(
      `INSERT INTO notifications (user_id, kind, title, body, link, urgent) VALUES ($1,'payment','Unpaid: Christmas tournament for Neema (KES 800)','Please pay before 12 December so we can register the team.','/child/' || $2::text, true)`,
      [parent.id, neema.id],
    );
  }
}
