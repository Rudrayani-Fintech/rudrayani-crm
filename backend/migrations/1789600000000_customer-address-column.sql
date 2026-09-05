-- Up Migration

-- Phase 5 (N1, N2, §4.3): address is lender-sourced and read-only. Promote
-- it from a fuzzy custom_fields lookup (what the mobile customer-detail
-- screen has always done ad hoc, see customer_detail_screen.dart's
-- `_address` getter) to a real column, and require it going forward.
ALTER TABLE customers ADD COLUMN address TEXT;

-- Backfill from custom_fields using the exact same fuzzy match mobile
-- already uses: the first key whose lower-cased name contains 'address' or
-- 'addr', with a non-empty trimmed value. jsonb_each_text() doesn't
-- guarantee original insertion order the way a Dart Map does, but this is a
-- one-time historical backfill, not an ongoing behavior -- any customer
-- with more than one address-looking column is a rare edge case either way.
UPDATE customers c
   SET address = sub.v
  FROM (
    SELECT DISTINCT ON (c2.id) c2.id, TRIM(kv.value) AS v
      FROM customers c2, jsonb_each_text(c2.custom_fields) kv
     WHERE (lower(kv.key) LIKE '%address%' OR lower(kv.key) LIKE '%addr%')
       AND TRIM(kv.value) <> ''
     ORDER BY c2.id, kv.key
  ) sub
 WHERE c.id = sub.id;

-- The address field definition: was storage_column = NULL / is_core = false
-- (a mappable-but-optional custom field). Now routes to the real column and
-- is required. is_core must also flip to true, not just storage_column --
-- resolveFieldCatalog() defaults is_enabled to is_core
-- (COALESCE(s.is_enabled, d.is_core)) for any company with no explicit
-- override, and import-service.ts's required-field check is gated on
-- `is_enabled && is_required` -- leaving is_core false would silently skip
-- the new required-at-import check for every company that never explicitly
-- enabled address, which is precisely the set of companies this migration
-- is targeting.
UPDATE system_field_definitions
   SET storage_column = 'address', is_core = true
 WHERE field_key = 'address';

-- Down Migration
UPDATE system_field_definitions
   SET storage_column = NULL, is_core = false
 WHERE field_key = 'address';
ALTER TABLE customers DROP COLUMN IF EXISTS address;
