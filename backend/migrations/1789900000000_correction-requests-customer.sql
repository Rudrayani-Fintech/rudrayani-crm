-- Up Migration

-- Widen correction_requests.record_type to also accept 'customer' (Phase 16,
-- N3): an agent may request an address correction on a customer they're
-- assigned to (primary or field agent), approved by a manager -- reusing
-- this same request/approve pattern rather than a bespoke workflow.
-- customers.address is lender-sourced and read-only (N1); this is the one
-- sanctioned way it ever changes outside an import. The route handler's
-- RECORD_TYPES/ALLOWED_FIELDS (correction-requests.ts) were updated
-- alongside this -- both need to agree, or every 'customer' correction
-- request fails this table-level CHECK before it can be stored.
ALTER TABLE correction_requests DROP CONSTRAINT correction_requests_record_type_check;
ALTER TABLE correction_requests ADD CONSTRAINT correction_requests_record_type_check
  CHECK (record_type IN ('payment', 'call_log', 'ptp', 'field_visit', 'customer'));

-- Down Migration

-- Same reasoning as the field_visit-widening migration this mirrors: there
-- is no correct narrower value to remap an existing 'customer' row to, so
-- the only way to keep the down-migration runnable is to drop them --
-- acceptable here because rolling back this migration is already a
-- "customer corrections no longer exist as a concept" decision.
DELETE FROM correction_requests WHERE record_type = 'customer';
ALTER TABLE correction_requests DROP CONSTRAINT correction_requests_record_type_check;
ALTER TABLE correction_requests ADD CONSTRAINT correction_requests_record_type_check
  CHECK (record_type IN ('payment', 'call_log', 'ptp', 'field_visit'));
