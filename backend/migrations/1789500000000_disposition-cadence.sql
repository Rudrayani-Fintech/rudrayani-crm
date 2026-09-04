-- Up Migration

-- Phase 4 (§4.2): the day-plan engine. A disposition code now carries its
-- own cadence -- how long until the customer resurfaces, and whether they
-- leave the agent's queue entirely.
ALTER TABLE disposition_codes ADD COLUMN followup_after_hours INT;
ALTER TABLE disposition_codes ADD COLUMN exits_agent_queue BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE disposition_codes ADD COLUMN routes_to TEXT
  CHECK (routes_to IN ('field', 'manager', 'data_correction', 'closed') OR routes_to IS NULL);

-- Seed defaults by category, admin-editable per row afterward. Matched
-- against the real category strings seeded from Trail_Codes.xlsx (see
-- seed_disposition_codes.ts) -- several differ from the spec's shorthand
-- names, resolved here:
--   * "Not connected (NC, RNR, Phone Out Of Service)" -> categories NC, RNR
--     exist; no distinct "Phone Out Of Service" category exists in the
--     sheet, so nothing to match for it.
--   * "Pick Up / Left Message" -> categories PICK UP, LEFT MESSAGE. (There
--     is no separate field-specific "Pick Up" row -- the sheet's one PICK UP
--     row is action_code OC. "Field Referral" below is the row that
--     actually exits to the field.)
--   * "Escalated Case / Legal Proceedings" -> categories ESCALATED CASE and
--     LGL ( Legal Initiation) (a distinct category not literally named in
--     the spec table, but plainly the same "legal proceedings" bucket).
--   * "Cleared From Bank / Paid" -> category CLEARED FROM BANK, plus the
--     result_code = 'PAID' rows (category is blank for those -- "PAID" is
--     the sheet's actual full-payment trail code per I1/§1.5).
-- Any category not named in §4.2's table (ANF, DISPUTE, DL, ENA, EXPIRED,
-- INC, INSURANCE, NSP, PENAL, REDEP, RESOLVED, SETTLEMENT, SFT, SKIP, PNU,
-- and the sheet's blank-category rows other than PAID) is deliberately left
-- at the column defaults (NULL / false / NULL) -- the spec doesn't define a
-- cadence for them, and inventing one isn't this migration's call to make.

-- Promise to Pay / Call Back: no followup_after_hours override -- these
-- already resurface via the PTP date / captured reminder time (the two
-- existing sources in refreshNextActionDate()).
-- (Nothing to UPDATE: followup_after_hours stays NULL, the column default.)

UPDATE disposition_codes
   SET followup_after_hours = 24
 WHERE category IN ('PICK UP', 'LEFT MESSAGE');

UPDATE disposition_codes
   SET followup_after_hours = 4
 WHERE category IN ('NC', 'RNR');

UPDATE disposition_codes
   SET followup_after_hours = 168
 WHERE category = 'OUT OF STATION';

UPDATE disposition_codes
   SET followup_after_hours = 72
 WHERE category = 'REFUSE TO PAY';

UPDATE disposition_codes
   SET followup_after_hours = 360
 WHERE category = 'INABILITY TO PAY';

UPDATE disposition_codes
   SET followup_after_hours = 24
 WHERE category = 'RV';

UPDATE disposition_codes
   SET exits_agent_queue = true, routes_to = 'data_correction'
 WHERE category IN ('WRONG NUMBER', 'NEW MOBILE NUMBER');

UPDATE disposition_codes
   SET exits_agent_queue = true, routes_to = 'field'
 WHERE category = 'FIELD REFERRAL';

UPDATE disposition_codes
   SET exits_agent_queue = true, routes_to = 'manager'
 WHERE category IN ('ESCALATED CASE', 'LGL ( Legal Initiation)');

UPDATE disposition_codes
   SET exits_agent_queue = true, routes_to = 'closed'
 WHERE category = 'CLEARED FROM BANK' OR result_code = 'PAID';

-- Down Migration
ALTER TABLE disposition_codes DROP COLUMN IF EXISTS routes_to;
ALTER TABLE disposition_codes DROP COLUMN IF EXISTS exits_agent_queue;
ALTER TABLE disposition_codes DROP COLUMN IF EXISTS followup_after_hours;
