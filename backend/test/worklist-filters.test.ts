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
