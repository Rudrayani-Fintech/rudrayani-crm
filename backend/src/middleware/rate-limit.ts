import rateLimit from "express-rate-limit";

/**
 * Per-IP throttles for the two unauthenticated auth endpoints that had none
 * at all. Per-account lockout already exists (users.failed_login_attempts,
 * otp_requests.attempts) -- these close the gap that lockout can't:
 * credential stuffing across MANY accounts from one source, and unlimited
 * SMS/OTP bombing of a phone number (each request costs real SMS spend and
 * can be used to harass the number's owner).
 *
 * Windows are generous enough not to lock out a shared-NAT office network
 * doing ordinary retries, tight enough to blunt automated sweeps.
 */
export const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts from this network. Try again later." },
});

export const otpRequestRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many OTP requests from this network. Try again later." },
});

// Same shape as otpRequestRateLimiter -- unauthenticated, phone-targeted,
// and the reset request itself alerts a human, so it doesn't need OTP's
// tighter SMS-cost pressure, but still needs its own bucket (Phase 2, A4).
export const passwordResetRequestRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many password reset requests from this network. Try again later." },
});
