import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { pool } from "../src/config/db";
import { hashPassword } from "../src/services/auth-service";
import { istToday } from "../src/utils/ist";
import { booleansForDesignation } from "../src/types/user";

/**
 * GET /api/reports/agent-activity: the "field_agent_1 contacted 20 Hero
 * customers today -- 5 PTP, 10 part paid, 10 paid in full" ledger question
 * (REVAMP-SPEC.md Phase 17, item 6). Regression coverage for a real bug
 * found via live E2E: `dateFor()`'s template has `{COL}` twice but used
 * `.replace()` (first-occurrence only), so any date-filtered call left a
 * literal `{COL}` in the generated SQL and 500'd -- exactly the request
 * shape the web Agent Daily Activity page sends by default. No test file
 * exercised this endpoint before, which is how it went unnoticed.
 */
const app = createApp();

const PASSWORD = "Secret@123";
const PHONES = {
  admin: "7982000001",
  agent: "7982000002",
  otherAgent: "7982000003",
};

let agencyId: string;
let companyId: string;
const userIds: Record<string, string> = {};
const tokens: Record<string, string> = {};
const customerIds: string[] = [];
let today: string;

async function login(phone: string): Promise<string> {
  const res = await request(app).post("/api/auth/login").send({ phone, password: PASSWORD });
  return res.body.access_token;
}

beforeAll(async () => {
  const agency = await pool.query(
    "INSERT INTO agencies (name) VALUES ('Agent Activity Test Agency') RETURNING id",
  );
  agencyId = agency.rows[0].id;

  const company = await pool.query(
    "INSERT INTO companies (agency_id, name) VALUES ($1, 'AA Hero Finance') RETURNING id",
    [agencyId],
  );
  companyId = company.rows[0].id;

  const hash = await hashPassword(PASSWORD);
  const mk = async (key: keyof typeof PHONES, designation: "agency_admin" | "telecaller") => {
    const flags = booleansForDesignation(designation);
    const { rows } = await pool.query(
      `INSERT INTO users (agency_id, full_name, phone, password_hash, designation, is_agency_admin, is_operations_manager, is_telecaller, is_field_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [
        agencyId,
        `AA ${key}`,
        PHONES[key],
        hash,
        designation,
        flags.is_agency_admin,
        flags.is_operations_manager,
        flags.is_telecaller,
        flags.is_field_agent,
      ],
    );
    userIds[key] = rows[0].id;
  };
  await mk("admin", "agency_admin");
  await mk("agent", "telecaller");
  await mk("otherAgent", "telecaller");

  for (const key of Object.keys(PHONES) as (keyof typeof PHONES)[]) {
    tokens[key] = await login(PHONES[key]);
  }

  today = istToday();

  const disposition = await pool.query(
    `INSERT INTO disposition_codes (agency_id, action_code, category, result_code, description)
     VALUES ($1, 'OC', 'PROMISE TO PAY', 'PTP', 'Promise to Pay') RETURNING id`,
    [agencyId],
  );
  const dispositionId = disposition.rows[0].id;

  for (let i = 0; i < 3; i++) {
    const cust = await pool.query(
      `INSERT INTO customers (company_id, loan_number, customer_name, mobile_number, product, bucket, due_amount, assigned_agent_id)
       VALUES ($1, $2, $3, '9800000000', 'Hero Two-Wheeler Loan', 'Current', 5000, $4)
       RETURNING id`,
      [companyId, `AA-${i}`, `AA Customer ${i}`, userIds.agent],
    );
    customerIds.push(cust.rows[0].id);
  }

  // Customer 0: call + PTP today.
  const callLog = await pool.query(
    `INSERT INTO call_logs (customer_id, agent_id, disposition_code_id, remark)
     VALUES ($1, $2, $3, 'will pay Friday') RETURNING id`,
    [customerIds[0], userIds.agent, dispositionId],
  );
  await pool.query(
    `INSERT INTO ptps (customer_id, call_log_id, agent_id, amount, promised_date, status)
     VALUES ($1, $2, $3, 5000, $4, 'pending')`,
    [customerIds[0], callLog.rows[0].id, userIds.agent, today],
  );

  // Customer 1: payment today (part payment).
  await pool.query(
    `INSERT INTO payments (customer_id, collected_by_user_id, amount, mode, type)
     VALUES ($1, $2, 2000, 'Cash', 'emi')`,
    [customerIds[1], userIds.agent],
  );

  // Customer 2: field visit today, logged by a DIFFERENT agent -- must not
  // appear when we ask for only userIds.agent's activity.
  await pool.query(
    `INSERT INTO field_visits (customer_id, agent_id, remark)
     VALUES ($1, $2, 'visited, promised to pay')`,
    [customerIds[2], userIds.otherAgent],
  );
});

afterAll(async () => {
  await pool.query(
    "DELETE FROM field_visits WHERE customer_id = ANY($1)",
    [customerIds],
  );
  await pool.query("DELETE FROM ptps WHERE customer_id = ANY($1)", [customerIds]);
  await pool.query("DELETE FROM payments WHERE customer_id = ANY($1)", [customerIds]);
  await pool.query("DELETE FROM call_logs WHERE customer_id = ANY($1)", [customerIds]);
  await pool.query("DELETE FROM customers WHERE id = ANY($1)", [customerIds]);
  await pool.query("DELETE FROM disposition_codes WHERE agency_id = $1", [agencyId]);
  await pool.query("DELETE FROM companies WHERE id = $1", [companyId]);
  await pool.query("DELETE FROM users WHERE agency_id = $1", [agencyId]);
  await pool.query("DELETE FROM agencies WHERE id = $1", [agencyId]);
  await pool.end();
});

describe("GET /api/reports/agent-activity", () => {
  it("with an explicit date filter (the web page's default request shape), returns 200 not 500", async () => {
    const res = await request(app)
      .get(`/api/reports/agent-activity?date=${today}&agent_id=${userIds.agent}`)
      .set("Authorization", `Bearer ${tokens.admin}`);
    expect(res.status).toBe(200);
  });

  it("returns exactly this agent's call, PTP and payment for today -- not the other agent's visit", async () => {
    const res = await request(app)
      .get(`/api/reports/agent-activity?date=${today}&agent_id=${userIds.agent}&limit=50`)
      .set("Authorization", `Bearer ${tokens.admin}`);
    expect(res.status).toBe(200);
    expect(Number(res.body.total_count)).toBe(3);
    const kinds = res.body.activity.map((a: { kind: string }) => a.kind).sort();
    expect(kinds).toEqual(["call", "payment", "ptp"]);
    const customerNames = res.body.activity.map((a: { customer_name: string }) => a.customer_name);
    expect(customerNames).not.toContain("AA Customer 2");
  });

  it("browse=all (admin/ops) rolls up every agent's activity, filterable by product -- the owner's ledger question", async () => {
    const res = await request(app)
      .get(`/api/reports/agent-activity?date=${today}&browse=all&product=Hero%20Two-Wheeler%20Loan&limit=50`)
      .set("Authorization", `Bearer ${tokens.admin}`);
    expect(res.status).toBe(200);
    expect(Number(res.body.total_count)).toBe(4); // agent's 3 + otherAgent's 1 field visit
    const ptpCount = res.body.activity.filter((a: { kind: string }) => a.kind === "ptp").length;
    const paymentCount = res.body.activity.filter((a: { kind: string }) => a.kind === "payment").length;
    expect(ptpCount).toBe(1);
    expect(paymentCount).toBe(1);
  });

  it("action_type filter narrows to just PTPs", async () => {
    const res = await request(app)
      .get(`/api/reports/agent-activity?date=${today}&agent_id=${userIds.agent}&action_type=ptp`)
      .set("Authorization", `Bearer ${tokens.admin}`);
    expect(res.status).toBe(200);
    expect(Number(res.body.total_count)).toBe(1);
    expect(res.body.activity[0].kind).toBe("ptp");
  });

  it("a plain agent cannot browse another agent's activity", async () => {
    const res = await request(app)
      .get(`/api/reports/agent-activity?date=${today}&agent_id=${userIds.otherAgent}`)
      .set("Authorization", `Bearer ${tokens.agent}`);
    expect(res.status).toBe(403);
  });
});
