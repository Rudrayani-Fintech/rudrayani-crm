-- Up Migration
-- Phase 2.1: ptps.status was declared with kept/broken as valid values
-- since the very first migration, but nothing in the codebase ever wrote
-- them -- every PTP sits at 'pending' forever, which makes
-- ptps_kept/ptps_broken/ptp_conversion_pct (trailAnalytics) permanently
-- zero. This is the single most important collections KPI and it did not
-- exist. kept_amount records what was actually paid (may be less than the
-- promised amount -- a partial payment still counts as the promise being
-- kept, matching standard collections-industry convention of "did they pay
-- by the promised date" rather than "did they pay the exact amount).
-- satisfied_by_payment_id links back to the payment that satisfied it, for
-- audit/drill-down.

ALTER TABLE ptps ADD COLUMN kept_amount NUMERIC(14,2);
ALTER TABLE ptps ADD COLUMN satisfied_by_payment_id UUID REFERENCES payments(id);

-- Backfill: any PTP whose promised_date has already passed and is still
-- 'pending' is broken as of today. Anything satisfied by a historical
-- payment that already exists is left for the app to reconcile going
-- forward (this migration only needs to seed the "definitely broken"
-- backlog so the nightly job's future writes aren't the sole source of
-- kept/broken data for months of pre-existing pending rows).
UPDATE ptps SET status = 'broken'
 WHERE status = 'pending' AND promised_date < (now() AT TIME ZONE 'Asia/Kolkata')::date;

-- Down Migration
ALTER TABLE ptps DROP COLUMN satisfied_by_payment_id;
ALTER TABLE ptps DROP COLUMN kept_amount;
-- Note: this down migration cannot restore the 'pending' status the
-- backfill above overwrote to 'broken' -- the original values are gone.
