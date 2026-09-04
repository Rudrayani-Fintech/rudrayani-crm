import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/app";
import { pool } from "../src/config/db";
import { hashPassword } from "../src/services/auth-service";

/**
 * Task 4.3: offline-sync idempotency. A queued action re-sent after a lost
 * response must return the already-created row, not create a duplicate.
 */
const app = createApp();

const AGENT_PHONE = "7900000050";
const PASSWORD = "Secret@123";

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

let agencyId: string;
let companyId: string;
let agentId: string;
let agentToken: string;
let customerId: string;
let codeId: string;

beforeAll(async () => {
  const agency = await pool.query(
    "INSERT INTO agencies (name) VALUES ('Idempotency Test Agency') RETURNING id",
  );
  agencyId = agency.rows[0].id;
  const company = await pool.query(
    "INSERT INTO companies (agency_id, name) VALUES ($1, 'Idem NBFC') RETURNING id",
    [agencyId],
  );
  companyId = company.rows[0].id;

  const hash = await hashPassword(PASSWORD);
  const agent = await pool.query(
    `INSERT INTO users (agency_id, full_name, phone, password_hash, is_field_agent, designation)
     VALUES ($1, 'Idem Agent', $2, $3, true, 'field_agent') RETURNING id`,
    [agencyId, AGENT_PHONE, hash],
  );
  agentId = agent.rows[0].id;

  const customer = await pool.query(
    `INSERT INTO customers (company_id, loan_number, customer_name, mobile_number, due_amount)
     VALUES ($1, 'IDEM-001', 'Offline Kumar', '9844444444', 50000) RETURNING id`,
    [companyId],
  );
  customerId = customer.rows[0].id;

  const code = await pool.query(
    `INSERT INTO disposition_codes
       (agency_id, action_code, category, result_code, description, remark_template,
        needs_amount, needs_date)
     VALUES ($1, 'OC', 'PROMISE TO PAY', 'PTP', 'Promised to Pay',
             'Will pay <amount> on <Date>', true, true) RETURNING id`,
    [agencyId],
  );
  codeId = code.rows[0].id;

  const login = await request(app)
    .post("/api/auth/login")
    .send({ phone: AGENT_PHONE, password: PASSWORD });
  agentToken = login.body.access_token;
});

afterAll(async () => {
  await pool.query("DELETE FROM ptps WHERE customer_id = $1", [customerId]);
  await pool.query("DELETE FROM call_logs WHERE customer_id = $1", [customerId]);
  await pool.query("DELETE FROM payments WHERE customer_id = $1", [customerId]);
  await pool.query("DELETE FROM customers WHERE id = $1", [customerId]);
  await pool.query("DELETE FROM disposition_codes WHERE agency_id = $1", [agencyId]);
  await pool.query("DELETE FROM users WHERE id = $1", [agentId]);
  await pool.query("DELETE FROM companies WHERE id = $1", [companyId]);
  await pool.query("DELETE FROM agencies WHERE id = $1", [agencyId]);
  await pool.end();
});

describe("call-log idempotency", () => {
  const clientKey = randomUUID();
  const promisedDate = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);

  it("first send creates the call log (and PTP) — 201", async () => {
    const res = await request(app)
      .post("/api/call-logs")
      .set("Authorization", `Bearer ${agentToken}`)
      .send({
        customer_id: customerId,
        disposition_code_id: codeId,
        fields: { amount: 5000, date: promisedDate },
        client_key: clientKey,
      });
    expect(res.status).toBe(201);
    expect(res.body.call_log.client_key).toBe(clientKey);
    expect(res.body.ptp).not.toBeNull();
  });

  it("re-send with the same key returns the existing row — 200, no duplicate", async () => {
    const res = await request(app)
      .post("/api/call-logs")
      .set("Authorization", `Bearer ${agentToken}`)
      .send({
        customer_id: customerId,
        disposition_code_id: codeId,
        fields: { amount: 5000, date: promisedDate },
        client_key: clientKey,
      });
    expect(res.status).toBe(200);
    expect(res.body.duplicate).toBe(true);
    expect(res.body.ptp).not.toBeNull();

    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM call_logs WHERE customer_id = $1",
      [customerId],
    );
    expect(rows[0].n).toBe(1);
    const ptps = await pool.query(
      "SELECT count(*)::int AS n FROM ptps WHERE customer_id = $1",
      [customerId],
    );
    expect(ptps.rows[0].n).toBe(1);
  });

  it("a different key creates a new row as usual", async () => {
    const res = await request(app)
      .post("/api/call-logs")
      .set("Authorization", `Bearer ${agentToken}`)
      .send({
        customer_id: customerId,
        disposition_code_id: codeId,
        fields: { amount: 6000, date: promisedDate },
        client_key: randomUUID(),
      });
    expect(res.status).toBe(201);
  });

  it("requests without a key are unaffected", async () => {
    const res = await request(app)
      .post("/api/call-logs")
      .set("Authorization", `Bearer ${agentToken}`)
      .send({
        customer_id: customerId,
        disposition_code_id: codeId,
        fields: { amount: 7000, date: promisedDate },
      });
    expect(res.status).toBe(201);
    expect(res.body.call_log.client_key).toBeNull();
  });
});

describe("payment idempotency", () => {
  const clientKey = randomUUID();

  it("first send records the payment with photo — 201", async () => {
    const res = await request(app)
      .post("/api/payments")
      .set("Authorization", `Bearer ${agentToken}`)
      .field("customer_id", customerId)
      .field("amount", "2500")
      .field("mode", "Cash")
      .field("client_key", clientKey)
      .attach("photo", PNG_1PX, { filename: "proof.png", contentType: "image/png" });
    expect(res.status).toBe(201);
    expect(res.body.payment.client_key).toBe(clientKey);
  });

  it("re-send with the same key returns the existing payment — 200, single row", async () => {
    const res = await request(app)
      .post("/api/payments")
      .set("Authorization", `Bearer ${agentToken}`)
      .field("customer_id", customerId)
      .field("amount", "2500")
      .field("mode", "Cash")
      .field("client_key", clientKey)
      .attach("photo", PNG_1PX, { filename: "proof.png", contentType: "image/png" });
    expect(res.status).toBe(200);
    expect(res.body.duplicate).toBe(true);

    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM payments WHERE customer_id = $1",
      [customerId],
    );
    expect(rows[0].n).toBe(1);
  });
});
