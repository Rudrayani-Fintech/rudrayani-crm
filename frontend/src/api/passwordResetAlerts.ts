import { api } from "./client";

export interface PendingResetRequest {
  id: string;
  full_name: string;
  phone: string;
  message: string;
  created_at: string;
}

type Listener = (requests: PendingResetRequest[] | null, error: unknown) => void;

// Password-reset requests are nowhere near as time-sensitive as live
// tracking alerts (an agent submitting one is already locked out and
// waiting, not mid-shift) -- a minute is plenty, and it halves the request
// volume the header otherwise adds on top of liveTracking.ts's own poll.
const POLL_MS = 60_000;

let cached: PendingResetRequest[] | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let inFlight: Promise<void> | null = null;
const listeners = new Set<Listener>();

async function fetchOnce(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = api
    .get("/password-reset-requests", { params: { status: "pending" } })
    .then((res) => {
      cached = res.data.password_reset_requests;
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
 * Phase 16 (A4): "surface a count in AlertsBell, which currently only polls
 * tracking alerts." Same shared-interval-across-subscribers shape as
 * subscribeLiveTracking (liveTracking.ts) -- AlertsBell is this module's
 * only subscriber today, but the pattern costs nothing to keep consistent
 * if a second screen ever needs the same data.
 */
export function subscribePasswordResetAlerts(listener: Listener): () => void {
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
