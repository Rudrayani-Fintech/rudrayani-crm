import { describe, expect, it } from "vitest";
import { distanceMeters, findDwellStarts, type TimedPoint } from "../src/services/dwell-detection";

const BASE = { lat: 18.5204, lng: 73.8567 };

/** Offsets `northMeters` from BASE -- mirrors tracking.test.ts's own helper. */
function pointAt(minutesAgoFromEpoch: number, northMeters: number): TimedPoint {
  const lat = BASE.lat + northMeters / 111_320;
  return {
    lat,
    lng: BASE.lng,
    recorded_at: new Date(minutesAgoFromEpoch * 60_000).toISOString(),
  };
}

describe("distanceMeters", () => {
  it("is ~0 for the same point", () => {
    expect(distanceMeters(18.5, 73.8, 18.5, 73.8)).toBeCloseTo(0, 3);
  });

  it("approximates 111.32km per degree of latitude", () => {
    const d = distanceMeters(0, 0, 1, 0);
    expect(d).toBeGreaterThan(110_000);
    expect(d).toBeLessThan(112_000);
  });
});

describe("findDwellStarts", () => {
  it("returns nothing for an empty list", () => {
    expect(findDwellStarts([], 100, 20)).toEqual([]);
  });

  it("finds one dwell start for a cluster that stays put long enough", () => {
    // 15 points, 2 minutes apart (28 minutes total), drifting 0-28m -- all
    // within a 100m radius of the first point, spanning >= 20 minutes.
    const points = Array.from({ length: 15 }, (_, i) => pointAt(i * 2, i * 2));
    const starts = findDwellStarts(points, 100, 20);
    expect(starts).toHaveLength(1);
    expect(starts[0]).toBe(points[0]);
  });

  it("finds no dwell when the stay is too short", () => {
    // Same spot, but only 10 minutes -- under the 20-minute threshold.
    const points = Array.from({ length: 6 }, (_, i) => pointAt(i * 2, 0));
    expect(findDwellStarts(points, 100, 20)).toEqual([]);
  });

  it("finds no dwell when points keep moving apart", () => {
    const points = [pointAt(0, 0), pointAt(10, 500), pointAt(20, 1000)];
    expect(findDwellStarts(points, 100, 20)).toEqual([]);
  });

  it("finds two separate dwells with travel in between", () => {
    const stopA = Array.from({ length: 11 }, (_, i) => pointAt(i * 2, 0)); // 0-20 min, 20 min stay
    const travel = [pointAt(22, 1000)]; // passes through, distinct from both stops
    const stopB = Array.from({ length: 11 }, (_, i) => pointAt(24 + i * 2, 2000)); // another 20 min stay
    const points = [...stopA, ...travel, ...stopB];
    const starts = findDwellStarts(points, 100, 20);
    expect(starts).toHaveLength(2);
    expect(starts[0]).toBe(stopA[0]);
    expect(starts[1]).toBe(stopB[0]);
  });

  it("only flags the start of a dwell, not every point inside it", () => {
    const points = Array.from({ length: 15 }, (_, i) => pointAt(i * 2, 0));
    const starts = findDwellStarts(points, 100, 20);
    expect(starts).toHaveLength(1);
    expect(points).not.toEqual(starts); // starts is a strict subset
  });
});
