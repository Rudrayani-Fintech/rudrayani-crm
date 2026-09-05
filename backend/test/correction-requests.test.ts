import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { pool } from "../src/config/db";
import { hashPassword } from "../src/services/auth-service";

/** MVP hardening: agent-initiated corrections for payments/call-logs/PTPs. */
const app = createApp();

const PASSWORD = "Secret@123";
const REVIEWER_PHONE = "7950000001";
const AGENT_PHONE = "7950000002";
const AGENT2_PHONE = "7950000003";

let agencyId: string;
let companyId: string;
let customerId: string;
let reviewerToken: string;
let agentToken: string;
let agent2Token: string;
let agentId: string;
let paymentId: string;
let callLogId: string;
let ptpId: string;
let fieldVisitId: string;

async function login(phone: string): Promise<string> {
  const res = await request(app).post("/api/auth/login").send({ phone, password: PASSWORD });
  return res.body.access_token;
}

beforeAll(async () => {
  const agency = await pool.query(
    "INSERT INTO agencies (name) VALUES ('Correction Requests Agency') RETURNING id",
  );
  agencyId = agency.rows[0].id;
  const company = await pool.query(
    "INSERT INTO companies (agency_id, name) VALUES ($1, 'CR Test NBFC') RETURNING id",
    [agencyId],
  );
  companyId = company.rows[0].id;

  const hash = await hashPassword(PASSWORD);
  await pool.query(
    `INSERT INTO users (agency_id, full_name, phone, password_hash, is_agency_admin, designation)
     VALUES ($1, 'CR Reviewer', $2, $3, true, 'agency_admin')`,
    [agencyId, REVIEWER_PHONE, hash],
  );
  const agent = await pool.query(
    `INSERT INTO users (agency_id, full_name, phone, password_hash, is_telecaller, designation)
     VALUES ($1, 'CR Agent', $2, $3, true, 'telecaller') RETURNING id`,
    [agencyId, AGENT_PHONE, hash],
  );
  agentId = agent.rows[0].id;
  await pool.query(
    `INSERT INTO users (agency_id, full_name, phone, password_hash, is_telecaller, designation)
     VALUES ($1, 'CR Agent 2', $2, $3, true, 'telecaller')`,
    [agencyId, AGENT2_PHONE, hash],
  );

  const customer = await pool.query(
    `INSERT INTO customers (company_id, loan_number, customer_name, mobile_number, due_amount, assigned_agent_id)
     VALUES ($1, 'CR-001', 'Test Customer', '9800000000', 50000, $2) RETURNING id`,
    [companyId, agentId],
  );
  customerId = customer.rows[0].id;

  const payment = await pool.query(
    `INSERT INTO payments (customer_id, collected_by_user_id, amount, mode)
     VALUES ($1, $2, 5000, 'Cash') RETURNING id`,
    [customerId, agentId],
  );
  paymentId = payment.rows[0].id;

  const callLog = await pool.query(
    `INSERT INTO call_logs (customer_id, agent_id, remark)
     VALUES ($1, $2, 'Customer said they would pay') RETURNING id`,
    [customerId, agentId],
  );
  callLogId = callLog.rows[0].id;

  const promised = new Date();
  promised.setDate(promised.getDate() + 5);
  const ptp = await pool.query(
    `INSERT INTO ptps (customer_id, call_log_id, agent_id, amount, promised_date)
     VALUES ($1, $2, $3, 10000, $4) RETURNING id`,
    [customerId, callLogId, agentId, promised.toISOString().slice(0, 10)],
  );
  ptpId = ptp.rows[0].id;

  const fieldVisit = await pool.query(
    `INSERT INTO field_visits (customer_id, agent_id, remark)
     VALUES ($1, $2, 'Door locked, nobody home') RETURNING id`,
    [customerId, agentId],
  );
  fieldVisitId = fieldVisit.rows[0].id;

  reviewerToken = await login(REVIEWER_PHONE);
  agentToken = await login(AGENT_PHONE);
  agent2Token = await login(AGENT2_PHONE);
});

afterAll(async () => {
  await pool.query("DELETE FROM correction_requests WHERE requested_by IN (SELECT id FROM users WHERE agency_id = $1)", [agencyId]);
  await pool.query("DELETE FROM field_visits WHERE customer_id = $1", [customerId]);
  await pool.query("DELETE FROM ptps WHERE customer_id = $1", [customerId]);
  await pool.query("DELETE FROM call_logs WHERE customer_id = $1", [customerId]);
  await pool.query("DELETE FROM payments WHERE customer_id = $1", [customerId]);
  await pool.query("DELETE FROM customers WHERE id = $1", [customerId]);
  await pool.query("DELETE FROM users WHERE agency_id = $1", [agencyId]);
  await pool.query("DELETE FROM companies WHERE id = $1", [companyId]);
  await pool.query("DELETE FROM agencies WHERE id = $1", [agencyId]);
  await pool.end();
});

describe("correction requests", () => {
  it("rejects a disallowed field for the record type", async () => {
    const res = await request(app)
      .post("/api/correction-requests")
      .set("Authorization", `Bearer ${agentToken}`)
      .send({
        record_type: "payment",
        record_id: paymentId,
        proposed_changes: { collected_by_user_id: "11111111-1111-1111-1111-111111111111" },
        reason: "trying to change ownership",
      });
    expect(res.status).toBe(400);
  });

  it("agent cannot request a correction on someone else's record", async () => {
    const res = await request(app)
      .post("/api/correction-requests")
      .set("Authorization", `Bearer ${agent2Token}`)
      .send({
        record_type: "payment",
        record_id: paymentId,
        proposed_changes: { amount: 4500 },
        reason: "not mine",
      });
    expect(res.status).toBe(404);
  });

  it("agent submits a payment amount correction; approving it applies the change", async () => {
    const submit = await request(app)
      .post("/api/correction-requests")
      .set("Authorization", `Bearer ${agentToken}`)
      .send({
        record_type: "payment",
        record_id: paymentId,
        proposed_changes: { amount: 5500 },
        reason: "typo'd the amount, customer actually paid 5500",
      });
    expect(submit.status).toBe(201);
    const requestId = submit.body.request.id;

    // Not visible to TL under "pending" filter's confusion — should be there.
    const pendingQueue = await request(app)
      .get("/api/correction-requests?status=pending")
      .set("Authorization", `Bearer ${reviewerToken}`);
    expect(pendingQueue.body.requests.map((r: { id: string }) => r.id)).toContain(requestId);

    const decide = await request(app)
      .post(`/api/correction-requests/${requestId}/decide`)
      .set("Authorization", `Bearer ${reviewerToken}`)
      .send({ approve: true, note: "Confirmed with customer" });
    expect(decide.status).toBe(200);
    expect(decide.body.request.status).toBe("approved");

    const payment = await pool.query("SELECT amount FROM payments WHERE id = $1", [paymentId]);
    expect(Number(payment.rows[0].amount)).toBe(5500);
  });

  it("rejecting a request leaves the underlying record untouched", async () => {
    const submit = await request(app)
      .post("/api/correction-requests")
      .set("Authorization", `Bearer ${agentToken}`)
      .send({
        record_type: "call_log",
        record_id: callLogId,
        proposed_changes: { remark: "Corrected remark text" },
        reason: "original remark was garbled",
      });
    expect(submit.status).toBe(201);

    const decide = await request(app)
      .post(`/api/correction-requests/${submit.body.request.id}/decide`)
      .set("Authorization", `Bearer ${reviewerToken}`)
      .send({ approve: false, note: "Doesn't match the call recording" });
    expect(decide.status).toBe(200);
    expect(decide.body.request.status).toBe("rejected");

    const callLog = await pool.query("SELECT remark FROM call_logs WHERE id = $1", [callLogId]);
    expect(callLog.rows[0].remark).toBe("Customer said they would pay");
  });

  it("PTP promised_date correction applies on approval", async () => {
    const newDate = new Date();
    newDate.setDate(newDate.getDate() + 10);
    const newDateStr = newDate.toISOString().slice(0, 10);

    const submit = await request(app)
      .post("/api/correction-requests")
      .set("Authorization", `Bearer ${agentToken}`)
      .send({
        record_type: "ptp",
        record_id: ptpId,
        proposed_changes: { promised_date: newDateStr },
        reason: "customer asked to push the date",
      });
    expect(submit.status).toBe(201);

    await request(app)
      .post(`/api/correction-requests/${submit.body.request.id}/decide`)
      .set("Authorization", `Bearer ${reviewerToken}`)
      .send({ approve: true });

    const ptp = await pool.query("SELECT promised_date FROM ptps WHERE id = $1", [ptpId]);
    expect(new Date(ptp.rows[0].promised_date).toISOString().slice(0, 10)).toBe(newDateStr);
  });

  it("agent's GET only returns their own requests; TL sees the whole agency's queue", async () => {
    const agentView = await request(app)
      .get("/api/correction-requests?status=all")
      .set("Authorization", `Bearer ${agentToken}`);
    expect(agentView.status).toBe(200);
    expect(
      agentView.body.requests.every((r: { requested_by_id: string }) => r.requested_by_id === agentId),
    ).toBe(true);

    const tlView = await request(app)
      .get("/api/correction-requests?status=all")
      .set("Authorization", `Bearer ${reviewerToken}`);
    expect(tlView.body.requests.length).toBeGreaterThanOrEqual(agentView.body.requests.length);
  });

  it("a plain agent cannot decide a request (403)", async () => {
    const submit = await request(app)
      .post("/api/correction-requests")
      .set("Authorization", `Bearer ${agentToken}`)
      .send({
        record_type: "payment",
        record_id: paymentId,
        proposed_changes: { mode: "UPI" },
        reason: "wrong mode selected",
      });
    const res = await request(app)
      .post(`/api/correction-requests/${submit.body.request.id}/decide`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ approve: true });
    expect(res.status).toBe(403);
  });

  it("cannot decide an already-decided request", async () => {
    const submit = await request(app)
      .post("/api/correction-requests")
      .set("Authorization", `Bearer ${agentToken}`)
      .send({
        record_type: "payment",
        record_id: paymentId,
        proposed_changes: { mode: "NEFT" },
        reason: "wrong mode",
      });
    const requestId = submit.body.request.id;
    await request(app)
      .post(`/api/correction-requests/${requestId}/decide`)
      .set("Authorization", `Bearer ${reviewerToken}`)
      .send({ approve: true });

    const second = await request(app)
      .post(`/api/correction-requests/${requestId}/decide`)
      .set("Authorization", `Bearer ${reviewerToken}`)
      .send({ approve: false });
    expect(second.status).toBe(409);
  });

  it("customer record type: rejects a field other than address", async () => {
    const res = await request(app)
      .post("/api/correction-requests")
      .set("Authorization", `Bearer ${agentToken}`)
      .send({
        record_type: "customer",
        record_id: customerId,
        proposed_changes: { due_amount: 99999 },
        reason: "trying to change something other than address",
      });
    expect(res.status).toBe(400);
  });

  it("customer record type: an agent not assigned to the customer cannot request a correction (404)", async () => {
    const res = await request(app)
      .post("/api/correction-requests")
      .set("Authorization", `Bearer ${agent2Token}`)
      .send({
        record_type: "customer",
        record_id: customerId,
        proposed_changes: { address: "123 Someone Else's Street" },
        reason: "not my customer",
      });
    expect(res.status).toBe(404);
  });

  it("customer record type: an assigned agent's address correction applies customers.address on approval (N3)", async () => {
    const submit = await request(app)
      .post("/api/correction-requests")
      .set("Authorization", `Bearer ${agentToken}`)
      .send({
        record_type: "customer",
        record_id: customerId,
        proposed_changes: { address: "42 Corrected Lane, Pune" },
        reason: "lender file had a stale address, customer confirmed the new one",
      });
    expect(submit.status).toBe(201);
    const requestId = submit.body.request.id;

    // Appears in the existing Correction Requests queue alongside the other
    // record types (Phase 16's A: "appears in the existing... queue").
    const pendingQueue = await request(app)
      .get("/api/correction-requests?status=pending")
      .set("Authorization", `Bearer ${reviewerToken}`);
    const queued = pendingQueue.body.requests.find((r: { id: string }) => r.id === requestId);
    expect(queued).toBeDefined();
    expect(queued.record_type).toBe("customer");
    expect(queued.customer_id).toBe(customerId);

    const decide = await request(app)
      .post(`/api/correction-requests/${requestId}/decide`)
      .set("Authorization", `Bearer ${reviewerToken}`)
      .send({ approve: true, note: "Confirmed with customer directly" });
    expect(decide.status).toBe(200);
    expect(decide.body.request.status).toBe("approved");

    const customer = await pool.query("SELECT address FROM customers WHERE id = $1", [customerId]);
    expect(customer.rows[0].address).toBe("42 Corrected Lane, Pune");
  });

  it("field visit remark correction applies on approval", async () => {
    const submit = await request(app)
      .post("/api/correction-requests")
      .set("Authorization", `Bearer ${agentToken}`)
      .send({
        record_type: "field_visit",
        record_id: fieldVisitId,
        proposed_changes: { remark: "Neighbour confirmed they still live there" },
        reason: "original remark was incomplete",
      });
    expect(submit.status).toBe(201);

    const decide = await request(app)
      .post(`/api/correction-requests/${submit.body.request.id}/decide`)
      .set("Authorization", `Bearer ${reviewerToken}`)
      .send({ approve: true });
    expect(decide.status).toBe(200);

    const visit = await pool.query("SELECT remark FROM field_visits WHERE id = $1", [fieldVisitId]);
    expect(visit.rows[0].remark).toBe("Neighbour confirmed they still live there");
  });
});
