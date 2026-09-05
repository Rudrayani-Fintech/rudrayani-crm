import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { pool } from "../src/config/db";
import { hashPassword } from "../src/services/auth-service";

/**
 * Task 4.4: field-visit evidence (photo + signature) and the reallocation
 * request/approval flow, plus the TL team-day summary. Brief Section 8.
 */
const app = createApp();

const PASSWORD = "Secret@123";
const BM_PHONE = "7900000060";
const AGENT_PHONE = "7900000061";
const AGENT2_PHONE = "7900000062";

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

let agencyId: string;
let companyId: string;
let branchId: string;
let teamId: string;
let bmToken: string;
let agentToken: string;
let agent2Token: string;
let agentId: string;
let agent2Id: string;
let customerId: string;
let customer2Id: string;

async function login(phone: string): Promise<string> {
  const res = await request(app).post("/api/auth/login").send({ phone, password: PASSWORD });
  return res.body.access_token;
}

beforeAll(async () => {
  const agency = await pool.query(
    "INSERT INTO agencies (name) VALUES ('Field Workflow Agency') RETURNING id",
  );
  agencyId = agency.rows[0].id;
  const company = await pool.query(
    "INSERT INTO companies (agency_id, name) VALUES ($1, 'Field NBFC') RETURNING id",
    [agencyId],
  );
  companyId = company.rows[0].id;
  const branch = await pool.query(
    "INSERT INTO branches (agency_id, name) VALUES ($1, 'Field Branch') RETURNING id",
    [agencyId],
  );
  branchId = branch.rows[0].id;
  const team = await pool.query(
    "INSERT INTO teams (branch_id, name) VALUES ($1, 'Field Team') RETURNING id",
    [branchId],
  );
  teamId = team.rows[0].id;

  const hash = await hashPassword(PASSWORD);
  const bm = await pool.query(
    `INSERT INTO users (agency_id, full_name, phone, password_hash, designation)
     VALUES ($1, 'Field BM', $2, $3, 'branch_manager') RETURNING id`,
    [agencyId, BM_PHONE, hash],
  );
  void bm;
  const agent = await pool.query(
    `INSERT INTO users (agency_id, full_name, phone, password_hash, is_field_agent, team_id, designation)
     VALUES ($1, 'Field Agent One', $2, $3, true, $4, 'field_agent') RETURNING id`,
    [agencyId, AGENT_PHONE, hash, teamId],
  );
  agentId = agent.rows[0].id;
  const agent2 = await pool.query(
    `INSERT INTO users (agency_id, full_name, phone, password_hash, is_field_agent, team_id, designation)
     VALUES ($1, 'Field Agent Two', $2, $3, true, $4, 'field_agent') RETURNING id`,
    [agencyId, AGENT2_PHONE, hash, teamId],
  );
  agent2Id = agent2.rows[0].id;

  const customers = await pool.query(
    `INSERT INTO customers (company_id, loan_number, customer_name, mobile_number, due_amount, assigned_agent_id)
     VALUES ($1, 'FV-001', 'Visit Kumar', '9855555555', 90000, $2),
            ($1, 'FV-002', 'Visit Sharma', '9866666666', 45000, $2)
     RETURNING id`,
    [companyId, agentId],
  );
  customerId = customers.rows[0].id;
  customer2Id = customers.rows[1].id;

  bmToken = await login(BM_PHONE);
  agentToken = await login(AGENT_PHONE);
  agent2Token = await login(AGENT2_PHONE);
});

afterAll(async () => {
  await pool.query(
    "DELETE FROM reallocation_requests WHERE customer_id IN ($1, $2)",
    [customerId, customer2Id],
  );
  await pool.query("DELETE FROM field_visits WHERE customer_id IN ($1, $2)", [
    customerId,
    customer2Id,
  ]);
  await pool.query(
    "DELETE FROM allocation_logs WHERE customer_id IN ($1, $2)",
    [customerId, customer2Id],
  );
  await pool.query("DELETE FROM customers WHERE company_id = $1", [companyId]);
  await pool.query(
    "DELETE FROM attendance WHERE user_id IN (SELECT id FROM users WHERE agency_id = $1)",
    [agencyId],
  );
  await pool.query("DELETE FROM users WHERE agency_id = $1", [agencyId]);
  await pool.query("DELETE FROM teams WHERE id = $1", [teamId]);
  await pool.query("DELETE FROM branches WHERE id = $1", [branchId]);
  await pool.query("DELETE FROM companies WHERE id = $1", [companyId]);
  await pool.query("DELETE FROM agencies WHERE id = $1", [agencyId]);
  await pool.end();
});

describe("field visits", () => {
  it("records a visit with photo, signature, and GPS", async () => {
    const res = await request(app)
      .post("/api/field-visits")
      .set("Authorization", `Bearer ${agentToken}`)
      .field("customer_id", customerId)
      .field("remark", "Met customer at shop")
      .field("lat", "18.52")
      .field("lng", "73.85")
      .attach("photo", PNG_1PX, { filename: "visit.png", contentType: "image/png" })
      .attach("signature", PNG_1PX, { filename: "sig.png", contentType: "image/png" });
    expect(res.status).toBe(201);
    expect(res.body.field_visit.has_photo).toBe(true);
    expect(res.body.field_visit.has_signature).toBe(true);
  });

  it("rejects a visit with neither photo nor signature", async () => {
    const res = await request(app)
      .post("/api/field-visits")
      .set("Authorization", `Bearer ${agentToken}`)
      .field("customer_id", customerId);
    expect(res.status).toBe(400);
  });

  it("lists visits and streams the signature", async () => {
    const list = await request(app)
      .get(`/api/field-visits?customer_id=${customerId}`)
      .set("Authorization", `Bearer ${bmToken}`);
    expect(list.status).toBe(200);
    expect(list.body.field_visits.length).toBe(1);
    expect(list.body.field_visits[0].agent_name).toBe("Field Agent One");

    const sig = await request(app)
      .get(`/api/field-visits/${list.body.field_visits[0].id}/signature`)
      .set("Authorization", `Bearer ${bmToken}`);
    expect(sig.status).toBe(200);
    expect(sig.headers["content-type"]).toBe("image/png");
  });
});

describe("reallocation requests", () => {
  let requestId: string;

  it("an agent cannot request for a customer not assigned to them", async () => {
    const res = await request(app)
      .post("/api/reallocation-requests")
      .set("Authorization", `Bearer ${agent2Token}`)
      .send({ customer_id: customerId, reason: "Customer is in my area" });
    expect(res.status).toBe(403);
  });

  it("the assigned agent raises a request", async () => {
    const res = await request(app)
      .post("/api/reallocation-requests")
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ customer_id: customerId, reason: "Customer relocated to another city" });
    expect(res.status).toBe(201);
    requestId = res.body.request.id;
  });

  it("a second pending request for the same customer is a 409", async () => {
    const res = await request(app)
      .post("/api/reallocation-requests")
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ customer_id: customerId, reason: "Trying again" });
    expect(res.status).toBe(409);
  });

  it("an agent CAN list their own requests (self-scoped), but not decide them", async () => {
    const res = await request(app)
      .get("/api/reallocation-requests?status=all")
      .set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
    expect(res.body.requests.length).toBe(1);
    expect(res.body.requests[0].id).toBe(requestId);

    const decide = await request(app)
      .post(`/api/reallocation-requests/${requestId}/decide`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ approve: true });
    expect(decide.status).toBe(403);
  });

  it("the TL sees the pending request", async () => {
    const res = await request(app)
      .get("/api/reallocation-requests")
      .set("Authorization", `Bearer ${bmToken}`);
    expect(res.status).toBe(200);
    expect(res.body.requests.length).toBe(1);
    expect(res.body.requests[0].requested_by_name).toBe("Field Agent One");
  });

  it("approval reassigns the customer and writes an allocation log", async () => {
    const res = await request(app)
      .post(`/api/reallocation-requests/${requestId}/decide`)
      .set("Authorization", `Bearer ${bmToken}`)
      .send({ approve: true, new_agent_id: agent2Id });
    expect(res.status).toBe(200);
    expect(res.body.request.status).toBe("approved");

    const cust = await pool.query("SELECT assigned_agent_id FROM customers WHERE id = $1", [
      customerId,
    ]);
    expect(cust.rows[0].assigned_agent_id).toBe(agent2Id);

    const log = await pool.query(
      "SELECT * FROM allocation_logs WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 1",
      [customerId],
    );
    expect(log.rows[0].to_agent_id).toBe(agent2Id);
    expect(log.rows[0].from_agent_id).toBe(agentId);
  });

  it("deciding twice is a 409", async () => {
    const res = await request(app)
      .post(`/api/reallocation-requests/${requestId}/decide`)
      .set("Authorization", `Bearer ${bmToken}`)
      .send({ approve: false });
    expect(res.status).toBe(409);
  });

  it("approval without a new agent returns the customer to the pool", async () => {
    const raise = await request(app)
      .post("/api/reallocation-requests")
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ customer_id: customer2Id, reason: "Language barrier" });
    expect(raise.status).toBe(201);

    const decide = await request(app)
      .post(`/api/reallocation-requests/${raise.body.request.id}/decide`)
      .set("Authorization", `Bearer ${bmToken}`)
      .send({ approve: true });
    expect(decide.status).toBe(200);

    const cust = await pool.query("SELECT assigned_agent_id FROM customers WHERE id = $1", [
      customer2Id,
    ]);
    expect(cust.rows[0].assigned_agent_id).toBeNull();
  });
});

describe("team day summary", () => {
  it("returns attendance + activity per team member for the TL", async () => {
    await pool.query(
      `INSERT INTO attendance (user_id, punch_in_at, punch_out_at)
       VALUES ($1, now() - interval '4 hours', now() - interval '1 hour')`,
      [agentId],
    );

    const res = await request(app)
      .get("/api/tracking/team-day")
      .set("Authorization", `Bearer ${bmToken}`);
    expect(res.status).toBe(200);

    const one = res.body.members.find((m: { user_id: string }) => m.user_id === agentId);
    expect(one).toBeDefined();
    expect(one.minutes_worked).toBeGreaterThanOrEqual(179);
    expect(one.on_duty).toBe(false);
    // scope: only the TL's team
    const names = res.body.members.map((m: { full_name: string }) => m.full_name);
    expect(names).toContain("Field Agent Two");
    expect(names).toContain("Field TL");
  });

  // Phase 12: agents (telecaller/field_agent) now hold tracking.view too, so
  // their own mobile dashboard can call /tracking/team-day for their own
  // attendance -- but scope.ts clamps them to just their own row.
  it("agents see only their own row, never the rest of the team", async () => {
    const res = await request(app)
      .get("/api/tracking/team-day")
      .set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
    const ids = res.body.members.map((m: { user_id: string }) => m.user_id);
    expect(ids).toEqual([agentId]);
  });
});
