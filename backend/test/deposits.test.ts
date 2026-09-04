import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { pool } from "../src/config/db";
import { hashPassword } from "../src/services/auth-service";

/** Task 5.4: deposit reconciliation — pending vs deposited payments. */
const app = createApp();

const PASSWORD = "Secret@123";
const ADMIN_PHONE = "7940000010";
const AGENT_PHONE = "7940000011";

let agencyId: string;
let otherAgencyId: string;
let companyId: string;
let customerId: string;
let agentId: string;
let adminToken: string;
let agentToken: string;
let paymentIds: string[] = [];
let foreignPaymentId: string;

async function login(phone: string): Promise<string> {
  const res = await request(app).post("/api/auth/login").send({ phone, password: PASSWORD });
  return res.body.access_token;
}

beforeAll(async () => {
  const agency = await pool.query(
    "INSERT INTO agencies (name) VALUES ('Deposits Agency') RETURNING id",
  );
  agencyId = agency.rows[0].id;
  const otherAgency = await pool.query(
    "INSERT INTO agencies (name) VALUES ('Deposits Foreign Agency') RETURNING id",
  );
  otherAgencyId = otherAgency.rows[0].id;

  const company = await pool.query(
    "INSERT INTO companies (agency_id, name) VALUES ($1, 'Deposits NBFC') RETURNING id",
    [agencyId],
  );
  companyId = company.rows[0].id;
  const foreignCompany = await pool.query(
    "INSERT INTO companies (agency_id, name) VALUES ($1, 'Deposits Foreign NBFC') RETURNING id",
    [otherAgencyId],
  );

  const hash = await hashPassword(PASSWORD);
  await pool.query(
    `INSERT INTO users (agency_id, full_name, phone, password_hash, is_agency_admin, designation)
     VALUES ($1, 'Deposits Admin', $2, $3, true, 'agency_admin')`,
    [agencyId, ADMIN_PHONE, hash],
  );
  const agent = await pool.query(
    `INSERT INTO users (agency_id, full_name, phone, password_hash, is_field_agent, designation)
     VALUES ($1, 'Deposits Agent', $2, $3, true, 'field_agent') RETURNING id`,
    [agencyId, AGENT_PHONE, hash],
  );
  agentId = agent.rows[0].id;
  const foreignAgent = await pool.query(
    `INSERT INTO users (agency_id, full_name, phone, password_hash, is_field_agent, designation)
     VALUES ($1, 'Foreign Agent', '7940000012', $2, true, 'field_agent') RETURNING id`,
    [otherAgencyId, hash],
  );

  const customer = await pool.query(
    `INSERT INTO customers (company_id, loan_number, customer_name, due_amount)
     VALUES ($1, 'DEP-001', 'Deposit Kumar', 50000) RETURNING id`,
    [companyId],
  );
  customerId = customer.rows[0].id;
  const foreignCustomer = await pool.query(
    `INSERT INTO customers (company_id, loan_number, customer_name, due_amount)
     VALUES ($1, 'DEP-F01', 'Foreign Kumar', 50000) RETURNING id`,
    [foreignCompany.rows[0].id],
  );

  const payments = await pool.query(
    `INSERT INTO payments (customer_id, collected_by_user_id, amount, mode)
     VALUES ($1, $2, 5000, 'cash'), ($1, $2, 3000, 'upi'), ($1, $2, 2000, 'cash')
     RETURNING id`,
    [customerId, agentId],
  );
  paymentIds = payments.rows.map((r) => r.id as string);
  const foreignPayment = await pool.query(
    `INSERT INTO payments (customer_id, collected_by_user_id, amount, mode)
     VALUES ($1, $2, 9000, 'cash') RETURNING id`,
    [foreignCustomer.rows[0].id, foreignAgent.rows[0].id],
  );
  foreignPaymentId = foreignPayment.rows[0].id;

  adminToken = await login(ADMIN_PHONE);
  agentToken = await login(AGENT_PHONE);
});

afterAll(async () => {
  await pool.query(
    `DELETE FROM payments WHERE customer_id IN
       (SELECT id FROM customers WHERE company_id IN
         (SELECT id FROM companies WHERE agency_id IN ($1, $2)))`,
    [agencyId, otherAgencyId],
  );
  await pool.query(
    `DELETE FROM customers WHERE company_id IN
       (SELECT id FROM companies WHERE agency_id IN ($1, $2))`,
    [agencyId, otherAgencyId],
  );
  await pool.query("DELETE FROM companies WHERE agency_id IN ($1, $2)", [
    agencyId,
    otherAgencyId,
  ]);
  // audit_logs.actor_id has no ON DELETE CASCADE -- clear it before deleting
  // the users it references.
  await pool.query("DELETE FROM audit_logs WHERE agency_id IN ($1, $2)", [agencyId, otherAgencyId]);
  await pool.query("DELETE FROM users WHERE agency_id IN ($1, $2)", [agencyId, otherAgencyId]);
  await pool.query("DELETE FROM agencies WHERE id IN ($1, $2)", [agencyId, otherAgencyId]);
  await pool.end();
});

describe("deposit reconciliation", () => {
  it("lists pending payments for the agency", async () => {
    const res = await request(app)
      .get("/api/payments/deposits?deposited=false")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const ids = res.body.payments.map((p: { id: string }) => p.id);
    for (const id of paymentIds) expect(ids).toContain(id);
    expect(ids).not.toContain(foreignPaymentId); // agency-scoped
  });

  it("marks selected payments deposited; foreign and repeated ids are ignored", async () => {
    const res = await request(app)
      .patch("/api/payments/mark-deposited")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ payment_ids: [paymentIds[0], paymentIds[1], foreignPaymentId] });
    expect(res.status).toBe(200);
    expect(res.body.marked).toBe(2); // foreign one skipped

    const again = await request(app)
      .patch("/api/payments/mark-deposited")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ payment_ids: [paymentIds[0]] });
    expect(again.body.marked).toBe(0); // idempotent

    const foreign = await pool.query("SELECT deposited_at FROM payments WHERE id = $1", [
      foreignPaymentId,
    ]);
    expect(foreign.rows[0].deposited_at).toBeNull();
  });

  it("deposited filter reflects the marks", async () => {
    const deposited = await request(app)
      .get("/api/payments/deposits?deposited=true")
      .set("Authorization", `Bearer ${adminToken}`);
    const ids = deposited.body.payments.map((p: { id: string }) => p.id);
    expect(ids).toContain(paymentIds[0]);
    expect(ids).toContain(paymentIds[1]);
    expect(ids).not.toContain(paymentIds[2]);
    expect(deposited.body.payments[0].deposited_by_name).toBe("Deposits Admin");
  });

  it("agents cannot list or mark deposits", async () => {
    const list = await request(app)
      .get("/api/payments/deposits")
      .set("Authorization", `Bearer ${agentToken}`);
    expect(list.status).toBe(403);
    const mark = await request(app)
      .patch("/api/payments/mark-deposited")
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ payment_ids: [paymentIds[2]] });
    expect(mark.status).toBe(403);
  });
});
