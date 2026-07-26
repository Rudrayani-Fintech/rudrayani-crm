-- Up Migration
-- Phase 2.2: PTPs could previously only come into existence as a side
-- effect of logging a call whose disposition code had needs_amount/
-- needs_date set -- there was no way to create one directly (e.g. an agent
-- recording a promise made in person, or on a call logged before this
-- existed). call_log_id being NOT NULL forced every PTP through that one
-- path; making it nullable allows a standalone PTP with no backing call log.

ALTER TABLE ptps ALTER COLUMN call_log_id DROP NOT NULL;

-- Down Migration
-- Only safe to reapply NOT NULL if every row already has a call_log_id --
-- will fail if any standalone PTPs were created since the up migration ran,
-- which is the expected/acceptable behavior for a development down migration.
ALTER TABLE ptps ALTER COLUMN call_log_id SET NOT NULL;
