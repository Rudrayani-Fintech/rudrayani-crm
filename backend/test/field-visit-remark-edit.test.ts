import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { pool } from "../src/config/db";
import { hashPassword } from "../src/services/auth-service";

const app = createApp();
const PASSWORD = "Secret@123";
const AGENT_PHONE = "7960000003";
const AGENT2_PHONE = "7960000004";

let agencyId: string;
let companyId: string;
let customerId: string;
let agentToken: string;
let agent2Token: string;

async function login(phone: string): Promise<string> {
  const res = await request(app).post("/api/auth/login").send({ phone, password: PASSWORD });
  return res.body.access_token;
}

beforeAll(async () => {
  const agency = await pool.query("INSERT INTO agencies (name) VALUES ('FV Edit Agency') RETURNING id");
  agencyId = agency.rows[0].id;
  const company = await pool.query(
    "INSERT INTO companies (agency_id, name) VALUES ($1, 'FV Edit NBFC') RETURNING id",
    [agencyId],
  );
  companyId = company.rows[0].id;

  const hash = await hashPassword(PASSWORD);
  const agent = await pool.query(
    `INSERT INTO users (agency_id, full_name, phone, password_hash, is_field_agent, designation)
     VALUES ($1, 'FV Edit Agent', $2, $3, true, 'field_agent') RETURNING id`,
    [agencyId, AGENT_PHONE, hash],
  );
  await pool.query(
    `INSERT INTO users (agency_id, full_name, phone, password_hash, is_field_agent, designation)
     VALUES ($1, 'FV Edit Agent 2', $2, $3, true, 'field_agent')`,
    [agencyId, AGENT2_PHONE, hash],
  );

  const customer = await pool.query(
    `INSERT INTO customers (company_id, loan_number, customer_name, mobile_number, due_amount, assigned_field_agent_id)
     VALUES ($1, 'FVE-001', 'FV Edit Test Customer', '9800000002', 20000, $2) RETURNING id`,
    [companyId, agent.rows[0].id],
  );
  customerId = customer.rows[0].id;

  agentToken = await login(AGENT_PHONE);
  agent2Token = await login(AGENT2_PHONE);
});

afterAll(async () => {
  await pool.query("DELETE FROM field_visits WHERE customer_id = $1", [customerId]);
  await pool.query("DELETE FROM customers WHERE id = $1", [customerId]);
  await pool.query("DELETE FROM users WHERE agency_id = $1", [agencyId]);
  await pool.query("DELETE FROM companies WHERE id = $1", [companyId]);
  await pool.query("DELETE FROM agencies WHERE id = $1", [agencyId]);
  await pool.end();
});

describe("field visit remark edit", () => {
  it("owner edits their remark within the window", async () => {
    const create = await request(app)
      .post("/api/field-visits")
      .set("Authorization", `Bearer ${agentToken}`)
      .field("customer_id", customerId)
      .field("remark", "Door locked, nobody home");
    expect(create.status).toBe(201);
    const visitId = create.body.field_visit.id;

    const edit = await request(app)
      .patch(`/api/field-visits/${visitId}/remark`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ remark: "Neighbour said they moved out" });
    expect(edit.status).toBe(200);
    expect(edit.body.field_visit.remark).toBe("Neighbour said they moved out");
    expect(edit.body.field_visit.edited_at).not.toBeNull();
  });

  it("a non-owner cannot edit (404)", async () => {
    const create = await request(app)
      .post("/api/field-visits")
      .set("Authorization", `Bearer ${agentToken}`)
      .field("customer_id", customerId)
      .field("remark", "Door locked, nobody home");
    const visitId = create.body.field_visit.id;

    const edit = await request(app)
      .patch(`/api/field-visits/${visitId}/remark`)
      .set("Authorization", `Bearer ${agent2Token}`)
      .send({ remark: "not mine" });
    expect(edit.status).toBe(404);
  });

  it("rejects an edit once the visit is more than 24h old (409)", async () => {
    const create = await request(app)
      .post("/api/field-visits")
      .set("Authorization", `Bearer ${agentToken}`)
      .field("customer_id", customerId)
      .field("remark", "Door locked, nobody home");
    const visitId = create.body.field_visit.id;
    await pool.query("UPDATE field_visits SET created_at = now() - interval '25 hours' WHERE id = $1", [visitId]);

    const edit = await request(app)
      .patch(`/api/field-visits/${visitId}/remark`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ remark: "too late now" });
    expect(edit.status).toBe(409);
  });
});
