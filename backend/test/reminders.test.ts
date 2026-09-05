import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { pool } from "../src/config/db";
import { hashPassword } from "../src/services/auth-service";

/**
 * Agent-owned follow-up reminders (Group B): create, list (self-scoped vs
 * TL/agency-wide), mark done/cancelled, idempotent replay.
 */
const app = createApp();

const BM_PHONE = "7900000070";
const AGENT_PHONE = "7900000071";
const AGENT2_PHONE = "7900000072";
const PASSWORD = "Secret@123";

let agencyId: string;
let otherAgencyId: string;
let companyId: string;
let bmToken: string;
let agentToken: string;
let agent2Token: string;
let agentId: string;
let customerId: string;
let otherAgencyCustomerId: string;

async function login(phone: string): Promise<string> {
  const res = await request(app).post("/api/auth/login").send({ phone, password: PASSWORD });
  return res.body.access_token;
}

beforeAll(async () => {
  const agency = await pool.query(
    "INSERT INTO agencies (name) VALUES ('Reminders Test Agency') RETURNING id",
  );
  agencyId = agency.rows[0].id;

  const otherAgency = await pool.query(
    "INSERT INTO agencies (name) VALUES ('Other Agency (reminders)') RETURNING id",
  );
  otherAgencyId = otherAgency.rows[0].id;

  const company = await pool.query(
    "INSERT INTO companies (agency_id, name) VALUES ($1, 'Test NBFC') RETURNING id",
    [agencyId],
  );
  companyId = company.rows[0].id;

  const otherCompany = await pool.query(
    "INSERT INTO companies (agency_id, name) VALUES ($1, 'Other NBFC') RETURNING id",
    [otherAgencyId],
  );

  const hash = await hashPassword(PASSWORD);
  await pool.query(
    `INSERT INTO users (agency_id, full_name, phone, password_hash, designation)
     VALUES ($1, 'Rem BM', $2, $3, 'branch_manager')`,
    [agencyId, BM_PHONE, hash],
  );
  const agent = await pool.query(
    `INSERT INTO users (agency_id, full_name, phone, password_hash, is_telecaller, designation)
     VALUES ($1, 'Rem Agent', $2, $3, true, 'telecaller') RETURNING id`,
    [agencyId, AGENT_PHONE, hash],
  );
  agentId = agent.rows[0].id;
  await pool.query(
    `INSERT INTO users (agency_id, full_name, phone, password_hash, is_telecaller, designation)
     VALUES ($1, 'Rem Agent 2', $2, $3, true, 'telecaller')`,
    [agencyId, AGENT2_PHONE, hash],
  );

  const customer = await pool.query(
    `INSERT INTO customers (company_id, loan_number, customer_name, mobile_number, product, bucket, due_amount)
     VALUES ($1, 'REM-001', 'Anita Rao', '9844444444', 'Personal Loan', 'B1', 60000)
     RETURNING id`,
    [companyId],
  );
  customerId = customer.rows[0].id;

  const otherCustomer = await pool.query(
    `INSERT INTO customers (company_id, loan_number, customer_name, mobile_number, product, bucket, due_amount)
     VALUES ($1, 'OTH-001', 'Foreign Customer', '9855555555', 'Personal Loan', 'B1', 10000)
     RETURNING id`,
    [otherCompany.rows[0].id],
  );
  otherAgencyCustomerId = otherCustomer.rows[0].id;

  bmToken = await login(BM_PHONE);
  agentToken = await login(AGENT_PHONE);
  agent2Token = await login(AGENT2_PHONE);
});

afterAll(async () => {
  await pool.query("DELETE FROM reminders WHERE agency_id IN ($1, $2)", [agencyId, otherAgencyId]);
  await pool.query("DELETE FROM customers WHERE company_id IN (SELECT id FROM companies WHERE agency_id IN ($1, $2))", [
    agencyId,
    otherAgencyId,
  ]);
  await pool.query("DELETE FROM companies WHERE agency_id IN ($1, $2)", [agencyId, otherAgencyId]);
  await pool.query("DELETE FROM users WHERE agency_id IN ($1, $2)", [agencyId, otherAgencyId]);
  await pool.query("DELETE FROM agencies WHERE id IN ($1, $2)", [agencyId, otherAgencyId]);
  await pool.end();
});

describe("POST /api/reminders", () => {
  it("creates a reminder against a customer", async () => {
    const remindAt = new Date(Date.now() + 3600_000).toISOString();
    const res = await request(app)
      .post("/api/reminders")
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ customer_id: customerId, remind_at: remindAt, note: "Call back re: settlement" });
    expect(res.status).toBe(201);
    expect(res.body.reminder.agent_id).toBe(agentId);
    expect(res.body.reminder.status).toBe("pending");
  });

  it("creates a free-standing reminder with no customer", async () => {
    const res = await request(app)
      .post("/api/reminders")
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ remind_at: new Date(Date.now() + 7200_000).toISOString(), note: "Team meeting" });
    expect(res.status).toBe(201);
    expect(res.body.reminder.customer_id).toBeNull();
  });

  it("rejects a customer outside the caller's agency", async () => {
    const res = await request(app)
      .post("/api/reminders")
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ customer_id: otherAgencyCustomerId, remind_at: new Date().toISOString() });
    expect(res.status).toBe(404);
  });

  it("replaying the same client_key is idempotent", async () => {
    const clientKey = "b3f6e2c0-1111-4a2b-9c3d-000000000001";
    const remindAt = new Date(Date.now() + 3600_000).toISOString();
    const first = await request(app)
      .post("/api/reminders")
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ remind_at: remindAt, note: "Idempotency check", client_key: clientKey });
    expect(first.status).toBe(201);

    const replay = await request(app)
      .post("/api/reminders")
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ remind_at: remindAt, note: "Idempotency check", client_key: clientKey });
    expect(replay.status).toBe(200);
    expect(replay.body.duplicate).toBe(true);
    expect(replay.body.reminder.id).toBe(first.body.reminder.id);
  });
});

describe("GET /api/reminders", () => {
  it("a non-allocate agent only sees their own reminders", async () => {
    const mine = await request(app)
      .get("/api/reminders?status=all")
      .set("Authorization", `Bearer ${agentToken}`);
    expect(mine.status).toBe(200);
    expect(mine.body.total).toBeGreaterThan(0);
    expect(mine.body.reminders.every((r: { agent_id: string }) => r.agent_id === agentId)).toBe(true);

    const other = await request(app)
      .get("/api/reminders?status=all")
      .set("Authorization", `Bearer ${agent2Token}`);
    expect(other.status).toBe(200);
    expect(other.body.total).toBe(0);
  });

  it("a non-allocate agent's foreign agent_id filter is ignored, not honored", async () => {
    const res = await request(app)
      .get(`/api/reminders?status=all&agent_id=${agentId}`)
      .set("Authorization", `Bearer ${agent2Token}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
  });

  it("a TL (customers.allocate) sees every agent's reminders in the agency", async () => {
    const res = await request(app)
      .get("/api/reminders?status=all")
      .set("Authorization", `Bearer ${bmToken}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThanOrEqual(3);
  });

  it("a TL can filter to one agent explicitly", async () => {
    const res = await request(app)
      .get(`/api/reminders?status=all&agent_id=${agentId}`)
      .set("Authorization", `Bearer ${bmToken}`);
    expect(res.status).toBe(200);
    expect(res.body.reminders.every((r: { agent_id: string }) => r.agent_id === agentId)).toBe(true);
  });
});

describe("PATCH /api/reminders/:id", () => {
  it("owner marks their own reminder done", async () => {
    const created = await request(app)
      .post("/api/reminders")
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ remind_at: new Date(Date.now() + 3600_000).toISOString(), note: "To be completed" });
    const id = created.body.reminder.id;

    const patched = await request(app)
      .patch(`/api/reminders/${id}`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ status: "done" });
    expect(patched.status).toBe(200);
    expect(patched.body.reminder.status).toBe("done");
  });

  it("another agent (not owner, not allocate) gets 404", async () => {
    const created = await request(app)
      .post("/api/reminders")
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ remind_at: new Date(Date.now() + 3600_000).toISOString() });
    const id = created.body.reminder.id;

    const res = await request(app)
      .patch(`/api/reminders/${id}`)
      .set("Authorization", `Bearer ${agent2Token}`)
      .send({ status: "cancelled" });
    expect(res.status).toBe(404);
  });

  it("TL can cancel any team member's reminder", async () => {
    const created = await request(app)
      .post("/api/reminders")
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ remind_at: new Date(Date.now() + 3600_000).toISOString() });
    const id = created.body.reminder.id;

    const res = await request(app)
      .patch(`/api/reminders/${id}`)
      .set("Authorization", `Bearer ${bmToken}`)
      .send({ status: "cancelled" });
    expect(res.status).toBe(200);
    expect(res.body.reminder.status).toBe("cancelled");
  });
});
