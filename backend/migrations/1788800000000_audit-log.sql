-- Phase 8.6: there was no audit trail at all for sensitive account/money
-- actions -- employee capability/branch changes, password resets, deposit
-- marking, import rollback. actor_id is nullable because a system/cron job
-- (not a request) may also need to write an audit row in the future.
CREATE TABLE audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agency_id UUID NOT NULL REFERENCES agencies(id),
    actor_id UUID REFERENCES users(id),
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id UUID,
    details JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_logs_agency_created ON audit_logs (agency_id, created_at);
CREATE INDEX idx_audit_logs_entity ON audit_logs (entity_type, entity_id);
