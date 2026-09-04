import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { pool } from "../src/config/db";
import { hashPassword } from "../src/services/auth-service";

const app = createApp();
const PASSWORD = "Secret@123";
const AGENT_PHONE = "7960000005";
const BM_PHONE = "7960000006";
const TEAM_AGENT_PHONE = "7960000007";

let agencyId: string;
let companyId: string;
let branchAId: string;
let branchBId: string;
let agentToken: string;
let bmToken: string;

async function login(phone: string): Promise<string> {
  const res = await request(app).post("/api/auth/login").send({ phone, password: PASSWORD });
  return res.body.access_token;
}

beforeAll(async () => {
  const agency = await pool.query("INSERT INTO agencies (name) VALUES ('WL Filter Agency') RETURNING id");
  agencyId = agency.rows[0].id;
  const company = await pool.query(
    "INSERT INTO companies (agency_id, name) VALUES ($1, 'WL Filter NBFC') RETURNING id",
    [agencyId],
  );
  companyId = company.rows[0].id;

  const branchA = await pool.query("INSERT INTO branches (agency_id, name) VALUES ($1, 'Branch A') RETURNING id", [
    agencyId,
  ]);
  branchAId = branchA.rows[0].id;
  const branchB = await pool.query("INSERT INTO branches (agency_id, name) VALUES ($1, 'Branch B') RETURNING id", [
    agencyId,
  ]);
  branchBId = branchB.rows[0].id;

  const hash = await hashPassword(PASSWORD);
  const agent = await pool.query(
    `INSERT INTO users (agency_id, full_name, phone, password_hash, is_telecaller, designation)
     VALUES ($1, 'WL Filter Agent', $2, $3, true, 'telecaller') RETURNING id`,
    [agencyId, AGENT_PHONE, hash],
  );
  const agentId = agent.rows[0].id;

  await pool.query(
    `INSERT INTO customers (company_id, loan_number, customer_name, mobile_number, due_amount, bucket, branch_id, assigned_agent_id)
     VALUES
       ($1, 'WLF-001', 'Cust A1', '9800000010', 1000, '0-30', $2, $4),
       ($1, 'WLF-002', 'Cust B1', '9800000011', 2000, '31-60', $3, $4)`,
    [companyId, branchAId, branchBId, agentId],
  );

  // Branch-manager "My Team" scope fixture (regression for the
  // filter-options $1-unreferenced-parameter bug -- Postgres can't
  // determine the type of $1 when the built query only ever references
  // $2/$3 in the clamped branch). A branch_manager managing Branch A, plus a
  // telecaller assigned to Branch A (via users.branch_id) with an allocated
  // active customer, mirrors the fixture style used elsewhere for
  // resolveBranchClamp()/agentBranchClamp() coverage (see day-plan.test.ts).
  const bm = await pool.query(
    `INSERT INTO users (agency_id, full_name, phone, password_hash, designation)
     VALUES ($1, 'WL Filter BM', $2, $3, 'branch_manager') RETURNING id`,
    [agencyId, BM_PHONE, hash],
  );
  await pool.query("UPDATE branches SET branch_manager_id = $1 WHERE id = $2", [bm.rows[0].id, branchAId]);

  const teamAgent = await pool.query(
    `INSERT INTO users (agency_id, branch_id, full_name, phone, password_hash, is_telecaller, designation)
     VALUES ($1, $2, 'WL Filter Team Agent', $3, $4, true, 'telecaller') RETURNING id`,
    [agencyId, branchAId, TEAM_AGENT_PHONE, hash],
  );
  await pool.query(
    `INSERT INTO customers (company_id, loan_number, customer_name, mobile_number, due_amount, bucket, branch_id, assigned_agent_id)
     VALUES ($1, 'WLF-003', 'Cust Team A1', '9800000012', 1500, '61-90', $2, $3)`,
    [companyId, branchAId, teamAgent.rows[0].id],
  );

  agentToken = await login(AGENT_PHONE);
  bmToken = await login(BM_PHONE);
});

afterAll(async () => {
  await pool.query("DELETE FROM customers WHERE company_id = $1", [companyId]);
  // branches.branch_manager_id FKs to users -- clear it before deleting the
  // branch_manager row (see branches.test.ts/day-plan.test.ts for the same
  // pattern).
  await pool.query("UPDATE branches SET branch_manager_id = NULL WHERE agency_id = $1", [agencyId]);
  await pool.query("DELETE FROM users WHERE agency_id = $1", [agencyId]);
  await pool.query("DELETE FROM branches WHERE agency_id = $1", [agencyId]);
  await pool.query("DELETE FROM companies WHERE id = $1", [companyId]);
  await pool.query("DELETE FROM agencies WHERE id = $1", [agencyId]);
  await pool.end();
});

describe("worklist multi-value filters + filter-options", () => {
  it("filter-options returns only this agent's own branches/buckets", async () => {
    const res = await request(app).get("/api/worklist/filter-options").set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
    expect(res.body.branches.sort()).toEqual(["Branch A", "Branch B"]);
    expect(res.body.buckets.sort()).toEqual(["0-30", "31-60"]);
  });

  it("bucket accepts a comma-separated list", async () => {
    const res = await request(app)
      .get("/api/worklist?bucket=0-30,31-60")
      .set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
    expect(res.body.customers).toHaveLength(2);
  });

  it("bucket narrows to only the listed values", async () => {
    const res = await request(app).get("/api/worklist?bucket=0-30").set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
    expect(res.body.customers).toHaveLength(1);
    expect(res.body.customers[0].loan_number).toBe("WLF-001");
  });

  it("customer_branch accepts a comma-separated list", async () => {
    const res = await request(app)
      .get("/api/worklist?customer_branch=Branch A,Branch B")
      .set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
    expect(res.body.customers).toHaveLength(2);
  });

  // Regression for the Critical review finding: filter-options seeded
  // params with [req.user!.id] for $1 but the clamped (team-scope) branch
  // of the query never referenced $1 anywhere -- only $2/$3 from the two
  // agentBranchClamp() calls -- so Postgres couldn't determine $1's type
  // and threw "could not determine data type of parameter $1", 500ing this
  // endpoint for every branch_manager on scope=team (MyWorklistPage.tsx's
  // default scope).
  it("filter-options?scope=team succeeds for a branch_manager (no unreferenced $1)", async () => {
    const res = await request(app)
      .get("/api/worklist/filter-options?scope=team")
      .set("Authorization", `Bearer ${bmToken}`);
    expect(res.status).toBe(200);
    expect(res.body.branches).toContain("Branch A");
    expect(res.body.buckets).toContain("61-90");
  });

  it("GET /worklist?scope=team also succeeds for a branch_manager", async () => {
    const res = await request(app).get("/api/worklist?scope=team").set("Authorization", `Bearer ${bmToken}`);
    expect(res.status).toBe(200);
    expect(res.body.customers.some((c: { loan_number: string }) => c.loan_number === "WLF-003")).toBe(true);
  });
});

// Phase 3 (N5, P6, P7, P8, P10): pagination, worked_today/collected_today,
// worked-state-first sort. Own isolated agency/agent/customers rather than
// reusing the fixtures above, so page/limit math and worked-row sorting
// stay exact and don't interact with the bucket/branch filters those tests
// already assert on.
describe("worklist pagination and worked state (Phase 3)", () => {
  const PAGE_PHONE = "7980100001";
  let pageAgencyId: string;
  let pageCompanyId: string;
  let pageAgentId: string;
  let pageAgentToken: string;
  let workedCustomerId: string;
  const customerIds: string[] = [];

  beforeAll(async () => {
    const agency = await pool.query(
      "INSERT INTO agencies (name) VALUES ('WL Pagination Agency') RETURNING id",
    );
    pageAgencyId = agency.rows[0].id;
    const company = await pool.query(
      "INSERT INTO companies (agency_id, name) VALUES ($1, 'WL Pagination NBFC') RETURNING id",
      [pageAgencyId],
    );
    pageCompanyId = company.rows[0].id;
    const hash = await hashPassword(PASSWORD);
    const agent = await pool.query(
      `INSERT INTO users (agency_id, full_name, phone, password_hash, is_telecaller, designation)
       VALUES ($1, 'WL Pagination Agent', $2, $3, true, 'telecaller') RETURNING id`,
      [pageAgencyId, PAGE_PHONE, hash],
    );
    pageAgentId = agent.rows[0].id;

    // 5 customers, all assigned to pageAgentId -- enough to prove page 1 and
    // page 2 return disjoint rows under a small limit without needing 50+
    // fixture rows to exercise the same LIMIT/OFFSET math the real 50-row
    // default would use.
    for (let i = 1; i <= 5; i++) {
      const c = await pool.query(
        `INSERT INTO customers
           (company_id, loan_number, customer_name, mobile_number, due_amount, bucket, assigned_agent_id)
         VALUES ($1, $2, $3, $4, $5, 'PAGINATION-TEST', $6) RETURNING id`,
        [pageCompanyId, `WLP-00${i}`, `Pagination Cust ${i}`, `98100000${i}0`, 1000 - i, pageAgentId],
      );
      customerIds.push(c.rows[0].id);
    }
    workedCustomerId = customerIds[0];

    pageAgentToken = await login(PAGE_PHONE);
  });

  afterAll(async () => {
    await pool.query("DELETE FROM payments WHERE customer_id = ANY($1)", [customerIds]);
    await pool.query("DELETE FROM call_logs WHERE customer_id = ANY($1)", [customerIds]);
    await pool.query("DELETE FROM customers WHERE company_id = $1", [pageCompanyId]);
    await pool.query("DELETE FROM users WHERE agency_id = $1", [pageAgencyId]);
    await pool.query("DELETE FROM companies WHERE id = $1", [pageCompanyId]);
    await pool.query("DELETE FROM agencies WHERE id = $1", [pageAgencyId]);
  });

  it("total reflects every matching row, not just the page returned", async () => {
    const res = await request(app)
      .get("/api/worklist?limit=2&page=1")
      .set("Authorization", `Bearer ${pageAgentToken}`);
    expect(res.status).toBe(200);
    expect(res.body.customers).toHaveLength(2);
    expect(res.body.total).toBe(5);
    expect(res.body.page).toBe(1);
    expect(res.body.limit).toBe(2);
  });

  it("pagination boundaries: page 2 and page 3 return the remaining, disjoint rows", async () => {
    const page1 = await request(app)
      .get("/api/worklist?limit=2&page=1")
      .set("Authorization", `Bearer ${pageAgentToken}`);
    const page2 = await request(app)
      .get("/api/worklist?limit=2&page=2")
      .set("Authorization", `Bearer ${pageAgentToken}`);
    const page3 = await request(app)
      .get("/api/worklist?limit=2&page=3")
      .set("Authorization", `Bearer ${pageAgentToken}`);

    expect(page2.body.customers).toHaveLength(2);
    expect(page3.body.customers).toHaveLength(1); // 5 rows, limit 2 -> last page has 1

    const ids1 = page1.body.customers.map((c: { id: string }) => c.id);
    const ids2 = page2.body.customers.map((c: { id: string }) => c.id);
    const ids3 = page3.body.customers.map((c: { id: string }) => c.id);
    const allIds = [...ids1, ...ids2, ...ids3];
    expect(new Set(allIds).size).toBe(5); // every row appears exactly once across all 3 pages
  });

  it("worked_today toggles true after a call log, and the row sorts to the bottom", async () => {
    const before = await request(app)
      .get("/api/worklist?limit=10")
      .set("Authorization", `Bearer ${pageAgentToken}`);
    const beforeRow = before.body.customers.find((c: { id: string }) => c.id === workedCustomerId);
    expect(beforeRow.worked_today).toBe(false);

    await pool.query(
      `INSERT INTO call_logs (customer_id, agent_id, remark, created_at) VALUES ($1, $2, 'Called today', now())`,
      [workedCustomerId, pageAgentId],
    );

    const after = await request(app)
      .get("/api/worklist?limit=10")
      .set("Authorization", `Bearer ${pageAgentToken}`);
    const rows = after.body.customers as { id: string; worked_today: boolean }[];
    const afterRow = rows.find((c) => c.id === workedCustomerId);
    expect(afterRow!.worked_today).toBe(true);

    // P8: worked rows sink to the bottom -- this is now the only worked
    // row among the 5, so it must be last.
    expect(rows[rows.length - 1].id).toBe(workedCustomerId);
    expect(rows.slice(0, 4).every((c) => c.worked_today === false)).toBe(true);
  });

  it("collected_today reflects only this agent's payments against this customer, today", async () => {
    await pool.query(
      `INSERT INTO payments (customer_id, collected_by_user_id, amount, paid_at) VALUES ($1, $2, 250, now())`,
      [workedCustomerId, pageAgentId],
    );

    const res = await request(app)
      .get("/api/worklist?limit=10")
      .set("Authorization", `Bearer ${pageAgentToken}`);
    const rows = res.body.customers as { id: string; collected_today: string }[];
    const row = rows.find((c) => c.id === workedCustomerId);
    expect(Number(row!.collected_today)).toBe(250);

    const otherRow = rows.find((c) => c.id === customerIds[1]);
    expect(Number(otherRow!.collected_today)).toBe(0);
  });

  it("?customer_branch= filters server-side, not just client-side", async () => {
    // None of this fixture's customers have a branch set, so a real branch
    // filter narrows the result to zero -- proves the filter runs in the
    // query (server-side), not merely accepted and ignored.
    const res = await request(app)
      .get("/api/worklist?customer_branch=Some Other Branch")
      .set("Authorization", `Bearer ${pageAgentToken}`);
    expect(res.status).toBe(200);
    expect(res.body.customers).toHaveLength(0);
    expect(res.body.total).toBe(0);
  });
});
