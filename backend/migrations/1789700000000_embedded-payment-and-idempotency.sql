-- Up Migration

-- Phase 6 §4.4 (I2): money is recorded inside the interaction -- a field
-- visit or call log can embed a payment, created in the same transaction.
ALTER TABLE payments ADD COLUMN call_log_id UUID REFERENCES call_logs(id);
ALTER TABLE payments ADD COLUMN field_visit_id UUID REFERENCES field_visits(id);
ALTER TABLE payments ADD CONSTRAINT chk_payments_one_interaction
  CHECK (num_nonnulls(call_log_id, field_visit_id) <= 1);
CREATE INDEX idx_payments_call_log ON payments (call_log_id) WHERE call_log_id IS NOT NULL;
CREATE INDEX idx_payments_field_visit ON payments (field_visit_id) WHERE field_visit_id IS NOT NULL;

-- Phase 6 §4.5: idempotency completion. Each of these three writes was
-- still not safely retryable over an unreliable mobile connection.
ALTER TABLE ptps ADD COLUMN client_key UUID;
CREATE UNIQUE INDEX uq_ptps_client_key ON ptps (agent_id, client_key) WHERE client_key IS NOT NULL;

ALTER TABLE attendance ADD COLUMN punch_out_client_key UUID;
CREATE UNIQUE INDEX uq_attendance_punch_out_client_key
  ON attendance (user_id, punch_out_client_key) WHERE punch_out_client_key IS NOT NULL;

-- reminders.client_key + its unique index already exist (used by POST
-- /reminders); PATCH /reminders/:id needs its own separate key so a retried
-- PATCH doesn't collide with the POST that created the row, or with itself
-- across genuinely-different PATCH calls to the same reminder.
ALTER TABLE reminders ADD COLUMN patch_client_key UUID;
CREATE UNIQUE INDEX uq_reminders_patch_client_key
  ON reminders (created_by, patch_client_key) WHERE patch_client_key IS NOT NULL;

-- Down Migration
DROP INDEX IF EXISTS uq_reminders_patch_client_key;
ALTER TABLE reminders DROP COLUMN IF EXISTS patch_client_key;
DROP INDEX IF EXISTS uq_attendance_punch_out_client_key;
ALTER TABLE attendance DROP COLUMN IF EXISTS punch_out_client_key;
DROP INDEX IF EXISTS uq_ptps_client_key;
ALTER TABLE ptps DROP COLUMN IF EXISTS client_key;
DROP INDEX IF EXISTS idx_payments_field_visit;
DROP INDEX IF EXISTS idx_payments_call_log;
ALTER TABLE payments DROP CONSTRAINT IF EXISTS chk_payments_one_interaction;
ALTER TABLE payments DROP COLUMN IF EXISTS field_visit_id;
ALTER TABLE payments DROP COLUMN IF EXISTS call_log_id;
