-- Up Migration

-- Drop dashboard_preferences: the last consumer is gone.
--
-- The table backed per-user show/hide + reorder of Management Dashboard metric
-- widgets. Phase 7 deleted the KPI surface on the backend and Phase 15 deleted
-- the widget registry, the customiser and the useDashboardPreferences hook on
-- the web client. An audit confirmed zero callers of GET/PUT/DELETE
-- /api/dashboard-preferences in either frontend/src or mobile/lib, so the
-- routes and their test have been removed alongside this table.
--
-- The stored `layout` JSON described widgets that no longer exist in any
-- client, so there is nothing worth migrating out of it.

DROP TABLE IF EXISTS dashboard_preferences;

-- Down Migration

CREATE TABLE dashboard_preferences (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL DEFAULT 'Default',
    layout JSONB NOT NULL,
    is_default BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX dashboard_preferences_one_default_per_user
    ON dashboard_preferences (user_id) WHERE is_default;
CREATE INDEX dashboard_preferences_user_id_idx ON dashboard_preferences (user_id);
