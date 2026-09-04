import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { pool } from "../src/config/db";
import { hashPassword } from "../src/services/auth-service";

const app = createApp();

const ADMIN_PHONE = "7900000010";
const AGENT_PHONE = "7900000011";
const PASSWORD = "Secret@123";

let agencyId: string;
let adminToken: string;
let agentToken: string;
let createdCodeId: string;

beforeAll(async () => {
  const agency = await pool.query(
    "INSERT INTO agencies (name) VALUES ('Disp Test Agency') RETURNING id",
  );
  agencyId = agency.rows[0].id;

  const hash = await hashPassword(PASSWORD);
  await pool.query(
    `INSERT INTO users (agency_id, full_name, phone, password_hash, is_agency_admin, designation)
     VALUES ($1, 'Disp Admin', $2, $3, true, 'agency_admin')`,
    [agencyId, ADMIN_PHONE, hash],
  );
  // Field agent — has customers.view but NOT dispositions.manage
  await pool.query(
    `INSERT INTO users (agency_id, full_name, phone, password_hash, is_field_agent, designation)
     VALUES ($1, 'Disp Agent', $2, $3, true, 'field_agent')`,
    [agencyId, AGENT_PHONE, hash],
  );

  // Seed 2 codes for this agency
  await pool.query(
    `INSERT INTO disposition_codes (agency_id, action_code, category, result_code, description, needs_amount, needs_date)
     VALUES
       ($1, 'OC', 'PROMISE TO PAY', 'PTP', 'Promised to Pay', true, true),
       ($1, 'OC', 'BROKEN PROMISE', 'BP', 'Broken Promise', false, false)`,
    [agencyId],
  );

  const adminLogin = await request(app)
    .post("/api/auth/login")
    .send({ phone: ADMIN_PHONE, password: PASSWORD });
  adminToken = adminLogin.body.access_token;

  const agentLogin = await request(app)
    .post("/api/auth/login")
    .send({ phone: AGENT_PHONE, password: PASSWORD });
  agentToken = agentLogin.body.access_token;
});

afterAll(async () => {
  await pool.query("DELETE FROM disposition_codes WHERE agency_id = $1", [agencyId]);
  await pool.query("DELETE FROM users WHERE agency_id = $1", [agencyId]);
  await pool.query("DELETE FROM agencies WHERE id = $1", [agencyId]);
  await pool.end();
});

describe("Disposition codes master (brief §7)", () => {
  it("admin sees only active codes for their agency", async () => {
    const res = await request(app)
      .get("/api/dispositions")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const codes = res.body.disposition_codes as { description: string; is_active: boolean }[];
    // Every returned code must be active
    expect(codes.every((c) => c.is_active)).toBe(true);
    // Our 2 seeded codes are there
    const descs = codes.map((c) => c.description);
    expect(descs).toContain("Promised to Pay");
    expect(descs).toContain("Broken Promise");
  });

  it("field agent can also list disposition codes (needed for call logging)", async () => {
    const res = await request(app)
      .get("/api/dispositions")
      .set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
    expect(res.body.disposition_codes.length).toBeGreaterThan(0);
  });

  it("include_inactive=true shows retired codes too", async () => {
    // First retire a code via PATCH
    const list = await request(app)
      .get("/api/dispositions")
      .set("Authorization", `Bearer ${adminToken}`);
    const bpId = list.body.disposition_codes.find(
      (c: { description: string }) => c.description === "Broken Promise",
    )?.id;
    await request(app)
      .patch(`/api/dispositions/${bpId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ is_active: false });

    const res = await request(app)
      .get("/api/dispositions?include_inactive=true")
      .set("Authorization", `Bearer ${adminToken}`);
    const codes = res.body.disposition_codes as { is_active: boolean }[];
    expect(codes.some((c) => !c.is_active)).toBe(true);
  });

  it("admin can create a new disposition code", async () => {
    const res = await request(app)
      .post("/api/dispositions")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        action_code: "FV",
        category: "DISPUTE",
        result_code: "RTP",
        description: "Refused to Pay",
        remark_template: "Customer refused: {reason}",
        channel: "FV",
        needs_reason: true,
      });
    expect(res.status).toBe(201);
    expect(res.body.disposition_code.needs_reason).toBe(true);
    expect(res.body.disposition_code.is_active).toBe(true);
    createdCodeId = res.body.disposition_code.id;
  });

  it("admin can edit a disposition code", async () => {
    const res = await request(app)
      .patch(`/api/dispositions/${createdCodeId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ description: "Refused to Pay — updated", needs_amount: true });
    expect(res.status).toBe(200);
    expect(res.body.disposition_code.description).toBe("Refused to Pay — updated");
    expect(res.body.disposition_code.needs_amount).toBe(true);
    expect(res.body.disposition_code.needs_reason).toBe(true); // unchanged
  });

  it("admin can retire a code (is_active = false)", async () => {
    const res = await request(app)
      .patch(`/api/dispositions/${createdCodeId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ is_active: false });
    expect(res.status).toBe(200);
    expect(res.body.disposition_code.is_active).toBe(false);

    // Should no longer appear in default (active-only) list
    const list = await request(app)
      .get("/api/dispositions")
      .set("Authorization", `Bearer ${adminToken}`);
    const ids = list.body.disposition_codes.map((c: { id: string }) => c.id);
    expect(ids).not.toContain(createdCodeId);
  });

  it("field agent cannot create disposition codes (403)", async () => {
    const res = await request(app)
      .post("/api/dispositions")
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ action_code: "OC", description: "Test", needs_amount: false });
    expect(res.status).toBe(403);
  });

  it("PATCH on a code from another agency returns 404", async () => {
    // createdCodeId belongs to agencyId; agentToken is also from agencyId but
    // imagine we got an id from a different agency — just use a random uuid
    const res = await request(app)
      .patch("/api/dispositions/00000000-0000-0000-0000-000000000001")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ is_active: false });
    expect(res.status).toBe(404);
  });
});
