import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { pool } from "../src/config/db";
import { hashPassword } from "../src/services/auth-service";

/**
 * Task (Phase 7 correction): DPD cross-check. Buckets are still 100%
 * lender-supplied and authoritative -- this report independently computes
 * DPD from an EMI due date (standard 30-day increments: 0-29=canonical 0,
 * 30-59=1, 60-89=2, ...) purely to flag disagreements for review. It must
 * never be used to infer the "real" bucket, only to catch cases worth a
 * second look.
 */
const app = createApp();

const PASSWORD = "Secret@123";
const ADMIN_PHONE = "7960000090";

let agencyId: string;
let companyId: string;
let adminToken: string;

async function login(phone: string): Promise<string> {
  const res = await request(app).post("/api/auth/login").send({ phone, password: PASSWORD });
  return res.body.access_token;
}

/** Inserts a customer with due_date set N days before today (positive N = overdue). */
async function customerWithDpd(loanNumber: string, bucketLabel: string, daysOverdue: number) {
  const { rows } = await pool.query(
    `INSERT INTO customers (company_id, loan_number, customer_name, bucket, due_amount, emi, due_date)
     VALUES ($1, $2, $2, $3, 10000, 1000, CURRENT_DATE - $4::int)
     RETURNING id`,
    [companyId, loanNumber, bucketLabel, daysOverdue],
  );
  return rows[0].id as string;
}

beforeAll(async () => {
  const agency = await pool.query(
    "INSERT INTO agencies (name) VALUES ('Bucket Mismatch Agency') RETURNING id",
  );
  agencyId = agency.rows[0].id;
  const company = await pool.query(
    "INSERT INTO companies (agency_id, name) VALUES ($1, 'Mismatch NBFC') RETURNING id",
    [agencyId],
  );
  companyId = company.rows[0].id;

  const hash = await hashPassword(PASSWORD);
  await pool.query(
    `INSERT INTO users (agency_id, full_name, phone, password_hash, is_agency_admin, designation)
     VALUES ($1, 'Mismatch Admin', $2, $3, true, 'agency_admin')`,
    [agencyId, ADMIN_PHONE, hash],
  );
  adminToken = await login(ADMIN_PHONE);

  // Canonical bucket master: X=0, 1=1 (30-59 DPD), 2=2 (60-89 DPD).
  await pool.query(
    `INSERT INTO buckets (company_id, label, sort_order, canonical_bucket, is_current)
     VALUES ($1, 'X', 0, 0, true)`,
    [companyId],
  );
  await pool.query(
    `INSERT INTO buckets (company_id, label, sort_order, canonical_bucket) VALUES ($1, '1', 1, 1)`,
    [companyId],
  );
  await pool.query(
    `INSERT INTO buckets (company_id, label, sort_order, canonical_bucket) VALUES ($1, '2', 2, 2)`,
    [companyId],
  );
  // Unmapped bucket -- customers here must never appear in the mismatch report.
  await pool.query(`INSERT INTO buckets (company_id, label, sort_order) VALUES ($1, '3', 3)`, [
    companyId,
  ]);
});

afterAll(async () => {
  await pool.query(`DELETE FROM customers WHERE company_id = $1`, [companyId]);
  await pool.query(`DELETE FROM buckets WHERE company_id = $1`, [companyId]);
  await pool.query(`DELETE FROM companies WHERE id = $1`, [companyId]);
  await pool.query(`DELETE FROM users WHERE agency_id = $1`, [agencyId]);
  await pool.query(`DELETE FROM agencies WHERE id = $1`, [agencyId]);
  await pool.end();
});

describe("bucket mismatch (DPD cross-check) report", () => {
  it("flags a lender bucket that disagrees with the due-date-implied bucket", async () => {
    // 45 days overdue -> DPD-implied canonical 1, but lender says "X" (canonical 0).
    await customerWithDpd("DPD-MISMATCH-1", "X", 45);

    const res = await request(app)
      .get(`/api/reports/bucket-mismatches?company_id=${companyId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const row = res.body.rows.find((r: { loan_number: string }) => r.loan_number === "DPD-MISMATCH-1");
    expect(row).toBeDefined();
    expect(row.lender_bucket).toBe("X");
    expect(row.lender_canonical).toBe(0);
    expect(row.dpd).toBe(45);
    expect(row.computed_canonical).toBe(1);
  });

  it("does not flag a customer whose lender bucket agrees with the due-date-implied bucket", async () => {
    // 40 days overdue -> DPD-implied canonical 1, lender also says "1". Agreement -- no flag.
    await customerWithDpd("DPD-AGREE-1", "1", 40);

    const res = await request(app)
      .get(`/api/reports/bucket-mismatches?company_id=${companyId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const row = res.body.rows.find((r: { loan_number: string }) => r.loan_number === "DPD-AGREE-1");
    expect(row).toBeUndefined();
  });

  it("never flags a customer with no due_date (undetectable, not a false mismatch)", async () => {
    await pool.query(
      `INSERT INTO customers (company_id, loan_number, customer_name, bucket, due_amount, emi)
       VALUES ($1, 'DPD-NO-DUE-DATE', 'No Due Date', 'X', 10000, 1000)`,
      [companyId],
    );
    const res = await request(app)
      .get(`/api/reports/bucket-mismatches?company_id=${companyId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    const row = res.body.rows.find((r: { loan_number: string }) => r.loan_number === "DPD-NO-DUE-DATE");
    expect(row).toBeUndefined();
  });

  it("never flags a customer whose bucket label isn't canonically mapped", async () => {
    // Bucket "3" exists but has no canonical_bucket set -- undetectable, must be excluded.
    await customerWithDpd("DPD-UNMAPPED-BUCKET", "3", 100);
    const res = await request(app)
      .get(`/api/reports/bucket-mismatches?company_id=${companyId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    const row = res.body.rows.find((r: { loan_number: string }) => r.loan_number === "DPD-UNMAPPED-BUCKET");
    expect(row).toBeUndefined();
  });

  it("excludes recalled/closed customers -- only the active book is cross-checked", async () => {
    await pool.query(
      `INSERT INTO customers (company_id, loan_number, customer_name, bucket, due_amount, emi, due_date, status, recalled_at)
       VALUES ($1, 'DPD-RECALLED', 'Recalled Guy', 'X', 10000, 1000, CURRENT_DATE - 90, 'recalled', now())`,
      [companyId],
    );
    const res = await request(app)
      .get(`/api/reports/bucket-mismatches?company_id=${companyId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    const row = res.body.rows.find((r: { loan_number: string }) => r.loan_number === "DPD-RECALLED");
    expect(row).toBeUndefined();
  });

  it("a due date in the future (not yet due) implies canonical 0, never a negative DPD", async () => {
    await customerWithDpd("DPD-FUTURE", "2", -10); // due_date 10 days from now
    const res = await request(app)
      .get(`/api/reports/bucket-mismatches?company_id=${companyId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    const row = res.body.rows.find((r: { loan_number: string }) => r.loan_number === "DPD-FUTURE");
    expect(row).toBeDefined(); // lender says "2" (canonical 2), but DPD implies 0 -- a real mismatch
    expect(row.dpd).toBe(0);
    expect(row.computed_canonical).toBe(0);
  });

  it("company_id scoping keeps mismatches from other companies out", async () => {
    const otherCompany = await pool.query(
      `INSERT INTO companies (agency_id, name) VALUES ($1, 'Other Co') RETURNING id`,
      [agencyId],
    );
    await pool.query(
      `INSERT INTO buckets (company_id, label, sort_order, canonical_bucket)
       VALUES ($1, 'X', 0, 0)`,
      [otherCompany.rows[0].id],
    );
    await pool.query(
      `INSERT INTO customers (company_id, loan_number, customer_name, bucket, due_amount, emi, due_date)
       VALUES ($1, 'DPD-OTHER-CO', 'Other Co Guy', 'X', 10000, 1000, CURRENT_DATE - 60)`,
      [otherCompany.rows[0].id],
    );
    const res = await request(app)
      .get(`/api/reports/bucket-mismatches?company_id=${companyId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    const row = res.body.rows.find((r: { loan_number: string }) => r.loan_number === "DPD-OTHER-CO");
    expect(row).toBeUndefined();

    await pool.query(`DELETE FROM customers WHERE company_id = $1`, [otherCompany.rows[0].id]);
    await pool.query(`DELETE FROM buckets WHERE company_id = $1`, [otherCompany.rows[0].id]);
    await pool.query(`DELETE FROM companies WHERE id = $1`, [otherCompany.rows[0].id]);
  });
});
