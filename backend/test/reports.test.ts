import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { pool } from "../src/config/db";
import { hashPassword } from "../src/services/auth-service";
import { monthDays } from "../src/services/report-service";

/**
 * Task 5.5: report engine. Seeds May+June 2026 snapshots so May is classified
 * on bucket TRANSITIONS while June (no July file) falls back to the
 * payments-based proxies. Buckets: Current(0, current) < X(1) < 30(2) <
 * 60(3) < NPA(4, npa).
 */
const app = createApp();

const PASSWORD = "Secret@123";
const ADMIN_PHONE = "7950000020";
const BM_PHONE = "7950000021";
const AGENT_PHONE = "7950000022";
const AGENT2_PHONE = "7950000023";

let agencyId: string;
let companyId: string;
let branchId: string;
let teamId: string;
let team2Id: string;
let otherBranchId: string;
let agentId: string;
let agent2Id: string;
let adminToken: string;
let bmToken: string;
let agentToken: string;
const customerIds: Record<string, string> = {};

const MAY = "2026-05-01";
const JUNE = "2026-06-01";

async function login(phone: string): Promise<string> {
  const res = await request(app).post("/api/auth/login").send({ phone, password: PASSWORD });
  return res.body.access_token;
}

async function snapshot(
  loan: string,
  month: string,
  bucket: string,
  pos: number,
  emi: number,
  agent: string,
  team: string,
  // Owner feedback round, Phase 2: real principal-outstanding value for the
  // new customer_month_snapshots.pos column, separate from due_amount ($4,
  // the misleadingly-named "pos" param above -- kept as-is to avoid touching
  // every existing call site). Defaults to the same number as due_amount so
  // pre-existing allocated/resolution/rollback/normalization amount
  // assertions (all keyed off due_amount historically) stay numerically
  // unchanged now that those aggregates read SUM(pos) instead.
  posAmount: number = pos,
) {
  await pool.query(
    `INSERT INTO customer_month_snapshots
       (customer_id, company_id, month, bucket, due_amount, pos, emi, product,
        assigned_team_id, assigned_agent_id)
     SELECT id, company_id, $2, $3, $4, $5, $6, product, $7, $8 FROM customers WHERE id = $1`,
    [customerIds[loan], month, bucket, pos, posAmount, emi, team, agent],
  );
}

/** A payment timestamped inside the given IST day. */
async function pay(loan: string, amount: number, istDate: string, byUser: string, deposited = false) {
  await pool.query(
    `INSERT INTO payments (customer_id, collected_by_user_id, amount, paid_at,
                           deposited_at, deposited_by_user_id)
     VALUES ($1, $2, $3, ($4::timestamp AT TIME ZONE 'Asia/Kolkata'),
             CASE WHEN $5 THEN now() END, CASE WHEN $5 THEN $2::uuid END)`,
    [customerIds[loan], byUser, amount, `${istDate} 12:00:00`, deposited],
  );
}

beforeAll(async () => {
  const agency = await pool.query(
    "INSERT INTO agencies (name) VALUES ('Reports Agency') RETURNING id",
  );
  agencyId = agency.rows[0].id;
  const company = await pool.query(
    "INSERT INTO companies (agency_id, name) VALUES ($1, 'Reports NBFC') RETURNING id",
    [agencyId],
  );
  companyId = company.rows[0].id;
  const branch = await pool.query(
    "INSERT INTO branches (agency_id, name) VALUES ($1, 'Reports Branch') RETURNING id",
    [agencyId],
  );
  branchId = branch.rows[0].id;
  const team = await pool.query(
    "INSERT INTO teams (branch_id, name) VALUES ($1, 'Reports Team A') RETURNING id",
    [branchId],
  );
  teamId = team.rows[0].id;
  const team2 = await pool.query(
    "INSERT INTO teams (branch_id, name) VALUES ($1, 'Reports Team B') RETURNING id",
    [branchId],
  );
  team2Id = team2.rows[0].id;

  const hash = await hashPassword(PASSWORD);
  await pool.query(
    `INSERT INTO users (agency_id, full_name, phone, password_hash, is_agency_admin, designation)
     VALUES ($1, 'Reports Admin', $2, $3, true, 'agency_admin')`,
    [agencyId, ADMIN_PHONE, hash],
  );
  const bm = await pool.query(
    `INSERT INTO users (agency_id, full_name, phone, password_hash, designation)
     VALUES ($1, 'Reports BM', $2, $3, 'branch_manager') RETURNING id`,
    [agencyId, BM_PHONE, hash],
  );
  await pool.query("UPDATE branches SET branch_manager_id = $1 WHERE id = $2", [
    bm.rows[0].id,
    branchId,
  ]);
  const otherBranch = await pool.query(
    "INSERT INTO branches (agency_id, name) VALUES ($1, 'Reports Other Branch') RETURNING id",
    [agencyId],
  );
  otherBranchId = otherBranch.rows[0].id;
  const agent = await pool.query(
    `INSERT INTO users (agency_id, branch_id, team_id, full_name, phone, password_hash, is_field_agent, designation)
     VALUES ($1, $2, $3, 'Reports Agent One', $4, $5, true, 'field_agent') RETURNING id`,
    [agencyId, branchId, teamId, AGENT_PHONE, hash],
  );
  agentId = agent.rows[0].id;
  const agent2 = await pool.query(
    `INSERT INTO users (agency_id, branch_id, team_id, full_name, phone, password_hash, is_field_agent, designation)
     VALUES ($1, $2, $3, 'Reports Agent Two', $4, $5, true, 'field_agent') RETURNING id`,
    [agencyId, branchId, team2Id, AGENT2_PHONE, hash],
  );
  agent2Id = agent2.rows[0].id;

  // Buckets master with explicit ordering + flags
  const bucketDefs: [string, number, string, boolean][] = [
    ["Current", 0, "normal", true],
    ["X", 1, "normal", false],
    ["30", 2, "normal", false],
    ["60", 3, "normal", false],
    ["NPA", 4, "npa", false],
  ];
  for (const [label, order, category, isCurrent] of bucketDefs) {
    await pool.query(
      `INSERT INTO buckets (company_id, label, sort_order, category, is_current)
       VALUES ($1, $2, $3, $4, $5)`,
      [companyId, label, order, category, isCurrent],
    );
  }

  // Customers (product CVL except RPT-05 = LPL)
  const defs: [string, string][] = [
    ["RPT-01", "CVL"],
    ["RPT-02", "CVL"],
    ["RPT-03", "CVL"],
    ["RPT-04", "CVL"],
    ["RPT-05", "LPL"],
    ["RPT-06", "CVL"],
  ];
  for (const [loan, product] of defs) {
    const { rows } = await pool.query(
      `INSERT INTO customers (company_id, loan_number, customer_name, product, due_amount, emi)
       VALUES ($1, $2, $2, $3, 1, 1) RETURNING id`,
      [companyId, loan, product],
    );
    customerIds[loan] = rows[0].id;
    await pool.query(
      `INSERT INTO products (company_id, raw_label, canonical_label)
       VALUES ($1, $2, $2) ON CONFLICT DO NOTHING`,
      [companyId, product],
    );
  }

  // ── MAY (transition basis: June file exists) ─────────────────────────────
  // RPT-01: 30 -> Current  = normalized (and resolved: didn't flow forward)
  // RPT-02: 60 -> 30       = rolled back (and resolved)
  // RPT-03: 30 -> 60       = flowed forward (nothing)
  // RPT-04: 30 -> 30       = held (resolved only)
  // RPT-05: NPA -> NPA     = recovery base; payment in May = recovery MTD
  // RPT-06: 30 -> (absent) = dropped from June file: excluded from resolution
  await snapshot("RPT-01", MAY, "30", 100000, 5000, agentId, teamId);
  await snapshot("RPT-02", MAY, "60", 200000, 8000, agentId, teamId);
  await snapshot("RPT-03", MAY, "30", 150000, 6000, agent2Id, team2Id);
  await snapshot("RPT-04", MAY, "30", 120000, 5000, agent2Id, team2Id);
  await snapshot("RPT-05", MAY, "NPA", 300000, 0, agentId, teamId);
  await snapshot("RPT-06", MAY, "30", 80000, 4000, agentId, teamId);

  await snapshot("RPT-01", JUNE, "Current", 95000, 5000, agentId, teamId);
  await snapshot("RPT-02", JUNE, "30", 190000, 8000, agentId, teamId);
  await snapshot("RPT-03", JUNE, "60", 155000, 6000, agent2Id, team2Id);
  await snapshot("RPT-04", JUNE, "30", 118000, 5000, agent2Id, team2Id);
  await snapshot("RPT-05", JUNE, "NPA", 290000, 0, agentId, teamId);

  // May money: recovery payment on the NPA loan + a normal one (deposited)
  await pay("RPT-05", 10000, "2026-05-10", agentId);
  await pay("RPT-01", 5000, "2026-05-12", agentId, true);
  // IST edge: 2026-05-31 23:30 IST is still May
  await pay("RPT-02", 8000, "2026-05-31", agentId);

  // ── JUNE (payments basis: no July file) ──────────────────────────────────
  // RPT-01 pays its full arrears -> normalized; RPT-02 pays exactly one EMI
  // -> resolved+rolled back; RPT-03 pays less than an EMI -> nothing.
  await pay("RPT-01", 95000, "2026-06-05", agentId, true);
  await pay("RPT-02", 8000, "2026-06-08", agentId);
  await pay("RPT-03", 1000, "2026-06-09", agent2Id);

  // Trail: one call log for RPT-01 in May (IST)
  await pool.query(
    `INSERT INTO call_logs (customer_id, agent_id, remark, created_at)
     VALUES ($1, $2, 'test call', ('2026-05-15 10:00:00'::timestamp AT TIME ZONE 'Asia/Kolkata'))`,
    [customerIds["RPT-01"], agentId],
  );

  adminToken = await login(ADMIN_PHONE);
  bmToken = await login(BM_PHONE);
  agentToken = await login(AGENT_PHONE);
});

afterAll(async () => {
  await pool.query("DELETE FROM customer_month_snapshots WHERE company_id = $1", [companyId]);
  await pool.query(
    `DELETE FROM call_logs WHERE customer_id IN (SELECT id FROM customers WHERE company_id = $1)`,
    [companyId],
  );
  await pool.query(
    `DELETE FROM payments WHERE customer_id IN (SELECT id FROM customers WHERE company_id = $1)`,
    [companyId],
  );
  await pool.query("DELETE FROM buckets WHERE company_id = $1", [companyId]);
  await pool.query("DELETE FROM products WHERE company_id = $1", [companyId]);
  await pool.query("DELETE FROM customers WHERE company_id = $1", [companyId]);
  await pool.query("DELETE FROM companies WHERE id = $1", [companyId]);
  // branches.branch_manager_id FKs to users -- clear it before deleting the
  // branch_manager row, or the delete below violates the FK (pre-existing
  // cleanup-order gap, unrelated to this task's scope).
  await pool.query("UPDATE branches SET branch_manager_id = NULL WHERE agency_id = $1", [agencyId]);
  await pool.query("DELETE FROM users WHERE agency_id = $1", [agencyId]);
  await pool.query("DELETE FROM teams WHERE id IN ($1, $2)", [teamId, team2Id]);
  await pool.query("DELETE FROM branches WHERE id IN ($1, $2)", [branchId, otherBranchId]);
  await pool.query("DELETE FROM agencies WHERE id = $1", [agencyId]);
  await pool.end();
});

describe("report-service utilities", () => {
  it("monthDays handles past, current and future months in IST", () => {
    expect(monthDays("2026-05", new Date("2026-07-06T12:00:00Z"))).toEqual({
      in_month: 31,
      elapsed: 31,
      left: 0,
    });
    expect(monthDays("2026-08", new Date("2026-07-06T12:00:00Z"))).toEqual({
      in_month: 31,
      elapsed: 0,
      left: 31,
    });
    const current = monthDays("2026-07", new Date("2026-07-06T12:00:00Z"));
    expect(current.in_month).toBe(31);
    expect(current.elapsed).toBe(6);
    expect(current.left).toBe(25);
  });
});


// Phase 12 (Management Dashboard): today_amount, by_type, by_channel all
// read the LIVE clock (paid_at compared against now()/date_trunc('month',
// now())), unlike the rest of this file's fixed May/June-2026 fixtures --
// so this block seeds its own customer/payments against the real current
// month instead of reusing the May/June snapshots.
describe("Phase 12 Management Dashboard KPIs (today/type/channel/trend)", () => {
  let kpiCustomerId: string;
  let teleId: string;
  const TELE_PHONE = "7950000024";
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  beforeAll(async () => {
    const cust = await pool.query(
      `INSERT INTO customers (company_id, loan_number, customer_name, product, due_amount, emi)
       VALUES ($1, 'RPT-P12-01', 'P12 Customer', 'CVL', 1, 1) RETURNING id`,
      [companyId],
    );
    kpiCustomerId = cust.rows[0].id;

    const hash = await hashPassword(PASSWORD);
    const tele = await pool.query(
      `INSERT INTO users (agency_id, branch_id, team_id, full_name, phone, password_hash, is_telecaller, designation)
       VALUES ($1, $2, $3, 'Reports Tele', $4, $5, true, 'telecaller') RETURNING id`,
      [agencyId, branchId, teamId, TELE_PHONE, hash],
    );
    teleId = tele.rows[0].id;

    // Today, field agent, Cash, EMI.
    await pool.query(
      `INSERT INTO payments (customer_id, collected_by_user_id, amount, mode, type, paid_at)
       VALUES ($1, $2, 4000, 'Cash', 'emi', now())`,
      [kpiCustomerId, agentId],
    );
    // Earlier this month (not today), telecaller, UPI, settlement.
    await pool.query(
      `INSERT INTO payments (customer_id, collected_by_user_id, amount, mode, type, paid_at)
       VALUES ($1, $2, 6000, 'UPI', 'settlement', date_trunc('month', now()) + interval '10 hours')`,
      [kpiCustomerId, teleId],
    );
  });

  afterAll(async () => {
    await pool.query("DELETE FROM payments WHERE customer_id = $1", [kpiCustomerId]);
    await pool.query("DELETE FROM customers WHERE id = $1", [kpiCustomerId]);
    await pool.query("DELETE FROM users WHERE id = $1", [teleId]);
  });

  it("/reports/trend buckets collected amounts by day and sums to the range total", async () => {
    const from = `${currentMonth}-01`;
    const to = now.toISOString().slice(0, 10);
    const res = await request(app)
      .get(`/api/reports/trend?from=${from}&to=${to}&granularity=day`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const total = res.body.points.reduce((s: number, p: { amount: number }) => s + p.amount, 0);
    expect(total).toBe(10000);
  });

  it("an agent's own trend request is scope-clamped to themselves, not 403'd", async () => {
    const from = `${currentMonth}-01`;
    const to = now.toISOString().slice(0, 10);
    const res = await request(app)
      .get(`/api/reports/trend?from=${from}&to=${to}`)
      .set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
    const total = res.body.points.reduce((s: number, p: { amount: number }) => s + p.amount, 0);
    expect(total).toBe(4000); // only agentId's own payment, not the telecaller's
  });
});

describe("trail analytics", () => {
  let trailCustomerId: string;
  let ptpCallLogId: string;

  beforeAll(async () => {
    const cust = await pool.query(
      `INSERT INTO customers (company_id, loan_number, customer_name, product, due_amount, emi)
       VALUES ($1, 'RPT-TRAIL-1', 'Trail Customer', 'CVL', 10000, 5000) RETURNING id`,
      [companyId],
    );
    trailCustomerId = cust.rows[0].id;

    const dc1 = await pool.query(
      `INSERT INTO disposition_codes (agency_id, action_code, result_code, description)
       VALUES ($1, 'OC', 'PTP', 'Promise to pay') RETURNING id`,
      [agencyId],
    );
    const dc2 = await pool.query(
      `INSERT INTO disposition_codes (agency_id, action_code, result_code, description)
       VALUES ($1, 'OC', 'RNR', 'Ringing not responding') RETURNING id`,
      [agencyId],
    );
    // Phase 12 (Telecaller dashboard "Escalation Cases" KPI): the seeded
    // Trail_Codes.xlsx category value, confirmed via the source file.
    const dc3 = await pool.query(
      `INSERT INTO disposition_codes (agency_id, action_code, category, result_code, description)
       VALUES ($1, 'OC', 'ESCALATED CASE', 'ESCN', 'Escalated to legal') RETURNING id`,
      [agencyId],
    );

    const call1 = await pool.query(
      `INSERT INTO call_logs (customer_id, agent_id, disposition_code_id, remark, created_at)
       VALUES ($1, $2, $3, 'will pay', ('2026-05-20 10:00:00'::timestamp AT TIME ZONE 'Asia/Kolkata'))
       RETURNING id`,
      [trailCustomerId, agentId, dc1.rows[0].id],
    );
    ptpCallLogId = call1.rows[0].id;
    await pool.query(
      `INSERT INTO call_logs (customer_id, agent_id, disposition_code_id, remark, created_at)
       VALUES ($1, $2, $3, 'no answer', ('2026-05-21 10:00:00'::timestamp AT TIME ZONE 'Asia/Kolkata'))`,
      [trailCustomerId, agentId, dc2.rows[0].id],
    );
    await pool.query(
      `INSERT INTO call_logs (customer_id, agent_id, disposition_code_id, remark, created_at)
       VALUES ($1, $2, $3, 'escalating', ('2026-05-22 10:00:00'::timestamp AT TIME ZONE 'Asia/Kolkata'))`,
      [trailCustomerId, agentId, dc3.rows[0].id],
    );

    await pool.query(
      `INSERT INTO ptps (customer_id, call_log_id, agent_id, amount, promised_date, status)
       VALUES ($1, $2, $3, 5000, '2026-05-25', 'kept')`,
      [trailCustomerId, ptpCallLogId, agentId],
    );
    // A second, still-pending PTP created in the same window -- backs
    // ptps_pending_value (Management Dashboard "PTP Value" KPI).
    await pool.query(
      `INSERT INTO ptps (customer_id, call_log_id, agent_id, amount, promised_date, status)
       VALUES ($1, $2, $3, 7500, '2026-06-01', 'pending')`,
      [trailCustomerId, ptpCallLogId, agentId],
    );
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM ptps WHERE customer_id = $1`, [trailCustomerId]);
    await pool.query(`DELETE FROM call_logs WHERE customer_id = $1`, [trailCustomerId]);
    await pool.query(`DELETE FROM disposition_codes WHERE agency_id = $1`, [agencyId]);
    await pool.query(`DELETE FROM customers WHERE id = $1`, [trailCustomerId]);
  });

  it("counts trails by action/result code and computes PTP conversion", async () => {
    const res = await request(app)
      .get("/api/reports/trail?from=2026-05-01&to=2026-05-31")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    // 3 dispositioned calls from this block (PTP, RNR, ESCN) + the 1
    // un-dispositioned call from the May fixture (RPT-01) -- total_trails
    // counts every call_log row.
    expect(res.body.total_trails).toBe(4);
    expect(res.body.unique_customers_contacted).toBe(2); // trailCustomerId + RPT-01

    const ptpAction = res.body.by_action_code.find((r: { action_code: string }) => r.action_code === "OC");
    expect(ptpAction.count).toBe(3); // the three dispositioned calls all have action_code OC
    const ptpResult = res.body.by_result_code.find((r: { result_code: string }) => r.result_code === "PTP");
    expect(ptpResult.count).toBe(1);

    expect(res.body.ptps_created).toBe(2); // 1 kept + 1 pending
    expect(res.body.ptps_kept).toBe(1);
    expect(res.body.ptps_broken).toBe(0);
    expect(res.body.ptp_conversion_pct).toBe(100); // 1 kept / (1 kept + 0 broken)
    // Phase 12 additions:
    expect(res.body.ptps_pending_value).toBe(7500);
    expect(res.body.escalated_count).toBe(1);
  });

  it("an agent's own trail request is scope-clamped, not 403'd, when they don't try to widen", async () => {
    const res = await request(app)
      .get("/api/reports/trail?from=2026-05-01&to=2026-05-31")
      .set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
    expect(res.body.total_trails).toBe(4); // all logged by agentId

    const widen = await request(app)
      .get(`/api/reports/trail?from=2026-05-01&to=2026-05-31&agent_id=${agent2Id}`)
      .set("Authorization", `Bearer ${agentToken}`);
    expect(widen.status).toBe(403);
  });
});
