-- Database-level guarantees Prisma's schema language cannot express.
-- The API normalises first (lib/security/rbac.ts); these make sure nothing
-- un-normalised can ever be stored, even by a script or a future bug.

-- Zero duplicate profiles: unique indexes exist on users.email / users.phone;
-- these checks make sure the values are in the one canonical form.
ALTER TABLE "users"
  ADD CONSTRAINT "users_email_normalised" CHECK ("email" = lower(btrim("email")) AND position('@' IN "email") > 1),
  ADD CONSTRAINT "users_phone_e164"       CHECK ("phone" IS NULL OR "phone" ~ '^\+[1-9][0-9]{7,14}$'),
  ADD CONSTRAINT "users_name_present"     CHECK (length(btrim("name")) >= 2);

ALTER TABLE "players"
  ADD CONSTRAINT "players_guardian_email_normalised" CHECK ("guardianEmail" IS NULL OR "guardianEmail" = lower(btrim("guardianEmail"))),
  ADD CONSTRAINT "players_guardian_phone_e164"       CHECK ("guardianPhone" IS NULL OR "guardianPhone" ~ '^\+[1-9][0-9]{7,14}$'),
  ADD CONSTRAINT "players_first_name_present"        CHECK (length(btrim("firstName")) >= 1);

ALTER TABLE "countries"
  ADD CONSTRAINT "countries_phone_prefix" CHECK ("phonePrefix" ~ '^\+[1-9][0-9]{0,3}$'),
  ADD CONSTRAINT "countries_code_upper"   CHECK ("code" = upper("code"));

-- Session day and times (minutes after midnight).
ALTER TABLE "intramurals"
  ADD CONSTRAINT "intramurals_weekday" CHECK ("sessionWeekday" BETWEEN 0 AND 6),
  ADD CONSTRAINT "intramurals_times"   CHECK ("sessionStartMin" BETWEEN 0 AND 1439 AND "sessionEndMin" BETWEEN 1 AND 1440 AND "sessionEndMin" > "sessionStartMin");

ALTER TABLE "sessions"
  ADD CONSTRAINT "sessions_times"        CHECK ("startMin" BETWEEN 0 AND 1439 AND "endMin" BETWEEN 1 AND 1440 AND "endMin" > "startMin"),
  ADD CONSTRAINT "sessions_training_key" CHECK (("kind" = 'TRAINING') = ("trainingKey" IS NOT NULL));

-- Score ranges.
ALTER TABLE "virtue_scores"  ADD CONSTRAINT "virtue_scores_range"  CHECK ("score" BETWEEN 1 AND 10);
ALTER TABLE "coach_feedback" ADD CONSTRAINT "coach_feedback_range" CHECK ("rating" IS NULL OR "rating" BETWEEN 1 AND 5);

-- Money.
ALTER TABLE "fee_items" ADD CONSTRAINT "fee_items_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "payments"  ADD CONSTRAINT "payments_amount_positive"  CHECK ("amount" > 0);
ALTER TABLE "payments"  ADD CONSTRAINT "payments_mpesa_phone"      CHECK ("phone" IS NULL OR "phone" ~ '^254(7|1)[0-9]{8}$');

-- Equipment counts.
ALTER TABLE "equipment_items"       ADD CONSTRAINT "equipment_items_expected" CHECK ("expected" >= 0);
ALTER TABLE "equipment_check_lines" ADD CONSTRAINT "equipment_lines_counts"   CHECK ("expected" >= 0 AND "counted" >= 0);

-- A field privilege must be for an intramural the coach is assigned to.
ALTER TABLE "field_privileges"
  ADD CONSTRAINT "field_privileges_assignment_fk"
  FOREIGN KEY ("userId", "intramuralId") REFERENCES "intramural_assignments" ("userId", "intramuralId") ON DELETE CASCADE;
