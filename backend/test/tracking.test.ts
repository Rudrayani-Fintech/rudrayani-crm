import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { pool } from "../src/config/db";
import { hashPassword } from "../src/services/auth-service";

/**
 * Live tracking + route replay for managers, and the permission audit the
 * hierarchy depends on (brief Sections 3, 9): admin/ops see the whole
 * agency, a branch_manager sees their whole branch (every team in it, no
 * team_leader intermediary since Phase 2), agents see nothing.
 */
const app = createApp();

const PASSWORD = "Secret@123";
const PHONES = {
  admin: "7900000040",
  ops: "7900000041",
  bm: "7900000042",
  agentA: "7900000043", // field agent in branch manager's branch, team A
  agentB: "7900000044", // field agent in branch manager's branch, team B
  outsider: "7900000045", // other agency
  tele: "7900000046", // telecaller — desk job, stationary alert must not apply
  otherBranchAgent: "7900000047", // same agency, different branch -- outside the branch_manager's scope
};

let agencyId: string;
let otherAgencyId: string;
let teamAId: string;
let teamBId: string;
let otherBranchId: string;
const userIds: Record<string, string> = {};
const tokens: Record<string, string> = {};

const BASE = { lat: 18.5204, lng: 73.8567 };

async function login(phone: string): Promise<string> {
  const res = await request(app).post("/api/auth/login").send({ phone, password: PASSWORD });
  return res.body.access_token;
}

/** Insert a ping at an offset (meters, roughly) minutes ago. */
async function ping(userId: string, minutesAgo: number, northMeters = 0): Promise<void> {
  // ~1e-5 deg latitude ≈ 1.11 m
  const lat = BASE.lat + (northMeters / 111_320);
  await pool.query(
    `INSERT INTO location_pings (user_id, recorded_at, location, accuracy_meters)
     VALUES ($1, now() - make_interval(mins => $2), ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography, 10)
     ON CONFLICT DO NOTHING`,
    [userId, minutesAgo, BASE.lng, lat],
  );
}

async function punchIn(userId: string, minutesAgo: number): Promise<void> {
  await pool.query(
    `INSERT INTO attendance (user_id, punch_in_at, punch_in_location)
     VALUES ($1, now() - make_interval(mins => $2), ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography)`,
    [userId, minutesAgo, BASE.lng, BASE.lat],
  );
}

beforeAll(async () => {
  const agency = await pool.query(
    "INSERT INTO agencies (name) VALUES ('Tracking Test Agency') RETURNING id",
  );
  agencyId = agency.rows[0].id;
  const other = await pool.query(
    "INSERT INTO agencies (name) VALUES ('Other Tracking Agency') RETURNING id",
  );
  otherAgencyId = other.rows[0].id;

  const branch = await pool.query(
    "INSERT INTO branches (agency_id, name) VALUES ($1, 'Pune Branch') RETURNING id",
    [agencyId],
  );
  const teamA = await pool.query(
    "INSERT INTO teams (branch_id, name) VALUES ($1, 'Team A') RETURNING id",
    [branch.rows[0].id],
  );
  teamAId = teamA.rows[0].id;
  const teamB = await pool.query(
    "INSERT INTO teams (branch_id, name) VALUES ($1, 'Team B') RETURNING id",
    [branch.rows[0].id],
  );
  teamBId = teamB.rows[0].id;
  const otherBranch = await pool.query(
    "INSERT INTO branches (agency_id, name) VALUES ($1, 'Other Branch') RETURNING id",
    [agencyId],
  );
  otherBranchId = otherBranch.rows[0].id;

  const hash = await hashPassword(PASSWORD);
  const mk = async (
    key: keyof typeof PHONES,
    agency: string,
    flags: string,
    teamId: string | null,
    branchId: string | null,
  ) => {
    const designation =
      flags === "is_agency_admin"
        ? "agency_admin"
        : flags === "is_operations_manager"
          ? "operations_manager"
          : flags === "is_telecaller"
            ? "telecaller"
            : "field_agent";
    const { rows } = await pool.query(
      `INSERT INTO users (agency_id, full_name, phone, password_hash, team_id, branch_id, ${flags}, designation)
       VALUES ($1, $2, $3, $4, $5, $6, true, $7) RETURNING id`,
      [agency, `Track ${key}`, PHONES[key], hash, teamId, branchId, designation],
    );
    userIds[key] = rows[0].id;
    tokens[key] = await login(PHONES[key]);
  };

  await mk("admin", agencyId, "is_agency_admin", null, null);
  await mk("ops", agencyId, "is_operations_manager", null, null);
  const bm = await pool.query(
    `INSERT INTO users (agency_id, full_name, phone, password_hash, designation)
     VALUES ($1, 'Track bm', $2, $3, 'branch_manager') RETURNING id`,
    [agencyId, PHONES.bm, hash],
  );
  userIds.bm = bm.rows[0].id;
  tokens.bm = await login(PHONES.bm);
  await pool.query("UPDATE branches SET branch_manager_id = $1 WHERE id = $2", [
    userIds.bm,
    branch.rows[0].id,
  ]);
  await mk("agentA", agencyId, "is_field_agent", teamAId, branch.rows[0].id);
  await mk("agentB", agencyId, "is_field_agent", teamBId, branch.rows[0].id);
  await mk("outsider", otherAgencyId, "is_field_agent", null, null);
  await mk("tele", agencyId, "is_telecaller", teamBId, branch.rows[0].id);
  await mk("otherBranchAgent", agencyId, "is_field_agent", null, otherBranchId);
});

afterAll(async () => {
  const ids = Object.values(userIds);
  await pool.query("DELETE FROM location_pings WHERE user_id = ANY($1)", [ids]);
  await pool.query("DELETE FROM attendance WHERE user_id = ANY($1)", [ids]);
  // branches.branch_manager_id FKs to users -- clear it before deleting the
  // branch_manager row, or this delete throws on the FK constraint.
  await pool.query("UPDATE branches SET branch_manager_id = NULL WHERE agency_id = $1", [agencyId]);
  await pool.query("DELETE FROM users WHERE id = ANY($1)", [ids]);
  await pool.query("DELETE FROM teams WHERE id = ANY($1)", [[teamAId, teamBId]]);
  await pool.query("DELETE FROM branches WHERE agency_id = $1", [agencyId]);
  await pool.query("DELETE FROM agencies WHERE id = ANY($1)", [[agencyId, otherAgencyId]]);
  await pool.end();
});

describe("permission audit (brief Section 3)", () => {
  it("agency_admin holds every permission in the catalog", async () => {
    const { rows } = await pool.query(
      `SELECT key FROM permissions
        WHERE key NOT IN (SELECT permission_key FROM capability_permissions
                           WHERE capability = 'agency_admin')`,
    );
    expect(rows.map((r) => r.key)).toEqual([]);
  });

  it("operations_manager holds everything except admin-only keys", async () => {
    const { rows } = await pool.query(
      `SELECT key FROM permissions
        WHERE key NOT IN (SELECT permission_key FROM capability_permissions
                           WHERE capability = 'operations_manager')`,
    );
    expect(rows.map((r) => r.key).sort()).toEqual(["billing.view", "ops_managers.create"]);
  });

  // Phase 12: telecaller/field_agent were added so their mobile dashboards
  // can read their own attendance/GPS/route via the same tracking.view-gated
  // routes -- scope.ts's self-only fallback (see "rejects agents" below)
  // keeps this from widening what they can actually see.
  it("branch_manager has tracking.view; so do telecaller/field_agent (self-scoped)", async () => {
    const { rows } = await pool.query(
      `SELECT capability FROM capability_permissions WHERE permission_key = 'tracking.view'
        ORDER BY capability`,
    );
    expect(rows.map((r) => r.capability)).toEqual([
      "agency_admin",
      "branch_manager",
      "field_agent",
      "operations_manager",
      "telecaller",
    ]);
  });
});

describe("live view scoping", () => {
  beforeAll(async () => {
    // agentA: on duty 30 min, stationary at BASE the whole time (2-min pings)
    await punchIn(userIds.agentA, 30);
    for (let m = 28; m >= 0; m -= 2) await ping(userIds.agentA, m, m); // drift < 30m
    // agentB: on duty, moved 500m between pings, last ping fresh
    await punchIn(userIds.agentB, 30);
    await ping(userIds.agentB, 20, 0);
    await ping(userIds.agentB, 10, 500);
    await ping(userIds.agentB, 1, 1000);
    // outsider: on duty in the other agency
    await punchIn(userIds.outsider, 30);
    await ping(userIds.outsider, 1, 0);
    // telecaller: parked at their desk for 28 minutes — must NOT alert
    await punchIn(userIds.tele, 30);
    for (let m = 28; m >= 0; m -= 4) await ping(userIds.tele, m, 5000 + (m % 3));
  });

  // Phase 12: agentA (field_agent) now holds tracking.view, but is clamped to
  // self only -- sees their own live ping, never the rest of the team.
  it("an agent sees only themselves, never the rest of the team", async () => {
    const res = await request(app)
      .get("/api/tracking/live")
      .set("Authorization", `Bearer ${tokens.agentA}`);
    expect(res.status).toBe(200);
    const ids = res.body.agents.map((a: { user_id: string }) => a.user_id);
    expect(ids).toEqual([userIds.agentA]);
  });

  it("admin sees all on-duty agents of the agency, never other agencies", async () => {
    const res = await request(app)
      .get("/api/tracking/live")
      .set("Authorization", `Bearer ${tokens.admin}`);
    expect(res.status).toBe(200);
    const ids = res.body.agents.map((a: { user_id: string }) => a.user_id).sort();
    expect(ids).toEqual([userIds.agentA, userIds.agentB, userIds.tele].sort());
  });

  it("ops manager sees the same agency-wide view", async () => {
    const res = await request(app)
      .get("/api/tracking/live")
      .set("Authorization", `Bearer ${tokens.ops}`);
    const ids = res.body.agents.map((a: { user_id: string }) => a.user_id).sort();
    expect(ids).toEqual([userIds.agentA, userIds.agentB, userIds.tele].sort());
  });

  it("branch_manager sees every on-duty agent in their branch, across teams", async () => {
    const res = await request(app)
      .get("/api/tracking/live")
      .set("Authorization", `Bearer ${tokens.bm}`);
    const ids = res.body.agents.map((a: { user_id: string }) => a.user_id).sort();
    expect(ids).toEqual([userIds.agentA, userIds.agentB, userIds.tele].sort());
  });

  it("flags an agent parked in one spot for 20+ minutes as stationary", async () => {
    const res = await request(app)
      .get("/api/tracking/live")
      .set("Authorization", `Bearer ${tokens.admin}`);
    const a = res.body.agents.find((x: { user_id: string }) => x.user_id === userIds.agentA);
    expect(a.status).toBe("stationary");
    expect(a.stationary_minutes).toBeGreaterThanOrEqual(20);
    expect(a.stationary_since).toBeDefined();
    expect(res.body.alerts.map((x: { user_id: string }) => x.user_id)).toContain(userIds.agentA);
  });

  it("a telecaller parked at their desk never alerts as stationary", async () => {
    const res = await request(app)
      .get("/api/tracking/live")
      .set("Authorization", `Bearer ${tokens.admin}`);
    const t = res.body.agents.find((x: { user_id: string }) => x.user_id === userIds.tele);
    expect(t.status).toBe("moving");
    expect(res.body.alerts.map((x: { user_id: string }) => x.user_id)).not.toContain(
      userIds.tele,
    );
  });

  it("an agent covering ground stays 'moving' and out of alerts", async () => {
    const res = await request(app)
      .get("/api/tracking/live")
      .set("Authorization", `Bearer ${tokens.admin}`);
    const b = res.body.agents.find((x: { user_id: string }) => x.user_id === userIds.agentB);
    expect(b.status).toBe("moving");
    expect(res.body.alerts.map((x: { user_id: string }) => x.user_id)).not.toContain(
      userIds.agentB,
    );
  });

  it("flags no_signal when the last ping is stale, awaiting_first_ping when none", async () => {
    // agentB's pings suddenly stop: rewrite them as 15+ minutes old
    await pool.query(
      "UPDATE location_pings SET recorded_at = recorded_at - interval '15 minutes' WHERE user_id = $1",
      [userIds.agentB],
    );
    // branch_manager punches in but has no pings yet
    await punchIn(userIds.bm, 1);

    const res = await request(app)
      .get("/api/tracking/live")
      .set("Authorization", `Bearer ${tokens.admin}`);
    const b = res.body.agents.find((x: { user_id: string }) => x.user_id === userIds.agentB);
    expect(b.status).toBe("no_signal");
    const bm = res.body.agents.find((x: { user_id: string }) => x.user_id === userIds.bm);
    expect(bm.status).toBe("awaiting_first_ping");
    expect(res.body.alerts.map((x: { user_id: string }) => x.user_id)).toContain(userIds.agentB);
  });

  it("only pings since punch-in count toward the dwell (yesterday's parking spot doesn't)", async () => {
    // agentA re-punches: old shift closed 5 min ago, new shift 2 min old,
    // one fresh ping at the same spot — dwell restarts, not stationary yet.
    await pool.query(
      "UPDATE attendance SET punch_out_at = now() - interval '5 minutes' WHERE user_id = $1 AND punch_out_at IS NULL",
      [userIds.agentA],
    );
    await punchIn(userIds.agentA, 2);
    await ping(userIds.agentA, 0, 0);

    const res = await request(app)
      .get("/api/tracking/live")
      .set("Authorization", `Bearer ${tokens.admin}`);
    const a = res.body.agents.find((x: { user_id: string }) => x.user_id === userIds.agentA);
    expect(a.status).toBe("moving");
  });
});

describe("route replay", () => {
  const today = new Date().toISOString().slice(0, 10);

  it("returns the day's ordered points and path length", async () => {
    const res = await request(app)
      .get(`/api/tracking/route?user_id=${userIds.agentB}&date=${today}`)
      .set("Authorization", `Bearer ${tokens.ops}`);
    expect(res.status).toBe(200);
    expect(res.body.points.length).toBe(3);
    const times = res.body.points.map((p: { recorded_at: string }) => p.recorded_at);
    expect([...times].sort()).toEqual(times);
    // 0 → 500m → 1000m north ≈ 1km of path
    expect(res.body.distance_meters).toBeGreaterThan(900);
    expect(res.body.distance_meters).toBeLessThan(1100);
    expect(res.body.shifts.length).toBeGreaterThan(0);
  });

  it("branch_manager can replay an agent on a different team in their own branch", async () => {
    const res = await request(app)
      .get(`/api/tracking/route?user_id=${userIds.agentB}&date=${today}`)
      .set("Authorization", `Bearer ${tokens.bm}`);
    expect(res.status).toBe(200);
  });

  it("branch_manager cannot replay an agent outside their branch", async () => {
    const res = await request(app)
      .get(`/api/tracking/route?user_id=${userIds.otherBranchAgent}&date=${today}`)
      .set("Authorization", `Bearer ${tokens.bm}`);
    expect(res.status).toBe(404);
  });

  it("never leaks users of another agency", async () => {
    const res = await request(app)
      .get(`/api/tracking/route?user_id=${userIds.outsider}&date=${today}`)
      .set("Authorization", `Bearer ${tokens.admin}`);
    expect(res.status).toBe(404);
  });

  it("rejects a malformed date", async () => {
    const res = await request(app)
      .get(`/api/tracking/route?user_id=${userIds.agentB}&date=06-07-2026`)
      .set("Authorization", `Bearer ${tokens.admin}`);
    expect(res.status).toBe(400);
  });

  it("a date with no pings returns an empty route, not an error", async () => {
    const res = await request(app)
      .get(`/api/tracking/route?user_id=${userIds.agentB}&date=2020-01-01`)
      .set("Authorization", `Bearer ${tokens.admin}`);
    expect(res.status).toBe(200);
    expect(res.body.points).toEqual([]);
    expect(res.body.distance_meters).toBe(0);
  });
});
