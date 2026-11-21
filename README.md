# Ambassadors Football

**Football. Faith. Future.** One app for coaches, coordinators, parents and Super Admins across every partner school and club, in every country.

It's a mobile-first Progressive Web App: it installs from the browser, opens on the pitch with no signal, and can be wrapped for the Google Play Store as a Trusted Web Activity (see [Google Play](#google-play-2027)).

## What's in it

| Module | What it does |
|---|---|
| **Roles & access** | Four roles: Super Admin, Admin/Coordinator, Coach and Parent. The server checks every request by role, country, intramural and permission. The web app hides what you can't use, but the protection is on the server. |
| **Creator Control** | Super Admins only. Promote or demote people, tick per-admin permissions, assign schools, give a country override, add countries and schools, see international impact metrics, and read the activity log. |
| **Field privileges** | Admins give individual coaches task-specific powers (take attendance, register walk-ins, run the equipment checklist, generate reports) for one school, optionally with an end date. They can never hand out Setup or delete controls. |
| **Parent Dashboard** | Attendance rate, check-in history, coach feedback by category, a virtue radar (Temperance, Wisdom, Fortitude, Justice, Teamwork, Discipline) compared with the start of the season, awards, injury alerts, fixtures with kit and travel, fees, M-PESA checkout, and sibling registration through the school's own Airtable form. |
| **Parent isolation** | A parent sees nothing until a coordinator confirms which children are theirs. After that they see only those children and their schools: no school switcher, no polls, no admin pages, and never mentorship notes. |
| **Mentorship** | Coach-only reflection logs (discussion, scripture and milestones, prayer points, welfare), tallies, sportsmanship points and weekly character awards. |
| **Field Mode (offline)** | Roll call, walk-in registration with check-in, equipment counts before and after the session, match scores, team points and injury reports all work with no signal. They're queued on the phone with a *Pending sync* badge and sync by themselves through Background Sync, or when the app reopens. Re-sent items are applied once. |
| **Airtable** | Each school has its own registration form link, plus an optional base, table and token for instant player search, importing, and copying walk-ins back to Airtable. The token never leaves the server. |
| **M-PESA** | Daraja STK Push, a secured callback, a status query fallback when the callback is late, and protection against double-tap, wrong amounts and replayed callbacks. Parents pay the full balance or a single charge. Admins can bulk-charge a term fee and record cash or bank payments. |
| **Matchday report** | One click makes a PDF with results, team points, attendance by age group, coach availability and roles, equipment before and after (with missing items), virtue milestones and awards, mentorship counts (details stay confidential) and injuries. |
| **Play Store compliance** | Privacy policy covering youth data at `/privacy`, an in-app **Delete my account** with password confirmation, a public `/delete-account` page (Play asks for a web link), and `/.well-known/assetlinks.json`. |

### Bug fixes carried over from the prototype

- **Duplicate profiles:** emails are unique regardless of case, and phone numbers are normalised to +254… before a uniqueness check. Players are unique per school by name and date of birth.
- **Name casing:** names are Title Cased as you type and again on the server ("o'brien-smith" becomes "O'Brien-Smith").
- **Session labels:** each school's own day gives "Tuesday Session" or "Saturday Session". Changing the day in Setup moves the untouched upcoming sessions. Every time shows AM/PM.

## Run it on your computer

You need Node.js 20+ and Postgres (for example `docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=ambassadors postgres:16`).

```bash
cp .env.example .env               # fill it in
npm install
npm run seed:demo                  # optional demo data; every demo password is "ambassadors1"
npm run dev                        # web on http://localhost:5173, API on :3000
```

Demo sign-ins after `seed:demo`: `CREATOR_EMAIL` (Super Admin), `kate@example.org` (Admin), `denilson@example.org` (Coach with field privileges), `grace@example.org` (Parent of Amani and Neema), and `peter@example.org` (a parent waiting for approval).

- `npm test` runs 22 API tests against a real database (`TEST_DATABASE_URL`, which gets wiped). They cover access rules, country isolation, parent isolation, duplicates, offline sync, M-PESA and the PDF report.
- `npm run typecheck`, then `npm run build`, then `npm start` (one server for the app and the API).

## Where it runs now (demo)

It runs inside the **Rafiki_games** Render service at **`/ambassadors/`**, the same way interschool runs at `/interschool/`:

- `npm run embed -- ../Rafiki_games/artifacts/api-server/ambassadors` builds `server.mjs` + `web/` for the `/ambassadors/` path and copies them into the Rafiki repo; commit and push Rafiki and Render redeploys.
- It reuses Rafiki's `INTERSCHOOL_DATABASE_URL` but keeps all its tables in its own Postgres schema, `ambassadors_football`, so interschool's data is never touched.
- Demo mode is on: the sign-in screen offers demo accounts (password `ambassadors1`). Before real families use it, set `AMBASSADORS_DEMO=0` on Render (and `AMBASSADORS_CREATOR_EMAIL` to the Super Admin's email). See `artifacts/api-server/src/lib/ambassadors.ts` in Rafiki_games for every setting.

## Put it online

1. Create a Postgres database (Neon free tier works) and copy its connection string.
2. On Render: **New → Blueprint**, then pick this repo. `render.yaml` sets everything up. Fill in `DATABASE_URL` and `CREATOR_EMAIL`.
3. Sign up with the creator email. You're the Super Admin. Open **Creator** to promote coordinators and assign them to schools.

### M-PESA: mock → sandbox → live

- `MPESA_MODE=mock` (default) makes no Safaricom calls. A payment completes by itself after about 5 seconds, and numbers ending in `000` act as "cancelled". Use it for demos.
- `sandbox`: create an app at developer.safaricom.co.ke, then set `MPESA_CONSUMER_KEY`, `MPESA_CONSUMER_SECRET`, `MPESA_PASSKEY` (shortcode `174379`). `PUBLIC_URL` must be the public https address, because the callback is `PUBLIC_URL/api/mpesa/callback/MPESA_CALLBACK_SECRET`.
- `production`: go live on the Daraja portal and use your own paybill or till and passkey.

### Airtable

The registration links for Rafiki, Rosslyn and ICC Imara are already set, and their base IDs come from those links. For instant search, an admin opens **School → Setup → Airtable for…**, adds the table name and a personal access token (scope `data.records:read`, plus `data.records:write` to copy walk-ins), and checks the field names match the base.

## Google Play (2027)

The app is a PWA with a manifest, maskable icons, a service worker and an offline shell, so it packages as a Trusted Web Activity:

1. `npx @bubblewrap/cli init --manifest https://YOUR-DOMAIN/manifest.webmanifest`, then `bubblewrap build`.
2. Upload to Play Console with Play App Signing on. Copy the app-signing SHA-256 into `ANDROID_SHA256` and the package name into `ANDROID_PACKAGE`. `/.well-known/assetlinks.json` then serves them, which removes the browser bar.
3. Data safety form: you collect names, email, phone, children's information and payment info. Data is encrypted in transit, users can request deletion (in the app and at `/delete-account`), and nothing is shared for advertising.
4. The target audience is adults (parents and coaches). Children don't have accounts.

## How the code is laid out

```
server/
  auth.ts              roles, permissions, country scoping, parent↔child isolation (every check lives here)
  migrations.ts        the whole schema, plus the starting schools and Airtable links
  lib/field.ts         offline-safe field actions (shared by REST and /api/sync)
  lib/mpesa.ts         Daraja STK push, query, mock
  lib/airtable.ts      search, import, walk-in push with retry
  routes/              auth, creator, people, intramurals, sessions, players, coaching, payments, airtable, sync, reports
web/
  sw-template.js       service worker: offline shell + Background Sync of the outbox
  src/lib/offline.ts   IndexedDB outbox, cached reads, sync loop
  src/pages/           Parent, Staff, Field, Hub, Admin, Creator, Account, Auth
tests/api.test.ts      what the API must do
scripts/seed-demo.ts   demo data
```

## Choices made while building (worth checking)

- **Daniels, ICC Imara and Rosslyn start on Saturdays** (9:00–11:00 AM; Rosslyn 9:30–11:30 AM). Rafiki keeps Tuesday, 3:15–4:50 PM, with its full timetable. Change any of them in Setup.
- **Coaches sign up themselves**, but see nothing until a coordinator adds them to a school. **Parents need approval.**
- **A coach's mentorship logs are visible to that coach and to admins**, not to other coaches.
- **Virtue scores are 1–10**, and a season is the calendar year.
- **New admins start with every permission ticked.** Untick in Creator Control.
- **Deleting an account keeps payment records** (accounting) but removes the phone number and the link to the person.
