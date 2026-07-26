-- Up Migration
-- Phase 2.4: the worklist had no follow-up ordering for a customer with no
-- pending PTP (fell back to due_amount, which has nothing to do with when
-- an agent should next act). next_action_date is the earliest of the
-- customer's pending PTP promised_date and pending reminder remind_at date
-- (maintained by refreshNextActionDate() in ptp-service.ts, called
-- whenever a PTP or reminder is created or resolved). dpd stores the same
-- days-past-due figure report-service.ts computed ad hoc on every request
-- (CURRENT_DATE - due_date) -- as a real column it's filterable, sortable,
-- and indexable, refreshed nightly (see scheduler.ts) since it changes
-- with the passage of time, not just on write events. updated_at closes
-- the gap where customers.* was mutated by imports, branch reassignment,
-- and rollback with no change timestamp at all.

ALTER TABLE customers ADD COLUMN next_action_date DATE;
ALTER TABLE customers ADD COLUMN dpd INT;
ALTER TABLE customers ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE INDEX idx_customers_next_action_date ON customers (next_action_date)
  WHERE status = 'active';
CREATE INDEX idx_customers_dpd ON customers (dpd) WHERE status = 'active';

-- Backfill dpd for existing active customers with a due_date.
UPDATE customers SET dpd = GREATEST((now() AT TIME ZONE 'Asia/Kolkata')::date - due_date, 0)
 WHERE due_date IS NOT NULL;

-- Backfill next_action_date from whatever pending PTPs/reminders already exist.
UPDATE customers c
   SET next_action_date = (
     SELECT MIN(d) FROM (
       SELECT promised_date AS d FROM ptps WHERE customer_id = c.id AND status = 'pending'
       UNION ALL
       SELECT (remind_at AT TIME ZONE 'Asia/Kolkata')::date AS d
         FROM reminders WHERE customer_id = c.id AND status = 'pending'
     ) sub
   );

-- A trigger rather than hand-editing every UPDATE customers site: there are
-- more of them than the three the audit named (imports.ts alone has three
-- separate UPDATE statements for additions/reactivations/removals/recall),
-- and a hand-picked subset would inevitably miss one, silently leaving
-- updated_at stale exactly where it matters. This does mean the nightly
-- DPD refresh and next_action_date recompute also bump it -- treated here
-- as "this row's data is current as of X", not "a human edited this row",
-- which is the more useful and unambiguous of the two meanings to guarantee.
CREATE OR REPLACE FUNCTION set_customers_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_customers_updated_at
  BEFORE UPDATE ON customers
  FOR EACH ROW
  EXECUTE FUNCTION set_customers_updated_at();

-- Down Migration
DROP TRIGGER trg_customers_updated_at ON customers;
DROP FUNCTION set_customers_updated_at();
DROP INDEX idx_customers_dpd;
DROP INDEX idx_customers_next_action_date;
ALTER TABLE customers DROP COLUMN updated_at;
ALTER TABLE customers DROP COLUMN dpd;
ALTER TABLE customers DROP COLUMN next_action_date;
