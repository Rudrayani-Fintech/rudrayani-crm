import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { pool } from "../src/config/db";
import { hashPassword } from "../src/services/auth-service";

/** Phase 4 (§4.2): the disposition-cadence engine behind the day plan. */
const app = createApp();

const PASSWORD = "Secret@123";
const AGENT_PHONE = "7981200001";

let agencyId: string;
let companyId: string;
let agentId: string;
let agentToken: string;
let notConnectedCodeId: string;
let wrongNumberCodeId: string;

async function login(phone: string): Promise<string> {
  const res = await request(app).post("/api/auth/login").send({ phone, password: PASSWORD });
  return res.body.access_token;
}

async function freshCustomer(loanSuffix: string): Promise<string> {
  const c = await pool.query(
    `INSERT INTO customers (company_id, loan_number, customer_name, mobile_number, due_amount, bucket, assigned_agent_id)
     VALUES ($1, $2, $3, '9812340000', 1000, '0-30', $4) RETURNING id`,
    [companyId, `CAD-${loanSuffix}`, `Cadence Cust ${loanSuffix}`, agentId],
  );
  return c.rows[0].id;
}

async function logCall(customerId: string, dispositionCodeId: string) {
  return request(app)
    .post("/api/call-logs")
    .set("Authorization", `Bearer ${agentToken}`)
    .send({ customer_id: customerId, disposition_code_id: dispositionCodeId });
}

beforeAll(async () => {
  const agency = await pool.query(
    "INSERT INTO agencies (name) VALUES ('Cadence Test Agency') RETURNING id",
  );
  agencyId = agency.rows[0].id;
  const company = await pool.query(
    "INSERT INTO companies (agency_id, name) VALUES ($1, 'Cadence NBFC') RETURNING id",
    [agencyId],
  );
  companyId = company.rows[0].id;

  const hash = await hashPassword(PASSWORD);
  const agent = await pool.query(
    `INSERT INTO users (agency_id, full_name, phone, password_hash, is_telecaller, designation)
     VALUES ($1, 'Cadence Agent', $2, $3, true, 'telecaller') RETURNING id`,
    [agencyId, AGENT_PHONE, hash],
  );
  agentId = agent.rows[0].id;

  const notConnected = await pool.query(
    `INSERT INTO disposition_codes
       (agency_id, action_code, category, result_code, description, channel, followup_after_hours)
     VALUES ($1, 'OC', 'NC', 'NC', 'Not connected', 'OC', 4) RETURNING id`,
    [agencyId],
  );
  notConnectedCodeId = notConnected.rows[0].id;

  const wrongNumber = await pool.query(
    `INSERT INTO disposition_codes
       (agency_id, action_code, category, result_code, description, channel, exits_agent_queue, routes_to)
     VALUES ($1, 'OC', 'WRONG NUMBER', 'WRN', 'Wrong number', 'OC', true, 'data_correction') RETURNING id`,
    [agencyId],
  );
  wrongNumberCodeId = wrongNumber.rows[0].id;

  agentToken = await login(AGENT_PHONE);
});

afterAll(async () => {
  await pool.query(
    "DELETE FROM call_logs WHERE customer_id IN (SELECT id FROM customers WHERE company_id = $1)",
    [companyId],
  );
  await pool.query("DELETE FROM customers WHERE company_id = $1", [companyId]);
  await pool.query("DELETE FROM disposition_codes WHERE agency_id = $1", [agencyId]);
  await pool.query("DELETE FROM refresh_tokens WHERE user_id = $1", [agentId]);
  await pool.query("DELETE FROM users WHERE agency_id = $1", [agencyId]);
  await pool.query("DELETE FROM companies WHERE id = $1", [companyId]);
  await pool.query("DELETE FROM agencies WHERE id = $1", [agencyId]);
  await pool.end();
});

describe("Disposition cadence (§4.2)", () => {
  it("a 'not connected' code sets next_action_date to the code's followup_after_hours later", async () => {
    const customerId = await freshCustomer("nc1");

    const res = await logCall(customerId, notConnectedCodeId);
    expect(res.status).toBe(201);

    const expected = await pool.query<{ d: string }>(
      `SELECT ((cl.created_at + interval '4 hours') AT TIME ZONE 'Asia/Kolkata')::date::text AS d
         FROM call_logs cl WHERE cl.customer_id = $1`,
      [customerId],
    );
    const actual = await pool.query<{ next_action_date: string }>(
      "SELECT next_action_date::text FROM customers WHERE id = $1",
      [customerId],
    );
    expect(actual.rows[0].next_action_date).toBe(expected.rows[0].d);
  });

  it("Wrong Number exits the agent's queue: unassigned and gone from /worklist", async () => {
    const customerId = await freshCustomer("wrn1");

    const before = await request(app)
      .get("/api/worklist")
      .set("Authorization", `Bearer ${agentToken}`);
    expect(before.body.customers.some((c: { id: string }) => c.id === customerId)).toBe(true);

    const res = await logCall(customerId, wrongNumberCodeId);
    expect(res.status).toBe(201);

    const after = await request(app)
      .get("/api/worklist")
      .set("Authorization", `Bearer ${agentToken}`);
    expect(after.body.customers.some((c: { id: string }) => c.id === customerId)).toBe(false);

    const row = await pool.query(
      "SELECT assigned_agent_id, assigned_field_agent_id, next_action_date FROM customers WHERE id = $1",
      [customerId],
    );
    expect(row.rows[0].assigned_agent_id).toBeNull();
    expect(row.rows[0].assigned_field_agent_id).toBeNull();
    expect(row.rows[0].next_action_date).toBeNull();
  });

  it("a 4th attempt in one day does not resurface the customer (daily attempt cap of 3)", async () => {
    const customerId = await freshCustomer("cap1");

    for (let i = 0; i < 3; i++) {
      const res = await logCall(customerId, notConnectedCodeId);
      expect(res.status).toBe(201);
    }
    const afterThird = await pool.query<{ next_action_date: string | null }>(
      "SELECT next_action_date FROM customers WHERE id = $1",
      [customerId],
    );
    // 3rd attempt still resurfaces normally.
    expect(afterThird.rows[0].next_action_date).not.toBeNull();

    // Force the 3rd call's next_action_date to something clearly in the
    // past-relative-to-cadence so a 4th, cap-suppressed call is
    // distinguishable from "the 3rd call's date happened to repeat".
    await pool.query("UPDATE customers SET next_action_date = NULL WHERE id = $1", [customerId]);

    const fourth = await logCall(customerId, notConnectedCodeId);
    expect(fourth.status).toBe(201);

    const afterFourth = await pool.query<{ next_action_date: string | null }>(
      "SELECT next_action_date FROM customers WHERE id = $1",
      [customerId],
    );
    // Cap hit on the 4th attempt: cadence source suppressed, and with no
    // pending PTP/reminder either, next_action_date stays NULL.
    expect(afterFourth.rows[0].next_action_date).toBeNull();
  });

  it("dispositions admin API exposes and accepts the cadence fields", async () => {
    const res = await request(app)
      .get("/api/dispositions")
      .set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
    const nc = res.body.disposition_codes.find(
      (c: { id: string }) => c.id === notConnectedCodeId,
    );
    expect(nc.followup_after_hours).toBe(4);
    const wrn = res.body.disposition_codes.find(
      (c: { id: string }) => c.id === wrongNumberCodeId,
    );
    expect(wrn.exits_agent_queue).toBe(true);
    expect(wrn.routes_to).toBe("data_correction");
  });
});
