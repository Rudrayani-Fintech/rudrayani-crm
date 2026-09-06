-- Make `customer_branch` a core, enabled-by-default field.
--
-- Why: migration 1787400000000 added customer_branch with is_core = false AND
-- wrote an explicit `is_enabled = false` company_field_settings row for every
-- company. resolveFieldCatalog() resolves enablement as
-- COALESCE(settings.is_enabled, definition.is_core), so the field was off for
-- every company, which meant it never appeared in the import mapping dropdown.
-- With no column mapped to it, customers.branch_id was left NULL on every
-- imported row, and customerBranchClamp() (which matches on c.branch_id, or a
-- custom_fields->>'branch' fallback) then matched nothing -- so a branch
-- manager saw ZERO customers while still correctly seeing their own staff.
-- Verified live: BM saw 0 of 12 customers; after enabling this one field and
-- re-importing, they saw exactly their own 6.
--
-- Deliberately NOT made required: an allocation file with no branch column
-- must still import cleanly (branch_id simply stays NULL for those rows).

-- 1. The definition itself becomes core, so any company with no explicit
--    settings row now defaults to enabled.
UPDATE system_field_definitions
   SET is_core = true
 WHERE field_key = 'customer_branch';

-- 2. Existing per-company rows carry an explicit `false` that would keep
--    overriding is_core, so flip those too. Only touches rows still sitting at
--    the migration-seeded default; a company that deliberately turned it on is
--    already true and is unaffected.
UPDATE company_field_settings
   SET is_enabled = true, updated_at = now()
 WHERE field_key = 'customer_branch'
   AND is_enabled = false;
