import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { pool } from "../src/config/db";
import { hashPassword } from "../src/services/auth-service";

/**
 * Task 7.4: customer 360 view. Identity + the source columns the agency chose
 * to keep as "detail" fields, plus trail/PTP/payment/allocation/snapshot
 * history. Agents without customers.allocate may only open THEIR OWN
 * assigned customers -- everyone else in scope (TL and up) sees any.
 */
const app = createApp();

const PASSWORD = "Secret@123";
const ADMIN_PHONE = "7940000090";
const BM_PHONE = "7940000091";
const AGENT_PHONE = "7940000092";
const OTHER_AGENT_PHONE = "7940000093";

let agencyId: string;
let companyId: string;
let branchId: string;
let teamId: string;
let agentId: string;
let custAssignedId: string;
let custUnassignedId: string;
let adminToken: string;
let bmToken: string;
let agentToken: string;

beforeAll(async () => {
  const agency = await pool.query(
    "INSERT INTO agencies (name) VALUES ('Customer Detail Agency') RETURNING id",
  );
  agencyId = agency.rows[0].id;
  const company = await pool.query(
    "INSERT INTO companies (agency_id, name) VALUES ($1, 'Detail NBFC') RETURNING id",
    [agencyId],
  );
  companyId = company.rows[0].id;
  const branch = await pool.query(
    "INSERT INTO branches (agency_id, name) VALUES ($1, 'Detail Branch') RETURNING id",
    [agencyId],
  );
  branchId = branch.rows[0].id;
  const team = await pool.query(
    "INSERT INTO teams (branch_id, name) VALUES ($1, 'Detail Team') RETURNING id",
    [branchId],
  );
  teamId = team.rows[0].id;

  const hash = await hashPassword(PASSWORD);
  await pool.query(
    `INSERT INTO users (agency_id, full_name, phone, password_hash, is_agency_admin, designation)
     VALUES ($1, 'Detail Admin', $2, $3, true, 'agency_admin')`,
    [agencyId, ADMIN_PHONE, hash],
  );
  await pool.query(
    `INSERT INTO users (agency_id, full_name, phone, password_hash, designation)
     VALUES ($1, 'Detail BM', $2, $3, 'branch_manager')`,
    [agencyId, BM_PHONE, hash],
  );
  const agent = await pool.query(
    `INSERT INTO users (agency_id, full_name, phone, password_hash, is_telecaller, team_id, designation)
     VALUES ($1, 'Detail Agent', $2, $3, true, $4, 'telecaller') RETURNING id`,
    [agencyId, AGENT_PHONE, hash, teamId],
  );
  agentId = agent.rows[0].id;
  await pool.query(
    `INSERT INTO users (agency_id, full_name, phone, password_hash, is_telecaller, team_id, designation)
     VALUES ($1, 'Other Agent', $2, $3, true, $4, 'telecaller')`,
    [agencyId, OTHER_AGENT_PHONE, hash, teamId],
  );

  const custAssigned = await pool.query(
    `INSERT INTO customers (company_id, loan_number, customer_name, bucket, due_amount, emi,
                             assigned_agent_id, custom_fields)
     VALUES ($1, 'DET-001', 'Assigned Customer', '30', 10000, 500, $2, $3::jsonb)
     RETURNING id`,
    [companyId, agentId, JSON.stringify({ branch: "Mumbai Central", state_name: "Maharashtra", extra_col: "" })],
  );
  custAssignedId = custAssigned.rows[0].id;

  const custUnassigned = await pool.query(
    `INSERT INTO customers (company_id, loan_number, customer_name, bucket, due_amount, emi)
     VALUES ($1, 'DET-002', 'Unassigned Customer', '60', 20000, 1000)
     RETURNING id`,
    [companyId],
  );
  custUnassignedId = custUnassigned.rows[0].id;

  // Template with detail_fields, so the 360 view knows which custom_fields to surface.
  await pool.query(
    `INSERT INTO import_templates (company_id, name, column_mapping, detail_fields, version, is_active)
     VALUES ($1, 'Standard Ledger', '{}'::jsonb, $2::jsonb, 1, true)`,
    [companyId, JSON.stringify(["branch", "state_name", "extra_col"])],
  );

  // Trail/PTP/payment/allocation/snapshot history for the assigned customer.
  const callLog = await pool.query(
    `INSERT INTO call_logs (customer_id, agent_id, remark)
     VALUES ($1, $2, 'Customer will pay next week') RETURNING id`,
    [custAssignedId, agentId],
  );
  await pool.query(
    `INSERT INTO ptps (customer_id, call_log_id, agent_id, amount, promised_date, status)
     VALUES ($1, $2, $3, 5000, '2026-08-01', 'pending')`,
    [custAssignedId, callLog.rows[0].id, agentId],
  );
  await pool.query(
    `INSERT INTO payments (customer_id, collected_by_user_id, amount, mode) VALUES ($1, $2, 5000, 'cash')`,
    [custAssignedId, agentId],
  );
  await pool.query(
    `INSERT INTO allocation_logs (customer_id, from_agent_id, to_agent_id, allocated_by, reason)
     VALUES ($1, NULL, $2, $3, 'Assigned by import')`,
    [custAssignedId, agentId, agentId],
  );
  await pool.query(
    `INSERT INTO customer_month_snapshots (customer_id, company_id, month, bucket, due_amount, emi)
     VALUES ($1, $2, '2026-07-01', '30', 10000, 500)`,
    [custAssignedId, companyId],
  );
  await pool.query(
    `INSERT INTO field_visits (customer_id, agent_id, remark, photo_url)
     VALUES ($1, $2, 'Visited residence, met spouse', 'visits/fake-key.jpg')`,
    [custAssignedId, agentId],
  );
  await pool.query(
    `INSERT INTO attachments (agency_id, customer_id, uploaded_by, kind, file_key, file_name, mime_type, size_bytes)
     VALUES ($1, $2, $3, 'document', 'attachments/fake-key.pdf', 'agreement.pdf', 'application/pdf', 1024)`,
    [agencyId, custAssignedId, agentId],
  );

  const [adminLogin, bmLogin, agentLogin] = await Promise.all([
    request(app).post("/api/auth/login").send({ phone: ADMIN_PHONE, password: PASSWORD }),
    request(app).post("/api/auth/login").send({ phone: BM_PHONE, password: PASSWORD }),
    request(app).post("/api/auth/login").send({ phone: AGENT_PHONE, password: PASSWORD }),
  ]);
  adminToken = adminLogin.body.access_token;
  bmToken = bmLogin.body.access_token;
  agentToken = agentLogin.body.access_token;
});

afterAll(async () => {
  await pool.query(
    `DELETE FROM attachments WHERE customer_id IN (SELECT id FROM customers WHERE company_id = $1)`,
    [companyId],
  );
  await pool.query(
    `DELETE FROM field_visits WHERE customer_id IN (SELECT id FROM customers WHERE company_id = $1)`,
    [companyId],
  );
  await pool.query(`DELETE FROM customer_month_snapshots WHERE company_id = $1`, [companyId]);
  await pool.query(
    `DELETE FROM allocation_logs WHERE customer_id IN (SELECT id FROM customers WHERE company_id = $1)`,
    [companyId],
  );
  await pool.query(
    `DELETE FROM payments WHERE customer_id IN (SELECT id FROM customers WHERE company_id = $1)`,
    [companyId],
  );
  await pool.query(
    `DELETE FROM ptps WHERE customer_id IN (SELECT id FROM customers WHERE company_id = $1)`,
    [companyId],
  );
  await pool.query(
    `DELETE FROM call_logs WHERE customer_id IN (SELECT id FROM customers WHERE company_id = $1)`,
    [companyId],
  );
  await pool.query(`DELETE FROM import_templates WHERE company_id = $1`, [companyId]);
  await pool.query("DELETE FROM customers WHERE company_id = $1", [companyId]);
  await pool.query("DELETE FROM companies WHERE id = $1", [companyId]);
  await pool.query("DELETE FROM users WHERE agency_id = $1", [agencyId]);
  await pool.query("DELETE FROM teams WHERE id = $1", [teamId]);
  await pool.query("DELETE FROM branches WHERE id = $1", [branchId]);
  await pool.query("DELETE FROM agencies WHERE id = $1", [agencyId]);
  await pool.end();
});

describe("customer 360 view: scope", () => {
  it("an agent can open their own assigned customer", async () => {
    const res = await request(app)
      .get(`/api/customers/${custAssignedId}`)
      .set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
    expect(res.body.customer.loan_number).toBe("DET-001");
  });

  it("an agent gets 404 (not 403) for a customer not assigned to them", async () => {
    const res = await request(app)
      .get(`/api/customers/${custUnassignedId}`)
      .set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(404);
  });

  it("a branch manager (holds customers.allocate) can open any customer in the agency", async () => {
    const res = await request(app)
      .get(`/api/customers/${custUnassignedId}`)
      .set("Authorization", `Bearer ${bmToken}`);
    expect(res.status).toBe(200);
    expect(res.body.customer.loan_number).toBe("DET-002");
  });
});

describe("customer 360 view: shape and history", () => {
  it("returns detail_fields from the company's active template, and history from every source", async () => {
    const res = await request(app)
      .get(`/api/customers/${custAssignedId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);

    expect(res.body.company_name).toBe("Detail NBFC");
    expect(res.body.detail_fields).toEqual(["branch", "state_name", "extra_col"]);
    expect(res.body.customer.custom_fields.branch).toBe("Mumbai Central");
    expect(res.body.customer.custom_fields.extra_col).toBe(""); // present but empty -- frontend renders "-"

    expect(res.body.trail).toHaveLength(1);
    expect(res.body.trail[0].remark).toBe("Customer will pay next week");

    expect(res.body.ptps).toHaveLength(1);
    expect(Number(res.body.ptps[0].amount)).toBe(5000);

    expect(res.body.payments).toHaveLength(1);
    expect(Number(res.body.payments[0].amount)).toBe(5000);

    expect(res.body.allocation_history).toHaveLength(1);
    expect(res.body.allocation_history[0].to_agent_name).toBe("Detail Agent");

    expect(res.body.snapshots).toHaveLength(1);
    expect(res.body.snapshots[0].bucket).toBe("30");

    expect(res.body.bucket_movements).toEqual([]); // none recorded yet (Task 7.5)

    expect(res.body.field_visits).toHaveLength(1);
    expect(res.body.field_visits[0].remark).toBe("Visited residence, met spouse");
    expect(res.body.field_visits[0].has_photo).toBe(true);
    expect(res.body.field_visits[0].agent_name).toBe("Detail Agent");

    expect(res.body.attachments).toHaveLength(1);
    expect(res.body.attachments[0].file_name).toBe("agreement.pdf");
    expect(res.body.attachments[0].kind).toBe("document");
    expect(res.body.attachments[0].uploaded_by_name).toBe("Detail Agent");
  });

  it("a customer with no history returns empty arrays, not an error", async () => {
    const res = await request(app)
      .get(`/api/customers/${custUnassignedId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.trail).toEqual([]);
    expect(res.body.ptps).toEqual([]);
    expect(res.body.payments).toEqual([]);
    expect(res.body.allocation_history).toEqual([]);
    expect(res.body.snapshots).toEqual([]);
    expect(res.body.field_visits).toEqual([]);
    expect(res.body.attachments).toEqual([]);
  });

  it("a nonexistent or cross-agency customer id is a 404", async () => {
    const res = await request(app)
      .get(`/api/customers/00000000-0000-0000-0000-000000000000`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });
});
