-- Phase 6.2: customer_month_snapshots had no branch_id of its own, so every
-- branch-scoped report resolved it at query time via a 3-way COALESCE
-- (team's branch -> customer's CURRENT branch -> agent's CURRENT branch).
-- For a historical month, "current" branch can be wrong if the customer or
-- agent moved branches since -- a mid-month reallocation retroactively
-- reassigns last month's numbers to the new branch. Capturing branch_id at
-- snapshot time (see import-service.ts) fixes that going forward; this
-- backfills existing rows with the same COALESCE the code already used, so
-- the migration changes nothing about today's numbers, only how tomorrow's
-- get stored.

ALTER TABLE customer_month_snapshots
  ADD COLUMN branch_id UUID REFERENCES branches(id);

UPDATE customer_month_snapshots s
   SET branch_id = COALESCE(
         (SELECT branch_id FROM teams WHERE id = s.assigned_team_id),
         c.branch_id,
         (SELECT branch_id FROM users WHERE id = s.assigned_agent_id)
       )
  FROM customers c
 WHERE c.id = s.customer_id
   AND s.branch_id IS NULL;

CREATE INDEX idx_customer_month_snapshots_branch ON customer_month_snapshots (branch_id);
