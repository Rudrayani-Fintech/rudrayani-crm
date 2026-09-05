import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { pool } from "../src/config/db";
import { hashPassword } from "../src/services/auth-service";

/**
 * Phase 9: Branches drill-down detail view -- GET /branches/:id aggregates
 * team details and deposits for a single branch, agency-scoped
 * (never leaks another branch's or another agency's data).
 */
const app = createApp();

const PASSWORD = "Secret@123";
const ADMIN_PHONE = "7960000030";
const TELECALLER_PHONE = "7960000031";
const AGENT_A_PHONE = "7960000032";
const AGENT_A2_PHONE = "7960000033";
const AGENT_A_INACTIVE_PHONE = "7960000034";
const BM_A_PHONE = "7960000035";
const AGENT_B_PHONE = "7960000036";
const BM_B_PHONE = "7960000037";

const MONTH = "2026-07";

let agencyId: string;
let companyId: string;
let branchAId: string;
let branchBId: string;
let teamA1Id: string;
let teamA2Id: string;
let teamBId: string;
let agentAId: string;
let agentBId: string;
let bmAId: string;
let adminToken: string;
let telecallerToken: string;
let bmAToken: string;
let bmBToken: string;

async function login(phone: string): Promise<string> {
  const res = await request(app).post("/api/auth/login").send({ phone, password: PASSWORD });
  expect(res.status).toBe(200);
  return res.body.access_token as string;
}

/** A payment timestamped inside the given IST day. */
async function pay(customerId: string, amount: number, byUser: string, istDate: string, deposited = false) {
  await pool.query(
    `INSERT INTO payments (customer_id, collected_by_user_id, amount, paid_at,
                           deposited_at, deposited_by_user_id)
     VALUES ($1, $2, $3, ($4::timestamp AT TIME ZONE 'Asia/Kolkata'),
             CASE WHEN $5 THEN now() END, CASE WHEN $5 THEN $2::uuid END)`,
    [customerId, byUser, amount, `${istDate} 12:00:00`, deposited],
  );
}

beforeAll(async () => {
  const agency = await pool.query(
    "INSERT INTO agencies (name) VALUES ('Branch Detail Agency') RETURNING id",
  );
  agencyId = agency.rows[0].id;

  const company = await pool.query(
    "INSERT INTO companies (agency_id, name) VALUES ($1, 'Branch Detail NBFC') RETURNING id",
    [agencyId],
  );
  companyId = company.rows[0].id;

  const branchA = await pool.query(
    "INSERT INTO branches (agency_id, name) VALUES ($1, 'Sangli') RETURNING id",
    [agencyId],
  );
  branchAId = branchA.rows[0].id;
  const branchB = await pool.query(
    "INSERT INTO branches (agency_id, name) VALUES ($1, 'Kolhapur') RETURNING id",
    [agencyId],
  );
  branchBId = branchB.rows[0].id;

  const teamA1 = await pool.query(
    "INSERT INTO teams (branch_id, name) VALUES ($1, 'Sangli Team A') RETURNING id",
    [branchAId],
  );
  teamA1Id = teamA1.rows[0].id;
  const teamA2 = await pool.query(
    "INSERT INTO teams (branch_id, name) VALUES ($1, 'Sangli Team B') RETURNING id",
    [branchAId],
  );
  teamA2Id = teamA2.rows[0].id;
  const teamB = await pool.query(
    "INSERT INTO teams (branch_id, name) VALUES ($1, 'Kolhapur Team') RETURNING id",
    [branchBId],
  );
  teamBId = teamB.rows[0].id;

  const hash = await hashPassword(PASSWORD);
  await pool.query(
    `INSERT INTO users (agency_id, full_name, phone, password_hash, is_agency_admin, designation)
     VALUES ($1, 'Branch Detail Admin', $2, $3, true, 'agency_admin')`,
    [agencyId, ADMIN_PHONE, hash],
  );
  await pool.query(
    `INSERT INTO users (agency_id, full_name, phone, password_hash, is_telecaller, designation)
     VALUES ($1, 'No Branch Perm Telecaller', $2, $3, true, 'telecaller')`,
    [agencyId, TELECALLER_PHONE, hash],
  );

  // Branch manager for branch A (no team_id/branch_id of their own -- their
  // branch comes from branches.branch_manager_id, see Phase 2).
  const bmA = await pool.query(
    `INSERT INTO users (agency_id, full_name, phone, password_hash, designation)
     VALUES ($1, 'Sangli BM', $2, $3, 'branch_manager') RETURNING id`,
    [agencyId, BM_A_PHONE, hash],
  );
  bmAId = bmA.rows[0].id;
  await pool.query("UPDATE branches SET branch_manager_id = $1 WHERE id = $2", [
    bmAId,
    branchAId,
  ]);

  // Branch manager for branch B -- used to prove a branch_manager can't
  // PATCH/GET a branch (or create/move a team into one) they don't manage.
  const bmB = await pool.query(
    `INSERT INTO users (agency_id, full_name, phone, password_hash, designation)
     VALUES ($1, 'Kolhapur BM', $2, $3, 'branch_manager') RETURNING id`,
    [agencyId, BM_B_PHONE, hash],
  );
  await pool.query("UPDATE branches SET branch_manager_id = $1 WHERE id = $2", [
    bmB.rows[0].id,
    branchBId,
  ]);

  const agentA = await pool.query(
    `INSERT INTO users (agency_id, branch_id, team_id, full_name, phone, password_hash, is_field_agent, designation)
     VALUES ($1, $2, $3, 'Sangli Agent 1', $4, $5, true, 'field_agent') RETURNING id`,
    [agencyId, branchAId, teamA1Id, AGENT_A_PHONE, hash],
  );
  agentAId = agentA.rows[0].id;
  await pool.query(
    `INSERT INTO users (agency_id, branch_id, team_id, full_name, phone, password_hash, is_field_agent, designation)
     VALUES ($1, $2, $3, 'Sangli Agent 2', $4, $5, true, 'field_agent')`,
    [agencyId, branchAId, teamA2Id, AGENT_A2_PHONE, hash],
  );
  // Inactive agent in branch A -- must not count toward member_count/agent_count.
  await pool.query(
    `INSERT INTO users (agency_id, branch_id, team_id, full_name, phone, password_hash, is_field_agent, is_active, designation)
     VALUES ($1, $2, $3, 'Sangli Inactive Agent', $4, $5, true, false, 'field_agent')`,
    [agencyId, branchAId, teamA1Id, AGENT_A_INACTIVE_PHONE, hash],
  );

  const agentB = await pool.query(
    `INSERT INTO users (agency_id, branch_id, team_id, full_name, phone, password_hash, is_field_agent, designation)
     VALUES ($1, $2, $3, 'Kolhapur Agent', $4, $5, true, 'field_agent') RETURNING id`,
    [agencyId, branchBId, teamBId, AGENT_B_PHONE, hash],
  );
  agentBId = agentB.rows[0].id;

  const customerA = await pool.query(
    `INSERT INTO customers (company_id, loan_number, customer_name, due_amount)
     VALUES ($1, 'BR-A-001', 'Branch A Customer', 40000) RETURNING id`,
    [companyId],
  );
  const customerB = await pool.query(
    `INSERT INTO customers (company_id, loan_number, customer_name, due_amount)
     VALUES ($1, 'BR-B-001', 'Branch B Customer', 40000) RETURNING id`,
    [companyId],
  );

  // Branch A payments: one deposited, one pending -- inside MONTH.
  await pay(customerA.rows[0].id, 5000, agentAId, "2026-07-05", true);
  await pay(customerA.rows[0].id, 3000, agentAId, "2026-07-10", false);
  // Branch B payment -- must NOT leak into branch A's deposit numbers.
  await pay(customerB.rows[0].id, 9000, agentBId, "2026-07-06", false);

  adminToken = await login(ADMIN_PHONE);
  telecallerToken = await login(TELECALLER_PHONE);
  bmAToken = await login(BM_A_PHONE);
  bmBToken = await login(BM_B_PHONE);
});

afterAll(async () => {
  await pool.query(
    `DELETE FROM payments WHERE customer_id IN
       (SELECT id FROM customers WHERE company_id = $1)`,
    [companyId],
  );
  await pool.query("DELETE FROM customers WHERE company_id = $1", [companyId]);
  await pool.query("DELETE FROM companies WHERE agency_id = $1", [agencyId]);
  // branches.branch_manager_id FKs to users -- clear it before deleting the
  // branch_manager row, or the delete below violates the FK (pre-existing
  // cleanup-order gap, unrelated to this task's scope).
  await pool.query("UPDATE branches SET branch_manager_id = NULL WHERE agency_id = $1", [agencyId]);
  await pool.query("DELETE FROM users WHERE agency_id = $1", [agencyId]);
  await pool.query("DELETE FROM teams WHERE branch_id IN ($1, $2)", [branchAId, branchBId]);
  await pool.query("DELETE FROM branches WHERE agency_id = $1", [agencyId]);
  await pool.query("DELETE FROM agencies WHERE id = $1", [agencyId]);
  await pool.end();
});

describe("GET /branches/:id (Phase 9 drill-down)", () => {
  it("aggregates team details and deposits for the branch, scoped correctly", async () => {
    const res = await request(app)
      .get(`/api/branches/${branchAId}?month=${MONTH}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);

    expect(res.body.branch.id).toBe(branchAId);
    expect(res.body.branch.name).toBe("Sangli");
    expect(res.body.branch.branch_manager_name).toBe("Sangli BM");
    expect(res.body.month).toBe(MONTH);

    // Team details: both branch-A teams present, branch-B team absent.
    expect(res.body.team_count).toBe(2);
    const teamNames = res.body.teams.map((t: { name: string }) => t.name);
    expect(teamNames).toEqual(expect.arrayContaining(["Sangli Team A", "Sangli Team B"]));
    expect(teamNames).not.toContain("Kolhapur Team");

    const teamA1 = res.body.teams.find((t: { id: string }) => t.id === teamA1Id);
    // Team A1 has Agent 1 active -- the branch manager has no team_id of
    // their own (Phase 2), and the inactive agent is excluded.
    expect(teamA1.member_count).toBe(1);

    // agent_count: active users with branch_id = branchA (2 agents) -- the
    // branch manager has no branch_id of their own either (Phase 2).
    expect(res.body.agent_count).toBe(2);

    // Deposits: only branch-A payments counted (5000 deposited + 3000 pending).
    expect(res.body.deposits.collected).toBe(8000);
    expect(res.body.deposits.deposited).toBe(5000);
    expect(res.body.deposits.pending).toBe(3000);
    expect(res.body.deposits.payments).toHaveLength(2);
    const collectedByNames = res.body.deposits.payments.map(
      (p: { collected_by_name: string }) => p.collected_by_name,
    );
    expect(collectedByNames.every((n: string) => n === "Sangli Agent 1")).toBe(true);
  });

  it("defaults deposits to the current month when none is given", async () => {
    const res = await request(app)
      .get(`/api/branches/${branchAId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.month).toMatch(/^\d{4}-\d{2}$/);
  });

  it("404s for a branch id that does not exist", async () => {
    const res = await request(app)
      .get("/api/branches/00000000-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  it("404s for a branch belonging to another agency", async () => {
    const foreignAgency = await pool.query(
      "INSERT INTO agencies (name) VALUES ('Branch Detail Foreign Agency') RETURNING id",
    );
    const foreignBranch = await pool.query(
      "INSERT INTO branches (agency_id, name) VALUES ($1, 'Foreign Branch') RETURNING id",
      [foreignAgency.rows[0].id],
    );
    const res = await request(app)
      .get(`/api/branches/${foreignBranch.rows[0].id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
    await pool.query("DELETE FROM branches WHERE id = $1", [foreignBranch.rows[0].id]);
    await pool.query("DELETE FROM agencies WHERE id = $1", [foreignAgency.rows[0].id]);
  });

  it("rejects a caller without branches.manage", async () => {
    const res = await request(app)
      .get(`/api/branches/${branchAId}`)
      .set("Authorization", `Bearer ${telecallerToken}`);
    expect(res.status).toBe(403);
  });

  // RBAC gap: branches.manage is granted to branch_manager (Phase 2), but
  // neither route checked the target branch belongs to the caller -- a
  // branch_manager could view or rename/reassign-manager on ANY branch in
  // the agency, not just their own.
  it("lets a branch_manager view their own branch", async () => {
    const res = await request(app)
      .get(`/api/branches/${branchAId}`)
      .set("Authorization", `Bearer ${bmAToken}`);
    expect(res.status).toBe(200);
    expect(res.body.branch.id).toBe(branchAId);
  });

  it("403s a branch_manager viewing another branch's roster/targets/deposits", async () => {
    const res = await request(app)
      .get(`/api/branches/${branchBId}`)
      .set("Authorization", `Bearer ${bmAToken}`);
    expect(res.status).toBe(403);
  });

  it("403s a branch_manager renaming another branch", async () => {
    const res = await request(app)
      .patch(`/api/branches/${branchBId}`)
      .set("Authorization", `Bearer ${bmAToken}`)
      .send({ name: "Hijacked Name" });
    expect(res.status).toBe(403);

    const check = await pool.query("SELECT name FROM branches WHERE id = $1", [branchBId]);
    expect(check.rows[0].name).toBe("Kolhapur"); // unchanged
  });

  it("403s a branch_manager reassigning another branch's manager", async () => {
    const res = await request(app)
      .patch(`/api/branches/${branchBId}`)
      .set("Authorization", `Bearer ${bmAToken}`)
      .send({ branch_manager_id: bmAId });
    expect(res.status).toBe(403);
  });

  it("still lets a branch_manager rename their own branch", async () => {
    const res = await request(app)
      .patch(`/api/branches/${branchAId}`)
      .set("Authorization", `Bearer ${bmAToken}`)
      .send({ name: "Sangli" }); // same name -- no-op update, just proves the clamp allows it
    expect(res.status).toBe(200);
    expect(res.body.branch.name).toBe("Sangli");
  });

  it("does not restrict agency_admin/operations_manager (resolveBranchClamp is null for them)", async () => {
    const res = await request(app)
      .get(`/api/branches/${branchBId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.branch.id).toBe(branchBId);
  });
});

describe("GET /payments/deposits?branch_id= (Phase 9: branch filter reuse)", () => {
  it("filters the existing deposit list by the collecting agent's branch", async () => {
    const res = await request(app)
      .get(`/api/payments/deposits?branch_id=${branchAId}&month=${MONTH}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.payments).toHaveLength(2);
    const names = res.body.payments.map((p: { collected_by_name: string }) => p.collected_by_name);
    expect(names.every((n: string) => n === "Sangli Agent 1")).toBe(true);

    const branchB = await request(app)
      .get(`/api/payments/deposits?branch_id=${branchBId}&month=${MONTH}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(branchB.body.payments).toHaveLength(1);
    expect(branchB.body.payments[0].collected_by_name).toBe("Kolhapur Agent");
  });
});
