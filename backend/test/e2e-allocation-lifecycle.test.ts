import { afterAll, beforeAll, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import request from "supertest";
import { createApp } from "../src/app";
import { pool } from "../src/config/db";
import { hashPassword } from "../src/services/auth-service";
import {
  ALPHA_MAPPING,
  ALPHA_MAPPING_WITH_DUE_DATE,
  BETA_MAPPING,
  BETA_MAPPING_WITH_DUE_DATE,
  alphaMonth1,
  alphaMonth2,
  alphaMonth3,
  betaMonth1,
  betaMonth2,
  betaMonth3,
  monthsAgo,
} from "./fixtures/build-scenarios";

/**
 * End-to-end coverage of the full Phase 7 allocation lifecycle, driven
 * through the real HTTP API (not service functions in isolation) across two
 * companies with deliberately different column layouts and three months of
 * real allocation history each -- "think like a collection agency owner and
 * account for every corner case." Uses the same fixture builders as the
 * tracked demo .xlsx files (test/fixtures/), so this test and the files a
 * human would click through in the UI can never silently diverge.
 */
const app = createApp();

const PASSWORD = "Secret@123";
const ADMIN_PHONE = "7970000090";
const TELECALLER_PHONE = "7970000091";

let agencyId: string;
let alphaCompanyId: string;
let betaCompanyId: string;
let adminToken: string;
let telecallerId: string;

const ALLOC_MONTH = monthsAgo(2); // "cycle 1": three repeat imports within this one reporting month
const NEXT_MONTH = monthsAgo(1); // a genuinely later month, for transition/confirmation testing

async function login(phone: string): Promise<string> {
  const res = await request(app).post("/api/auth/login").send({ phone, password: PASSWORD });
  return res.body.access_token;
}

async function uploadAndCommit(
  companyId: string,
  buffer: Buffer,
  mapping: Record<string, string>,
  allocationMonth: string,
) {
  const up = await request(app)
    .post("/api/imports/upload")
    .set("Authorization", `Bearer ${adminToken}`)
    .attach("file", buffer, "allocation.xlsx");
  expect(up.status).toBe(201);
  return request(app)
    .post("/api/imports/commit")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({
      upload_key: up.body.upload_key,
      company_id: companyId,
      column_mapping: mapping,
      mode: "allocation",
      allocation_month: allocationMonth,
    });
}

async function approveAllPending(companyId: string): Promise<void> {
  const list = await request(app)
    .get(`/api/import-reviews?company_id=${companyId}&status=pending&limit=200`)
    .set("Authorization", `Bearer ${adminToken}`);
  const ids = (list.body.items as { id: string }[]).map((i) => i.id);
  if (ids.length === 0) return;
  const res = await request(app)
    .post("/api/import-reviews/bulk-decision")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ ids, action: "approve" });
  expect(res.status).toBe(200);
  expect(res.body.skipped).toHaveLength(0);
}

async function customerId(companyId: string, loanNumber: string): Promise<string> {
  const { rows } = await pool.query(
    `SELECT id FROM customers WHERE company_id = $1 AND loan_number = $2`,
    [companyId, loanNumber],
  );
  return rows[0].id as string;
}

async function sheetFromRows(headers: string[], rows: (string | number)[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Allocation");
  ws.addRow(headers);
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

beforeAll(async () => {
  const agency = await pool.query(
    "INSERT INTO agencies (name) VALUES ('E2E Lifecycle Agency') RETURNING id",
  );
  agencyId = agency.rows[0].id;
  const alpha = await pool.query(
    "INSERT INTO companies (agency_id, name) VALUES ($1, 'Alpha Finance NBFC') RETURNING id",
    [agencyId],
  );
  alphaCompanyId = alpha.rows[0].id;
  const beta = await pool.query(
    "INSERT INTO companies (agency_id, name) VALUES ($1, 'Beta Credit Corp') RETURNING id",
    [agencyId],
  );
  betaCompanyId = beta.rows[0].id;

  const hash = await hashPassword(PASSWORD);
  await pool.query(
    `INSERT INTO users (agency_id, full_name, phone, password_hash, is_agency_admin, designation)
     VALUES ($1, 'E2E Admin', $2, $3, true, 'agency_admin')`,
    [agencyId, ADMIN_PHONE, hash],
  );
  const tc = await pool.query(
    `INSERT INTO users (agency_id, full_name, phone, password_hash, is_telecaller, designation)
     VALUES ($1, 'E2E Telecaller', $2, $3, true, 'telecaller') RETURNING id`,
    [agencyId, TELECALLER_PHONE, hash],
  );
  telecallerId = tc.rows[0].id;
  adminToken = await login(ADMIN_PHONE);
});

afterAll(async () => {
  for (const companyId of [alphaCompanyId, betaCompanyId]) {
    await pool.query(`DELETE FROM bucket_movements WHERE company_id = $1`, [companyId]);
    await pool.query(
      `DELETE FROM payments WHERE customer_id IN (SELECT id FROM customers WHERE company_id = $1)`,
      [companyId],
    );
    await pool.query(
      `DELETE FROM allocation_logs WHERE customer_id IN (SELECT id FROM customers WHERE company_id = $1)`,
      [companyId],
    );
    await pool.query(`DELETE FROM import_review_items WHERE company_id = $1`, [companyId]);
    await pool.query(`DELETE FROM customer_month_snapshots WHERE company_id = $1`, [companyId]);
    await pool.query(`DELETE FROM import_runs WHERE company_id = $1`, [companyId]);
    await pool.query(`DELETE FROM buckets WHERE company_id = $1`, [companyId]);
    await pool.query(`DELETE FROM products WHERE company_id = $1`, [companyId]);
    await pool.query(`DELETE FROM customers WHERE company_id = $1`, [companyId]);
    await pool.query(`DELETE FROM companies WHERE id = $1`, [companyId]);
  }
  await pool.query(`DELETE FROM users WHERE agency_id = $1`, [agencyId]);
  await pool.query(`DELETE FROM agencies WHERE id = $1`, [agencyId]);
  await pool.end();
});

describe("Alpha Finance NBFC (Hero-style columns): full three-file reporting cycle", () => {
  it("month 1 (first import): all 8 loans insert directly, nothing pending", async () => {
    const res = await uploadAndCommit(alphaCompanyId, await alphaMonth1(), ALPHA_MAPPING, ALLOC_MONTH);
    expect(res.status).toBe(201);
    expect(res.body.inserted_rows).toBe(8);
    expect(res.body.pending_review).toBe(0);
    expect(res.body.removal_flagged).toBe(0);
    expect(res.body.is_repeat_import).toBe(false);
    expect(new Set(res.body.new_buckets)).toEqual(new Set(["X", "1", "2", "NPA"]));
    expect(new Set(res.body.new_products)).toEqual(new Set(["CVL", "LPL", "PBPLF"]));

    const active = await pool.query(
      `SELECT COUNT(*)::int AS n FROM customers WHERE company_id = $1 AND status = 'active'`,
      [alphaCompanyId],
    );
    expect(active.rows[0].n).toBe(8);
  });

  it("month 2 (repeat for the same month): ALPHA-004 flagged for removal, ALPHA-009 flagged as an addition -- neither applied until approved", async () => {
    const res = await uploadAndCommit(alphaCompanyId, await alphaMonth2(), ALPHA_MAPPING, ALLOC_MONTH);
    expect(res.status).toBe(201);
    expect(res.body.is_repeat_import).toBe(true);
    expect(res.body.inserted_rows).toBe(0); // additions wait on a repeat import
    // MVP hardening: a repeat import's changes to already-active customers now
    // wait for review too, same as additions -- these loans may already have
    // calls/payments logged against the old numbers.
    expect(res.body.updated_rows).toBe(0); // nothing applied directly anymore
    expect(res.body.pending_review).toBe(8); // 7 continuing-loan updates + ALPHA-009 addition
    expect(res.body.removal_flagged).toBe(1); // ALPHA-004

    const stillActive = await pool.query(
      `SELECT status FROM customers WHERE company_id = $1 AND loan_number = 'ALPHA-004'`,
      [alphaCompanyId],
    );
    expect(stillActive.rows[0].status).toBe("active"); // not recalled yet -- awaiting decision
    const notYetInserted = await pool.query(
      `SELECT 1 FROM customers WHERE company_id = $1 AND loan_number = 'ALPHA-009'`,
      [alphaCompanyId],
    );
    expect(notYetInserted.rows).toHaveLength(0);

    await approveAllPending(alphaCompanyId);

    const recalled = await pool.query(
      `SELECT status, recalled_at, assigned_agent_id FROM customers
        WHERE company_id = $1 AND loan_number = 'ALPHA-004'`,
      [alphaCompanyId],
    );
    expect(recalled.rows[0]).toMatchObject({ status: "recalled", assigned_agent_id: null });
    expect(recalled.rows[0].recalled_at).not.toBeNull();

    const added = await pool.query(
      `SELECT status, bucket, customer_name FROM customers
        WHERE company_id = $1 AND loan_number = 'ALPHA-009'`,
      [alphaCompanyId],
    );
    expect(added.rows[0]).toMatchObject({ status: "active", bucket: "1", customer_name: "Rohit Bhatia" });

    const snap = await pool.query(
      `SELECT s.bucket FROM customer_month_snapshots s
         JOIN customers c ON c.id = s.customer_id
        WHERE c.company_id = $1 AND c.loan_number = 'ALPHA-009' AND s.month = $2::date`,
      [alphaCompanyId, ALLOC_MONTH],
    );
    expect(snap.rows).toHaveLength(1); // approving an addition writes its month snapshot too
  });

  it("month 3 (repeat again): ALPHA-004 reappearing is a reactivation, not a silent update, and needs review regardless of month timing", async () => {
    const res = await uploadAndCommit(alphaCompanyId, await alphaMonth3(), ALPHA_MAPPING_WITH_DUE_DATE, ALLOC_MONTH);
    expect(res.status).toBe(201);
    expect(res.body.inserted_rows).toBe(0);
    expect(res.body.pending_review).toBeGreaterThanOrEqual(1);

    const stillRecalled = await pool.query(
      `SELECT status FROM customers WHERE company_id = $1 AND loan_number = 'ALPHA-004'`,
      [alphaCompanyId],
    );
    expect(stillRecalled.rows[0].status).toBe("recalled"); // untouched until approved

    await approveAllPending(alphaCompanyId);

    const reactivated = await pool.query(
      `SELECT status, recalled_at, bucket, due_amount::numeric AS due_amount, due_date FROM customers
        WHERE company_id = $1 AND loan_number = 'ALPHA-004'`,
      [alphaCompanyId],
    );
    expect(reactivated.rows[0].status).toBe("active");
    expect(reactivated.rows[0].recalled_at).toBeNull();
    expect(reactivated.rows[0].bucket).toBe("1");
    expect(Number(reactivated.rows[0].due_amount)).toBe(41000);
    expect(reactivated.rows[0].due_date).not.toBeNull(); // emi_due_date column flowed through on reactivation

    // ALPHA-008's due_date flowed through too -- as a review item like every
    // other continuing loan in this repeat import, approved above.
    const withDueDate = await pool.query(
      `SELECT due_date FROM customers WHERE company_id = $1 AND loan_number = 'ALPHA-008'`,
      [alphaCompanyId],
    );
    expect(withDueDate.rows[0].due_date).not.toBeNull();
  });

  it("a subsequent calendar month with real bucket drops writes allocation-confirmed movement events, and improving buckets never trigger a rollback event", async () => {
    // A genuinely later month (not a repeat of ALLOC_MONTH): deliberate drops
    // on 001/003/007 (should confirm), no change on most others, and a
    // rollback on 009 (should NOT produce a confirmation event).
    const nextSheet = await sheetFromRows(
      ["loan_agreement_no", "customername", "Bkt", "PROD", "pos", "emi_amount", "Mobile", "RealPos", "Agent"],
      [
        ["ALPHA-001", "Ramesh Kumar", "X", "CVL", 0, 1500, "9800000001", 0, ""], // 1 -> X: drop, confirms
        ["ALPHA-002", "Sita Devi", "X", "CVL", 0, 2500, "9800000002", 0, ""],
        ["ALPHA-003", "Manoj Tiwari", "1", "LPL", 15000, 3000, "9800000003", 15000, ""], // NPA -> 1: drop, confirms
        ["ALPHA-004", "Priya Singh", "1", "CVL", 41000, 4000, "9800000004", 41000, ""],
        ["ALPHA-005", "Ajay Verma", "X", "PBPLF", 0, 1800, "9800000005", 0, ""],
        ["ALPHA-006", "Kavita Joshi", "NPA", "LPL", 58000, 6000, "9800000006", 58000, ""],
        ["ALPHA-007", "Suresh Nair", "X", "CVL", 0, 2200, "9800000007", 0, ""], // 2 -> X: drop, confirms
        ["ALPHA-008", "Deepa Menon", "X", "CVL", 19500, 1900, "9800000008", 19500, ""],
        ["ALPHA-009", "Rohit Bhatia", "2", "CVL", 29000, 2800, "9800000009", 29000, ""], // 1 -> 2: rollback, no event
      ],
    );
    const res = await uploadAndCommit(alphaCompanyId, nextSheet, ALPHA_MAPPING, NEXT_MONTH);
    expect(res.status).toBe(201);
    expect(res.body.is_repeat_import).toBe(false); // first file for NEXT_MONTH

    const confirmed = await pool.query(
      `SELECT c.loan_number FROM bucket_movements bm
         JOIN customers c ON c.id = bm.customer_id
        WHERE bm.company_id = $1 AND bm.trigger = 'allocation' AND bm.month = $2::date
        ORDER BY c.loan_number`,
      [alphaCompanyId, NEXT_MONTH],
    );
    expect(confirmed.rows.map((r) => r.loan_number)).toEqual(["ALPHA-001", "ALPHA-003", "ALPHA-007"]);

    const rollbackEvent = await pool.query(
      `SELECT 1 FROM bucket_movements bm
         JOIN customers c ON c.id = bm.customer_id
        WHERE bm.company_id = $1 AND c.loan_number = 'ALPHA-009' AND bm.trigger = 'allocation'`,
      [alphaCompanyId],
    );
    expect(rollbackEvent.rows).toHaveLength(0);
  });

  it("recording a payment that covers a bucket-1 loan's arrears writes a payment-driven movement event, independent of the allocation import", async () => {
    const id = await customerId(alphaCompanyId, "ALPHA-004"); // bucket "1", canonical 1, emi 4000
    const res = await request(app)
      .post("/api/payments")
      .set("Authorization", `Bearer ${adminToken}`)
      .field("customer_id", id)
      .field("amount", "4000"); // 1 * emi -- exactly covers the arrears threshold
    expect(res.status).toBe(201);

    const events = await pool.query(
      `SELECT trigger FROM bucket_movements WHERE customer_id = $1 AND trigger = 'payment'`,
      [id],
    );
    expect(events.rows).toHaveLength(1);
  });

});

describe("Beta Credit Corp (Indifi-style columns, deliberately different layout)", () => {
  it("runs the same three-file cycle end to end and leaves BETA-103 genuinely recalled (no reactivation)", async () => {
    const m1 = await uploadAndCommit(betaCompanyId, await betaMonth1(), BETA_MAPPING, ALLOC_MONTH);
    expect(m1.status).toBe(201);
    expect(m1.body.inserted_rows).toBe(6);

    const m2 = await uploadAndCommit(betaCompanyId, await betaMonth2(), BETA_MAPPING, ALLOC_MONTH);
    expect(m2.status).toBe(201);
    // MVP hardening: the 5 continuing loans (6 inserted in month 1, minus
    // BETA-103 which is removed here) now also route to review, alongside
    // BETA-107's addition.
    expect(m2.body.pending_review).toBe(6); // 5 continuing-loan updates + BETA-107 addition
    expect(m2.body.removal_flagged).toBe(1); // BETA-103
    await approveAllPending(betaCompanyId);

    const recalled = await pool.query(
      `SELECT status FROM customers WHERE company_id = $1 AND loan_number = 'BETA-103'`,
      [betaCompanyId],
    );
    expect(recalled.rows[0].status).toBe("recalled");

    const m3 = await uploadAndCommit(betaCompanyId, await betaMonth3(), BETA_MAPPING_WITH_DUE_DATE, ALLOC_MONTH);
    expect(m3.status).toBe(201);
    // BETA-103 is absent from month 3 too -- still recalled, no new decision needed.
    await approveAllPending(betaCompanyId);
  });

});
