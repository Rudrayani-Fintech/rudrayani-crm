import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { pool } from "../src/config/db";
import { hashPassword } from "../src/services/auth-service";

const app = createApp();
const PASSWORD = "Secret@123";
const AGENT_PHONE = "7960000005";

let agencyId: string;
let companyId: string;
let branchAId: string;
let branchBId: string;
let agentToken: string;

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

  agentToken = await login(AGENT_PHONE);
});

afterAll(async () => {
  await pool.query("DELETE FROM customers WHERE company_id = $1", [companyId]);
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
});
