import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { pool } from "../src/config/db";
import { hashPassword } from "../src/services/auth-service";

/**
 * Generic supporting-document attachments (Group D): images and PDFs, per
 * customer, distinct from the single hard-coded photo fields on
 * payments/field_visits.
 */
const app = createApp();

const AGENT_PHONE = "7900000090";
const OTHER_AGENT_PHONE = "7900000091";
const PASSWORD = "Secret@123";

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const MINIMAL_PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF");

let agencyId: string;
let otherAgencyId: string;
let companyId: string;
let agentToken: string;
let otherAgentToken: string;
let customerId: string;
let otherAgencyCustomerId: string;

async function login(phone: string): Promise<string> {
  const res = await request(app).post("/api/auth/login").send({ phone, password: PASSWORD });
  return res.body.access_token;
}

beforeAll(async () => {
  const agency = await pool.query(
    "INSERT INTO agencies (name) VALUES ('Attachments Test Agency') RETURNING id",
  );
  agencyId = agency.rows[0].id;
  const otherAgency = await pool.query(
    "INSERT INTO agencies (name) VALUES ('Other Agency (attachments)') RETURNING id",
  );
  otherAgencyId = otherAgency.rows[0].id;

  const company = await pool.query(
    "INSERT INTO companies (agency_id, name) VALUES ($1, 'Test NBFC') RETURNING id",
    [agencyId],
  );
  companyId = company.rows[0].id;
  const otherCompany = await pool.query(
    "INSERT INTO companies (agency_id, name) VALUES ($1, 'Other NBFC') RETURNING id",
    [otherAgencyId],
  );

  const hash = await hashPassword(PASSWORD);
  await pool.query(
    `INSERT INTO users (agency_id, full_name, phone, password_hash, is_telecaller, designation)
     VALUES ($1, 'Attach Agent', $2, $3, true, 'telecaller')`,
    [agencyId, AGENT_PHONE, hash],
  );
  await pool.query(
    `INSERT INTO users (agency_id, full_name, phone, password_hash, is_telecaller, designation)
     VALUES ($1, 'Other Agency Agent', $2, $3, true, 'telecaller')`,
    [otherAgencyId, OTHER_AGENT_PHONE, hash],
  );

  const customer = await pool.query(
    `INSERT INTO customers (company_id, loan_number, customer_name, mobile_number, product, bucket, due_amount)
     VALUES ($1, 'ATT-001', 'Doc Customer', '9877777777', 'Personal Loan', 'B1', 40000)
     RETURNING id`,
    [companyId],
  );
  customerId = customer.rows[0].id;
  const otherCustomer = await pool.query(
    `INSERT INTO customers (company_id, loan_number, customer_name, mobile_number, product, bucket, due_amount)
     VALUES ($1, 'OTH-ATT-001', 'Foreign Customer', '9888888888', 'Personal Loan', 'B1', 15000)
     RETURNING id`,
    [otherCompany.rows[0].id],
  );
  otherAgencyCustomerId = otherCustomer.rows[0].id;

  agentToken = await login(AGENT_PHONE);
  otherAgentToken = await login(OTHER_AGENT_PHONE);
});

afterAll(async () => {
  await pool.query(
    "DELETE FROM attachments WHERE agency_id IN ($1, $2)",
    [agencyId, otherAgencyId],
  );
  await pool.query(
    "DELETE FROM customers WHERE company_id IN (SELECT id FROM companies WHERE agency_id IN ($1, $2))",
    [agencyId, otherAgencyId],
  );
  await pool.query("DELETE FROM companies WHERE agency_id IN ($1, $2)", [agencyId, otherAgencyId]);
  await pool.query("DELETE FROM users WHERE agency_id IN ($1, $2)", [agencyId, otherAgencyId]);
  await pool.query("DELETE FROM agencies WHERE id IN ($1, $2)", [agencyId, otherAgencyId]);
  await pool.end();
});

describe("POST /api/attachments", () => {
  it("uploads a photo and it round-trips byte-identical", async () => {
    const res = await request(app)
      .post("/api/attachments")
      .set("Authorization", `Bearer ${agentToken}`)
      .field("customer_id", customerId)
      .field("note", "KYC selfie")
      .attach("file", PNG_1PX, { filename: "kyc.png", contentType: "image/png" });
    expect(res.status).toBe(201);
    expect(res.body.attachment.kind).toBe("photo");

    const file = await request(app)
      .get(`/api/attachments/${res.body.attachment.id}/file`)
      .set("Authorization", `Bearer ${agentToken}`);
    expect(file.status).toBe(200);
    expect(file.headers["content-type"]).toBe("image/png");
    expect(Buffer.compare(file.body, PNG_1PX)).toBe(0);
  });

  it("uploads a PDF and classifies it as a document", async () => {
    const res = await request(app)
      .post("/api/attachments")
      .set("Authorization", `Bearer ${agentToken}`)
      .field("customer_id", customerId)
      .attach("file", MINIMAL_PDF, { filename: "agreement.pdf", contentType: "application/pdf" });
    expect(res.status).toBe(201);
    expect(res.body.attachment.kind).toBe("document");
    expect(res.body.attachment.file_name).toBe("agreement.pdf");

    const file = await request(app)
      .get(`/api/attachments/${res.body.attachment.id}/file`)
      .set("Authorization", `Bearer ${agentToken}`);
    expect(file.status).toBe(200);
    expect(file.headers["content-type"]).toBe("application/pdf");
  });

  it("rejects an unsupported mimetype", async () => {
    const res = await request(app)
      .post("/api/attachments")
      .set("Authorization", `Bearer ${agentToken}`)
      .field("customer_id", customerId)
      .attach("file", Buffer.from("not a real file"), {
        filename: "notes.txt",
        contentType: "text/plain",
      });
    expect(res.status).toBe(400);
  });

  it("rejects a customer outside the caller's agency", async () => {
    const res = await request(app)
      .post("/api/attachments")
      .set("Authorization", `Bearer ${agentToken}`)
      .field("customer_id", otherAgencyCustomerId)
      .attach("file", PNG_1PX, { filename: "kyc.png", contentType: "image/png" });
    expect(res.status).toBe(404);
  });

  it("replaying the same client_key is idempotent", async () => {
    const clientKey = "c4a7f1e0-2222-4b3c-9d4e-000000000001";
    const first = await request(app)
      .post("/api/attachments")
      .set("Authorization", `Bearer ${agentToken}`)
      .field("customer_id", customerId)
      .field("client_key", clientKey)
      .attach("file", PNG_1PX, { filename: "dup.png", contentType: "image/png" });
    expect(first.status).toBe(201);

    const replay = await request(app)
      .post("/api/attachments")
      .set("Authorization", `Bearer ${agentToken}`)
      .field("customer_id", customerId)
      .field("client_key", clientKey)
      .attach("file", PNG_1PX, { filename: "dup.png", contentType: "image/png" });
    expect(replay.status).toBe(200);
    expect(replay.body.duplicate).toBe(true);
    expect(replay.body.attachment.id).toBe(first.body.attachment.id);
  });
});

describe("GET /api/attachments", () => {
  it("lists attachments for a customer, newest first", async () => {
    const res = await request(app)
      .get(`/api/attachments?customer_id=${customerId}`)
      .set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
    expect(res.body.attachments.length).toBeGreaterThanOrEqual(3);
    expect(res.body.attachments[0].uploaded_by_name).toBe("Attach Agent");
  });

  it("an agent from another agency sees no rows for a customer outside their scope", async () => {
    const list = await request(app)
      .get(`/api/attachments?customer_id=${customerId}`)
      .set("Authorization", `Bearer ${otherAgentToken}`);
    expect(list.status).toBe(200);
    expect(list.body.attachments).toHaveLength(0);
  });

  it("an agent from another agency cannot fetch the file directly by id", async () => {
    const upload = await request(app)
      .post("/api/attachments")
      .set("Authorization", `Bearer ${agentToken}`)
      .field("customer_id", customerId)
      .attach("file", PNG_1PX, { filename: "scoped.png", contentType: "image/png" });

    const file = await request(app)
      .get(`/api/attachments/${upload.body.attachment.id}/file`)
      .set("Authorization", `Bearer ${otherAgentToken}`);
    expect(file.status).toBe(404);
  });
});
