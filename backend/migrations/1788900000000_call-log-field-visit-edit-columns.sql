-- Up Migration
-- Same-day remark edit (rolling 24h, owner-only): call_logs.remark is
-- server-composed from a disposition template + structured fields + a
-- free-text tail (see disposition-service.ts composeRemark() and
-- call-logs.ts's `${composed} — ${extra_remark}` concatenation) -- until now
-- extra_remark was folded into the final string and discarded, so there was
-- nothing to re-edit without redoing the whole composition. Storing it
-- separately lets an edit recompose remark = composed(disposition, details)
-- + " -- " + new extra_remark without touching the disposition-driven part.
ALTER TABLE call_logs ADD COLUMN extra_remark TEXT;
ALTER TABLE call_logs ADD COLUMN edited_at TIMESTAMPTZ;
ALTER TABLE field_visits ADD COLUMN edited_at TIMESTAMPTZ;

-- Down Migration
ALTER TABLE field_visits DROP COLUMN edited_at;
ALTER TABLE call_logs DROP COLUMN edited_at;
ALTER TABLE call_logs DROP COLUMN extra_remark;
