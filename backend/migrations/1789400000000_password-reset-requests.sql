-- Up Migration

-- Phase 2 (A4, S1-S3): mobile password recovery is a request to an admin,
-- not a self-service OTP flow (A2 -- no SMS gateway). An agent who forgot
-- their password submits a free-text request; an admin/branch manager
-- resolves it via the existing POST /employees/:id/reset-password.
CREATE TABLE password_reset_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id UUID NOT NULL REFERENCES agencies(id),
  user_id UUID NOT NULL REFERENCES users(id),
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'resolved', 'rejected')),
  resolved_by UUID REFERENCES users(id),
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- S3: one open request per user -- a second submission updates the
-- existing pending row instead of creating a duplicate.
CREATE UNIQUE INDEX uq_prr_open ON password_reset_requests (user_id) WHERE status = 'pending';

CREATE INDEX idx_prr_agency_status ON password_reset_requests (agency_id, status);

-- Down Migration
DROP TABLE IF EXISTS password_reset_requests;
