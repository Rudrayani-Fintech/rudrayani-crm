import { pool } from "../config/db";
import { env } from "../config/env";
import { logger } from "../config/logger";

/**
 * Reverse geocoding (village/taluka/city/district/state) via OpenStreetMap
 * Nominatim -- free, but its usage policy caps requests at 1/sec and
 * requires caching results rather than re-requesting the same location.
 * Every outbound call in this process shares one throttle and one Postgres
 * cache table (geocode_cache, agency-agnostic -- a lat/lng's village is a
 * geographic fact, not a tenant-specific one).
 */
export interface GeocodeResult {
  village: string | null;
  taluka: string | null;
  city: string | null;
  district: string | null;
  state: string | null;
}

const NULL_RESULT: GeocodeResult = {
  village: null,
  taluka: null,
  city: null,
  district: null,
  state: null,
};

// 4 decimal places ~= 11m grid -- matches geocode_cache's NUMERIC(7,4)
// columns, so GPS jitter between pings at effectively the same spot reuses
// one cache row instead of one Nominatim call each.
function roundCoord(v: number): number {
  return Math.round(v * 10_000) / 10_000;
}

// Serializes every outbound Nominatim call process-wide (both /live's
// per-agent lookups and /route's per-dwell lookups share this), which is
// what actually satisfies the 1 req/sec usage policy across concurrent
// requests -- a per-request throttle wouldn't.
let nextSlotAt = 0;
async function throttledFetch(url: string): Promise<Response> {
  const wait = Math.max(0, nextSlotAt - Date.now());
  nextSlotAt = Date.now() + wait + 1100;
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  return fetch(url, {
    headers: { "User-Agent": env.NOMINATIM_USER_AGENT },
    signal: AbortSignal.timeout(5000),
  });
}

async function readCache(latR: number, lngR: number): Promise<GeocodeResult | null> {
  const { rows } = await pool.query<GeocodeResult>(
    `SELECT village, taluka, city, district, state FROM geocode_cache
      WHERE lat_rounded = $1 AND lng_rounded = $2`,
    [latR, lngR],
  );
  return rows[0] ?? null;
}

async function writeCache(latR: number, lngR: number, result: GeocodeResult): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO geocode_cache (lat_rounded, lng_rounded, village, taluka, city, district, state)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (lat_rounded, lng_rounded) DO NOTHING`,
      [latR, lngR, result.village, result.taluka, result.city, result.district, result.state],
    );
  } catch (err) {
    logger.warn({ err, latR, lngR }, "Failed to write geocode_cache row");
  }
}

// zoom=14 targets village/town/suburb-level detail rather than full
// house-number precision, which this feature doesn't need and which
// increases the odds of a null village/city on a more granular zoom.
async function fetchFromNominatim(lat: number, lng: number): Promise<GeocodeResult> {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=14&addressdetails=1`;
    const res = await throttledFetch(url);
    if (!res.ok) {
      logger.warn({ status: res.status, lat, lng }, "Nominatim reverse geocode returned non-200");
      return NULL_RESULT;
    }
    const body = (await res.json()) as { address?: Record<string, string> };
    const address = body.address ?? {};
    return {
      village: address.village ?? address.hamlet ?? address.suburb ?? null,
      // Nominatim maps India's tehsil/taluka administrative level to "county".
      taluka: address.county ?? null,
      city: address.city ?? address.town ?? null,
      district: address.state_district ?? address.county ?? null,
      state: address.state ?? null,
    };
  } catch (err) {
    // Network error, timeout, or malformed JSON -- never throws out of this
    // service; callers (/live, /route) degrade to null location fields
    // rather than failing the whole request over a geocoding hiccup.
    logger.warn({ err, lat, lng }, "Nominatim reverse geocode failed");
    return NULL_RESULT;
  }
}

// Collapses concurrent resolve() calls for the same rounded point (e.g.
// /live's several agents near each other, or /route's punch-in and a dwell
// at nearly the same spot) into one outbound fetch instead of N.
const inFlight = new Map<string, Promise<GeocodeResult>>();

async function resolve(lat: number, lng: number): Promise<GeocodeResult> {
  const latR = roundCoord(lat);
  const lngR = roundCoord(lng);
  const key = `${latR},${lngR}`;

  const cached = await readCache(latR, lngR);
  if (cached) return cached;

  let pending = inFlight.get(key);
  if (!pending) {
    pending = fetchFromNominatim(lat, lng)
      .then(async (result) => {
        // Cache an all-null result too -- a point that resolves to open
        // countryside shouldn't be re-requested on every future call.
        await writeCache(latR, lngR, result);
        return result;
      })
      .finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
  }
  return pending;
}

/**
 * Reverse-geocodes one point, cache-first, self-throttled, self-caching.
 * Never throws.
 */
export async function reverseGeocode(lat: number, lng: number): Promise<GeocodeResult> {
  return resolve(lat, lng);
}

/**
 * Cache-only lookup -- never calls Nominatim. /live uses this so a cold
 * cache can't stall the live map: a miss returns null fields for this poll
 * cycle, and reverseGeocodeAsync() below populates the cache in the
 * background so the *next* poll (30s later) picks it up.
 */
export async function reverseGeocodeCached(lat: number, lng: number): Promise<GeocodeResult> {
  const cached = await readCache(roundCoord(lat), roundCoord(lng));
  return cached ?? NULL_RESULT;
}

/**
 * Kicks off resolution (throttled fetch + cache write) without the caller
 * waiting on it. Errors are already swallowed inside resolve().
 */
export function reverseGeocodeAsync(lat: number, lng: number): void {
  void resolve(lat, lng);
}

/**
 * Batch helper for /route: dedupes identical rounded points across a whole
 * day (punch-in + punch-out + several dwells often share/near-share a spot)
 * so the throttle only pays for distinct grid cells.
 */
export async function reverseGeocodeMany(
  points: { lat: number; lng: number }[],
): Promise<GeocodeResult[]> {
  return Promise.all(points.map((p) => resolve(p.lat, p.lng)));
}
