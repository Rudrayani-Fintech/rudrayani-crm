import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { pool } from "../src/config/db";
import { hashPassword } from "../src/services/auth-service";

/**
 * Phase 3 (Tasks 3.1-3.3) end-to-end: unallocated queue → TL assigns →
 * agent worklist → disposition with PTP → reminder due → payment with
 * photo proof → customer closed. Brief Sections 5, 6, 7, 8.
 */
const app = createApp();

const BM_PHONE = "7900000020";
const AGENT_PHONE = "7900000021";
const AGENT2_PHONE = "7900000022";
const PASSWORD = "Secret@123";

// Minimal valid 1x1 PNG for the photo-proof upload.
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

let agencyId: string;
let companyId: string;
let bmToken: string;
let agentToken: string;
let agentId: string;
let agent2Id: string;
let customerIds: string[] = [];
let ptpCodeId: string;
let rnrCodeId: string;
let ptpPromisedDate: string;
let paymentId: string;

async function login(phone: string): Promise<string> {
  const res = await request(app).post("/api/auth/login").send({ phone, password: PASSWORD });
  return res.body.access_token;
}

beforeAll(async () => {
  const agency = await pool.query(
    "INSERT INTO agencies (name) VALUES ('Workflow Test Agency') RETURNING id",
  );
  agencyId = agency.rows[0].id;

  const company = await pool.query(
    "INSERT INTO companies (agency_id, name) VALUES ($1, 'Test NBFC') RETURNING id",
    [agencyId],
  );
  companyId = company.rows[0].id;

  const hash = await hashPassword(PASSWORD);
  const bm = await pool.query(
    `INSERT INTO users (agency_id, full_name, phone, password_hash, designation)
     VALUES ($1, 'Flow BM', $2, $3, 'branch_manager') RETURNING id`,
    [agencyId, BM_PHONE, hash],
  );
  void bm;
  const agent = await pool.query(
    `INSERT INTO users (agency_id, full_name, phone, password_hash, is_telecaller, designation)
     VALUES ($1, 'Flow Agent', $2, $3, true, 'telecaller') RETURNING id`,
    [agencyId, AGENT_PHONE, hash],
  );
  agentId = agent.rows[0].id;
  const agent2 = await pool.query(
    `INSERT INTO users (agency_id, full_name, phone, password_hash, is_field_agent, designation)
     VALUES ($1, 'Flow Agent 2', $2, $3, true, 'field_agent') RETURNING id`,
    [agencyId, AGENT2_PHONE, hash],
  );
  agent2Id = agent2.rows[0].id;

  const customers = await pool.query(
    `INSERT INTO customers (company_id, loan_number, customer_name, mobile_number, product, bucket, due_amount)
     VALUES
       ($1, 'WF-001', 'Ramesh Kumar', '9811111111', 'Home Loan', 'B1', 250000),
       ($1, 'WF-002', 'Suresh Patil', '9822222222', 'Personal Loan', 'B2', 80000),
       ($1, 'WF-003', 'Mahesh Joshi', '9833333333', 'Home Loan', 'B1', 150000)
     RETURNING id`,
    [companyId],
  );
  customerIds = customers.rows.map((r) => r.id);

  const ptpCode = await pool.query(
    `INSERT INTO disposition_codes
       (agency_id, action_code, category, result_code, description, remark_template,
        needs_amount, needs_date, needs_mode)
     VALUES ($1, 'OC', 'PROMISE TO PAY', 'PTP', 'Promised to Pay',
             'Customer agree to make payment of <amount> by <Online payment mode> on <Date>',
             true, true, true)
     RETURNING id`,
    [agencyId],
  );
  ptpCodeId = ptpCode.rows[0].id;

  const rnrCode = await pool.query(
    `INSERT INTO disposition_codes (agency_id, action_code, category, result_code, description)
     VALUES ($1, 'OC', 'NO CONTACT', 'RNR', 'Ringing No Response') RETURNING id`,
    [agencyId],
  );
  rnrCodeId = rnrCode.rows[0].id;

  bmToken = await login(BM_PHONE);
  agentToken = await login(AGENT_PHONE);

  const promised = new Date();
  promised.setDate(promised.getDate() + 3);
  ptpPromisedDate = promised.toISOString().slice(0, 10);
});

afterAll(async () => {
  await pool.query(
    "DELETE FROM ptps WHERE customer_id IN (SELECT id FROM customers WHERE company_id = $1)",
    [companyId],
  );
  await pool.query(
    "DELETE FROM call_logs WHERE customer_id IN (SELECT id FROM customers WHERE company_id = $1)",
    [companyId],
  );
  await pool.query(
    "DELETE FROM payments WHERE customer_id IN (SELECT id FROM customers WHERE company_id = $1)",
    [companyId],
  );
  await pool.query(
    "DELETE FROM allocation_logs WHERE customer_id IN (SELECT id FROM customers WHERE company_id = $1)",
    [companyId],
  );
  await pool.query("DELETE FROM customers WHERE company_id = $1", [companyId]);
  await pool.query("DELETE FROM disposition_codes WHERE agency_id = $1", [agencyId]);
  await pool.query("DELETE FROM companies WHERE id = $1", [companyId]);
  await pool.query("DELETE FROM users WHERE agency_id = $1", [agencyId]);
  await pool.query("DELETE FROM agencies WHERE id = $1", [agencyId]);
  await pool.end();
});

describe("Task 3.1 — allocation", () => {
  it("TL sees the unallocated queue, filterable by product", async () => {
    const res = await request(app)
      .get("/api/allocations/unallocated")
      .set("Authorization", `Bearer ${bmToken}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);

    const filtered = await request(app)
      .get("/api/allocations/unallocated?product=Home Loan")
      .set("Authorization", `Bearer ${bmToken}`);
    expect(filtered.body.total).toBe(2);
  });

  it("telecaller cannot open the allocation queue (403)", async () => {
    const res = await request(app)
      .get("/api/allocations/unallocated")
      .set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(403);
  });

  it("TL multi-assigns two customers to the agent", async () => {
    const res = await request(app)
      .post("/api/allocations/assign")
      .set("Authorization", `Bearer ${bmToken}`)
      .send({ customer_ids: [customerIds[0], customerIds[1]], agent_id: agentId });
    expect(res.status).toBe(200);
    expect(res.body.assigned).toBe(2);

    const queue = await request(app)
      .get("/api/allocations/unallocated")
      .set("Authorization", `Bearer ${bmToken}`);
    expect(queue.body.total).toBe(1);

    const logs = await request(app)
      .get(`/api/allocations/logs?customer_id=${customerIds[0]}`)
      .set("Authorization", `Bearer ${bmToken}`);
    expect(logs.body.logs).toHaveLength(1);
    expect(logs.body.logs[0].from_agent_name).toBeNull();
    expect(logs.body.logs[0].to_agent_name).toBe("Flow Agent");
  });

  it("reallocation without a reason is rejected; with reason it is logged", async () => {
    const noReason = await request(app)
      .post("/api/allocations/assign")
      .set("Authorization", `Bearer ${bmToken}`)
      .send({ customer_ids: [customerIds[1]], agent_id: agent2Id });
    expect(noReason.status).toBe(400);

    const withReason = await request(app)
      .post("/api/allocations/assign")
      .set("Authorization", `Bearer ${bmToken}`)
      .send({
        customer_ids: [customerIds[1]],
        agent_id: agent2Id,
        reason: "Field visit needed",
      });
    expect(withReason.status).toBe(200);

    const logs = await request(app)
      .get(`/api/allocations/logs?customer_id=${customerIds[1]}`)
      .set("Authorization", `Bearer ${bmToken}`);
    expect(logs.body.logs).toHaveLength(2);
    expect(logs.body.logs[0].reason).toBe("Field visit needed");
    expect(logs.body.logs[0].from_agent_name).toBe("Flow Agent");
    expect(logs.body.logs[0].to_agent_name).toBe("Flow Agent 2");
  });
});

describe("Web access — GET /customers self-scoping", () => {
  it("a telecaller's GET /customers returns only their own assigned customer", async () => {
    const res = await request(app)
      .get("/api/customers")
      .set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
    expect(res.body.customers.map((c: { id: string }) => c.id)).toEqual([customerIds[0]]);
  });

  it("passing agent_id for another agent doesn't leak their customers", async () => {
    const res = await request(app)
      .get(`/api/customers?agent_id=${agent2Id}`)
      .set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
    expect(res.body.customers).toHaveLength(0); // the forced self-clamp wins over the requested filter
  });

  it("a TL (customers.allocate) still sees the whole agency's customer list", async () => {
    const res = await request(app)
      .get("/api/customers")
      .set("Authorization", `Bearer ${bmToken}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
  });
});

describe("Task 3.2 — worklist, dispositions, PTP", () => {
  it("agent worklist shows exactly their allocation", async () => {
    const res = await request(app)
      .get("/api/worklist")
      .set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1); // WF-002 was reallocated away
    expect(res.body.customers[0].loan_number).toBe("WF-001");
  });

  it("GET /worklist/:id returns a customer assigned to the caller", async () => {
    const res = await request(app)
      .get(`/api/worklist/${customerIds[0]}`)
      .set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
    expect(res.body.customer.loan_number).toBe("WF-001");
  });

  it("GET /worklist/:id 404s for a customer assigned to someone else", async () => {
    // WF-002 (customerIds[1]) was reallocated away from this agent above.
    const res = await request(app)
      .get(`/api/worklist/${customerIds[1]}`)
      .set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(404);
  });

  it("GET /worklist/:id 404s for a nonexistent id", async () => {
    const res = await request(app)
      .get("/api/worklist/00000000-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(404);
  });

  it("rejects a PTP disposition missing its required structured fields", async () => {
    const res = await request(app)
      .post("/api/call-logs")
      .set("Authorization", `Bearer ${agentToken}`)
      .send({
        customer_id: customerIds[0],
        disposition_code_id: ptpCodeId,
        fields: { amount: 5000 }, // date + mode missing
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("date");
    expect(res.body.error).toContain("mode");
  });

  it("logs a PTP disposition: composes the remark and opens a PTP record", async () => {
    const res = await request(app)
      .post("/api/call-logs")
      .set("Authorization", `Bearer ${agentToken}`)
      .send({
        customer_id: customerIds[0],
        disposition_code_id: ptpCodeId,
        fields: { amount: 5000, date: ptpPromisedDate, mode: "UPI" },
        call_duration_seconds: 145,
      });
    expect(res.status).toBe(201);
    expect(res.body.call_log.remark).toBe(
      `Customer agree to make payment of 5000 by UPI on ${ptpPromisedDate}`,
    );
    expect(res.body.ptp).not.toBeNull();
    expect(Number(res.body.ptp.amount)).toBe(5000);
    expect(res.body.ptp.status).toBe("pending");
  });

  it("a non-promise code does not create a PTP", async () => {
    const res = await request(app)
      .post("/api/call-logs")
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ customer_id: customerIds[0], disposition_code_id: rnrCodeId });
    expect(res.status).toBe(201);
    expect(res.body.ptp).toBeNull();
    expect(res.body.call_log.remark).toBe("Ringing No Response");
  });

  it("PTP shows in the reminders-due list on its promised date", async () => {
    const res = await request(app)
      .get(`/api/ptps/due?date=${ptpPromisedDate}`)
      .set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.ptps[0].loan_number).toBe("WF-001");
    expect(res.body.ptps[0].agent_name).toBe("Flow Agent");
  });

  it("GET /ptps lists a customer's PTPs; owning agent and TL can both see it", async () => {
    const asAgent = await request(app)
      .get(`/api/ptps?customer_id=${customerIds[0]}`)
      .set("Authorization", `Bearer ${agentToken}`);
    expect(asAgent.status).toBe(200);
    expect(asAgent.body.total).toBe(1);
    expect(asAgent.body.ptps[0].loan_number).toBe("WF-001");
    expect(asAgent.body.ptps[0].status).toBe("pending");

    const asTl = await request(app)
      .get(`/api/ptps?customer_id=${customerIds[0]}`)
      .set("Authorization", `Bearer ${bmToken}`);
    expect(asTl.status).toBe(200);
    expect(asTl.body.total).toBe(1);
  });

  it("GET /ptps clamps a non-allocate agent to their own/assigned customers", async () => {
    // customerIds[1] belongs to agent2, not agentToken's user
    const res = await request(app)
      .get(`/api/ptps?customer_id=${customerIds[1]}`)
      .set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
  });

  it("GET /ptps?status= filters by status", async () => {
    const res = await request(app)
      .get(`/api/ptps?customer_id=${customerIds[0]}&status=kept`)
      .set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
  });

  it("call history is visible for the customer", async () => {
    const res = await request(app)
      .get(`/api/call-logs?customer_id=${customerIds[0]}`)
      .set("Authorization", `Bearer ${bmToken}`);
    expect(res.status).toBe(200);
    expect(res.body.call_logs).toHaveLength(2);
  });
});

describe("Task 3.3 — payments and closure", () => {
  it("records a payment with photo proof and closes the customer", async () => {
    const res = await request(app)
      .post("/api/payments")
      .set("Authorization", `Bearer ${agentToken}`)
      .field("customer_id", customerIds[0])
      .field("amount", "5000")
      .field("mode", "UPI")
      .field("close_customer", "true")
      .attach("photo", PNG_1PX, { filename: "proof.png", contentType: "image/png" });
    expect(res.status).toBe(201);
    expect(res.body.customer_closed).toBe(true);
    paymentId = res.body.payment.id;

    // Closed customer leaves the agent's worklist
    const worklist = await request(app)
      .get("/api/worklist")
      .set("Authorization", `Bearer ${agentToken}`);
    expect(worklist.body.total).toBe(0);
  });

  it("payment history shows the photo flag; the photo streams back", async () => {
    const list = await request(app)
      .get(`/api/payments?customer_id=${customerIds[0]}`)
      .set("Authorization", `Bearer ${bmToken}`);
    expect(list.status).toBe(200);
    expect(list.body.payments).toHaveLength(1);
    expect(list.body.payments[0].has_photo).toBe(true);
    expect(list.body.payments[0].collected_by_name).toBe("Flow Agent");

    const photo = await request(app)
      .get(`/api/payments/${paymentId}/photo`)
      .set("Authorization", `Bearer ${bmToken}`);
    expect(photo.status).toBe(200);
    expect(photo.headers["content-type"]).toBe("image/png");
  });

  it("rejects a payment against a closed customer", async () => {
    const res = await request(app)
      .post("/api/payments")
      .set("Authorization", `Bearer ${agentToken}`)
      .field("customer_id", customerIds[0])
      .field("amount", "100");
    expect(res.status).toBe(400);
  });

  it("stamps exceeds_due_amount server-side, but never rejects the payment", async () => {
    // WF-003 (customerIds[2]) has due_amount 150000 and was never closed.
    const overDue = await request(app)
      .post("/api/payments")
      .set("Authorization", `Bearer ${agentToken}`)
      .field("customer_id", customerIds[2])
      .field("amount", "999999"); // way more than due_amount
    expect(overDue.status).toBe(201);
    expect(overDue.body.payment.exceeds_due_amount).toBe(true);

    const withinDue = await request(app)
      .post("/api/payments")
      .set("Authorization", `Bearer ${agentToken}`)
      .field("customer_id", customerIds[2])
      .field("amount", "1000");
    expect(withinDue.status).toBe(201);
    expect(withinDue.body.payment.exceeds_due_amount).toBe(false);
  });

  it("closed customer cannot receive new dispositions", async () => {
    const res = await request(app)
      .post("/api/call-logs")
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ customer_id: customerIds[0], disposition_code_id: rnrCodeId });
    expect(res.status).toBe(404);
  });
});
