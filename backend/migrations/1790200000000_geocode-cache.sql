-- Up Migration

-- Reverse-geocode cache (Nominatim's usage policy requires caching results
-- and forbids re-requesting the same location). Keyed on lat/lng rounded to
-- 4 decimal places (~11m grid) so GPS jitter between pings at effectively
-- the same spot (e.g. punch-in vs. a stationary dwell later that day) reuses
-- one row instead of one Nominatim call each. Not agency-scoped -- a lat/lng's
-- village/city is a geographic fact, not a tenant-specific one, so caching it
-- once benefits every agency.
CREATE TABLE IF NOT EXISTS geocode_cache (
    lat_rounded NUMERIC(7,4) NOT NULL,
    lng_rounded NUMERIC(7,4) NOT NULL,
    village TEXT,
    taluka TEXT,
    city TEXT,
    district TEXT,
    state TEXT,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (lat_rounded, lng_rounded)
);

-- Down Migration
DROP TABLE IF EXISTS geocode_cache;
