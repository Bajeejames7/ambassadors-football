-- CreateEnum
CREATE TYPE "Role" AS ENUM ('SUPER_ADMIN', 'ADMIN', 'COACH', 'PARENT');

-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "IntramuralKind" AS ENUM ('INTRAMURAL', 'CLUB');

-- CreateEnum
CREATE TYPE "FieldPrivilegeType" AS ENUM ('TAKE_ATTENDANCE', 'REGISTER_WALK_INS', 'EQUIPMENT_CHECK', 'GENERATE_REPORTS');

-- CreateEnum
CREATE TYPE "PlayerSource" AS ENUM ('APP', 'WALK_IN', 'AIRTABLE');

-- CreateEnum
CREATE TYPE "SessionKind" AS ENUM ('TRAINING', 'MATCH', 'TOURNAMENT');

-- CreateEnum
CREATE TYPE "AttendanceStatus" AS ENUM ('PRESENT', 'LATE', 'ABSENT', 'EXCUSED');

-- CreateEnum
CREATE TYPE "Virtue" AS ENUM ('TEMPERANCE', 'WISDOM', 'FORTITUDE', 'JUSTICE', 'TEAMWORK', 'DISCIPLINE');

-- CreateEnum
CREATE TYPE "TallyKind" AS ENUM ('MATCH_SCORE', 'SPORTSMANSHIP', 'VIRTUE_POINTS');

-- CreateEnum
CREATE TYPE "WelfareSeverity" AS ENUM ('OBSERVATION', 'KNOCK', 'MINOR_INJURY', 'MODERATE_INJURY', 'SERIOUS_INJURY');

-- CreateEnum
CREATE TYPE "EquipmentPhase" AS ENUM ('PRE_SESSION', 'POST_SESSION');

-- CreateEnum
CREATE TYPE "EquipmentCondition" AS ENUM ('GOOD', 'DAMAGED', 'MISSING');

-- CreateEnum
CREATE TYPE "FeeKind" AS ENUM ('SUBSCRIPTION', 'TOURNAMENT', 'KIT', 'OTHER');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('MPESA', 'CASH', 'BANK');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "NotificationKind" AS ENUM ('WELFARE', 'PAYMENT', 'SCHEDULE', 'AWARD', 'APPROVAL', 'PRIVILEGES', 'GENERAL');

-- CreateEnum
CREATE TYPE "SyncOpType" AS ENUM ('ATTENDANCE', 'WALK_IN', 'MATCH_EVENT', 'EQUIPMENT_CHECK', 'MENTORSHIP_LOG', 'WELFARE_REPORT', 'VIRTUE_SCORE', 'AVAILABILITY');

-- CreateEnum
CREATE TYPE "SyncOpStatus" AS ENUM ('APPLIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "AirtableOutboxStatus" AS ENUM ('QUEUED', 'DONE', 'FAILED');

-- CreateTable
CREATE TABLE "countries" (
    "id" SERIAL NOT NULL,
    "code" CHAR(2) NOT NULL,
    "name" TEXT NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'KES',
    "timeZone" TEXT NOT NULL DEFAULT 'Africa/Nairobi',
    "phonePrefix" TEXT NOT NULL DEFAULT '+254',
    "mpesaEnabled" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "countries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intramurals" (
    "id" SERIAL NOT NULL,
    "countryId" INTEGER NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "shortCode" TEXT NOT NULL,
    "kind" "IntramuralKind" NOT NULL DEFAULT 'INTRAMURAL',
    "color" TEXT NOT NULL DEFAULT '#0F1E3D',
    "logoPath" TEXT,
    "coordinatorName" TEXT,
    "sessionWeekday" SMALLINT NOT NULL DEFAULT 2,
    "sessionStartMin" SMALLINT NOT NULL DEFAULT 915,
    "sessionEndMin" SMALLINT NOT NULL DEFAULT 1010,
    "location" TEXT NOT NULL DEFAULT '',
    "dressCode" TEXT NOT NULL DEFAULT '',
    "availabilityOptions" JSONB NOT NULL DEFAULT '[{"id":"yes","label":"I will be there","tone":"good"},{"id":"late","label":"I will be late","tone":"ok"},{"id":"absent","label":"I will not be able to attend","tone":"bad"}]',
    "defaultRoles" JSONB NOT NULL DEFAULT '[]',
    "defaultSchedule" JSONB NOT NULL DEFAULT '[]',
    "teams" JSONB NOT NULL DEFAULT '[]',
    "categories" JSONB NOT NULL DEFAULT '[]',
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "intramurals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" SERIAL NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'COACH',
    "status" "AccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "countryId" INTEGER NOT NULL,
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
    "tokenVersion" INTEGER NOT NULL DEFAULT 1,
    "lastSeenAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_permissions" (
    "userId" INTEGER NOT NULL,
    "canEditSchedules" BOOLEAN NOT NULL DEFAULT true,
    "canRegisterPlayers" BOOLEAN NOT NULL DEFAULT true,
    "canAssignCoachRoles" BOOLEAN NOT NULL DEFAULT true,
    "canManageAirtable" BOOLEAN NOT NULL DEFAULT true,
    "canApproveParents" BOOLEAN NOT NULL DEFAULT true,
    "canOverrideCountry" BOOLEAN NOT NULL DEFAULT false,
    "canManagePayments" BOOLEAN NOT NULL DEFAULT true,
    "canGenerateReports" BOOLEAN NOT NULL DEFAULT true,
    "canGrantFieldPrivileges" BOOLEAN NOT NULL DEFAULT true,
    "updatedById" INTEGER,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "admin_permissions_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "intramural_assignments" (
    "userId" INTEGER NOT NULL,
    "intramuralId" INTEGER NOT NULL,
    "assignedById" INTEGER,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "intramural_assignments_pkey" PRIMARY KEY ("userId","intramuralId")
);

-- CreateTable
CREATE TABLE "field_privileges" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "intramuralId" INTEGER NOT NULL,
    "privilege" "FieldPrivilegeType" NOT NULL,
    "grantedById" INTEGER,
    "expiresAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "field_privileges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "airtable_configs" (
    "intramuralId" INTEGER NOT NULL,
    "formUrl" TEXT,
    "baseId" TEXT,
    "tableName" TEXT,
    "viewName" TEXT,
    "apiTokenEncrypted" TEXT,
    "fieldMap" JSONB NOT NULL DEFAULT '{"name":"Name","category":"Category","guardianName":"Parent Name","guardianEmail":"Parent Email","guardianPhone":"Parent Phone","dateOfBirth":"Date of Birth"}',
    "pushWalkIns" BOOLEAN NOT NULL DEFAULT false,
    "updatedById" INTEGER,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "airtable_configs_pkey" PRIMARY KEY ("intramuralId")
);

-- CreateTable
CREATE TABLE "players" (
    "id" SERIAL NOT NULL,
    "intramuralId" INTEGER NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL DEFAULT '',
    "dedupeKey" TEXT NOT NULL,
    "dateOfBirth" DATE,
    "category" TEXT NOT NULL DEFAULT '',
    "team" TEXT NOT NULL DEFAULT '',
    "guardianName" TEXT NOT NULL DEFAULT '',
    "guardianEmail" TEXT,
    "guardianPhone" TEXT,
    "medicalNotes" TEXT NOT NULL DEFAULT '',
    "guardianConsentAt" TIMESTAMPTZ,
    "guardianConsentSource" TEXT,
    "mediaConsent" BOOLEAN NOT NULL DEFAULT false,
    "source" "PlayerSource" NOT NULL DEFAULT 'APP',
    "airtableRecordId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "retainUntil" DATE,
    "createdById" INTEGER,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "players_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "parent_children" (
    "parentId" INTEGER NOT NULL,
    "playerId" INTEGER NOT NULL,
    "verifiedById" INTEGER,
    "verifiedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "parent_children_pkey" PRIMARY KEY ("parentId","playerId")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" SERIAL NOT NULL,
    "intramuralId" INTEGER NOT NULL,
    "date" DATE NOT NULL,
    "kind" "SessionKind" NOT NULL DEFAULT 'TRAINING',
    "trainingKey" TEXT,
    "title" TEXT NOT NULL DEFAULT '',
    "startMin" SMALLINT NOT NULL,
    "endMin" SMALLINT NOT NULL,
    "location" TEXT NOT NULL DEFAULT '',
    "dressCode" TEXT NOT NULL DEFAULT '',
    "opponent" TEXT NOT NULL DEFAULT '',
    "travelNotes" TEXT NOT NULL DEFAULT '',
    "schedule" JSONB NOT NULL DEFAULT '[]',
    "roles" JSONB NOT NULL DEFAULT '[]',
    "cancelled" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedById" INTEGER,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "availability" (
    "sessionId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "optionId" TEXT NOT NULL,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "availability_pkey" PRIMARY KEY ("sessionId","userId")
);

-- CreateTable
CREATE TABLE "attendance" (
    "sessionId" INTEGER NOT NULL,
    "playerId" INTEGER NOT NULL,
    "status" "AttendanceStatus" NOT NULL,
    "checkedInAt" TIMESTAMPTZ,
    "recordedById" INTEGER,
    "recordedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "attendance_pkey" PRIMARY KEY ("sessionId","playerId")
);

-- CreateTable
CREATE TABLE "coach_feedback" (
    "id" SERIAL NOT NULL,
    "playerId" INTEGER NOT NULL,
    "sessionId" INTEGER,
    "category" TEXT NOT NULL,
    "rating" SMALLINT,
    "note" TEXT NOT NULL DEFAULT '',
    "visibleToParent" BOOLEAN NOT NULL DEFAULT true,
    "coachId" INTEGER,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coach_feedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "virtue_scores" (
    "id" SERIAL NOT NULL,
    "playerId" INTEGER NOT NULL,
    "sessionId" INTEGER,
    "virtue" "Virtue" NOT NULL,
    "score" SMALLINT NOT NULL,
    "season" TEXT NOT NULL,
    "recordedById" INTEGER,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "virtue_scores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mentorship_logs" (
    "id" SERIAL NOT NULL,
    "intramuralId" INTEGER NOT NULL,
    "sessionId" INTEGER,
    "playerId" INTEGER,
    "coachId" INTEGER,
    "discussionNotes" TEXT NOT NULL DEFAULT '',
    "scripture" TEXT NOT NULL DEFAULT '',
    "scriptureMilestone" TEXT NOT NULL DEFAULT '',
    "prayerPoints" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mentorship_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tally_events" (
    "id" SERIAL NOT NULL,
    "intramuralId" INTEGER NOT NULL,
    "sessionId" INTEGER,
    "kind" "TallyKind" NOT NULL,
    "team" TEXT NOT NULL DEFAULT '',
    "opponent" TEXT NOT NULL DEFAULT '',
    "points" SMALLINT NOT NULL DEFAULT 0,
    "opponentPoints" SMALLINT NOT NULL DEFAULT 0,
    "category" TEXT NOT NULL DEFAULT '',
    "note" TEXT NOT NULL DEFAULT '',
    "recordedById" INTEGER,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tally_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "character_awards" (
    "id" SERIAL NOT NULL,
    "intramuralId" INTEGER NOT NULL,
    "playerId" INTEGER NOT NULL,
    "sessionId" INTEGER,
    "weekOf" DATE NOT NULL,
    "award" TEXT NOT NULL,
    "virtue" "Virtue",
    "reason" TEXT NOT NULL DEFAULT '',
    "awardedById" INTEGER,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "character_awards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "welfare_reports" (
    "id" SERIAL NOT NULL,
    "playerId" INTEGER NOT NULL,
    "sessionId" INTEGER,
    "severity" "WelfareSeverity" NOT NULL,
    "bodyPart" TEXT NOT NULL DEFAULT '',
    "description" TEXT NOT NULL,
    "actionTaken" TEXT NOT NULL DEFAULT '',
    "reportedById" INTEGER,
    "parentNotifiedAt" TIMESTAMPTZ,
    "parentAcknowledgedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "welfare_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "equipment_items" (
    "id" SERIAL NOT NULL,
    "intramuralId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "expected" INTEGER NOT NULL DEFAULT 1,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "equipment_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "equipment_checks" (
    "id" SERIAL NOT NULL,
    "sessionId" INTEGER NOT NULL,
    "phase" "EquipmentPhase" NOT NULL,
    "notes" TEXT NOT NULL DEFAULT '',
    "recordedById" INTEGER,
    "recordedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "equipment_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "equipment_check_lines" (
    "checkId" INTEGER NOT NULL,
    "itemId" INTEGER NOT NULL,
    "expected" INTEGER NOT NULL,
    "counted" INTEGER NOT NULL,
    "condition" "EquipmentCondition" NOT NULL DEFAULT 'GOOD',

    CONSTRAINT "equipment_check_lines_pkey" PRIMARY KEY ("checkId","itemId")
);

-- CreateTable
CREATE TABLE "fee_items" (
    "id" SERIAL NOT NULL,
    "playerId" INTEGER NOT NULL,
    "kind" "FeeKind" NOT NULL DEFAULT 'SUBSCRIPTION',
    "title" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "dueDate" DATE,
    "createdById" INTEGER,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fee_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" SERIAL NOT NULL,
    "playerId" INTEGER NOT NULL,
    "feeItemId" INTEGER,
    "payerId" INTEGER,
    "method" "PaymentMethod" NOT NULL DEFAULT 'MPESA',
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "phone" TEXT,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "merchantRequestId" TEXT,
    "checkoutRequestId" TEXT,
    "mpesaReceipt" TEXT,
    "resultCode" INTEGER,
    "resultDesc" TEXT NOT NULL DEFAULT '',
    "rawCallback" JSONB,
    "recordedById" INTEGER,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_operations" (
    "id" UUID NOT NULL,
    "userId" INTEGER NOT NULL,
    "type" "SyncOpType" NOT NULL,
    "status" "SyncOpStatus" NOT NULL,
    "result" JSONB,
    "clientAt" TIMESTAMPTZ NOT NULL,
    "receivedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sync_operations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "airtable_outbox" (
    "id" SERIAL NOT NULL,
    "playerId" INTEGER NOT NULL,
    "status" "AirtableOutboxStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT NOT NULL DEFAULT '',
    "nextTryAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "doneAt" TIMESTAMPTZ,

    CONSTRAINT "airtable_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "kind" "NotificationKind" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "link" TEXT NOT NULL DEFAULT '',
    "urgent" BOOLEAN NOT NULL DEFAULT false,
    "readAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policy_consents" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "acceptedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ipAddress" TEXT,

    CONSTRAINT "policy_consents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_deletions" (
    "id" SERIAL NOT NULL,
    "emailHash" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "channel" TEXT NOT NULL,
    "requestedAt" TIMESTAMPTZ NOT NULL,
    "completedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_deletions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" SERIAL NOT NULL,
    "actorId" INTEGER,
    "action" TEXT NOT NULL,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "countries_code_key" ON "countries"("code");

-- CreateIndex
CREATE UNIQUE INDEX "intramurals_slug_key" ON "intramurals"("slug");

-- CreateIndex
CREATE INDEX "intramurals_countryId_idx" ON "intramurals"("countryId");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_key" ON "users"("phone");

-- CreateIndex
CREATE INDEX "users_countryId_role_idx" ON "users"("countryId", "role");

-- CreateIndex
CREATE INDEX "intramural_assignments_intramuralId_idx" ON "intramural_assignments"("intramuralId");

-- CreateIndex
CREATE INDEX "field_privileges_intramuralId_idx" ON "field_privileges"("intramuralId");

-- CreateIndex
CREATE UNIQUE INDEX "field_privileges_userId_intramuralId_privilege_key" ON "field_privileges"("userId", "intramuralId", "privilege");

-- CreateIndex
CREATE INDEX "players_guardianEmail_idx" ON "players"("guardianEmail");

-- CreateIndex
CREATE INDEX "players_guardianPhone_idx" ON "players"("guardianPhone");

-- CreateIndex
CREATE UNIQUE INDEX "players_intramuralId_dedupeKey_key" ON "players"("intramuralId", "dedupeKey");

-- CreateIndex
CREATE UNIQUE INDEX "players_intramuralId_airtableRecordId_key" ON "players"("intramuralId", "airtableRecordId");

-- CreateIndex
CREATE INDEX "parent_children_playerId_idx" ON "parent_children"("playerId");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_trainingKey_key" ON "sessions"("trainingKey");

-- CreateIndex
CREATE INDEX "sessions_intramuralId_date_idx" ON "sessions"("intramuralId", "date");

-- CreateIndex
CREATE INDEX "attendance_playerId_idx" ON "attendance"("playerId");

-- CreateIndex
CREATE INDEX "coach_feedback_playerId_createdAt_idx" ON "coach_feedback"("playerId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "virtue_scores_playerId_season_idx" ON "virtue_scores"("playerId", "season");

-- CreateIndex
CREATE INDEX "mentorship_logs_intramuralId_createdAt_idx" ON "mentorship_logs"("intramuralId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "tally_events_intramuralId_createdAt_idx" ON "tally_events"("intramuralId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "tally_events_sessionId_idx" ON "tally_events"("sessionId");

-- CreateIndex
CREATE INDEX "character_awards_intramuralId_weekOf_idx" ON "character_awards"("intramuralId", "weekOf");

-- CreateIndex
CREATE INDEX "character_awards_playerId_idx" ON "character_awards"("playerId");

-- CreateIndex
CREATE INDEX "welfare_reports_playerId_createdAt_idx" ON "welfare_reports"("playerId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "equipment_items_intramuralId_idx" ON "equipment_items"("intramuralId");

-- CreateIndex
CREATE UNIQUE INDEX "equipment_checks_sessionId_phase_key" ON "equipment_checks"("sessionId", "phase");

-- CreateIndex
CREATE INDEX "fee_items_playerId_idx" ON "fee_items"("playerId");

-- CreateIndex
CREATE UNIQUE INDEX "payments_checkoutRequestId_key" ON "payments"("checkoutRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "payments_mpesaReceipt_key" ON "payments"("mpesaReceipt");

-- CreateIndex
CREATE INDEX "payments_playerId_createdAt_idx" ON "payments"("playerId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "payments_status_createdAt_idx" ON "payments"("status", "createdAt");

-- CreateIndex
CREATE INDEX "sync_operations_userId_receivedAt_idx" ON "sync_operations"("userId", "receivedAt");

-- CreateIndex
CREATE INDEX "airtable_outbox_status_nextTryAt_idx" ON "airtable_outbox"("status", "nextTryAt");

-- CreateIndex
CREATE INDEX "notifications_userId_createdAt_idx" ON "notifications"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "policy_consents_userId_idx" ON "policy_consents"("userId");

-- CreateIndex
CREATE INDEX "audit_log_createdAt_idx" ON "audit_log"("createdAt" DESC);

-- AddForeignKey
ALTER TABLE "intramurals" ADD CONSTRAINT "intramurals_countryId_fkey" FOREIGN KEY ("countryId") REFERENCES "countries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_countryId_fkey" FOREIGN KEY ("countryId") REFERENCES "countries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_permissions" ADD CONSTRAINT "admin_permissions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intramural_assignments" ADD CONSTRAINT "intramural_assignments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intramural_assignments" ADD CONSTRAINT "intramural_assignments_intramuralId_fkey" FOREIGN KEY ("intramuralId") REFERENCES "intramurals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "field_privileges" ADD CONSTRAINT "field_privileges_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "field_privileges" ADD CONSTRAINT "field_privileges_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "field_privileges" ADD CONSTRAINT "field_privileges_intramuralId_fkey" FOREIGN KEY ("intramuralId") REFERENCES "intramurals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "airtable_configs" ADD CONSTRAINT "airtable_configs_intramuralId_fkey" FOREIGN KEY ("intramuralId") REFERENCES "intramurals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "airtable_configs" ADD CONSTRAINT "airtable_configs_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "players" ADD CONSTRAINT "players_intramuralId_fkey" FOREIGN KEY ("intramuralId") REFERENCES "intramurals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "players" ADD CONSTRAINT "players_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parent_children" ADD CONSTRAINT "parent_children_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parent_children" ADD CONSTRAINT "parent_children_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parent_children" ADD CONSTRAINT "parent_children_verifiedById_fkey" FOREIGN KEY ("verifiedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_intramuralId_fkey" FOREIGN KEY ("intramuralId") REFERENCES "intramurals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "availability" ADD CONSTRAINT "availability_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "availability" ADD CONSTRAINT "availability_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance" ADD CONSTRAINT "attendance_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance" ADD CONSTRAINT "attendance_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance" ADD CONSTRAINT "attendance_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coach_feedback" ADD CONSTRAINT "coach_feedback_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coach_feedback" ADD CONSTRAINT "coach_feedback_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coach_feedback" ADD CONSTRAINT "coach_feedback_coachId_fkey" FOREIGN KEY ("coachId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "virtue_scores" ADD CONSTRAINT "virtue_scores_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "virtue_scores" ADD CONSTRAINT "virtue_scores_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "virtue_scores" ADD CONSTRAINT "virtue_scores_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mentorship_logs" ADD CONSTRAINT "mentorship_logs_intramuralId_fkey" FOREIGN KEY ("intramuralId") REFERENCES "intramurals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mentorship_logs" ADD CONSTRAINT "mentorship_logs_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mentorship_logs" ADD CONSTRAINT "mentorship_logs_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mentorship_logs" ADD CONSTRAINT "mentorship_logs_coachId_fkey" FOREIGN KEY ("coachId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tally_events" ADD CONSTRAINT "tally_events_intramuralId_fkey" FOREIGN KEY ("intramuralId") REFERENCES "intramurals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tally_events" ADD CONSTRAINT "tally_events_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tally_events" ADD CONSTRAINT "tally_events_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "character_awards" ADD CONSTRAINT "character_awards_intramuralId_fkey" FOREIGN KEY ("intramuralId") REFERENCES "intramurals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "character_awards" ADD CONSTRAINT "character_awards_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "character_awards" ADD CONSTRAINT "character_awards_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "character_awards" ADD CONSTRAINT "character_awards_awardedById_fkey" FOREIGN KEY ("awardedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "welfare_reports" ADD CONSTRAINT "welfare_reports_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "welfare_reports" ADD CONSTRAINT "welfare_reports_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "welfare_reports" ADD CONSTRAINT "welfare_reports_reportedById_fkey" FOREIGN KEY ("reportedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "equipment_items" ADD CONSTRAINT "equipment_items_intramuralId_fkey" FOREIGN KEY ("intramuralId") REFERENCES "intramurals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "equipment_checks" ADD CONSTRAINT "equipment_checks_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "equipment_checks" ADD CONSTRAINT "equipment_checks_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "equipment_check_lines" ADD CONSTRAINT "equipment_check_lines_checkId_fkey" FOREIGN KEY ("checkId") REFERENCES "equipment_checks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "equipment_check_lines" ADD CONSTRAINT "equipment_check_lines_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "equipment_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_items" ADD CONSTRAINT "fee_items_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_items" ADD CONSTRAINT "fee_items_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_feeItemId_fkey" FOREIGN KEY ("feeItemId") REFERENCES "fee_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_payerId_fkey" FOREIGN KEY ("payerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_operations" ADD CONSTRAINT "sync_operations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "airtable_outbox" ADD CONSTRAINT "airtable_outbox_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policy_consents" ADD CONSTRAINT "policy_consents_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

