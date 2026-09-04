-- Up Migration

-- O3 (owner decision, 2026-09-04): "Inability to Pay" was OC-only, so a
-- field agent visiting a customer at their doorstep had no way to log this
-- outcome even though it's a plausible thing to hear face-to-face. Make it
-- OC/FV like every other dual-channel code.

-- Relabel the existing OC row's action_code for consistency with how every
-- other dual-channel code is labelled in the admin UI and pickers (e.g.
-- "OC/FV_CB — Call Back") -- purely a display label; channel-based picker
-- filtering runs on the `channel` column, not `action_code`, so this alone
-- changes nothing about who sees the code.
UPDATE disposition_codes
   SET action_code = 'OC/FV'
 WHERE action_code = 'OC' AND result_code = 'IP' AND channel = 'OC' AND is_active = true;

-- Add the FV twin so field agents can actually log it. ON CONFLICT DO
-- NOTHING on the natural key from 1789100000000 makes this safe to run more
-- than once, and safe across every agency that has this code (not just the
-- one seeded locally).
INSERT INTO disposition_codes
    (agency_id, action_code, category, result_code, description, remark_template,
     needs_amount, needs_date, needs_time, needs_mode, needs_reason, needs_name_relation,
     is_active, channel)
SELECT agency_id, action_code, category, result_code, description, remark_template,
       needs_amount, needs_date, needs_time, needs_mode, needs_reason, needs_name_relation,
       true, 'FV'
  FROM disposition_codes
 WHERE action_code = 'OC/FV' AND result_code = 'IP' AND channel = 'OC' AND is_active = true
ON CONFLICT (
  agency_id, action_code, COALESCE(result_code, ''), COALESCE(description, ''),
  COALESCE(remark_template, ''), channel
) DO NOTHING;

-- Down Migration
DELETE FROM disposition_codes
 WHERE action_code = 'OC/FV' AND result_code = 'IP' AND channel = 'FV';
UPDATE disposition_codes
   SET action_code = 'OC'
 WHERE action_code = 'OC/FV' AND result_code = 'IP' AND channel = 'OC';
