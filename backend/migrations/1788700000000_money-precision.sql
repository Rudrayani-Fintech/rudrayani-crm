-- Phase 8.6: due_amount/emi/payments.amount/ptps.amount were bare NUMERIC
-- (unbounded precision/scale) while pos and the snapshot/target tables were
-- already NUMERIC(14,2) -- an inconsistent schema for the same kind of value.
-- NUMERIC(14,2) supports up to 99,999,999,999.99 (nearly 1000 crore), well
-- beyond any single customer/payment/PTP amount this system handles.
ALTER TABLE customers ALTER COLUMN due_amount TYPE NUMERIC(14, 2);
ALTER TABLE customers ALTER COLUMN emi TYPE NUMERIC(14, 2);
ALTER TABLE payments ALTER COLUMN amount TYPE NUMERIC(14, 2);
ALTER TABLE ptps ALTER COLUMN amount TYPE NUMERIC(14, 2);
