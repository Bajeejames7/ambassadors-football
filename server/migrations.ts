import { getPool } from "./db.js";
import { config } from "./config.js";

/**
 * Database schema, applied in order at startup. Each migration runs once in a
 * transaction and is recorded in schema_migrations. Never edit one that has
 * shipped: add a new one after it.
 */
const migrations: { id: string; sql: string }[] = [
  {
    id: "001_core",
    sql: `
      -- ---------------------------------------------------------------- countries
      CREATE TABLE countries (
        id           serial PRIMARY KEY,
        code         char(2) NOT NULL UNIQUE,          -- ISO 3166-1 alpha-2
        name         text NOT NULL,
        currency     char(3) NOT NULL DEFAULT 'KES',
        time_zone    text NOT NULL DEFAULT 'Africa/Nairobi',
        phone_prefix text NOT NULL DEFAULT '+254',
        mpesa        boolean NOT NULL DEFAULT false,   -- M-PESA STK push available here
        active       boolean NOT NULL DEFAULT true,
        created_at   timestamptz NOT NULL DEFAULT now()
      );

      -- ------------------------------------------------------------------- users
      CREATE TABLE users (
        id                   serial PRIMARY KEY,
        email                text NOT NULL,
        phone                text,                      -- E.164, e.g. +254712345678
        name                 text NOT NULL,             -- always stored Title Cased
        password_hash        text NOT NULL,
        role                 text NOT NULL DEFAULT 'coach'
                             CHECK (role IN ('super_admin', 'admin', 'coach', 'parent')),
        -- pending: waiting for approval (parents); active; suspended
        status               text NOT NULL DEFAULT 'active' CHECK (status IN ('pending', 'active', 'suspended')),
        country_id           int REFERENCES countries(id),
        must_change_password boolean NOT NULL DEFAULT false,
        -- Bumped on sign-out-everywhere, role change and deletion: old tokens stop working.
        token_version        int NOT NULL DEFAULT 1,
        created_at           timestamptz NOT NULL DEFAULT now()
      );
      -- No duplicate profiles: one account per email and per phone number.
      CREATE UNIQUE INDEX users_email_uq ON users (lower(email));
      CREATE UNIQUE INDEX users_phone_uq ON users (phone) WHERE phone IS NOT NULL;

      -- ------------------------------------------------------------- intramurals
      -- An intramural (school-based) or a club, always inside one country.
      CREATE TABLE intramurals (
        id                   serial PRIMARY KEY,
        country_id           int NOT NULL REFERENCES countries(id),
        slug                 text NOT NULL UNIQUE,
        name                 text NOT NULL,
        short_code           text NOT NULL,
        kind                 text NOT NULL DEFAULT 'intramural' CHECK (kind IN ('intramural', 'club')),
        color                text NOT NULL DEFAULT '#2F5BD3',
        logo                 text NOT NULL DEFAULT '',
        coordinator_name     text NOT NULL DEFAULT '',
        -- Regular session: weekday 0=Sunday … 6=Saturday, local times.
        session_weekday      int  NOT NULL DEFAULT 2 CHECK (session_weekday BETWEEN 0 AND 6),
        session_start        time NOT NULL DEFAULT '15:15',
        session_end          time NOT NULL DEFAULT '16:50',
        location             text NOT NULL DEFAULT '',
        dress_code           text NOT NULL DEFAULT '',
        availability_options jsonb NOT NULL DEFAULT '[{"id":"yes","label":"I will be there","tone":"good"},{"id":"late","label":"I will be late","tone":"ok"},{"id":"absent","label":"I will not be able to attend","tone":"bad"}]',
        default_roles        jsonb NOT NULL DEFAULT '["Setup & Equipment","Player Check-in","Warmup Lead","Match Coordination"]',
        default_schedule     jsonb NOT NULL DEFAULT '[]',
        teams                jsonb NOT NULL DEFAULT '[]',
        categories           jsonb NOT NULL DEFAULT '["Under 9","Under 11","Under 13"]',
        archived             boolean NOT NULL DEFAULT false,
        position             int NOT NULL DEFAULT 0,
        created_at           timestamptz NOT NULL DEFAULT now()
      );

      -- Which intramurals an admin or coach works with. Parents are linked
      -- through their children instead (parent_children).
      CREATE TABLE user_intramurals (
        user_id       int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        intramural_id int NOT NULL REFERENCES intramurals(id) ON DELETE CASCADE,
        PRIMARY KEY (user_id, intramural_id)
      );

      -- Granular permissions. Super admins toggle these per admin; admins grant
      -- a subset to coaches as task-specific field privileges (optionally for
      -- one intramural only and until a date).
      CREATE TABLE user_permissions (
        id            serial PRIMARY KEY,
        user_id       int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        permission    text NOT NULL,
        intramural_id int REFERENCES intramurals(id) ON DELETE CASCADE,  -- NULL = all of theirs
        granted_by    int REFERENCES users(id) ON DELETE SET NULL,
        expires_at    timestamptz,
        created_at    timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX user_permissions_uq ON user_permissions (user_id, permission, coalesce(intramural_id, 0));

      -- Per-intramural Airtable link. The token is write-only from the app.
      CREATE TABLE airtable_configs (
        intramural_id   int PRIMARY KEY REFERENCES intramurals(id) ON DELETE CASCADE,
        form_url        text NOT NULL DEFAULT '',   -- registration / sibling registration form
        base_id         text NOT NULL DEFAULT '',
        table_name      text NOT NULL DEFAULT '',
        view_name       text NOT NULL DEFAULT '',
        api_token       text NOT NULL DEFAULT '',
        -- Which Airtable fields hold what (names as they appear in the base).
        field_map       jsonb NOT NULL DEFAULT '{"name":"Name","firstName":"","lastName":"","category":"Category","guardianName":"Parent Name","guardianEmail":"Parent Email","guardianPhone":"Parent Phone","dateOfBirth":"Date of Birth"}',
        push_walk_ins   boolean NOT NULL DEFAULT false,  -- also create Airtable rows for walk-ins
        updated_by      int REFERENCES users(id) ON DELETE SET NULL,
        updated_at      timestamptz NOT NULL DEFAULT now()
      );

      -- ----------------------------------------------------------------- players
      CREATE TABLE players (
        id                 serial PRIMARY KEY,
        intramural_id      int NOT NULL REFERENCES intramurals(id) ON DELETE CASCADE,
        first_name         text NOT NULL,
        last_name          text NOT NULL DEFAULT '',
        date_of_birth      date,
        category           text NOT NULL DEFAULT '',
        team               text NOT NULL DEFAULT '',
        guardian_name      text NOT NULL DEFAULT '',
        guardian_email     text NOT NULL DEFAULT '',
        guardian_phone     text NOT NULL DEFAULT '',
        medical_notes      text NOT NULL DEFAULT '',
        source             text NOT NULL DEFAULT 'app' CHECK (source IN ('app', 'walk_in', 'airtable')),
        airtable_record_id text,
        client_id          text UNIQUE,   -- set by the phone; a re-sent offline registration is created once
        active             boolean NOT NULL DEFAULT true,
        created_by         int REFERENCES users(id) ON DELETE SET NULL,
        created_at         timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX players_intramural_idx ON players (intramural_id);
      CREATE UNIQUE INDEX players_airtable_uq ON players (intramural_id, airtable_record_id) WHERE airtable_record_id IS NOT NULL;
      -- The same child cannot be registered twice in one intramural.
      CREATE UNIQUE INDEX players_dupe_uq ON players (intramural_id, lower(first_name), lower(last_name), coalesce(date_of_birth, '1900-01-01'));

      -- A parent sees only the children linked here, and only once verified.
      CREATE TABLE parent_children (
        parent_id   int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        player_id   int NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        verified_by int REFERENCES users(id) ON DELETE SET NULL,
        verified_at timestamptz,
        PRIMARY KEY (parent_id, player_id)
      );

      -- ---------------------------------------------------------------- sessions
      CREATE TABLE sessions (
        id            serial PRIMARY KEY,
        intramural_id int  NOT NULL REFERENCES intramurals(id) ON DELETE CASCADE,
        date          date NOT NULL,
        kind          text NOT NULL DEFAULT 'training' CHECK (kind IN ('training', 'match', 'tournament')),
        title         text NOT NULL DEFAULT '',
        start_time    time NOT NULL,
        end_time      time NOT NULL,
        location      text NOT NULL DEFAULT '',
        dress_code    text NOT NULL DEFAULT '',
        opponent      text NOT NULL DEFAULT '',
        travel_notes  text NOT NULL DEFAULT '',
        schedule      jsonb NOT NULL DEFAULT '[]',   -- [{time:"13:00", activity}]
        roles         jsonb NOT NULL DEFAULT '[]',   -- [{role, userId|null}]
        cancelled     boolean NOT NULL DEFAULT false,
        version       int NOT NULL DEFAULT 1,
        updated_by    int REFERENCES users(id) ON DELETE SET NULL,
        updated_at    timestamptz NOT NULL DEFAULT now()
      );
      -- One regular training per intramural per day; matches can be added alongside.
      CREATE UNIQUE INDEX sessions_training_uq ON sessions (intramural_id, date) WHERE kind = 'training';
      CREATE INDEX sessions_date_idx ON sessions (intramural_id, date);

      -- Coach availability poll.
      CREATE TABLE availability (
        session_id int NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        user_id    int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        option_id  text NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (session_id, user_id)
      );

      CREATE TABLE attendance (
        session_id    int NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        player_id     int NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        status        text NOT NULL CHECK (status IN ('present', 'late', 'absent', 'excused')),
        checked_in_at timestamptz,
        recorded_by   int REFERENCES users(id) ON DELETE SET NULL,
        recorded_at   timestamptz NOT NULL DEFAULT now(),  -- when it happened on the phone; later wins
        PRIMARY KEY (session_id, player_id)
      );

      -- ---------------------------------------------------- feedback & virtues
      CREATE TABLE coach_feedback (
        id         serial PRIMARY KEY,
        player_id  int NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        session_id int REFERENCES sessions(id) ON DELETE SET NULL,
        category   text NOT NULL,          -- Technical, Teamwork, Attitude, Fitness, …
        rating     int CHECK (rating BETWEEN 1 AND 5),
        note       text NOT NULL DEFAULT '',
        coach_id   int REFERENCES users(id) ON DELETE SET NULL,
        visible_to_parent boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX coach_feedback_player_idx ON coach_feedback (player_id, created_at DESC);

      CREATE TABLE virtue_scores (
        id         serial PRIMARY KEY,
        player_id  int NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        session_id int REFERENCES sessions(id) ON DELETE SET NULL,
        virtue     text NOT NULL CHECK (virtue IN ('temperance', 'wisdom', 'fortitude', 'justice', 'teamwork', 'discipline')),
        score      int NOT NULL CHECK (score BETWEEN 1 AND 10),
        season     text NOT NULL,          -- e.g. "2026"
        recorded_by int REFERENCES users(id) ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX virtue_scores_player_idx ON virtue_scores (player_id, season);

      -- Coach-only mentorship notes. Never shown to parents.
      CREATE TABLE mentorship_logs (
        id                  serial PRIMARY KEY,
        intramural_id       int NOT NULL REFERENCES intramurals(id) ON DELETE CASCADE,
        session_id          int REFERENCES sessions(id) ON DELETE SET NULL,
        player_id           int REFERENCES players(id) ON DELETE SET NULL,   -- NULL = whole group
        coach_id            int REFERENCES users(id) ON DELETE SET NULL,
        discussion_notes    text NOT NULL DEFAULT '',
        scripture           text NOT NULL DEFAULT '',
        scripture_milestone text NOT NULL DEFAULT '',
        prayer_points       text NOT NULL DEFAULT '',
        welfare_observation text NOT NULL DEFAULT '',
        client_id           text UNIQUE,
        created_at          timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX mentorship_logs_idx ON mentorship_logs (intramural_id, created_at DESC);

      -- ------------------------------------------------------- tally & awards
      CREATE TABLE tally_events (
        id            serial PRIMARY KEY,
        intramural_id int NOT NULL REFERENCES intramurals(id) ON DELETE CASCADE,
        session_id    int REFERENCES sessions(id) ON DELETE SET NULL,
        kind          text NOT NULL CHECK (kind IN ('match', 'sportsmanship', 'virtue_points')),
        team          text NOT NULL DEFAULT '',     -- team id, or home side for a match
        opponent      text NOT NULL DEFAULT '',     -- away side for a match
        points        int NOT NULL DEFAULT 0,       -- or home goals for a match
        opponent_points int NOT NULL DEFAULT 0,
        category      text NOT NULL DEFAULT '',
        note          text NOT NULL DEFAULT '',
        recorded_by   int REFERENCES users(id) ON DELETE SET NULL,
        client_id     text UNIQUE,
        created_at    timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX tally_events_idx ON tally_events (intramural_id, created_at DESC);

      CREATE TABLE character_awards (
        id            serial PRIMARY KEY,
        intramural_id int NOT NULL REFERENCES intramurals(id) ON DELETE CASCADE,
        player_id     int NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        session_id    int REFERENCES sessions(id) ON DELETE SET NULL,
        week_of       date NOT NULL,
        award         text NOT NULL,                 -- e.g. "Fortitude Award"
        virtue        text NOT NULL DEFAULT '',
        reason        text NOT NULL DEFAULT '',
        awarded_by    int REFERENCES users(id) ON DELETE SET NULL,
        created_at    timestamptz NOT NULL DEFAULT now()
      );

      -- --------------------------------------------------------------- welfare
      CREATE TABLE injuries (
        id            serial PRIMARY KEY,
        player_id     int NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        session_id    int REFERENCES sessions(id) ON DELETE SET NULL,
        severity      text NOT NULL CHECK (severity IN ('knock', 'minor', 'moderate', 'serious')),
        body_part     text NOT NULL DEFAULT '',
        description   text NOT NULL,
        action_taken  text NOT NULL DEFAULT '',
        reported_by   int REFERENCES users(id) ON DELETE SET NULL,
        client_id     text UNIQUE,
        parent_acknowledged_at timestamptz,
        created_at    timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX injuries_player_idx ON injuries (player_id, created_at DESC);

      CREATE TABLE notifications (
        id         serial PRIMARY KEY,
        user_id    int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind       text NOT NULL,                 -- injury, payment, schedule, approval, award
        title      text NOT NULL,
        body       text NOT NULL DEFAULT '',
        link       text NOT NULL DEFAULT '',
        urgent     boolean NOT NULL DEFAULT false,
        read_at    timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);

      -- ------------------------------------------------------- fees & payments
      -- A charge on a child's account: season subscription, tournament, kit.
      CREATE TABLE fee_items (
        id            serial PRIMARY KEY,
        player_id     int NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        kind          text NOT NULL DEFAULT 'subscription' CHECK (kind IN ('subscription', 'tournament', 'kit', 'other')),
        title         text NOT NULL,
        amount        numeric(12, 2) NOT NULL CHECK (amount > 0),
        currency      char(3) NOT NULL DEFAULT 'KES',
        due_date      date,
        created_by    int REFERENCES users(id) ON DELETE SET NULL,
        created_at    timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE payments (
        id                  serial PRIMARY KEY,
        player_id           int NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        fee_item_id         int REFERENCES fee_items(id) ON DELETE SET NULL,
        payer_id            int REFERENCES users(id) ON DELETE SET NULL,
        method              text NOT NULL DEFAULT 'mpesa' CHECK (method IN ('mpesa', 'cash', 'bank')),
        amount              numeric(12, 2) NOT NULL CHECK (amount > 0),
        currency            char(3) NOT NULL DEFAULT 'KES',
        phone               text NOT NULL DEFAULT '',     -- the M-PESA number (2547…)
        status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed', 'cancelled')),
        merchant_request_id text,
        checkout_request_id text UNIQUE,
        mpesa_receipt       text UNIQUE,
        result_code         int,
        result_desc         text NOT NULL DEFAULT '',
        raw_callback        jsonb,
        recorded_by         int REFERENCES users(id) ON DELETE SET NULL,   -- cash/bank entries
        created_at          timestamptz NOT NULL DEFAULT now(),
        completed_at        timestamptz
      );
      CREATE INDEX payments_player_idx ON payments (player_id, created_at DESC);

      -- ------------------------------------------------------------- equipment
      CREATE TABLE equipment_items (
        id            serial PRIMARY KEY,
        intramural_id int NOT NULL REFERENCES intramurals(id) ON DELETE CASCADE,
        name          text NOT NULL,
        expected      int NOT NULL DEFAULT 1 CHECK (expected >= 0),
        active        boolean NOT NULL DEFAULT true
      );

      -- A before- or after-session count of every item.
      CREATE TABLE equipment_checks (
        id          serial PRIMARY KEY,
        session_id  int NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        phase       text NOT NULL CHECK (phase IN ('before', 'after')),
        items       jsonb NOT NULL,   -- [{itemId, name, expected, counted, condition: good|damaged|missing}]
        notes       text NOT NULL DEFAULT '',
        recorded_by int REFERENCES users(id) ON DELETE SET NULL,
        client_id   text UNIQUE,
        created_at  timestamptz NOT NULL DEFAULT now(),
        UNIQUE (session_id, phase)
      );

      -- -------------------------------------------------------------- plumbing
      -- Walk-in players waiting to be copied to the intramural's Airtable base.
      CREATE TABLE airtable_outbox (
        id         serial PRIMARY KEY,
        player_id  int NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        attempts   int NOT NULL DEFAULT 0,
        last_error text NOT NULL DEFAULT '',
        next_try   timestamptz NOT NULL DEFAULT now(),
        done_at    timestamptz
      );

      CREATE TABLE audit_log (
        id         serial PRIMARY KEY,
        actor_id   int REFERENCES users(id) ON DELETE SET NULL,
        action     text NOT NULL,
        detail     jsonb NOT NULL DEFAULT '{}',
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `,
  },
  {
    id: "002_seed",
    sql: `
      INSERT INTO countries (code, name, currency, time_zone, phone_prefix, mpesa)
      VALUES ('KE', 'Kenya', 'KES', 'Africa/Nairobi', '+254', true);

      INSERT INTO intramurals (country_id, slug, name, short_code, kind, color, logo, coordinator_name,
                               session_weekday, session_start, session_end, position, default_roles,
                               default_schedule, teams, categories, availability_options)
      SELECT c.id, v.slug, v.name, v.code, v.kind, v.color, v.logo, v.coord, v.wd, v.st::time, v.en::time, v.pos,
             v.roles::jsonb, v.sched::jsonb, v.teams::jsonb, v.cats::jsonb, v.avail::jsonb
        FROM countries c,
        (VALUES
          ('rafiki', 'Rafiki Classical', 'RC', 'intramural', '#14A38B', 'logos/rafiki.png', 'Denilson Mwenjwa', 2, '15:15', '16:50', 1,
           '["Setup & Equipment","Player Check-in","Warmup Lead","Match Coordination","TTG Video Facilitator","Gate / Player Release"]',
           '[{"time":"13:00","activity":"Arrive to Rafiki"},{"time":"13:10","activity":"Check-in & Prayer"},{"time":"13:40","activity":"Affirm one another / Prayer time / Preview TTG / Player feedback per category"},{"time":"14:40","activity":"Walk to field / Set up equipment"},{"time":"15:15","activity":"Players arrive, check-in"},{"time":"15:20","activity":"Warmup (Play)"},{"time":"15:30","activity":"Small-sided matches"},{"time":"16:05","activity":"Players walk to TTR"},{"time":"16:10","activity":"TTG videos"},{"time":"16:40","activity":"Release players to front security gate"},{"time":"17:00","activity":"Coaches leave"}]',
           '[{"id":"wisdom","name":"Wisdom","color":"#FACC15"},{"id":"justice","name":"Justice","color":"#C4A5F5"},{"id":"fortitude","name":"Fortitude","color":"#F59C9C"},{"id":"temperance","name":"Temperance","color":"#93C5FD"}]',
           '["Under 7","Under 9","Under 11","Under 13"]',
           '[{"id":"early","label":"I will arrive by 1:00 PM for coaches fellowship","tone":"good"},{"id":"on_time","label":"I will arrive by 3:15 PM","tone":"ok"},{"id":"absent","label":"I will not be able to attend","tone":"bad"}]'),
          ('daniels', 'The Daniels Schools', 'DS', 'intramural', '#2F5BD3', 'logos/daniels.png', '', 6, '09:00', '11:00', 2,
           '["Setup & Equipment","Player Check-in","Warmup Lead","Match Coordination"]', '[]',
           '[{"id":"wisdom","name":"Wisdom","color":"#FACC15"},{"id":"justice","name":"Justice","color":"#C4A5F5"},{"id":"fortitude","name":"Fortitude","color":"#F59C9C"},{"id":"temperance","name":"Temperance","color":"#93C5FD"}]',
           '["Under 9","Under 11","Under 13"]',
           '[{"id":"yes","label":"I will be there","tone":"good"},{"id":"late","label":"I will be late","tone":"ok"},{"id":"absent","label":"I will not be able to attend","tone":"bad"}]'),
          ('icc-imara', 'ICC Imara', 'ICC', 'club', '#D8412F', 'logos/icc-imara.png', '', 6, '09:00', '11:00', 3,
           '["Setup & Equipment","Player Check-in","Warmup Lead","Match Coordination"]', '[]', '[]',
           '["Under 9","Under 11","Under 13"]',
           '[{"id":"yes","label":"I will be there","tone":"good"},{"id":"late","label":"I will be late","tone":"ok"},{"id":"absent","label":"I will not be able to attend","tone":"bad"}]'),
          ('rosslyn', 'Rosslyn Academy', 'RA', 'club', '#8B4FD1', 'logos/rosslyn.png', '', 6, '09:30', '11:30', 4,
           '["Setup & Equipment","Player Check-in","Warmup Lead","Match Coordination"]',
           '[{"time":"09:30","activity":"Session starts"},{"time":"11:30","activity":"Session ends"}]', '[]',
           '["Under 9","Under 11","Under 13"]',
           '[{"id":"yes","label":"I will be there","tone":"good"},{"id":"late","label":"I will be late","tone":"ok"},{"id":"absent","label":"I will not be able to attend","tone":"bad"}]')
        ) AS v(slug, name, code, kind, color, logo, coord, wd, st, en, pos, roles, sched, teams, cats, avail)
       WHERE c.code = 'KE';

      -- Airtable links supplied by the organisation (Nov 2026).
      INSERT INTO airtable_configs (intramural_id, form_url, base_id)
      SELECT i.id, v.url, v.base FROM intramurals i JOIN (VALUES
        ('rafiki',    'https://airtable.com/appQFwbjGiTPwZQxc/shr1ZecAArGDFOWSQ', 'appQFwbjGiTPwZQxc'),
        ('rosslyn',   'https://airtable.com/appCSS7M9vZDbhlgd/shrCu6PG9Gi52aUlM', 'appCSS7M9vZDbhlgd'),
        ('icc-imara', 'https://airtable.com/appoPbxsPonONNChK/shrtE4gCFEDNzysXV', 'appoPbxsPonONNChK')
      ) AS v(slug, url, base) ON v.slug = i.slug;

      INSERT INTO equipment_items (intramural_id, name, expected)
      SELECT i.id, e.name, e.n FROM intramurals i,
        (VALUES ('Footballs', 12), ('Cones', 30), ('Bibs / Pinnies', 24), ('Mini goals', 4), ('First aid kit', 1), ('Pump', 1)) AS e(name, n);
    `,
  },
  {
    id: "003_programs_age_groups_reports_alerts",
    sql: `
      -- School vs club: only school mode uses the 4 Virtue Teams; clubs run
      -- special events and camps instead.
      ALTER TABLE intramurals ADD COLUMN program_mode text NOT NULL DEFAULT 'club'
        CHECK (program_mode IN ('school', 'club'));
      UPDATE intramurals SET program_mode = 'school' WHERE slug = 'rafiki';
      UPDATE intramurals SET categories = '["U7","U9","U11","U13","U15","U17"]';

      -- Age-group registry: birth year drives the age group.
      ALTER TABLE players ADD COLUMN birth_year int CHECK (birth_year BETWEEN 1990 AND 2100);
      UPDATE players SET birth_year = extract(year FROM date_of_birth)::int WHERE date_of_birth IS NOT NULL;
      UPDATE players SET category = regexp_replace(category, '^Under\\s*(\\d+)$', 'U\\1') WHERE category ~ '^Under';

      -- Coaches rotate: each assignment can be limited to some age groups (empty = all).
      ALTER TABLE user_intramurals ADD COLUMN age_groups text[] NOT NULL DEFAULT '{}';

      -- Special events and camps (Summer Camp, clinics) alongside sessions.
      ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_kind_check;
      ALTER TABLE sessions ADD CONSTRAINT sessions_kind_check
        CHECK (kind IN ('training', 'match', 'tournament', 'camp', 'clinic'));
      ALTER TABLE sessions ADD COLUMN end_date date;

      -- Post-session feedback from a coach to the admins.
      CREATE TABLE session_reports (
        id                 serial PRIMARY KEY,
        session_id         int NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        coach_id           int REFERENCES users(id) ON DELETE SET NULL,
        age_group          text NOT NULL DEFAULT '',
        present_count      int NOT NULL DEFAULT 0,
        roster_count       int NOT NULL DEFAULT 0,
        attendance_summary text NOT NULL DEFAULT '',
        player_progress    text NOT NULL DEFAULT '',
        pitch_notes        text NOT NULL DEFAULT '',
        client_id          text UNIQUE,
        created_at         timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX session_reports_session_idx ON session_reports (session_id);

      -- "Unpaid" flags an admin raises for a player's session or camp; the
      -- parents are alerted, and the flag is cleared once paid.
      CREATE TABLE unpaid_alerts (
        id          serial PRIMARY KEY,
        player_id   int NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        session_id  int REFERENCES sessions(id) ON DELETE SET NULL,
        title       text NOT NULL,
        amount      numeric(12, 2) CHECK (amount IS NULL OR amount > 0),
        note        text NOT NULL DEFAULT '',
        created_by  int REFERENCES users(id) ON DELETE SET NULL,
        created_at  timestamptz NOT NULL DEFAULT now(),
        resolved_at timestamptz,
        resolved_by int REFERENCES users(id) ON DELETE SET NULL
      );
      CREATE INDEX unpaid_alerts_player_idx ON unpaid_alerts (player_id) WHERE resolved_at IS NULL;
    `,
  },
  {
    id: "004_restrictions_payment_config_terms",
    sql: `
      -- Admins have every Super Admin power unless a Super Admin switches
      -- one off here (Privilege Control). A row = that power is revoked.
      CREATE TABLE admin_restrictions (
        user_id     int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        restriction text NOT NULL,
        created_by  int REFERENCES users(id) ON DELETE SET NULL,
        created_at  timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (user_id, restriction)
      );

      -- Payment details set by the Super Admin, per school/club. Parents see
      -- exactly these and cannot change the amount.
      CREATE TABLE payment_configs (
        intramural_id      int PRIMARY KEY REFERENCES intramurals(id) ON DELETE CASCADE,
        term_label         text NOT NULL DEFAULT '',
        fee_amount         numeric(12, 2) CHECK (fee_amount IS NULL OR fee_amount > 0),
        method             text NOT NULL DEFAULT 'paybill' CHECK (method IN ('paybill', 'till')),
        paybill            text NOT NULL DEFAULT '',
        till               text NOT NULL DEFAULT '',
        account_ref_format text NOT NULL DEFAULT '{CODE}-{CHILD}',
        deadline           date,
        instructions       text NOT NULL DEFAULT '',
        updated_by         int REFERENCES users(id) ON DELETE SET NULL,
        updated_at         timestamptz NOT NULL DEFAULT now()
      );

      -- The term fee becomes one charge per child, once per term.
      ALTER TABLE fee_items ADD COLUMN term_key text;
      CREATE UNIQUE INDEX fee_items_term_uq ON fee_items (player_id, term_key) WHERE term_key IS NOT NULL;

      -- App-wide settings (the "Register a Child" link).
      CREATE TABLE app_settings (
        key        text PRIMARY KEY,
        value      text NOT NULL DEFAULT '',
        updated_by int REFERENCES users(id) ON DELETE SET NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      INSERT INTO app_settings (key, value)
      SELECT 'registration_url', form_url FROM airtable_configs a JOIN intramurals i ON i.id = a.intramural_id
       WHERE i.slug = 'rafiki' AND form_url <> '';

      -- Term dates (used by Edit and the "Whole term" attendance graph).
      ALTER TABLE intramurals ADD COLUMN term_start date, ADD COLUMN term_end date;

      CREATE INDEX attendance_player_idx ON attendance (player_id);
      CREATE INDEX sessions_date_only_idx ON sessions (date);
    `,
  },
];

export async function migrate(): Promise<void> {
  const client = await getPool().connect();
  try {
    if (config.dbSchema) {
      await client.query(`CREATE SCHEMA IF NOT EXISTS "${config.dbSchema}"`);
      await client.query(`SET search_path TO "${config.dbSchema}"`);
    }
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    await client.query("SELECT pg_advisory_lock(727272)");
    const done = new Set((await client.query<{ id: string }>("SELECT id FROM schema_migrations")).rows.map((r) => r.id));
    for (const m of migrations) {
      if (done.has(m.id)) continue;
      await client.query("BEGIN");
      try {
        await client.query(m.sql);
        await client.query("INSERT INTO schema_migrations (id) VALUES ($1)", [m.id]);
        await client.query("COMMIT");
        console.log(`[migrate] applied ${m.id}`);
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(727272)").catch(() => {});
    client.release();
  }
}
