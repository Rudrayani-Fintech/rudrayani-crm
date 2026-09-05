import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { pool } from "../src/config/db";
import { hashPassword } from "../src/services/auth-service";

/**
 * Task 5.1: buckets master — ordering + category/current flags that feed the
 * performance dashboard's Normalization/Rollback/Recovery math.
 */
const app = createApp();

const PASSWORD = "Secret@123";
const ADMIN_PHONE = "7910000070";
const AGENT_PHONE = "7910000071";

let agencyId: string;
let otherAgencyId: string;
let companyId: string;
let otherCompanyId: string;
let adminToken: string;
let agentToken: string;
const bucketIds: Record<string, string> = {};

async function login(phone: string): Promise<string> {
  const res = await request(app).post("/api/auth/login").send({ phone, password: PASSWORD });
  return res.body.access_token;
}

beforeAll(async () => {
  const agency = await pool.query(
    "INSERT INTO agencies (name) VALUES ('Buckets Agency') RETURNING id",
  );
  agencyId = agency.rows[0].id;
  const otherAgency = await pool.query(
    "INSERT INTO agencies (name) VALUES ('Buckets Other Agency') RETURNING id",
  );
  otherAgencyId = otherAgency.rows[0].id;
  const company = await pool.query(
    "INSERT INTO companies (agency_id, name) VALUES ($1, 'Buckets NBFC') RETURNING id",
    [agencyId],
  );
  companyId = company.rows[0].id;
  const otherCompany = await pool.query(
    "INSERT INTO companies (agency_id, name) VALUES ($1, 'Foreign NBFC') RETURNING id",
    [otherAgencyId],
  );
  otherCompanyId = otherCompany.rows[0].id;

  const hash = await hashPassword(PASSWORD);
  await pool.query(
    `INSERT INTO users (agency_id, full_name, phone, password_hash, is_agency_admin, designation)
     VALUES ($1, 'Buckets Admin', $2, $3, true, 'agency_admin')`,
    [agencyId, ADMIN_PHONE, hash],
  );
  await pool.query(
    `INSERT INTO users (agency_id, full_name, phone, password_hash, is_field_agent, designation)
     VALUES ($1, 'Buckets Agent', $2, $3, true, 'field_agent')`,
    [agencyId, AGENT_PHONE, hash],
  );

  // Seed master rows the way imports do (labels land unordered).
  for (const [i, label] of ["Current", "X", "30", "60", "NPA"].entries()) {
    const { rows } = await pool.query(
      `INSERT INTO buckets (company_id, label, sort_order) VALUES ($1, $2, $3) RETURNING id`,
      [companyId, label, i],
    );
    bucketIds[label] = rows[0].id;
  }
  await pool.query(
    `INSERT INTO buckets (company_id, label, sort_order) VALUES ($1, 'Foreign Bucket', 0)`,
    [otherCompanyId],
  );

  adminToken = await login(ADMIN_PHONE);
  agentToken = await login(AGENT_PHONE);
});

afterAll(async () => {
  await pool.query("DELETE FROM buckets WHERE company_id IN ($1, $2)", [
    companyId,
    otherCompanyId,
  ]);
  await pool.query("DELETE FROM users WHERE agency_id IN ($1, $2)", [agencyId, otherAgencyId]);
  await pool.query("DELETE FROM companies WHERE agency_id IN ($1, $2)", [
    agencyId,
    otherAgencyId,
  ]);
  await pool.query("DELETE FROM agencies WHERE id IN ($1, $2)", [agencyId, otherAgencyId]);
  await pool.end();
});

describe("buckets master", () => {
  it("lists buckets in sort order for any authenticated user", async () => {
    const res = await request(app)
      .get(`/api/buckets?company_id=${companyId}`)
      .set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
    expect(res.body.buckets.map((b: { label: string }) => b.label)).toEqual([
      "Current",
      "X",
      "30",
      "60",
      "NPA",
    ]);
  });

  it("rejects listing a company from another agency", async () => {
    const res = await request(app)
      .get(`/api/buckets?company_id=${otherCompanyId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  it("reorder rewrites sort_order to match the sent sequence", async () => {
    const newOrder = ["Current", "X", "30", "60", "NPA"].reverse().map((l) => bucketIds[l]);
    const res = await request(app)
      .put("/api/buckets/reorder")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ company_id: companyId, ordered_ids: newOrder });
    expect(res.status).toBe(200);

    const list = await request(app)
      .get(`/api/buckets?company_id=${companyId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(list.body.buckets.map((b: { label: string }) => b.label)).toEqual([
      "NPA",
      "60",
      "30",
      "X",
      "Current",
    ]);

    // restore for later tests
    await request(app)
      .put("/api/buckets/reorder")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        company_id: companyId,
        ordered_ids: ["Current", "X", "30", "60", "NPA"].map((l) => bucketIds[l]),
      });
  });

  it("reorder must include every bucket exactly once", async () => {
    const res = await request(app)
      .put("/api/buckets/reorder")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ company_id: companyId, ordered_ids: [bucketIds.Current] });
    expect(res.status).toBe(400);
  });

  it("marks category and enforces a single current bucket per company", async () => {
    const npa = await request(app)
      .patch(`/api/buckets/${bucketIds.NPA}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ category: "npa" });
    expect(npa.status).toBe(200);
    expect(npa.body.bucket.category).toBe("npa");

    await request(app)
      .patch(`/api/buckets/${bucketIds.X}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ is_current: true });
    const res = await request(app)
      .patch(`/api/buckets/${bucketIds.Current}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ is_current: true });
    expect(res.status).toBe(200);

    const list = await request(app)
      .get(`/api/buckets?company_id=${companyId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    const current = list.body.buckets.filter((b: { is_current: boolean }) => b.is_current);
    expect(current).toHaveLength(1);
    expect(current[0].label).toBe("Current");
  });

  it("agents cannot modify the bucket master", async () => {
    const patch = await request(app)
      .patch(`/api/buckets/${bucketIds.Current}`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ category: "npa" });
    expect(patch.status).toBe(403);

    const reorder = await request(app)
      .put("/api/buckets/reorder")
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ company_id: companyId, ordered_ids: Object.values(bucketIds) });
    expect(reorder.status).toBe(403);
  });

  it("cannot patch a bucket belonging to another agency", async () => {
    const { rows } = await pool.query("SELECT id FROM buckets WHERE company_id = $1", [
      otherCompanyId,
    ]);
    const res = await request(app)
      .patch(`/api/buckets/${rows[0].id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ category: "npa" });
    expect(res.status).toBe(404);
  });
});
