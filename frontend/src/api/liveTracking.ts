import { api } from "./client";

export interface LiveAgent {
  user_id: string;
  full_name: string;
  phone: string;
  team_name: string | null;
  branch_name: string | null;
  punch_in_at: string;
  last_ping_at: string | null;
  lat: number | null;
  lng: number | null;
  accuracy_meters: number | null;
  status: "moving" | "stationary" | "no_signal" | "awaiting_first_ping";
  stationary_since: string | null;
  stationary_minutes: number | null;
}

export interface TrackingAlert {
  user_id: string;
  full_name: string;
  team_name: string | null;
  status: "stationary" | "no_signal";
  stationary_minutes: number | null;
  last_ping_at: string | null;
}

export interface LiveTrackingData {
  agents: LiveAgent[];
  alerts: TrackingAlert[];
  thresholds: { stationary_minutes: number };
}

type Listener = (data: LiveTrackingData | null, error: unknown) => void;

const POLL_MS = 30_000;

let cached: LiveTrackingData | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let inFlight: Promise<void> | null = null;
const listeners = new Set<Listener>();

async function fetchOnce(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = api
    .get("/tracking/live")
    .then((res) => {
      cached = res.data;
      listeners.forEach((fn) => fn(cached, null));
    })
    .catch((err) => {
      listeners.forEach((fn) => fn(cached, err));
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/**
 * The header bell (AlertsBell) and the Tracking page's live map both need
 * /tracking/live on the same 30s cadence. Each used to run its own
 * setInterval, so a manager with the Tracking page open fired the same
 * query twice every 30s with no coordination. Sharing one interval and one
 * in-flight request across every subscriber fixes that without either
 * screen needing to know the other exists.
 */
export function subscribeLiveTracking(listener: Listener): () => void {
  listeners.add(listener);
  if (cached) listener(cached, null);
  if (!timer) {
    void fetchOnce();
    timer = setInterval(fetchOnce, POLL_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** Force an immediate refresh (e.g. a manual "Refresh" button) without
 * waiting for the next tick -- still shared across all subscribers. */
export function refreshLiveTracking(): Promise<void> {
  return fetchOnce();
}
