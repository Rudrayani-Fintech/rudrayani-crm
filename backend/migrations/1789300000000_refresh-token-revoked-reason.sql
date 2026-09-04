-- Up Migration

-- Phase 1 fix, found during verification of A5/O4: refresh()'s replay
-- defense treats ANY revoked token being presented again as evidence of a
-- stolen-and-replayed token, and responds by revoking every session the
-- user has. That's correct for its original purpose (a single-use token
-- rotated out and then reused), but the same code path also fires for
-- tokens revoked for entirely administrative reasons -- a password reset
-- revoking only the web session (O4), a device login superseding another
-- device (A3), a deactivation, a self-service password change. In every
-- one of those cases the OTHER, still-legitimate session's client hasn't
-- been told its token died yet, and the very next ordinary refresh from
-- that client would trigger the "replay" defense and kill every session
-- for the user -- including the one A5/O4 exists specifically to protect.
--
-- `revoked_reason` lets refresh() tell these apart: only a 'rotated' token
-- reused is treated as a replay attack.
ALTER TABLE refresh_tokens ADD COLUMN revoked_reason TEXT
  CHECK (revoked_reason IN (
    'rotated', 'device_superseded', 'admin_reset', 'deactivated',
    'self_password_reset', 'logout'
  ));

-- Down Migration
ALTER TABLE refresh_tokens DROP COLUMN IF EXISTS revoked_reason;
