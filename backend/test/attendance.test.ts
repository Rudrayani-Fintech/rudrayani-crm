import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { pool } from "../src/config/db";
import { hashPassword } from "../src/services/auth-service";

/**
 * Task 4.1: punch-in/out attendance, batch location-ping ingestion with
 * idempotent re-send, and the tracking config endpoint. Brief Sections 9, 10.
 */
const app = createApp();

const AGENT_PHONE = "7900000030";
const PASSWORD = "Secret@123";

let agencyId: string;
let agentId: string;
let agentToken: string;

const PUNE = { lat: 18.5204, lng: 73.8567 };

function isoMinutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

beforeAll(async () => {
  const agency = await pool.query(
    "INSERT INTO agencies (name) VALUES ('Attendance Test Agency') RETURNING id",
  );
  agencyId = agency.rows[0].id;

  const hash = await hashPassword(PASSWORD);
  const agent = await pool.query(
    `INSERT INTO users (agency_id, full_name, phone, password_hash, is_field_agent, designation)
     VALUES ($1, 'Track Agent', $2, $3, true, 'field_agent') RETURNING id`,
    [agencyId, AGENT_PHONE, hash],
  );
  agentId = agent.rows[0].id;

  const login = await request(app)
    .post("/api/auth/login")
    .send({ phone: AGENT_PHONE, password: PASSWORD });
  agentToken = login.body.access_token;
});

afterAll(async () => {
  await pool.query("DELETE FROM location_pings WHERE user_id = $1", [agentId]);
  await pool.query("DELETE FROM attendance WHERE user_id = $1", [agentId]);
  await pool.query("DELETE FROM users WHERE id = $1", [agentId]);
  await pool.query("DELETE FROM agencies WHERE id = $1", [agencyId]);
  await pool.end();
});

describe("attendance & location tracking", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await request(app).post("/api/attendance/punch-in").send(PUNE);
    expect(res.status).toBe(401);
  });

  it("reports not punched in before the shift starts", async () => {
    const res = await request(app)
      .get("/api/attendance/status")
      .set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
    expect(res.body.punched_in).toBe(false);
    expect(res.body.attendance).toBeNull();
  });

  it("rejects punch-out with no open shift", async () => {
    const res = await request(app)
      .post("/api/attendance/punch-out")
      .set("Authorization", `Bearer ${agentToken}`)
      .send(PUNE);
    expect(res.status).toBe(409);
  });

  it("punches in with a GPS point", async () => {
    const res = await request(app)
      .post("/api/attendance/punch-in")
      .set("Authorization", `Bearer ${agentToken}`)
      .send(PUNE);
    expect(res.status).toBe(201);
    expect(res.body.attendance.id).toBeDefined();
    expect(res.body.attendance.punch_in_at).toBeDefined();

    const { rows } = await pool.query(
      `SELECT ST_Y(punch_in_location::geometry) AS lat, ST_X(punch_in_location::geometry) AS lng
         FROM attendance WHERE id = $1`,
      [res.body.attendance.id],
    );
    expect(Number(rows[0].lat)).toBeCloseTo(PUNE.lat, 4);
    expect(Number(rows[0].lng)).toBeCloseTo(PUNE.lng, 4);
  });

  it("rejects a second punch-in while the shift is open", async () => {
    const res = await request(app)
      .post("/api/attendance/punch-in")
      .set("Authorization", `Bearer ${agentToken}`)
      .send(PUNE);
    expect(res.status).toBe(409);
  });

  it("shows the open shift in status", async () => {
    const res = await request(app)
      .get("/api/attendance/status")
      .set("Authorization", `Bearer ${agentToken}`);
    expect(res.body.punched_in).toBe(true);
    expect(res.body.attendance.punch_in_at).toBeDefined();
  });

  const firstBatch = [8, 6, 4, 2].map((m) => ({
    recorded_at: isoMinutesAgo(m),
    lat: PUNE.lat + m * 0.0001,
    lng: PUNE.lng + m * 0.0001,
    accuracy_meters: 12.5,
  }));

  it("accepts a batch of pings", async () => {
    const res = await request(app)
      .post("/api/location/pings")
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ pings: firstBatch });
    expect(res.status).toBe(201);
    expect(res.body.received).toBe(4);
    expect(res.body.inserted).toBe(4);
  });

  it("ignores duplicate pings on re-send (offline catch-up idempotency)", async () => {
    const duplicate = firstBatch[2];
    const fresh = { recorded_at: isoMinutesAgo(1), lat: PUNE.lat, lng: PUNE.lng };
    const res = await request(app)
      .post("/api/location/pings")
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ pings: [duplicate, fresh] });
    expect(res.status).toBe(201);
    expect(res.body.received).toBe(2);
    expect(res.body.inserted).toBe(1);

    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM location_pings WHERE user_id = $1",
      [agentId],
    );
    expect(rows[0].n).toBe(5);
  });

  it("rejects out-of-range coordinates", async () => {
    const res = await request(app)
      .post("/api/location/pings")
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ pings: [{ recorded_at: isoMinutesAgo(0), lat: 123, lng: 73.8 }] });
    expect(res.status).toBe(400);
  });

  it("serves the default tracking config", async () => {
    const res = await request(app)
      .get("/api/location/config")
      .set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
    expect(res.body.ping_interval_seconds).toBe(120);
    expect(res.body.retention_days).toBe(60);
  });

  it("serves a per-agency ping interval override", async () => {
    await pool.query(
      `UPDATE agencies SET settings = jsonb_set(settings, '{ping_interval_seconds}', '60') WHERE id = $1`,
      [agencyId],
    );
    const res = await request(app)
      .get("/api/location/config")
      .set("Authorization", `Bearer ${agentToken}`);
    expect(res.body.ping_interval_seconds).toBe(60);
  });

  it("punches out and closes the shift", async () => {
    const res = await request(app)
      .post("/api/attendance/punch-out")
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ lat: PUNE.lat + 0.001, lng: PUNE.lng + 0.001 });
    expect(res.status).toBe(200);
    expect(res.body.attendance.punch_out_at).toBeDefined();

    const status = await request(app)
      .get("/api/attendance/status")
      .set("Authorization", `Bearer ${agentToken}`);
    expect(status.body.punched_in).toBe(false);
  });

  it("allows a fresh punch-in after punch-out (next shift)", async () => {
    const res = await request(app)
      .post("/api/attendance/punch-in")
      .set("Authorization", `Bearer ${agentToken}`)
      .send(PUNE);
    expect(res.status).toBe(201);

    const out = await request(app)
      .post("/api/attendance/punch-out")
      .set("Authorization", `Bearer ${agentToken}`)
      .send(PUNE);
    expect(out.status).toBe(200);
  });
});
