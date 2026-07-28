-- Phase 8.1: every report/dashboard query filters payments by a paid_at
-- date range, but the only existing payments indexes are on customer_id and
-- a partial (undeposited-only) created_at index -- a full-book paid_at range
-- scan, or a per-agent "my collections" query, both hit a sequential scan.
CREATE INDEX idx_payments_paid_at ON payments (paid_at);
CREATE INDEX idx_payments_collected_by ON payments (collected_by_user_id);

-- The worklist/allocation/customer-list screens all filter by
-- (company, status) together, and separately by bucket/product for the
-- breakdown reports and filter dropdowns -- none of these had a supporting
-- index, so every one of them was a sequential scan over the whole book.
CREATE INDEX idx_customers_company_status ON customers (company_id, status);
CREATE INDEX idx_customers_status ON customers (status);
CREATE INDEX idx_customers_bucket ON customers (bucket);
CREATE INDEX idx_customers_product ON customers (product);

-- Reports scanning call-log/field-visit activity by date range (agent
-- productivity, trail analytics) had no time-based index at all on
-- field_visits, and call_logs only had a composite (agent_id, created_at) --
-- no help for a date-range scan that isn't also filtered to one agent.
CREATE INDEX idx_call_logs_created_at ON call_logs (created_at);
CREATE INDEX idx_field_visits_created_at ON field_visits (created_at);

-- customers.custom_fields->>'branch' is read by every branch-scope clamp
-- in scope.ts and every route that calls it (worklist.ts, allocations.ts,
-- customers.ts, report-service.ts) as the fallback for a customer with no
-- structured branch_id -- a JSONB scan with no index at all until now.
CREATE INDEX idx_customers_custom_fields_gin ON customers USING gin (custom_fields);

-- Leading-wildcard ILIKE ('%term%') searches on customer_name/loan_number
-- (customers.ts, worklist.ts) can't use a plain btree index; pg_trgm's
-- trigram GIN index is the standard fix and was never installed.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX idx_customers_name_trgm ON customers USING gin (customer_name gin_trgm_ops);
CREATE INDEX idx_customers_loan_number_trgm ON customers USING gin (loan_number gin_trgm_ops);
CREATE INDEX idx_customers_mobile_trgm ON customers USING gin (mobile_number gin_trgm_ops);
