-- ============================================================
-- PRODUCTION FULL RESET (portable SQL -- no psql-only syntax)
-- Wipes everything except: the agency row, the agency-admin login
-- (phone 9999999999), disposition_codes, and static app config
-- (permissions, capability_permissions, system_field_definitions).
--
-- IMPORTANT: this file intentionally avoids `\gset` and `:'var'`
-- (psql meta-commands / client-side variables) -- a GUI client like
-- Beekeeper Studio does not understand them, silently fails those
-- specific statements, and continues running the rest, which is how
-- a prior run of this script left branches/teams/companies/non-admin
-- users behind uncleaned while the plain TRUNCATEs went through.
-- Every statement below is plain SQL any Postgres client can run.
--
-- Idempotent: safe to re-run start to finish even if some tables are
-- already empty from a previous partial run.
--
-- Run the WHOLE file in one execution (not statement-by-statement),
-- then check the after-counts before doing anything else.
-- ============================================================

-- ── SANITY CHECK ──────────────────────────────────────────────
-- Aborts (raises an error) instead of silently deleting everyone if
-- the admin phone doesn't exist, or exists more than once.
DO $$
BEGIN
  IF (SELECT COUNT(*) FROM users WHERE phone = '9999999999') <> 1 THEN
    RAISE EXCEPTION 'Admin phone 9999999999 not found (or not unique) -- aborting wipe';
  END IF;
END $$;

-- ── BEFORE COUNTS ────────────────────────────────────────────
SELECT 'agencies'                AS tbl, COUNT(*) AS n FROM agencies
UNION ALL SELECT 'users',                        COUNT(*) FROM users
UNION ALL SELECT 'branches',                     COUNT(*) FROM branches
UNION ALL SELECT 'teams',                        COUNT(*) FROM teams
UNION ALL SELECT 'companies',                    COUNT(*) FROM companies
UNION ALL SELECT 'customers',                    COUNT(*) FROM customers
UNION ALL SELECT 'disposition_codes (preserved)', COUNT(*) FROM disposition_codes
UNION ALL SELECT 'call_logs',                     COUNT(*) FROM call_logs
UNION ALL SELECT 'payments',                      COUNT(*) FROM payments
UNION ALL SELECT 'ptps',                          COUNT(*) FROM ptps
UNION ALL SELECT 'import_runs',                   COUNT(*) FROM import_runs
ORDER BY tbl;

-- ── WIPE TRANSACTIONAL TABLES + COMPANIES ────────────────────
-- Deliberately excludes branches/teams/users/agencies here:
-- users.branch_id / users.team_id reference branches/teams, and
-- TRUNCATE ... CASCADE cascades to the WHOLE dependent table (not
-- just matching rows), which would wipe the kept admin row too.
-- Safe to re-run: TRUNCATE on an already-empty table is a no-op.
TRUNCATE TABLE
  location_pings,
  attendance,
  reminders,
  attachments,
  field_visits,
  reallocation_requests,
  correction_requests,
  ptps,
  call_logs,
  payments,
  import_review_items,
  allocation_logs,
  bucket_movements,
  customer_month_snapshots,
  dashboard_preferences,
  targets,
  buckets,
  company_field_settings,
  import_runs,
  products,
  import_templates,
  customers,
  companies,
  refresh_tokens,
  otp_requests,
  audit_logs
RESTART IDENTITY CASCADE;

-- ── WIPE ALL USERS EXCEPT THE ADMIN ───────────────────────────
-- users.manager_id self-references users with no ON DELETE action;
-- null it out everywhere first so the batch delete never trips over
-- a still-referenced manager mid-delete.
UPDATE users SET manager_id = NULL;
-- branches.branch_manager_id also references users with NO ACTION
-- (no CASCADE) -- null it out too, otherwise DELETE FROM users below
-- fails on any branch still pointing at a non-admin manager. Harmless
-- since branches themselves are deleted a few statements down anyway.
UPDATE branches SET branch_manager_id = NULL;
DELETE FROM users WHERE phone <> '9999999999';

-- Admin's own branch/team is about to be deleted -- clear those refs
-- so branches/teams can be removed without touching the users table.
UPDATE users SET branch_id = NULL, team_id = NULL WHERE phone = '9999999999';

-- ── WIPE ORG STRUCTURE (branches/teams) ──────────────────────
-- Plain DELETE, not TRUNCATE: only removes rows, never cascades to
-- the whole users table the way TRUNCATE would.
DELETE FROM teams;
DELETE FROM branches;

-- ── CLEAR OTHER AGENCIES' PRESERVED-TABLE ROWS (edge case) ───
-- disposition_codes has no ON DELETE CASCADE from agencies, so any
-- other agency's codes must go before the agency row itself can.
-- (system_field_definitions IS ON DELETE CASCADE, so no manual step
-- needed there.) No-op if this DB only ever had one agency.
DELETE FROM disposition_codes
WHERE agency_id <> (SELECT agency_id FROM users WHERE phone = '9999999999');

-- ── WIPE ALL OTHER AGENCIES ───────────────────────────────────
DELETE FROM agencies
WHERE id <> (SELECT agency_id FROM users WHERE phone = '9999999999');

-- ── AFTER COUNTS ─────────────────────────────────────────────
SELECT 'agencies (should be 1)'          AS tbl, COUNT(*) AS n FROM agencies
UNION ALL SELECT 'users (should be 1)',                  COUNT(*) FROM users
UNION ALL SELECT 'branches (should be 0)',                COUNT(*) FROM branches
UNION ALL SELECT 'teams (should be 0)',                   COUNT(*) FROM teams
UNION ALL SELECT 'companies (should be 0)',               COUNT(*) FROM companies
UNION ALL SELECT 'customers (should be 0)',               COUNT(*) FROM customers
UNION ALL SELECT 'disposition_codes (preserved, unchanged)', COUNT(*) FROM disposition_codes
UNION ALL SELECT 'call_logs (should be 0)',                COUNT(*) FROM call_logs
UNION ALL SELECT 'payments (should be 0)',                 COUNT(*) FROM payments
UNION ALL SELECT 'permissions (preserved, unchanged)',     COUNT(*) FROM permissions
UNION ALL SELECT 'capability_permissions (preserved, unchanged)', COUNT(*) FROM capability_permissions
UNION ALL SELECT 'system_field_definitions (preserved for kept agency)', COUNT(*) FROM system_field_definitions
ORDER BY tbl;

-- ── PRESERVED: the one agency, the admin user (phone 9999999999),
--              disposition_codes, permissions, capability_permissions,
--              system_field_definitions ──
-- No BEGIN/COMMIT wrapper: every statement above is self-contained
-- and safe to re-run, since this GUI client's transaction handling
-- around explicit BEGIN/COMMIT proved unreliable last time. If you'd
-- rather review before committing, wrap this whole file in your own
-- BEGIN; ... COMMIT; using Beekeeper's transaction controls, or run
-- it via `psql "$DATABASE_URL" -f prod-data-wipe-full.sql` instead,
-- where BEGIN/COMMIT here behave exactly as written.
