import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { pool } from "../src/config/db";
import { hashPassword } from "../src/services/auth-service";

/** Phase C3: per-user dashboard show/hide + reorder preferences. */
const app = createApp();

const PASSWORD = "Secret@123";
const USER_A_PHONE = "7940000001";
const USER_B_PHONE = "7940000002";

let agencyId: string;
let tokenA: string;
let tokenB: string;

async function login(phone: string): Promise<string> {
  const res = await request(app).post("/api/auth/login").send({ phone, password: PASSWORD });
  return res.body.access_token;
}

beforeAll(async () => {
  const agency = await pool.query(
    "INSERT INTO agencies (name) VALUES ('Dashboard Prefs Agency') RETURNING id",
  );
  agencyId = agency.rows[0].id;

  const hash = await hashPassword(PASSWORD);
  await pool.query(
    `INSERT INTO users (agency_id, full_name, phone, password_hash, is_agency_admin, designation)
     VALUES ($1, 'Prefs User A', $2, $3, true, 'agency_admin')`,
    [agencyId, USER_A_PHONE, hash],
  );
  await pool.query(
    `INSERT INTO users (agency_id, full_name, phone, password_hash, is_agency_admin, designation)
     VALUES ($1, 'Prefs User B', $2, $3, true, 'agency_admin')`,
    [agencyId, USER_B_PHONE, hash],
  );

  tokenA = await login(USER_A_PHONE);
  tokenB = await login(USER_B_PHONE);
});

afterAll(async () => {
  await pool.query("DELETE FROM dashboard_preferences WHERE user_id IN (SELECT id FROM users WHERE agency_id = $1)", [agencyId]);
  await pool.query("DELETE FROM users WHERE agency_id = $1", [agencyId]);
  await pool.query("DELETE FROM agencies WHERE id = $1", [agencyId]);
  await pool.end();
});

describe("dashboard preferences", () => {
  it("GET with no saved layout returns null", async () => {
    const res = await request(app)
      .get("/api/dashboard-preferences")
      .set("Authorization", `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    expect(res.body.layout).toBeNull();
  });

  it("PUT then GET round-trips the layout", async () => {
    const layout = {
      widgets: [
        { id: "collection-hero", visible: true, order: 0 },
        { id: "overview-chart", visible: false, order: 1 },
      ],
    };
    const put = await request(app)
      .put("/api/dashboard-preferences")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ layout });
    expect(put.status).toBe(200);
    expect(put.body.layout).toEqual(layout);

    const get = await request(app)
      .get("/api/dashboard-preferences")
      .set("Authorization", `Bearer ${tokenA}`);
    expect(get.status).toBe(200);
    expect(get.body.layout).toEqual(layout);
  });

  it("PUT with an invalid widgets shape 400s", async () => {
    const res = await request(app)
      .put("/api/dashboard-preferences")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ layout: { widgets: [{ id: "x" }] } }); // missing visible/order
    expect(res.status).toBe(400);
  });

  it("user A's PUT does not affect user B's GET", async () => {
    const res = await request(app)
      .get("/api/dashboard-preferences")
      .set("Authorization", `Bearer ${tokenB}`);
    expect(res.status).toBe(200);
    expect(res.body.layout).toBeNull();
  });

  it("DELETE resets to default (null)", async () => {
    const del = await request(app)
      .delete("/api/dashboard-preferences")
      .set("Authorization", `Bearer ${tokenA}`);
    expect(del.status).toBe(200);
    expect(del.body.layout).toBeNull();

    const get = await request(app)
      .get("/api/dashboard-preferences")
      .set("Authorization", `Bearer ${tokenA}`);
    expect(get.body.layout).toBeNull();
  });
});
