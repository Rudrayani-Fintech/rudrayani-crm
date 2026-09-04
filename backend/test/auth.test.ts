import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { pool } from "../src/config/db";
import { hashPassword } from "../src/services/auth-service";

// Integration tests: require the Postgres container running with migrations applied.
const app = createApp();

const PASSWORD = "Secret@123";
const ADMIN_PHONE = "7000000001";
const AGENT_PHONE = "7000000002";
const LOCKOUT_PHONE = "7000000003";
const RESET_TARGET_PHONE = "7000000004";

let agencyId: string;

beforeAll(async () => {
  const agency = await pool.query(
    "INSERT INTO agencies (name) VALUES ('Test Agency (auth.test)') RETURNING id",
  );
  agencyId = agency.rows[0].id;
  const hash = await hashPassword(PASSWORD);
  await pool.query(
    `INSERT INTO users (agency_id, full_name, phone, password_hash, is_agency_admin, designation)
     VALUES ($1, 'Test Admin', $2, $3, true, 'agency_admin')`,
    [agencyId, ADMIN_PHONE, hash],
  );
  await pool.query(
    `INSERT INTO users (agency_id, full_name, phone, password_hash, is_field_agent, designation)
     VALUES ($1, 'Test Agent', $2, $3, true, 'field_agent')`,
    [agencyId, AGENT_PHONE, hash],
  );
  await pool.query(
    `INSERT INTO users (agency_id, full_name, phone, password_hash, is_telecaller, designation)
     VALUES ($1, 'Lockout Target', $2, $3, true, 'telecaller')`,
    [agencyId, LOCKOUT_PHONE, hash],
  );
  await pool.query(
    `INSERT INTO users (agency_id, full_name, phone, password_hash, is_field_agent, designation)
     VALUES ($1, 'Reset Target', $2, $3, true, 'field_agent')`,
    [agencyId, RESET_TARGET_PHONE, hash],
  );
});

afterAll(async () => {
  // The reset-password test records an audit log entry (actor_id -> the
  // admin test user); audit_logs.actor_id has no ON DELETE CASCADE, so it
  // must go before the users delete below or this agency's users become
  // undeletable.
  await pool.query("DELETE FROM audit_logs WHERE agency_id = $1", [agencyId]);
  await pool.query(
    "DELETE FROM users WHERE phone IN ($1, $2, $3, $4)",
    [ADMIN_PHONE, AGENT_PHONE, LOCKOUT_PHONE, RESET_TARGET_PHONE],
  );
  await pool.query("DELETE FROM agencies WHERE id = $1", [agencyId]);
  await pool.end();
});

describe("POST /api/auth/login", () => {
  it("returns tokens and the public user shape on success", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ phone: ADMIN_PHONE, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.access_token).toBeTruthy();
    expect(res.body.refresh_token).toBeTruthy();
    expect(res.body.user.capabilities).toEqual(["agency_admin"]);
    expect(res.body.user.password_hash).toBeUndefined();
  });

  it("rejects a wrong password with a generic 401", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ phone: ADMIN_PHONE, password: "WrongPass1" });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Invalid phone or password");
  });

  it("rejects an unknown phone with the same generic 401", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ phone: "7999999999", password: PASSWORD });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Invalid phone or password");
  });

  it("locks the account after repeated failures, then rejects even correct logins", async () => {
    for (let i = 0; i < 5; i++) {
      await request(app)
        .post("/api/auth/login")
        .send({ phone: LOCKOUT_PHONE, password: "WrongPass1" });
    }
    const locked = await request(app)
      .post("/api/auth/login")
      .send({ phone: LOCKOUT_PHONE, password: PASSWORD });
    expect(locked.status).toBe(423);
  });

  it("device binding: a login on a new device supersedes older device sessions", async () => {
    const first = await request(app)
      .post("/api/auth/login")
      .send({ phone: AGENT_PHONE, password: PASSWORD, device_id: "device-A" });
    expect(first.status).toBe(200);

    const second = await request(app)
      .post("/api/auth/login")
      .send({ phone: AGENT_PHONE, password: PASSWORD, device_id: "device-B" });
    expect(second.status).toBe(200);

    // device-A's refresh token no longer works.
    const res = await request(app)
      .post("/api/auth/refresh")
      .send({ refresh_token: first.body.refresh_token });
    expect(res.status).toBe(401);
  });

  it("mobile login preserves an existing web session (A1/X5)", async () => {
    // Web never sends device_id. Before the fix, `device_id IS DISTINCT
    // FROM $2` revoked this NULL-device web session on the very next mobile
    // login for the same user (NULL IS DISTINCT FROM 'abc' is true in SQL),
    // and the web tab's subsequent refresh() then looked like a replayed
    // token and revoked every session for the user -- including the mobile
    // one that had just logged in. Neither should happen.
    const web = await request(app)
      .post("/api/auth/login")
      .send({ phone: RESET_TARGET_PHONE, password: PASSWORD });
    expect(web.status).toBe(200);

    const mobile = await request(app)
      .post("/api/auth/login")
      .send({ phone: RESET_TARGET_PHONE, password: PASSWORD, device_id: "mobile-device-X1" });
    expect(mobile.status).toBe(200);

    const webRefresh = await request(app)
      .post("/api/auth/refresh")
      .send({ refresh_token: web.body.refresh_token });
    expect(webRefresh.status).toBe(200);

    const mobileRefresh = await request(app)
      .post("/api/auth/refresh")
      .send({ refresh_token: mobile.body.refresh_token });
    expect(mobileRefresh.status).toBe(200);
  });
});

describe("POST /api/auth/refresh", () => {
  it("rotates the refresh token (old one becomes single-use)", async () => {
    const login = await request(app)
      .post("/api/auth/login")
      .send({ phone: ADMIN_PHONE, password: PASSWORD });

    const refreshed = await request(app)
      .post("/api/auth/refresh")
      .send({ refresh_token: login.body.refresh_token });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.access_token).toBeTruthy();

    const reused = await request(app)
      .post("/api/auth/refresh")
      .send({ refresh_token: login.body.refresh_token });
    expect(reused.status).toBe(401);
  });
});

describe("GET /api/auth/me", () => {
  it("returns the profile with a valid token and 401 without one", async () => {
    const login = await request(app)
      .post("/api/auth/login")
      .send({ phone: ADMIN_PHONE, password: PASSWORD });

    const me = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${login.body.access_token}`);
    expect(me.status).toBe(200);
    expect(me.body.user.phone).toBe(ADMIN_PHONE);

    const anon = await request(app).get("/api/auth/me");
    expect(anon.status).toBe(401);
  });
});

describe("OTP password reset", () => {
  it("full flow: request OTP (dev returns it), reset password, old sessions revoked", async () => {
    const login = await request(app)
      .post("/api/auth/login")
      .send({ phone: ADMIN_PHONE, password: PASSWORD });

    const otpRes = await request(app)
      .post("/api/auth/otp/request")
      .send({ phone: ADMIN_PHONE });
    expect(otpRes.status).toBe(200);
    expect(otpRes.body.devOtp).toMatch(/^\d{6}$/);

    const newPassword = "NewSecret@456";
    const verify = await request(app)
      .post("/api/auth/otp/verify")
      .send({ phone: ADMIN_PHONE, otp: otpRes.body.devOtp, new_password: newPassword });
    expect(verify.status).toBe(200);

    // Old password no longer works; new one does.
    const oldLogin = await request(app)
      .post("/api/auth/login")
      .send({ phone: ADMIN_PHONE, password: PASSWORD });
    expect(oldLogin.status).toBe(401);

    const newLogin = await request(app)
      .post("/api/auth/login")
      .send({ phone: ADMIN_PHONE, password: newPassword });
    expect(newLogin.status).toBe(200);

    // Pre-reset refresh token was revoked.
    const staleRefresh = await request(app)
      .post("/api/auth/refresh")
      .send({ refresh_token: login.body.refresh_token });
    expect(staleRefresh.status).toBe(401);

    // Reset back so other tests / reruns are unaffected.
    const backOtp = await request(app)
      .post("/api/auth/otp/request")
      .send({ phone: ADMIN_PHONE });
    await request(app)
      .post("/api/auth/otp/verify")
      .send({ phone: ADMIN_PHONE, otp: backOtp.body.devOtp, new_password: PASSWORD });
  });

  it("rejects a wrong OTP and does not leak whether a phone exists on request", async () => {
    const unknown = await request(app)
      .post("/api/auth/otp/request")
      .send({ phone: "7999999998" });
    expect(unknown.status).toBe(200); // same as for a real phone

    await request(app).post("/api/auth/otp/request").send({ phone: AGENT_PHONE });
    const bad = await request(app)
      .post("/api/auth/otp/verify")
      .send({ phone: AGENT_PHONE, otp: "000000", new_password: "Whatever@123" });
    // 400 either way (incorrect OTP), never a success with a guessed code
    expect(bad.status).toBe(400);
  });
});

describe("POST /api/employees/:id/reset-password", () => {
  it("revokes the target's web session but leaves an active mobile session untouched (A5/O4)", async () => {
    const target = await pool.query("SELECT id FROM users WHERE phone = $1", [
      RESET_TARGET_PHONE,
    ]);
    const targetId = target.rows[0].id;

    const web = await request(app)
      .post("/api/auth/login")
      .send({ phone: RESET_TARGET_PHONE, password: PASSWORD });
    expect(web.status).toBe(200);

    const mobile = await request(app)
      .post("/api/auth/login")
      .send({ phone: RESET_TARGET_PHONE, password: PASSWORD, device_id: "reset-test-device" });
    expect(mobile.status).toBe(200);

    const adminLogin = await request(app)
      .post("/api/auth/login")
      .send({ phone: ADMIN_PHONE, password: PASSWORD });
    const adminToken = adminLogin.body.access_token;

    // A4: this reset exists for the mobile-forgot-password flow -- the
    // point is the requester's live mobile session survives it. O4: web
    // sessions are revoked (device_id IS NULL), mobile sessions are not.
    const reset = await request(app)
      .post(`/api/employees/${targetId}/reset-password`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ new_password: "BrandNew@789" });
    expect(reset.status).toBe(200);

    const webRefresh = await request(app)
      .post("/api/auth/refresh")
      .send({ refresh_token: web.body.refresh_token });
    expect(webRefresh.status).toBe(401);

    // Not just "the mobile token still passes its own check" -- the whole
    // point of tagging revokes with revoked_reason is that the web client's
    // ordinary refresh attempt above, using a token that was correctly
    // revoked by the reset, must not cascade into revoking the mobile
    // session too (see refresh()'s "replay" branch). This assertion is
    // exactly what would fail if that cascade fired.
    const mobileRefresh = await request(app)
      .post("/api/auth/refresh")
      .send({ refresh_token: mobile.body.refresh_token });
    expect(mobileRefresh.status).toBe(200);
  });
});
