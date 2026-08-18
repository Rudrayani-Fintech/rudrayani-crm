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
ALTER TABLE correction_requests DROP CONSTRAINT correction_requests_record_type_check;
ALTER TABLE correction_requests ADD CONSTRAINT correction_requests_record_type_check
  CHECK (record_type IN ('payment', 'call_log', 'ptp'));
