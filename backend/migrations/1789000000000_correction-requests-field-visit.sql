-- Up Migration

-- Widen correction_requests.record_type to also accept 'field_visit', so an
-- agent can request a correction to a field-visit remark after the 24h
-- direct-edit window closes (mirrors the existing call_log path). The route
-- handler's RECORD_TYPES/ALLOWED_FIELDS were updated alongside this in
-- correction-requests.ts -- both need to agree, or every field_visit
-- correction request fails this table-level CHECK before it can be stored.
ALTER TABLE correction_requests DROP CONSTRAINT correction_requests_record_type_check;
ALTER TABLE correction_requests ADD CONSTRAINT correction_requests_record_type_check
  CHECK (record_type IN ('payment', 'call_log', 'ptp', 'field_visit'));

-- Down Migration

-- Re-adding the narrower CHECK below validates every existing row against
-- it, so any 'field_visit' correction request created while the Up
-- migration was in effect would make this DOWN migration fail outright.
-- There is no correct narrower value to remap those rows to (none of
-- 'payment'/'call_log'/'ptp' is what they actually correct), so the only
-- way to keep the down-migration runnable is to drop them -- acceptable
-- here because rolling back this migration is already a "field_visit
-- corrections no longer exist as a concept" decision.
DELETE FROM correction_requests WHERE record_type = 'field_visit';
ALTER TABLE correction_requests DROP CONSTRAINT correction_requests_record_type_check;
ALTER TABLE correction_requests ADD CONSTRAINT correction_requests_record_type_check
  CHECK (record_type IN ('payment', 'call_log', 'ptp'));
