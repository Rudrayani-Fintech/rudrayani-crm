import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { pool } from "../src/config/db";
import { hashPassword } from "../src/services/auth-service";

/** Phase 2 (A4, S1-S3): mobile-forgot-password request/resolve queue. */
const app = createApp();

const PASSWORD = "Secret@123";
const ADMIN_PHONE = "7980000001";
const BM_A_PHONE = "7980000002";
const BM_B_PHONE = "7980000003";
const AGENT_A_PHONE = "7980000004";
const AGENT_B_PHONE = "7980000005";
const UNKNOWN_PHONE = "7980099999";

let agencyId: string;
let branchAId: string;
let branchBId: string;
let adminToken: string;
let bmAToken: string;
let bmBToken: string;
let agentAUserId: string;

async function login(phone: string): Promise<string> {
  const res = await request(app).post("/api/auth/login").send({ phone, password: PASSWORD });
  return res.body.access_token;
}

beforeAll(async () => {
  const agency = await pool.query(
    "INSERT INTO agencies (name) VALUES ('Password Reset Requests Agency') RETURNING id",
  );
  agencyId = agency.rows[0].id;

  const branchA = await pool.query(
    "INSERT INTO branches (agency_id, name) VALUES ($1, 'PRR Branch A') RETURNING id",
    [agencyId],
  );
  branchAId = branchA.rows[0].id;
  const branchB = await pool.query(
    "INSERT INTO branches (agency_id, name) VALUES ($1, 'PRR Branch B') RETURNING id",
    [agencyId],
  );
  branchBId = branchB.rows[0].id;

  const hash = await hashPassword(PASSWORD);
  await pool.query(
    `INSERT INTO users (agency_id, full_name, phone, password_hash, is_agency_admin, designation)
     VALUES ($1, 'PRR Admin', $2, $3, true, 'agency_admin')`,
    [agencyId, ADMIN_PHONE, hash],
  );

  const bmA = await pool.query(
    `INSERT INTO users (agency_id, full_name, phone, password_hash, designation)
     VALUES ($1, 'PRR BM A', $2, $3, 'branch_manager') RETURNING id`,
    [agencyId, BM_A_PHONE, hash],
  );
  await pool.query("UPDATE branches SET branch_manager_id = $1 WHERE id = $2", [
    bmA.rows[0].id,
    branchAId,
  ]);
  const bmB = await pool.query(
    `INSERT INTO users (agency_id, full_name, phone, password_hash, designation)
     VALUES ($1, 'PRR BM B', $2, $3, 'branch_manager') RETURNING id`,
    [agencyId, BM_B_PHONE, hash],
  );
  await pool.query("UPDATE branches SET branch_manager_id = $1 WHERE id = $2", [
    bmB.rows[0].id,
    branchBId,
  ]);

  const agentA = await pool.query(
    `INSERT INTO users (agency_id, branch_id, full_name, phone, password_hash, is_field_agent, designation)
     VALUES ($1, $2, 'PRR Agent A', $3, $4, true, 'field_agent') RETURNING id`,
    [agencyId, branchAId, AGENT_A_PHONE, hash],
  );
  agentAUserId = agentA.rows[0].id;
  await pool.query(
    `INSERT INTO users (agency_id, branch_id, full_name, phone, password_hash, is_field_agent, designation)
     VALUES ($1, $2, 'PRR Agent B', $3, $4, true, 'field_agent')`,
    [agencyId, branchBId, AGENT_B_PHONE, hash],
  );

  adminToken = await login(ADMIN_PHONE);
  bmAToken = await login(BM_A_PHONE);
  bmBToken = await login(BM_B_PHONE);
});

afterAll(async () => {
  await pool.query(
    "DELETE FROM password_reset_requests WHERE agency_id = $1",
    [agencyId],
  );
  await pool.query("DELETE FROM audit_logs WHERE agency_id = $1", [agencyId]);
  await pool.query("UPDATE branches SET branch_manager_id = NULL WHERE agency_id = $1", [
    agencyId,
  ]);
  await pool.query("DELETE FROM users WHERE agency_id = $1", [agencyId]);
  await pool.query("DELETE FROM branches WHERE agency_id = $1", [agencyId]);
  await pool.query("DELETE FROM agencies WHERE id = $1", [agencyId]);
  await pool.end();
});

describe("POST /api/auth/password-reset-request", () => {
  it("a valid phone creates one pending row", async () => {
    const res = await request(app)
      .post("/api/auth/password-reset-request")
      .send({ phone: AGENT_A_PHONE, message: "Forgot my password, please reset it" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const { rows } = await pool.query(
      "SELECT status, message FROM password_reset_requests WHERE user_id = $1",
      [agentAUserId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pending");
    expect(rows[0].message).toBe("Forgot my password, please reset it");
  });

  it("a second submission collapses onto the existing pending row (S3)", async () => {
    const res = await request(app)
      .post("/api/auth/password-reset-request")
      .send({ phone: AGENT_A_PHONE, message: "Second attempt, updated message" });
    expect(res.status).toBe(200);

    const { rows } = await pool.query(
      "SELECT status, message FROM password_reset_requests WHERE user_id = $1",
      [agentAUserId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].message).toBe("Second attempt, updated message");
  });

  it("an unknown phone returns the identical response and creates nothing", async () => {
    const known = await request(app)
      .post("/api/auth/password-reset-request")
      .send({ phone: AGENT_A_PHONE, message: "Known phone message" });
    const unknown = await request(app)
      .post("/api/auth/password-reset-request")
      .send({ phone: UNKNOWN_PHONE, message: "Unknown phone message" });

    expect(unknown.status).toBe(known.status);
    expect(unknown.body).toEqual(known.body);

    const { rows } = await pool.query(
      `SELECT prr.id FROM password_reset_requests prr
         JOIN users u ON u.id = prr.user_id
        WHERE u.phone = $1`,
      [UNKNOWN_PHONE],
    );
    expect(rows).toHaveLength(0);
  });
});

describe("GET /api/auth/password-reset-request (S2 status check)", () => {
  it("returns only { status }, pending for a submitted request, none for no request", async () => {
    const pending = await request(app)
      .get("/api/auth/password-reset-request")
      .query({ phone: AGENT_A_PHONE });
    expect(pending.status).toBe(200);
    expect(pending.body).toEqual({ status: "pending" });

    const none = await request(app)
      .get("/api/auth/password-reset-request")
      .query({ phone: UNKNOWN_PHONE });
    expect(none.body).toEqual({ status: "none" });
  });
});

describe("GET /api/employees/password-reset-requests -> branch scoping", () => {
  it("a branch manager sees only their branch's requests; the agency admin sees all", async () => {
    const asBmA = await request(app)
      .get("/api/password-reset-requests")
      .set("Authorization", `Bearer ${bmAToken}`);
    expect(asBmA.status).toBe(200);
    const bmAPhones = asBmA.body.password_reset_requests.map((r: { phone: string }) => r.phone);
    expect(bmAPhones).toContain(AGENT_A_PHONE);
    expect(bmAPhones).not.toContain(AGENT_B_PHONE);

    const asBmB = await request(app)
      .get("/api/password-reset-requests")
      .set("Authorization", `Bearer ${bmBToken}`);
    const bmBPhones = asBmB.body.password_reset_requests.map((r: { phone: string }) => r.phone);
    expect(bmBPhones).not.toContain(AGENT_A_PHONE);

    const asAdmin = await request(app)
      .get("/api/password-reset-requests")
      .set("Authorization", `Bearer ${adminToken}`);
    const adminPhones = asAdmin.body.password_reset_requests.map((r: { phone: string }) => r.phone);
    expect(adminPhones).toContain(AGENT_A_PHONE);
  });
});

describe("POST /api/password-reset-requests/:id/resolve", () => {
  it("marks the request resolved; a branch manager from another branch can't resolve it", async () => {
    const { rows } = await pool.query(
      "SELECT id FROM password_reset_requests WHERE user_id = $1",
      [agentAUserId],
    );
    const requestId = rows[0].id;

    const forbidden = await request(app)
      .post(`/api/password-reset-requests/${requestId}/resolve`)
      .set("Authorization", `Bearer ${bmBToken}`);
    expect(forbidden.status).toBe(404);

    const resolved = await request(app)
      .post(`/api/password-reset-requests/${requestId}/resolve`)
      .set("Authorization", `Bearer ${bmAToken}`);
    expect(resolved.status).toBe(200);
    expect(resolved.body.password_reset_request.status).toBe("resolved");

    const again = await request(app)
      .post(`/api/password-reset-requests/${requestId}/resolve`)
      .set("Authorization", `Bearer ${bmAToken}`);
    expect(again.status).toBe(404); // no longer pending
  });
});
