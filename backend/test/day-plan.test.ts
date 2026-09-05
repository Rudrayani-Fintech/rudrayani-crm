import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { pool } from "../src/config/db";
import { hashPassword } from "../src/services/auth-service";

/**
 * Day Plan (Group C): per-agent "what's due today" summary for
 * admin/ops/branch_manager — attendance, due PTPs, due reminders, activity
 * so far. Same visibility scope as /tracking (tracking.view): agency-wide
 * for admin/ops, own whole branch for a branch_manager (every team in it,
 * no team_leader intermediary since Phase 2), forbidden for agents.
 */
const app = createApp();

const PASSWORD = "Secret@123";
const PHONES = {
  admin: "7900000080",
  bm: "7900000081",
  agentA: "7900000082", // in branch manager's branch, team A
  agentB: "7900000083", // in branch manager's branch, team B -- same branch, so also visible now
  agentC: "7900000084", // plain agent, no tracking.view
};

let agencyId: string;
let companyId: string;
let teamAId: string;
let teamBId: string;
const userIds: Record<string, string> = {};
const tokens: Record<string, string> = {};
let customerId: string;
let today: string;

async function login(phone: string): Promise<string> {
  const res = await request(app).post("/api/auth/login").send({ phone, password: PASSWORD });
  return res.body.access_token;
}

beforeAll(async () => {
  const agency = await pool.query(
    "INSERT INTO agencies (name) VALUES ('Day Plan Test Agency') RETURNING id",
  );
  agencyId = agency.rows[0].id;

  const branch = await pool.query(
    "INSERT INTO branches (agency_id, name) VALUES ($1, 'DP Branch') RETURNING id",
    [agencyId],
  );
  const teamA = await pool.query(
    "INSERT INTO teams (branch_id, name) VALUES ($1, 'DP Team A') RETURNING id",
    [branch.rows[0].id],
  );
  teamAId = teamA.rows[0].id;
  const teamB = await pool.query(
    "INSERT INTO teams (branch_id, name) VALUES ($1, 'DP Team B') RETURNING id",
    [branch.rows[0].id],
  );
  teamBId = teamB.rows[0].id;

  const company = await pool.query(
    "INSERT INTO companies (agency_id, name) VALUES ($1, 'DP NBFC') RETURNING id",
    [agencyId],
  );
  companyId = company.rows[0].id;

  const hash = await hashPassword(PASSWORD);
  const mk = async (key: keyof typeof PHONES, flags: string, teamId: string | null) => {
    const designation =
      flags === "is_agency_admin" ? "agency_admin" : flags === "is_telecaller" ? "telecaller" : "field_agent";
    const { rows } = await pool.query(
      `INSERT INTO users (agency_id, branch_id, team_id, full_name, phone, password_hash, ${flags}, designation)
       VALUES ($1, $2, $3, $4, $5, $6, true, $7) RETURNING id`,
      [agencyId, branch.rows[0].id, teamId, `DP ${key}`, PHONES[key], hash, designation],
    );
    userIds[key] = rows[0].id;
  };
  await mk("admin", "is_agency_admin", null);
  const bm = await pool.query(
    `INSERT INTO users (agency_id, full_name, phone, password_hash, designation)
     VALUES ($1, 'DP bm', $2, $3, 'branch_manager') RETURNING id`,
    [agencyId, PHONES.bm, hash],
  );
  userIds.bm = bm.rows[0].id;
  await pool.query("UPDATE branches SET branch_manager_id = $1 WHERE id = $2", [
    userIds.bm,
    branch.rows[0].id,
  ]);
  await mk("agentA", "is_telecaller", teamAId);
  await mk("agentB", "is_telecaller", teamBId);
  await mk("agentC", "is_telecaller", teamAId);

  for (const key of Object.keys(PHONES) as (keyof typeof PHONES)[]) {
    tokens[key] = await login(PHONES[key]);
  }

  const customer = await pool.query(
    `INSERT INTO customers (company_id, loan_number, customer_name, mobile_number, product, bucket, due_amount)
     VALUES ($1, 'DP-001', 'Test Customer', '9866666666', 'Personal Loan', 'B1', 25000)
     RETURNING id`,
    [companyId],
  );
  customerId = customer.rows[0].id;

  today = new Date().toISOString().slice(0, 10);

  // agentA: on duty, one due PTP, one due reminder, one call logged.
  await pool.query(
    `INSERT INTO attendance (user_id, punch_in_at, punch_in_location)
     VALUES ($1, now() - interval '2 hours', ST_SetSRID(ST_MakePoint(73.8567, 18.5204), 4326)::geography)`,
    [userIds.agentA],
  );
  const disposition = await pool.query(
    `INSERT INTO disposition_codes (agency_id, action_code, category, result_code, description)
     VALUES ($1, 'OC', 'NO CONTACT', 'RNR', 'Ringing No Response') RETURNING id`,
    [agencyId],
  );
  const callLog = await pool.query(
    `INSERT INTO call_logs (customer_id, agent_id, disposition_code_id, remark)
     VALUES ($1, $2, $3, 'test call') RETURNING id`,
    [customerId, userIds.agentA, disposition.rows[0].id],
  );
  await pool.query(
    `INSERT INTO ptps (customer_id, call_log_id, agent_id, amount, promised_date, status)
     VALUES ($1, $2, $3, 5000, $4, 'pending')`,
    [customerId, callLog.rows[0].id, userIds.agentA, today],
  );
  await pool.query(
    `INSERT INTO reminders (agency_id, customer_id, agent_id, remind_at, note, created_by, status)
     VALUES ($1, $2, $3, now() + interval '2 hours', 'Follow up', $3, 'pending')`,
    [agencyId, customerId, userIds.agentA],
  );

  // agentB: off duty, nothing due — used to confirm zero-rows still appear.
});

afterAll(async () => {
  await pool.query("DELETE FROM reminders WHERE agency_id = $1", [agencyId]);
  await pool.query(
    "DELETE FROM ptps WHERE customer_id IN (SELECT id FROM customers WHERE company_id = $1)",
    [companyId],
  );
  await pool.query(
    "DELETE FROM call_logs WHERE customer_id IN (SELECT id FROM customers WHERE company_id = $1)",
    [companyId],
  );
  await pool.query("DELETE FROM attendance WHERE user_id = ANY($1)", [Object.values(userIds)]);
  await pool.query("DELETE FROM customers WHERE company_id = $1", [companyId]);
  await pool.query("DELETE FROM disposition_codes WHERE agency_id = $1", [agencyId]);
  await pool.query("DELETE FROM companies WHERE id = $1", [companyId]);
  // branches.branch_manager_id FKs to users -- clear it before deleting the
  // branch_manager row, or this delete throws on the FK constraint.
  await pool.query("UPDATE branches SET branch_manager_id = NULL WHERE agency_id = $1", [agencyId]);
  await pool.query("DELETE FROM users WHERE agency_id = $1", [agencyId]);
  await pool.query("DELETE FROM teams WHERE id = ANY($1)", [[teamAId, teamBId]]);
  await pool.query("DELETE FROM branches WHERE agency_id = $1", [agencyId]);
  await pool.query("DELETE FROM agencies WHERE id = $1", [agencyId]);
  await pool.end();
});

describe("GET /api/day-plan", () => {
  it("admin sees every agent with correct due counts", async () => {
    const res = await request(app)
      .get(`/api/day-plan?date=${today}`)
      .set("Authorization", `Bearer ${tokens.admin}`);
    expect(res.status).toBe(200);
    expect(res.body.agents.length).toBeGreaterThanOrEqual(4);

    const agentA = res.body.agents.find((a: { user_id: string }) => a.user_id === userIds.agentA);
    expect(agentA.attendance.on_duty).toBe(true);
    expect(agentA.ptps_due.count).toBe(1);
    expect(Number(agentA.ptps_due.total_amount)).toBe(5000);
    expect(agentA.reminders_due.count).toBe(1);
    expect(agentA.activity.calls).toBe(1);

    const agentB = res.body.agents.find((a: { user_id: string }) => a.user_id === userIds.agentB);
    expect(agentB.attendance.on_duty).toBe(false);
    expect(agentB.ptps_due.count).toBe(0);
  });

  it("a branch_manager sees every team in their branch", async () => {
    const res = await request(app)
      .get(`/api/day-plan?date=${today}`)
      .set("Authorization", `Bearer ${tokens.bm}`);
    expect(res.status).toBe(200);
    const ids = res.body.agents.map((a: { user_id: string }) => a.user_id);
    // Both agentA (team A) and agentB (team B) are in the branch_manager's
    // branch -- no team_leader intermediary since Phase 2, so both are
    // visible even though they're on different teams.
    expect(ids).toContain(userIds.agentA);
    expect(ids).toContain(userIds.agentB);
  });

  // Phase 12: telecaller/field_agent now hold tracking.view too (their mobile
  // dashboards need their own attendance/GPS/route), but scope.ts clamps them
  // to self only -- not a 403, and not their team's data either.
  it("a plain agent sees only their own day-plan row, not the team's", async () => {
    const res = await request(app)
      .get(`/api/day-plan?date=${today}`)
      .set("Authorization", `Bearer ${tokens.agentC}`);
    expect(res.status).toBe(200);
    const ids = res.body.agents.map((a: { user_id: string }) => a.user_id);
    expect(ids).toEqual([userIds.agentC]);
  });

  it("team_id filter narrows the agency-wide view", async () => {
    const res = await request(app)
      .get(`/api/day-plan?date=${today}&team_id=${teamBId}`)
      .set("Authorization", `Bearer ${tokens.admin}`);
    expect(res.status).toBe(200);
    const ids = res.body.agents.map((a: { user_id: string }) => a.user_id);
    expect(ids).toContain(userIds.agentB);
    expect(ids).not.toContain(userIds.agentA);
  });
});

describe("GET /api/day-plan/agent/:id", () => {
  it("returns the customer-level PTPs and reminders behind the counts", async () => {
    const res = await request(app)
      .get(`/api/day-plan/agent/${userIds.agentA}?date=${today}`)
      .set("Authorization", `Bearer ${tokens.admin}`);
    expect(res.status).toBe(200);
    expect(res.body.ptps).toHaveLength(1);
    expect(res.body.ptps[0].customer_name).toBe("Test Customer");
    expect(res.body.reminders).toHaveLength(1);
    expect(res.body.reminders[0].note).toBe("Follow up");
  });

  it("a branch_manager can expand an agent on a different team in their own branch", async () => {
    const res = await request(app)
      .get(`/api/day-plan/agent/${userIds.agentB}?date=${today}`)
      .set("Authorization", `Bearer ${tokens.bm}`);
    expect(res.status).toBe(200);
  });
});
