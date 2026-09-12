import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { pool } from "../src/config/db";
import {
  reverseGeocode,
  reverseGeocodeCached,
  reverseGeocodeMany,
} from "../src/services/geocoding-service";

/**
 * Unit tests for the throttle/cache logic itself -- tracking.test.ts mocks
 * this whole module away, so this is the only place the real
 * cache-hit-skips-fetch and "Nominatim error -> nulls, never throws"
 * contracts are actually exercised.
 */

async function clearCache(): Promise<void> {
  await pool.query("DELETE FROM geocode_cache");
}

afterAll(async () => {
  await clearCache();
  await pool.end();
});

beforeEach(async () => {
  await clearCache();
  vi.restoreAllMocks();
});

const NOMINATIM_BODY = {
  address: {
    village: "Wagholi",
    county: "Haveli",
    city: "Pune",
    state_district: "Pune",
    state: "Maharashtra",
  },
};

function mockFetchOnce(body: unknown, ok = true, status = 200) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
    ok,
    status,
    json: async () => body,
  } as Response);
}

describe("reverseGeocode", () => {
  it("fetches from Nominatim on a cache miss and extracts the address hierarchy", async () => {
    const fetchSpy = mockFetchOnce(NOMINATIM_BODY);
    const result = await reverseGeocode(18.58, 73.9);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      village: "Wagholi",
      taluka: "Haveli",
      city: "Pune",
      district: "Pune",
      state: "Maharashtra",
    });
  });

  it("writes the result to the cache so a second call never hits fetch again", async () => {
    const fetchSpy = mockFetchOnce(NOMINATIM_BODY);
    await reverseGeocode(18.58, 73.9);
    const result2 = await reverseGeocode(18.58, 73.9);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result2.village).toBe("Wagholi");
  });

  it("rounds coordinates to the cache grid -- nearby jitter reuses the same row", async () => {
    const fetchSpy = mockFetchOnce(NOMINATIM_BODY);
    await reverseGeocode(18.58001, 73.90001);
    const result2 = await reverseGeocode(18.58004, 73.90004); // same 4-decimal cell
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result2.village).toBe("Wagholi");
  });

  it("never throws on a non-200 response -- degrades to all-null", async () => {
    mockFetchOnce({}, false, 503);
    const result = await reverseGeocode(1, 1);
    expect(result).toEqual({ village: null, taluka: null, city: null, district: null, state: null });
  });

  it("never throws on a network error -- degrades to all-null", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network down"));
    const result = await reverseGeocode(2, 2);
    expect(result).toEqual({ village: null, taluka: null, city: null, district: null, state: null });
  });

  it("caches an all-null result too, so an unresolvable point isn't re-fetched", async () => {
    const fetchSpy = mockFetchOnce({ address: {} });
    await reverseGeocode(3, 3);
    const result2 = await reverseGeocode(3, 3);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result2.village).toBeNull();
  });
});

describe("reverseGeocodeCached", () => {
  it("never calls fetch, even on a miss", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await reverseGeocodeCached(4, 4);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.village).toBeNull();
  });

  it("returns a previously-cached value without calling fetch", async () => {
    mockFetchOnce(NOMINATIM_BODY);
    await reverseGeocode(5, 5); // populates the cache
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await reverseGeocodeCached(5, 5);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.village).toBe("Wagholi");
  });
});

describe("reverseGeocodeMany", () => {
  it("dedupes identical rounded points into a single fetch", async () => {
    const fetchSpy = mockFetchOnce(NOMINATIM_BODY);
    const results = await reverseGeocodeMany([
      { lat: 6, lng: 6 },
      { lat: 6, lng: 6 },
      { lat: 6.00001, lng: 6.00001 },
    ]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.village === "Wagholi")).toBe(true);
  });
});
