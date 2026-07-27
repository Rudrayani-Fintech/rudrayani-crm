-- Up Migration
-- Phase 2.3: payments had only a UUID primary key -- no human-readable
-- receipt number, despite the mobile app already labelling a KPI "Receipts
-- Generated" for an artifact that didn't exist. receipt_sequences backs an
-- atomic per-branch-per-financial-year counter (RD/<BRANCH>/<FY>/<seq>);
-- receipt_no is generated in ptp-service.ts's sibling receipt-service.ts at
-- payment-insert time, inside the same transaction.

CREATE TABLE receipt_sequences (
  scope_key TEXT PRIMARY KEY,
  next_seq INT NOT NULL DEFAULT 1
);

ALTER TABLE payments ADD COLUMN receipt_no TEXT UNIQUE;

-- Backfill existing payments with a receipt number using the same scheme,
-- oldest first so numbering reads as a sane chronological sequence per
-- branch/FY rather than assignment order.
DO $$
DECLARE
  pmt_rec RECORD;
  branch_name TEXT;
  code TEXT;
  fy TEXT;
  scope TEXT;
  seq INT;
BEGIN
  FOR pmt_rec IN
    SELECT p.id, p.paid_at, u.branch_id
      FROM payments p
      JOIN users u ON u.id = p.collected_by_user_id
     ORDER BY p.paid_at ASC
  LOOP
    SELECT b.name INTO branch_name FROM branches b WHERE b.id = pmt_rec.branch_id;
    code := COALESCE(NULLIF(regexp_replace(upper(branch_name), '[^A-Z0-9]', '', 'g'), ''), 'GEN');
    code := left(code, 4);
    -- Indian financial year: Apr 1 - Mar 31.
    fy := CASE WHEN EXTRACT(MONTH FROM pmt_rec.paid_at AT TIME ZONE 'Asia/Kolkata') >= 4
      THEN right((EXTRACT(YEAR FROM pmt_rec.paid_at AT TIME ZONE 'Asia/Kolkata'))::text, 2)
           || '-' || right((EXTRACT(YEAR FROM pmt_rec.paid_at AT TIME ZONE 'Asia/Kolkata') + 1)::text, 2)
      ELSE right((EXTRACT(YEAR FROM pmt_rec.paid_at AT TIME ZONE 'Asia/Kolkata') - 1)::text, 2)
           || '-' || right((EXTRACT(YEAR FROM pmt_rec.paid_at AT TIME ZONE 'Asia/Kolkata'))::text, 2)
    END;
    scope := 'RD/' || code || '/' || fy;

    INSERT INTO receipt_sequences (scope_key, next_seq) VALUES (scope, 1)
      ON CONFLICT (scope_key) DO UPDATE SET next_seq = receipt_sequences.next_seq + 1
      RETURNING next_seq INTO seq;

    UPDATE payments SET receipt_no = scope || '/' || lpad(seq::text, 5, '0') WHERE id = pmt_rec.id;
  END LOOP;
END $$;

-- Down Migration
ALTER TABLE payments DROP COLUMN receipt_no;
DROP TABLE receipt_sequences;
