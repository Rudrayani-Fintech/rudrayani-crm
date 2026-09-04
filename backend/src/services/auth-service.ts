import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { pool } from "../config/db";
import { env } from "../config/env";
import { logger } from "../config/logger";
import { HttpError } from "../middleware/error-handler";
import { getSmsProvider } from "./sms/sms-provider";
import { publicUser, type UserRow } from "../types/user";

const BCRYPT_ROUNDS = 10;

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function signAccessToken(user: UserRow): string {
  return jwt.sign({ sub: user.id, agency_id: user.agency_id }, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN,
  } as jwt.SignOptions);
}

async function issueRefreshToken(userId: string, deviceId: string | null): Promise<string> {
  const token = crypto.randomBytes(48).toString("hex");
  await pool.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, device_id, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(days => $4))`,
    [userId, sha256(token), deviceId, env.REFRESH_TOKEN_TTL_DAYS],
  );
  return token;
}

function tokenResponse(user: UserRow, accessToken: string, refreshToken: string) {
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: env.JWT_EXPIRES_IN,
    user: publicUser(user),
  };
}

export async function login(phone: string, password: string, deviceId?: string) {
  const { rows } = await pool.query<UserRow>("SELECT * FROM users WHERE phone = $1", [phone]);
  const user = rows[0];
  // Same error for unknown phone and wrong password: don't leak which it was.
  if (!user || !user.is_active) throw new HttpError(401, "Invalid phone or password");

  if (user.locked_until && user.locked_until > new Date()) {
    throw new HttpError(423, "Account locked due to repeated failed logins. Try again later.");
  }

  const passwordOk = await bcrypt.compare(password, user.password_hash);
  if (!passwordOk) {
    const attempts = user.failed_login_attempts + 1;
    if (attempts >= env.LOCKOUT_MAX_ATTEMPTS) {
      await pool.query(
        `UPDATE users SET failed_login_attempts = 0,
                          locked_until = now() + make_interval(mins => $2)
         WHERE id = $1`,
        [user.id, env.LOCKOUT_DURATION_MINUTES],
      );
      logger.warn({ userId: user.id }, "Account locked after repeated failed logins");
      throw new HttpError(423, "Account locked due to repeated failed logins. Try again later.");
    }
    await pool.query("UPDATE users SET failed_login_attempts = $2 WHERE id = $1", [
      user.id,
      attempts,
    ]);
    throw new HttpError(401, "Invalid phone or password");
  }

  // Device binding (build brief Section 10): a login carrying a device_id
  // becomes the single active device — sessions on OTHER devices are
  // revoked. A web session never supplies a device_id (device_id IS NULL),
  // so it must never be caught by this (X5 / A1): `NULL IS DISTINCT FROM
  // 'abc'` is true in SQL, so the original `device_id IS DISTINCT FROM $2`
  // revoked the web session on every mobile login, which then made the
  // web tab's next refresh() look like a replayed token and revoke every
  // session for the user (see the "revoked_at" branch below). Requiring
  // device_id IS NOT NULL keeps this scoped to superseding another mobile
  // device, never a web session.
  if (deviceId) {
    await pool.query(
      `UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = 'device_superseded'
       WHERE user_id = $1 AND revoked_at IS NULL
         AND device_id IS NOT NULL AND device_id IS DISTINCT FROM $2`,
      [user.id, deviceId],
    );
    await pool.query(
      "UPDATE users SET active_device_id = $2, failed_login_attempts = 0, locked_until = NULL WHERE id = $1",
      [user.id, deviceId],
    );
    user.active_device_id = deviceId;
  } else {
    await pool.query(
      "UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = $1",
      [user.id],
    );
  }

  const accessToken = signAccessToken(user);
  const refreshToken = await issueRefreshToken(user.id, deviceId ?? null);
  return tokenResponse(user, accessToken, refreshToken);
}

export async function refresh(refreshToken: string) {
  const { rows } = await pool.query(
    `SELECT rt.*, u.* , rt.id AS rt_id
       FROM refresh_tokens rt
       JOIN users u ON u.id = rt.user_id
      WHERE rt.token_hash = $1`,
    [sha256(refreshToken)],
  );
  const row = rows[0];
  if (!row) throw new HttpError(401, "Invalid or expired refresh token");

  if (row.revoked_at) {
    if (row.revoked_reason === "rotated" || !row.revoked_reason) {
      // Refresh tokens are single-use (rotated below on every successful
      // refresh) -- a *rotated* token being presented again means either a
      // client bug or, more likely, a stolen-but-since-rotated token being
      // replayed. Don't just 401 this one request: revoke every active
      // session for the user so a leaked token can't keep riding along
      // after the legitimate client has already moved to the next one.
      // A NULL reason means an older revoke predates this column and is
      // treated the same conservative way.
      logger.warn({ userId: row.user_id }, "Revoked refresh token reused -- revoking all sessions for user");
      await pool.query(
        "UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = 'rotated' WHERE user_id = $1 AND revoked_at IS NULL",
        [row.user_id],
      );
    }
    // Any other reason (device_superseded, admin_reset, deactivated,
    // self_password_reset, logout) is an intentional, out-of-band session
    // end -- the client just hasn't been told yet. Presenting that token
    // again isn't suspicious, so it gets a plain 401 with no cascade. Not
    // cascading here is exactly what makes A5/O4 hold up in practice: an
    // admin password reset that revoked only the web session must not be
    // undone by the web client's next ordinary (and entirely expected)
    // refresh attempt.
    throw new HttpError(401, "Session revoked -- please log in again");
  }

  if (row.expires_at < new Date() || !row.is_active) {
    throw new HttpError(401, "Invalid or expired refresh token");
  }
  // Device binding: a token issued for a device that is no longer the active
  // device means the session was superseded by a newer login.
  if (row.device_id && row.active_device_id && row.device_id !== row.active_device_id) {
    throw new HttpError(401, "Session superseded by a login on another device");
  }

  // Rotate: the presented token is single-use.
  await pool.query(
    "UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = 'rotated' WHERE id = $1",
    [row.rt_id],
  );

  const user = row as UserRow;
  const accessToken = signAccessToken(user);
  const newRefreshToken = await issueRefreshToken(user.id, row.device_id);
  return tokenResponse(user, accessToken, newRefreshToken);
}

export async function logout(refreshToken: string): Promise<void> {
  await pool.query(
    "UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = 'logout' WHERE token_hash = $1",
    [sha256(refreshToken)],
  );
}

export async function requestPasswordOtp(phone: string): Promise<{ devOtp?: string }> {
  const { rows } = await pool.query<UserRow>(
    "SELECT * FROM users WHERE phone = $1 AND is_active = true",
    [phone],
  );
  const user = rows[0];
  // Always behave the same whether or not the phone exists: no account probing.
  if (!user) return {};

  const otp = String(crypto.randomInt(100000, 1000000));
  // Invalidate any previous pending OTPs for this user.
  await pool.query(
    "UPDATE otp_requests SET consumed_at = now() WHERE user_id = $1 AND consumed_at IS NULL",
    [user.id],
  );
  await pool.query(
    `INSERT INTO otp_requests (user_id, otp_hash, purpose, expires_at)
     VALUES ($1, $2, 'password_reset', now() + make_interval(mins => $3))`,
    [user.id, sha256(otp), env.OTP_EXPIRY_MINUTES],
  );
  await getSmsProvider().sendSms(
    phone,
    `Your Rudrayani CRM password reset OTP is ${otp}. Valid for ${env.OTP_EXPIRY_MINUTES} minutes.`,
  );
  // Explicit opt-in only (ALLOW_OTP_ECHO), not NODE_ENV -- a misconfigured
  // NODE_ENV value used to be enough to leak OTPs into every response.
  return env.ALLOW_OTP_ECHO ? { devOtp: otp } : {};
}

export async function resetPasswordWithOtp(
  phone: string,
  otp: string,
  newPassword: string,
): Promise<void> {
  const { rows } = await pool.query(
    `SELECT o.id, o.otp_hash, o.attempts, u.id AS user_id
       FROM otp_requests o
       JOIN users u ON u.id = o.user_id
      WHERE u.phone = $1 AND o.purpose = 'password_reset'
        AND o.consumed_at IS NULL AND o.expires_at > now()
      ORDER BY o.created_at DESC
      LIMIT 1`,
    [phone],
  );
  const pending = rows[0];
  if (!pending) throw new HttpError(400, "No valid OTP found. Request a new one.");

  if (pending.attempts >= env.OTP_MAX_VERIFY_ATTEMPTS) {
    await pool.query("UPDATE otp_requests SET consumed_at = now() WHERE id = $1", [pending.id]);
    throw new HttpError(429, "Too many incorrect attempts. Request a new OTP.");
  }

  if (pending.otp_hash !== sha256(otp)) {
    await pool.query("UPDATE otp_requests SET attempts = attempts + 1 WHERE id = $1", [
      pending.id,
    ]);
    throw new HttpError(400, "Incorrect OTP");
  }

  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  await pool.query("UPDATE otp_requests SET consumed_at = now() WHERE id = $1", [pending.id]);
  await pool.query(
    `UPDATE users SET password_hash = $2, failed_login_attempts = 0, locked_until = NULL
     WHERE id = $1`,
    [pending.user_id, passwordHash],
  );
  // Password changed: kill every existing session.
  await pool.query(
    "UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = 'self_password_reset' WHERE user_id = $1 AND revoked_at IS NULL",
    [pending.user_id],
  );
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

// Phase 2 (A4, S1-S3): mobile password recovery is a request to an admin,
// not self-service -- the user can't log in to trigger anything themselves,
// so both of these are unauthenticated and, like the OTP flow, must behave
// identically whether or not the phone exists (no account-enumeration
// signal, matching requestPasswordOtp's convention above).
export async function submitPasswordResetRequest(phone: string, message: string): Promise<void> {
  const { rows } = await pool.query<UserRow>(
    "SELECT id, agency_id FROM users WHERE phone = $1 AND is_active = true",
    [phone],
  );
  const user = rows[0];
  if (!user) return;
  // S3: one open request per user -- a second submission collapses onto the
  // existing pending row (relies on uq_prr_open, the partial unique index
  // on user_id WHERE status = 'pending') instead of creating a duplicate.
  await pool.query(
    `INSERT INTO password_reset_requests (agency_id, user_id, message, status)
     VALUES ($1, $2, $3, 'pending')
     ON CONFLICT (user_id) WHERE status = 'pending'
       DO UPDATE SET message = EXCLUDED.message, created_at = now()`,
    [user.agency_id, user.id, message],
  );
}

// S2: the mobile login screen polls this to show "Request sent -- waiting
// on your manager". 'none' covers both "no account" and "account exists,
// no request yet" identically -- same no-enumeration guarantee as above.
export async function passwordResetRequestStatus(
  phone: string,
): Promise<"none" | "pending" | "resolved" | "rejected"> {
  const { rows } = await pool.query<{ status: string }>(
    `SELECT prr.status
       FROM password_reset_requests prr
       JOIN users u ON u.id = prr.user_id
      WHERE u.phone = $1
      ORDER BY prr.created_at DESC
      LIMIT 1`,
    [phone],
  );
  return (rows[0]?.status as "pending" | "resolved" | "rejected" | undefined) ?? "none";
}
