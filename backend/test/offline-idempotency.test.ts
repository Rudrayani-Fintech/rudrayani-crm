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
    `INSERT INTO customers (company_id, loan_number, customer_name, mobile_number, due_amount, assigned_field_agent_id)
     VALUES ($1, 'IDEM-001', 'Offline Kumar', '9844444444', 50000, $2) RETURNING id`,
    [companyId, agentId],
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
  // Phase 6 (§4.4): field_visits.customer_id has no ON DELETE CASCADE --
  // clear it before deleting the customer it references.
  await pool.query("DELETE FROM field_visits WHERE customer_id = $1", [customerId]);
  await pool.query("DELETE FROM customers WHERE id = $1", [customerId]);
  await pool.query("DELETE FROM disposition_codes WHERE agency_id = $1", [agencyId]);
  // Phase 6 (§4.5): attendance.user_id has no ON DELETE CASCADE either.
  await pool.query("DELETE FROM attendance WHERE user_id = $1", [agentId]);
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

describe("field-visit-with-embedded-payment idempotency (Phase 6, §4.4/§4.5)", () => {
  const clientKey = randomUUID();

  it("first send creates one field_visits row and one linked payments row — 201", async () => {
    const res = await request(app)
      .post("/api/field-visits")
      .set("Authorization", `Bearer ${agentToken}`)
      .field("customer_id", customerId)
      .field("remark", "Met customer, collected part payment")
      .field("client_key", clientKey)
      .field("payment_amount", "1500")
      .field("payment_mode", "Cash");
    expect(res.status).toBe(201);
    expect(res.body.field_visit.customer_id).toBe(customerId);
    expect(res.body.payment).not.toBeNull();
    expect(Number(res.body.payment.amount)).toBe(1500);
    expect(res.body.payment.field_visit_id).toBe(res.body.field_visit.id);
    expect(res.body.payment.client_key).toBe(clientKey);
  });

  it("re-send with the same key returns the original pair, no duplicates — 200", async () => {
    const res = await request(app)
      .post("/api/field-visits")
      .set("Authorization", `Bearer ${agentToken}`)
      .field("customer_id", customerId)
      .field("remark", "Met customer, collected part payment")
      .field("client_key", clientKey)
      .field("payment_amount", "1500")
      .field("payment_mode", "Cash");
    expect(res.status).toBe(200);
    expect(res.body.duplicate).toBe(true);
    expect(res.body.payment).not.toBeNull();

    const visits = await pool.query(
      "SELECT count(*)::int AS n FROM field_visits WHERE customer_id = $1 AND client_key = $2",
      [customerId, clientKey],
    );
    expect(visits.rows[0].n).toBe(1);
    const payments = await pool.query(
      "SELECT count(*)::int AS n FROM payments WHERE customer_id = $1 AND client_key = $2",
      [customerId, clientKey],
    );
    expect(payments.rows[0].n).toBe(1);
  });

  it("a rolled-back visit leaves no orphan payment", async () => {
    // Simulate the payment leg failing inside the transaction (e.g. a
    // client_key collision on the payments table alone) by pre-seeding a
    // payments row with the key this new visit will reuse.
    const collidingKey = randomUUID();
    await pool.query(
      `INSERT INTO payments (customer_id, collected_by_user_id, amount, client_key)
       VALUES ($1, $2, 100, $3)`,
      [customerId, agentId, collidingKey],
    );

    const res = await request(app)
      .post("/api/field-visits")
      .set("Authorization", `Bearer ${agentToken}`)
      .field("customer_id", customerId)
      .field("remark", "This attempt should roll back entirely")
      .field("client_key", collidingKey)
      .field("payment_amount", "999");
    // error-handler.ts maps a raw 23505 (unique violation) to 409.
    expect(res.status).toBe(409);

    const visits = await pool.query(
      "SELECT count(*)::int AS n FROM field_visits WHERE customer_id = $1 AND client_key = $2",
      [customerId, collidingKey],
    );
    expect(visits.rows[0].n).toBe(0); // the field_visits INSERT was rolled back too

    await pool.query("DELETE FROM payments WHERE client_key = $1", [collidingKey]);
  });
});

describe("PTP idempotency (Phase 6, §4.5)", () => {
  const clientKey = randomUUID();
  const promisedDate = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);

  it("first send creates the PTP — 201", async () => {
    const res = await request(app)
      .post("/api/ptps")
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ customer_id: customerId, amount: 3000, promised_date: promisedDate, client_key: clientKey });
    expect(res.status).toBe(201);
    expect(res.body.ptp.client_key).toBe(clientKey);
  });

  it("re-send with the same key returns the existing PTP — 200, no duplicate", async () => {
    const res = await request(app)
      .post("/api/ptps")
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ customer_id: customerId, amount: 3000, promised_date: promisedDate, client_key: clientKey });
    expect(res.status).toBe(200);
    expect(res.body.duplicate).toBe(true);

    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM ptps WHERE customer_id = $1 AND client_key = $2",
      [customerId, clientKey],
    );
    expect(rows[0].n).toBe(1);
  });
});

describe("punch-out idempotency (Phase 6, §4.5)", () => {
  const clientKey = randomUUID();

  it("punch in, then punch out with a client_key — 200", async () => {
    const punchIn = await request(app)
      .post("/api/attendance/punch-in")
      .set("Authorization", `Bearer ${agentToken}`)
      .send({});
    expect(punchIn.status).toBe(201);

    const res = await request(app)
      .post("/api/attendance/punch-out")
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ client_key: clientKey });
    expect(res.status).toBe(200);
    expect(res.body.attendance.punch_out_at).not.toBeNull();
  });

  it("re-send with the same key returns the same punch-out, not a 409 'not punched in'", async () => {
    const res = await request(app)
      .post("/api/attendance/punch-out")
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ client_key: clientKey });
    expect(res.status).toBe(200);
    expect(res.body.duplicate).toBe(true);

    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM attendance WHERE user_id = $1 AND punch_out_client_key = $2",
      [agentId, clientKey],
    );
    expect(rows[0].n).toBe(1);
  });
});
