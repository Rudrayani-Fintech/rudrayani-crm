export interface TimedPoint {
  lat: number;
  lng: number;
  recorded_at: string | Date;
}

/** Flat-earth approximation -- adequate at the <=100m scale this is used
 * for; avoids pulling in a geo library for a distance check this small. */
export function distanceMeters(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6_371_000;
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad;
  const dLng = (bLng - aLng) * rad;
  const meanLat = ((aLat + bLat) / 2) * rad;
  const x = dLng * Math.cos(meanLat);
  const y = dLat;
  return R * Math.sqrt(x * x + y * y);
}

/**
 * Every "stop" in a day's ordered pings: a run of consecutive points that
 * stay within radiusMeters of the run's first point for at least
 * minutesThreshold. Mirrors the radius/minutes rule tracking.ts's /live
 * dwell-detection query encodes for "the current dwell only" (see
 * agencyThresholds() in routes/tracking.ts), generalized to a whole day's
 * pings via a linear scan -- a day at a 2-minute ping interval is only a
 * few hundred rows, trivial to scan in-process.
 *
 * Returns the actual point objects (by reference, from the input array)
 * that start a qualifying run, so callers can match them back to the
 * original point list with a Set/reference check rather than re-deriving
 * timestamps.
 */
export function findDwellStarts<T extends TimedPoint>(
  points: T[],
  radiusMeters: number,
  minutesThreshold: number,
): T[] {
  const starts: T[] = [];
  if (points.length === 0) return starts;

  let clusterStart = 0;
  for (let i = 1; i <= points.length; i++) {
    const anchor = points[clusterStart];
    const stillInCluster =
      i < points.length &&
      distanceMeters(anchor.lat, anchor.lng, points[i].lat, points[i].lng) <= radiusMeters;
    if (!stillInCluster) {
      const clusterEnd = points[i - 1];
      const durationMin =
        (new Date(clusterEnd.recorded_at).getTime() - new Date(anchor.recorded_at).getTime()) /
        60_000;
      if (durationMin >= minutesThreshold) {
        starts.push(anchor);
      }
      clusterStart = i;
    }
  }
  return starts;
}
