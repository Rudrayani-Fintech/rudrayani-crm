-- Up Migration

-- Phase 7 (§4.8, S5): split tracking visibility. tracking.view stays
-- granted to telecaller/field_agent for their own self-scoped data
-- (/tracking/team-day, /tracking/route -- see 1786000000000's comment) and
-- to agency_admin/operations_manager/branch_manager as before. The new
-- tracking.view_team gates the live map and route replay for managers only
-- -- a telecaller/field_agent must never see the team-wide live map.
INSERT INTO permissions (key, description) VALUES
  ('tracking.view_team', 'View the live team map and route replay for a team, branch, or the whole agency');

INSERT INTO capability_permissions (capability, permission_key) VALUES
  ('agency_admin', 'tracking.view_team'),
  ('operations_manager', 'tracking.view_team'),
  ('branch_manager', 'tracking.view_team');

-- Phase 7 (P2, P3, §4.10): the targets feature (dashboard, KPIs,
-- targets.manage) is deleted entirely -- replaced by the ledger
-- (/reports/agent-activity, kept below).
DELETE FROM capability_permissions WHERE permission_key = 'targets.manage';
DELETE FROM permissions WHERE key = 'targets.manage';
DROP TABLE IF EXISTS targets;

-- Down Migration
-- targets table recreation is not reversed -- its own migration
-- (1784200000000) remains the source of truth for that shape, and reviving
-- deleted target rows isn't recoverable from this migration alone.
INSERT INTO permissions (key, description) VALUES
  ('targets.manage', 'Set monthly collection/metric targets')
  ON CONFLICT (key) DO NOTHING;
INSERT INTO capability_permissions (capability, permission_key) VALUES
  ('agency_admin', 'targets.manage'),
  ('operations_manager', 'targets.manage')
  ON CONFLICT DO NOTHING;
DELETE FROM capability_permissions WHERE permission_key = 'tracking.view_team';
DELETE FROM permissions WHERE key = 'tracking.view_team';
