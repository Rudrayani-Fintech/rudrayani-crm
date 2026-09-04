import { afterAll, beforeAll, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import request from "supertest";
import { createApp } from "../src/app";
import { pool } from "../src/config/db";
import { hashPassword } from "../src/services/auth-service";

/**
 * Task 5.2: monthly allocation import mode — existing loans are UPDATED (not
 * rejected as duplicates) and every loan in the file gets a per-month
 * snapshot: the "allocated book" the performance dashboard reads.
 */
const app = createApp();

const PASSWORD = "Secret@123";
const ADMIN_PHONE = "7920000080";
const AGENT_PHONE = "7920000081";

let agencyId: string;
let companyId: string;
let branchId: string;
let teamId: string;
let agentId: string;
let token: string;

const MAPPING = {
  Loan: "loan_number",
  Name: "customer_name",
  Bucket: "bucket",
  POS: "due_amount",
  EMI: "emi",
  Agent: "agent_phone",
  // Owner feedback round, Phase 2: mobile_number/product/pos/emi_due_date are
  // now required-to-map too. buildSheet() below appends synthetic values for
  // these to every row so the ~15 existing (rows-per-test) fixtures below
  // don't each need individual edits -- their tested numbers (bucket/"POS"
  // i.e. due_amount/emi/agent) are unaffected.
  Mobile: "mobile_number",
  Product: "product",
  RealPos: "pos",
  DueDate: "emi_due_date",
};

async function buildSheet(rows: (string | number)[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Allocation");
  ws.addRow(["Loan", "Name", "Bucket", "POS", "EMI", "Agent", "Mobile", "Product", "RealPos", "DueDate"]);
  for (const r of rows) {
    const dueAmount = r[3]; // POS column position -> due_amount, per MAPPING above
    ws.addRow([...r, "9800000000", "TestProduct", dueAmount, "2026-01-08"]);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function uploadAndCommit(
  buffer: Buffer,
  mode: "new" | "allocation",
  allocationMonth?: string,
) {
  const up = await request(app)
    .post("/api/imports/upload")
    .set("Authorization", `Bearer ${token}`)
    .attach("file", buffer, "allocation.xlsx");
  expect(up.status).toBe(201);
  return request(app)
    .post("/api/imports/commit")
    .set("Authorization", `Bearer ${token}`)
    .send({
      upload_key: up.body.upload_key,
      company_id: companyId,
      column_mapping: MAPPING,
      mode,
      ...(allocationMonth ? { allocation_month: allocationMonth } : {}),
    });
}

beforeAll(async () => {
  const agency = await pool.query(
    "INSERT INTO agencies (name) VALUES ('Alloc Import Agency') RETURNING id",
  );
  agencyId = agency.rows[0].id;
  const company = await pool.query(
    "INSERT INTO companies (agency_id, name) VALUES ($1, 'Alloc NBFC') RETURNING id",
    [agencyId],
  );
  companyId = company.rows[0].id;
  const branch = await pool.query(
    "INSERT INTO branches (agency_id, name) VALUES ($1, 'Alloc Branch') RETURNING id",
    [agencyId],
  );
  branchId = branch.rows[0].id;
  const team = await pool.query(
    "INSERT INTO teams (branch_id, name) VALUES ($1, 'Alloc Team') RETURNING id",
    [branchId],
  );
  teamId = team.rows[0].id;

  const hash = await hashPassword(PASSWORD);
  await pool.query(
    `INSERT INTO users (agency_id, full_name, phone, password_hash, is_agency_admin, designation)
     VALUES ($1, 'Alloc Admin', $2, $3, true, 'agency_admin')`,
    [agencyId, ADMIN_PHONE, hash],
  );
  const agent = await pool.query(
    `INSERT INTO users (agency_id, full_name, phone, password_hash, is_field_agent, team_id, designation)
     VALUES ($1, 'Alloc Agent', $2, $3, true, $4, 'field_agent') RETURNING id`,
    [agencyId, AGENT_PHONE, hash, teamId],
  );
  agentId = agent.rows[0].id;

  const login = await request(app)
    .post("/api/auth/login")
    .send({ phone: ADMIN_PHONE, password: PASSWORD });
  token = login.body.access_token;
});

afterAll(async () => {
  await pool.query(
    `DELETE FROM customer_month_snapshots WHERE company_id = $1`,
    [companyId],
  );
  await pool.query(
    `DELETE FROM allocation_logs WHERE customer_id IN (SELECT id FROM customers WHERE company_id = $1)`,
    [companyId],
  );
  await pool.query("DELETE FROM import_runs WHERE company_id = $1", [companyId]);
  await pool.query("DELETE FROM buckets WHERE company_id = $1", [companyId]);
  await pool.query("DELETE FROM products WHERE company_id = $1", [companyId]);
  await pool.query("DELETE FROM customers WHERE company_id = $1", [companyId]);
  await pool.query("DELETE FROM companies WHERE id = $1", [companyId]);
  await pool.query("DELETE FROM users WHERE agency_id = $1", [agencyId]);
  await pool.query("DELETE FROM teams WHERE id = $1", [teamId]);
  await pool.query("DELETE FROM branches WHERE id = $1", [branchId]);
  await pool.query("DELETE FROM agencies WHERE id = $1", [agencyId]);
  await pool.end();
});

describe("monthly allocation import", () => {
  it("month 1: inserts new loans, assigns agents by phone, writes snapshots", async () => {
    const res = await uploadAndCommit(
      await buildSheet([
        ["AL-001", "Anil", "30", 100000, 5000, AGENT_PHONE],
        ["AL-002", "Sunil", "60", 200000, 8000, AGENT_PHONE],
        ["AL-003", "Kapil", "Current", 50000, 2500, ""],
      ]),
      "allocation",
      "2026-06-01",
    );
    expect(res.status).toBe(201);
    expect(res.body.inserted_rows).toBe(3);
    expect(res.body.updated_rows).toBe(0);
    expect(res.body.unknown_agent_phones).toEqual([]);

    const snaps = await pool.query(
      `SELECT s.bucket, s.due_amount::numeric AS pos, s.assigned_agent_id, c.loan_number
         FROM customer_month_snapshots s JOIN customers c ON c.id = s.customer_id
        WHERE s.company_id = $1 AND s.month = '2026-06-01' ORDER BY c.loan_number`,
      [companyId],
    );
    expect(snaps.rows).toHaveLength(3);
    expect(snaps.rows[0]).toMatchObject({ loan_number: "AL-001", bucket: "30" });
    expect(snaps.rows[0].assigned_agent_id).toBe(agentId);
    expect(Number(snaps.rows[0].pos)).toBe(100000);
  });

  it("month 2: existing loans update in place (bucket moves), snapshot per month", async () => {
    const res = await uploadAndCommit(
      await buildSheet([
        ["AL-001", "Anil", "Current", 95000, 5000, AGENT_PHONE], // normalized
        ["AL-002", "Sunil", "90", 210000, 8000, AGENT_PHONE], // flowed forward
        ["AL-004", "Nikhil", "30", 80000, 4000, AGENT_PHONE], // new loan this month
        // AL-003 missing from month 2's file
      ]),
      "allocation",
      "2026-07-01",
    );
    expect(res.status).toBe(201);
    expect(res.body.inserted_rows).toBe(1);
    expect(res.body.updated_rows).toBe(2);

    // Customer row reflects the new month's file
    const cust = await pool.query(
      `SELECT bucket, due_amount::numeric AS pos FROM customers
        WHERE company_id = $1 AND loan_number = 'AL-001'`,
      [companyId],
    );
    expect(cust.rows[0].bucket).toBe("Current");
    expect(Number(cust.rows[0].pos)).toBe(95000);

    // June snapshot untouched, July snapshot new
    const juneSnap = await pool.query(
      `SELECT s.bucket FROM customer_month_snapshots s JOIN customers c ON c.id = s.customer_id
        WHERE s.company_id = $1 AND c.loan_number = 'AL-001' AND s.month = '2026-06-01'`,
      [companyId],
    );
    expect(juneSnap.rows[0].bucket).toBe("30");
    const julySnaps = await pool.query(
      `SELECT COUNT(*)::int AS n FROM customer_month_snapshots WHERE company_id = $1 AND month = '2026-07-01'`,
      [companyId],
    );
    expect(julySnaps.rows[0].n).toBe(3); // AL-003 has no July snapshot
  });

  it("re-uploading a corrected file for the same month routes the update to review, not a blind overwrite", async () => {
    // This is a repeat import for 2026-07-01 (month 2 already ran) -- per the
    // MVP-hardening fix, a change to an already-active customer now waits for
    // an ops decision instead of applying silently, since AL-001 may already
    // have calls/payments logged against the old numbers.
    const res = await uploadAndCommit(
      await buildSheet([["AL-001", "Anil", "X", 90000, 5000, AGENT_PHONE]]),
      "allocation",
      "2026-07-01",
    );
    expect(res.status).toBe(201);
    expect(res.body.is_repeat_import).toBe(true);
    expect(res.body.updated_rows).toBe(0); // nothing applied directly
    expect(res.body.pending_review).toBeGreaterThanOrEqual(1);

    // Bucket is untouched -- still month 2's value, not the new file's "X".
    const custBefore = await pool.query(
      `SELECT bucket FROM customers WHERE company_id = $1 AND loan_number = 'AL-001'`,
      [companyId],
    );
    expect(custBefore.rows[0].bucket).toBe("Current");

    const item = await pool.query(
      `SELECT id, item_type, status, payload FROM import_review_items
        WHERE company_id = $1 AND loan_number = 'AL-001' AND item_type = 'update'
        ORDER BY created_at DESC LIMIT 1`,
      [companyId],
    );
    expect(item.rows).toHaveLength(1);
    expect(item.rows[0].status).toBe("pending");
    expect(item.rows[0].payload.bucket).toBe("X");

    // Approving it is what actually applies the change.
    const decide = await request(app)
      .post(`/api/import-reviews/${item.rows[0].id}/decision`)
      .set("Authorization", `Bearer ${token}`)
      .send({ action: "approve" });
    expect(decide.status).toBe(200);

    const custAfter = await pool.query(
      `SELECT bucket FROM customers WHERE company_id = $1 AND loan_number = 'AL-001'`,
      [companyId],
    );
    expect(custAfter.rows[0].bucket).toBe("X");

    const snaps = await pool.query(
      `SELECT s.bucket FROM customer_month_snapshots s JOIN customers c ON c.id = s.customer_id
        WHERE s.company_id = $1 AND c.loan_number = 'AL-001' AND s.month = '2026-07-01'`,
      [companyId],
    );
    expect(snaps.rows).toHaveLength(1);
    expect(snaps.rows[0].bucket).toBe("X");
  });

  it("allocation preview reports the diff: updates, and loans missing from the file flagged as removals", async () => {
    const up = await request(app)
      .post("/api/imports/upload")
      .set("Authorization", `Bearer ${token}`)
      .attach(
        "file",
        await buildSheet([["AL-001", "Anil", "X", 90000, 5000, ""]]),
        "one-loan.xlsx",
      );
    const res = await request(app)
      .post("/api/imports/preview")
      .set("Authorization", `Bearer ${token}`)
      .send({
        upload_key: up.body.upload_key,
        company_id: companyId,
        column_mapping: MAPPING,
        mode: "allocation",
        allocation_month: "2026-08-01",
      });
    expect(res.status).toBe(200);
    expect(res.body.is_repeat_import).toBe(false); // first import for 2026-08-01
    expect(res.body.will_update).toBe(1);
    expect(res.body.additions.count).toBe(0);
    expect(res.body.removals.count).toBe(3); // AL-002/003/004 active but absent
    const removedLoans = res.body.removals.sample.map((r: { loan_number: string }) => r.loan_number);
    expect(new Set(removedLoans)).toEqual(new Set(["AL-002", "AL-003", "AL-004"]));
  });

  it("allocation mode requires allocation_month", async () => {
    const res = await uploadAndCommit(
      await buildSheet([["AL-009", "NoMonth", "30", 1000, 100, ""]]),
      "allocation",
    );
    expect(res.status).toBe(400);
  });

  it("repeat-import addition (brand-new loan number) is routed to review, not inserted directly", async () => {
    // 2026-07-01 already had two allocation runs (month 2 + the re-upload above),
    // so this is a repeat/refresh import: a new loan number must wait for review.
    const res = await uploadAndCommit(
      await buildSheet([["AL-010", "Ghost Agent", "30", 60000, 3000, "7000000000"]]),
      "allocation",
      "2026-07-01",
    );
    expect(res.status).toBe(201);
    expect(res.body.is_repeat_import).toBe(true);
    expect(res.body.inserted_rows).toBe(0);
    expect(res.body.pending_review).toBeGreaterThanOrEqual(1);
    // Not written to customers at all -- payload lives on the review item.
    const cust = await pool.query(
      `SELECT id FROM customers WHERE company_id = $1 AND loan_number = 'AL-010'`,
      [companyId],
    );
    expect(cust.rows).toHaveLength(0);
    const item = await pool.query(
      `SELECT item_type, status, payload FROM import_review_items
        WHERE company_id = $1 AND loan_number = 'AL-010'`,
      [companyId],
    );
    expect(item.rows).toHaveLength(1);
    expect(item.rows[0].item_type).toBe("addition");
    expect(item.rows[0].status).toBe("pending");
    expect(item.rows[0].payload.agent_phone).toBe("7000000000");
  });

  it("first-of-month addition with an unknown agent phone still inserts directly and surfaces the phone", async () => {
    const res = await uploadAndCommit(
      await buildSheet([["AL-020", "Fresh Month", "30", 60000, 3000, "7000000001"]]),
      "allocation",
      "2026-09-01", // never imported before -> first-of-month, additions insert directly
    );
    expect(res.status).toBe(201);
    expect(res.body.is_repeat_import).toBe(false);
    expect(res.body.inserted_rows).toBe(1);
    expect(res.body.unknown_agent_phones).toEqual(["7000000001"]);
    const cust = await pool.query(
      `SELECT assigned_agent_id FROM customers WHERE company_id = $1 AND loan_number = 'AL-020'`,
      [companyId],
    );
    expect(cust.rows[0].assigned_agent_id).toBeNull();
  });

  it("reassignment via allocation import lands in allocation_logs", async () => {
    const logs = await pool.query(
      `SELECT al.reason FROM allocation_logs al
         JOIN customers c ON c.id = al.customer_id
        WHERE c.company_id = $1 AND c.loan_number = 'AL-001' ORDER BY al.created_at`,
      [companyId],
    );
    expect(logs.rows.length).toBeGreaterThanOrEqual(1);
    expect(logs.rows[0].reason).toBe("Assigned by import");
  });

  it("mode=new still rejects duplicate loans instead of updating", async () => {
    const res = await uploadAndCommit(
      await buildSheet([["AL-001", "Anil Again", "90", 999999, 9999, ""]]),
      "new",
    );
    expect(res.status).toBe(201);
    expect(res.body.inserted_rows).toBe(0);
    expect(res.body.duplicate_rows).toBe(1);
    const cust = await pool.query(
      `SELECT bucket FROM customers WHERE company_id = $1 AND loan_number = 'AL-001'`,
      [companyId],
    );
    expect(cust.rows[0].bucket).toBe("X"); // untouched by the rejected new-mode row
  });

  it("imported bucket labels registered in the master with defaults", async () => {
    const res = await request(app)
      .get(`/api/buckets?company_id=${companyId}`)
      .set("Authorization", `Bearer ${token}`);
    const labels = res.body.buckets.map((b: { label: string }) => b.label);
    expect(new Set(labels)).toEqual(new Set(["30", "60", "90", "Current", "X"]));
  });

  it("a recalled customer whose loan reappears is routed to review as a reactivation, not silently updated", async () => {
    await pool.query(
      `INSERT INTO customers (company_id, loan_number, customer_name, bucket, due_amount, emi, status, recalled_at)
       VALUES ($1, 'AL-REACT-1', 'Recalled Ravi', '30', 40000, 2000, 'recalled', now())`,
      [companyId],
    );
    const res = await uploadAndCommit(
      await buildSheet([["AL-REACT-1", "Recalled Ravi", "30", 40000, 2000, ""]]),
      "allocation",
      "2026-10-01", // fresh month for this company -> first-of-month
    );
    expect(res.status).toBe(201);
    expect(res.body.inserted_rows).toBe(0);
    expect(res.body.updated_rows).toBe(0);
    expect(res.body.pending_review).toBeGreaterThanOrEqual(1);
    // Status is untouched until a human approves the reactivation (Task 7.3).
    const cust = await pool.query(
      `SELECT status FROM customers WHERE company_id = $1 AND loan_number = 'AL-REACT-1'`,
      [companyId],
    );
    expect(cust.rows[0].status).toBe("recalled");
    const item = await pool.query(
      `SELECT item_type, status FROM import_review_items
        WHERE company_id = $1 AND loan_number = 'AL-REACT-1' ORDER BY created_at DESC LIMIT 1`,
      [companyId],
    );
    expect(item.rows[0]).toMatchObject({ item_type: "reactivation", status: "pending" });
  });

  it("a fresher file for the same month supersedes older pending review items for that month only", async () => {
    // First commit for a brand-new month: AL-001 (active since "month 1") is
    // absent from this file, so it's flagged as a removal review item.
    const first = await uploadAndCommit(
      await buildSheet([["AL-SUP-EXISTING", "Keeper", "30", 10000, 500, ""]]),
      "allocation",
      "2026-11-01",
    );
    expect(first.status).toBe(201);
    expect(first.body.inserted_rows).toBe(1); // first-of-month: inserts directly
    expect(first.body.removal_flagged).toBeGreaterThanOrEqual(1);

    const second = await uploadAndCommit(
      await buildSheet([
        ["AL-SUP-EXISTING", "Keeper", "30", 10000, 500, ""],
        ["AL-SUP-NEW", "Newcomer", "30", 20000, 1000, ""],
      ]),
      "allocation",
      "2026-11-01", // same month again -> repeat/refresh import
    );
    expect(second.status).toBe(201);
    expect(second.body.is_repeat_import).toBe(true);
    expect(second.body.pending_review).toBeGreaterThanOrEqual(1);

    // AL-SUP-NEW's addition item from the second commit is fresh and pending.
    const newItem = await pool.query(
      `SELECT status FROM import_review_items
        WHERE company_id = $1 AND loan_number = 'AL-SUP-NEW' ORDER BY created_at DESC LIMIT 1`,
      [companyId],
    );
    expect(newItem.rows[0].status).toBe("pending");

    // AL-001's removal item from the FIRST commit (this month) is now
    // superseded, and the second commit created a fresh pending removal item
    // for it (still absent). Scoped to this test's month -- AL-001 also picked
    // up an unrelated, still-pending removal item from a DIFFERENT month
    // earlier in this file, which must NOT be touched by this supersede.
    const al001Items = await pool.query(
      `SELECT iri.status FROM import_review_items iri
         JOIN import_runs ir ON ir.id = iri.import_run_id
        WHERE iri.company_id = $1 AND iri.loan_number = 'AL-001' AND iri.item_type = 'removal'
          AND ir.allocation_month = '2026-11-01'
        ORDER BY iri.created_at ASC`,
      [companyId],
    );
    expect(al001Items.rows.length).toBeGreaterThanOrEqual(2);
    expect(al001Items.rows[0].status).toBe("superseded");
    expect(al001Items.rows[al001Items.rows.length - 1].status).toBe("pending");
  });

  it("matches loan numbers to existing customers regardless of case/whitespace, so it updates instead of duplicating", async () => {
    await pool.query(
      `INSERT INTO customers (company_id, loan_number, customer_name, bucket, due_amount, emi, status)
       VALUES ($1, 'CI-001', 'Case Insensitive Carl', '30', 15000, 750, 'active')`,
      [companyId],
    );
    const res = await uploadAndCommit(
      await buildSheet([[" ci-001 ", "Case Insensitive Carl", "60", 16000, 750, ""]]),
      "allocation",
      "2026-12-01", // fresh month
    );
    expect(res.status).toBe(201);
    expect(res.body.inserted_rows).toBe(0);
    expect(res.body.updated_rows).toBe(1);
    const cust = await pool.query(
      `SELECT bucket, loan_number FROM customers WHERE company_id = $1 AND UPPER(TRIM(loan_number)) = 'CI-001'`,
      [companyId],
    );
    expect(cust.rows).toHaveLength(1); // no duplicate row created
    expect(cust.rows[0].bucket).toBe("60");
    expect(cust.rows[0].loan_number).toBe("CI-001"); // original casing preserved, not overwritten
  });

  it("maps an EMI due date column (DD-MM-YYYY) through to customers.due_date, for the DPD cross-check", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Allocation");
    ws.addRow(["Loan", "Name", "Mobile", "Product", "Bucket", "POS", "RealPos", "EMI", "DueDate", "Agent"]);
    ws.addRow(["DUE-001", "Due Date Guy", "9800000001", "TestProduct", "1", 10000, 10000, 500, "08-07-2026", ""]);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());

    const up = await request(app)
      .post("/api/imports/upload")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", buffer, "duedate.xlsx");
    const res = await request(app)
      .post("/api/imports/commit")
      .set("Authorization", `Bearer ${token}`)
      .send({
        upload_key: up.body.upload_key,
        company_id: companyId,
        column_mapping: {
          Loan: "loan_number",
          Name: "customer_name",
          Mobile: "mobile_number",
          Product: "product",
          Bucket: "bucket",
          POS: "due_amount",
          RealPos: "pos",
          EMI: "emi",
          DueDate: "emi_due_date",
          Agent: "agent_phone",
        },
        mode: "allocation",
        allocation_month: "2027-01-01", // fresh month, unused elsewhere in this file
      });
    expect(res.status).toBe(201);
    expect(res.body.inserted_rows).toBe(1);

    const cust = await pool.query(
      `SELECT due_date FROM customers WHERE company_id = $1 AND loan_number = 'DUE-001'`,
      [companyId],
    );
    expect(cust.rows[0].due_date).toBe("2026-07-08"); // raw 'YYYY-MM-DD' string (see db.ts DATE type parser)

    const snap = await pool.query(
      `SELECT s.due_date FROM customer_month_snapshots s
         JOIN customers c ON c.id = s.customer_id
        WHERE c.company_id = $1 AND c.loan_number = 'DUE-001' AND s.month = '2027-01-01'`,
      [companyId],
    );
    expect(snap.rows[0].due_date).toBe("2026-07-08");
  });

  it("rejects an unparseable EMI due date instead of silently dropping it", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Allocation");
    ws.addRow(["Loan", "Name", "Mobile", "Product", "Bucket", "POS", "RealPos", "EMI", "DueDate", "Agent"]);
    ws.addRow(["DUE-BAD", "Bad Date Guy", "9800000002", "TestProduct", "1", 10000, 10000, 500, "not-a-date", ""]);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());

    const up = await request(app)
      .post("/api/imports/upload")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", buffer, "baddate.xlsx");
    const res = await request(app)
      .post("/api/imports/preview")
      .set("Authorization", `Bearer ${token}`)
      .send({
        upload_key: up.body.upload_key,
        company_id: companyId,
        column_mapping: {
          Loan: "loan_number",
          Name: "customer_name",
          Mobile: "mobile_number",
          Product: "product",
          Bucket: "bucket",
          POS: "due_amount",
          RealPos: "pos",
          EMI: "emi",
          DueDate: "emi_due_date",
          Agent: "agent_phone",
        },
        mode: "new",
      });
    expect(res.status).toBe(200);
    expect(res.body.error_rows).toBe(1);
    expect(res.body.errors[0].problems[0]).toMatch(/unrecognized date/);
  });
});

/**
 * Owner feedback round, Phase 4: GET /customers already accepted branch_id/
 * team_id query params (an earlier, unrelated correction round wired them
 * up), but no test exercised them. Uses its own agency/company/branch/team
 * fixtures — isolated from the shared fixtures above — so customer counts
 * here can't leak into or be affected by the other describe block's tests.
 */
describe("GET /customers - branch_id / team_id filtering", () => {
  const PASSWORD_2 = "Secret@123";
  const ADMIN_PHONE_2 = "7920000090";

  let agencyId2: string;
  let companyId2: string;
  let branchA: string;
  let branchB: string;
  let teamA1: string;
  let teamA2: string;
  let teamB1: string;
  let token2: string;

  beforeAll(async () => {
    const agency = await pool.query(
      "INSERT INTO agencies (name) VALUES ('Branch Filter Agency') RETURNING id",
    );
    agencyId2 = agency.rows[0].id;
    const company = await pool.query(
      "INSERT INTO companies (agency_id, name) VALUES ($1, 'Branch Filter NBFC') RETURNING id",
      [agencyId2],
    );
    companyId2 = company.rows[0].id;

    const brA = await pool.query(
      "INSERT INTO branches (agency_id, name) VALUES ($1, 'Branch A') RETURNING id",
      [agencyId2],
    );
    branchA = brA.rows[0].id;
    const brB = await pool.query(
      "INSERT INTO branches (agency_id, name) VALUES ($1, 'Branch B') RETURNING id",
      [agencyId2],
    );
    branchB = brB.rows[0].id;

    // Two teams under branch A, one under branch B -- lets us tell "matches
    // this exact team" apart from "matches any team in this branch".
    const tA1 = await pool.query(
      "INSERT INTO teams (branch_id, name) VALUES ($1, 'Team A1') RETURNING id",
      [branchA],
    );
    teamA1 = tA1.rows[0].id;
    const tA2 = await pool.query(
      "INSERT INTO teams (branch_id, name) VALUES ($1, 'Team A2') RETURNING id",
      [branchA],
    );
    teamA2 = tA2.rows[0].id;
    const tB1 = await pool.query(
      "INSERT INTO teams (branch_id, name) VALUES ($1, 'Team B1') RETURNING id",
      [branchB],
    );
    teamB1 = tB1.rows[0].id;

    const hash = await hashPassword(PASSWORD_2);
    await pool.query(
      `INSERT INTO users (agency_id, full_name, phone, password_hash, is_agency_admin, designation)
       VALUES ($1, 'Branch Filter Admin', $2, $3, true, 'agency_admin')`,
      [agencyId2, ADMIN_PHONE_2, hash],
    );
    const agentA1 = await pool.query(
      `INSERT INTO users (agency_id, full_name, phone, password_hash, is_telecaller, team_id, designation)
       VALUES ($1, 'Agent A1', '7920000091', $2, true, $3, 'telecaller') RETURNING id`,
      [agencyId2, hash, teamA1],
    );
    const agentA2 = await pool.query(
      `INSERT INTO users (agency_id, full_name, phone, password_hash, is_telecaller, team_id, designation)
       VALUES ($1, 'Agent A2', '7920000092', $2, true, $3, 'telecaller') RETURNING id`,
      [agencyId2, hash, teamA2],
    );
    const agentB1 = await pool.query(
      `INSERT INTO users (agency_id, full_name, phone, password_hash, is_telecaller, team_id, designation)
       VALUES ($1, 'Agent B1', '7920000093', $2, true, $3, 'telecaller') RETURNING id`,
      [agencyId2, hash, teamB1],
    );

    // assigned_agent_id/assigned_team_id mirror what POST /allocations/assign
    // writes (team_id copied from the target agent at assignment time).
    await pool.query(
      `INSERT INTO customers (company_id, loan_number, customer_name, status, assigned_agent_id, assigned_team_id)
       VALUES ($1, 'BF-A1', 'Customer A1', 'active', $2, $3)`,
      [companyId2, agentA1.rows[0].id, teamA1],
    );
    await pool.query(
      `INSERT INTO customers (company_id, loan_number, customer_name, status, assigned_agent_id, assigned_team_id)
       VALUES ($1, 'BF-A2', 'Customer A2', 'active', $2, $3)`,
      [companyId2, agentA2.rows[0].id, teamA2],
    );
    await pool.query(
      `INSERT INTO customers (company_id, loan_number, customer_name, status, assigned_agent_id, assigned_team_id)
       VALUES ($1, 'BF-B1', 'Customer B1', 'active', $2, $3)`,
      [companyId2, agentB1.rows[0].id, teamB1],
    );
    await pool.query(
      `INSERT INTO customers (company_id, loan_number, customer_name, status)
       VALUES ($1, 'BF-UNASSIGNED', 'Unassigned Customer', 'active')`,
      [companyId2],
    );

    const login = await request(app)
      .post("/api/auth/login")
      .send({ phone: ADMIN_PHONE_2, password: PASSWORD_2 });
    token2 = login.body.access_token;
  });

  afterAll(async () => {
    await pool.query("DELETE FROM customers WHERE company_id = $1", [companyId2]);
    await pool.query("DELETE FROM companies WHERE id = $1", [companyId2]);
    await pool.query("DELETE FROM users WHERE agency_id = $1", [agencyId2]);
    await pool.query("DELETE FROM teams WHERE branch_id = ANY($1)", [[branchA, branchB]]);
    await pool.query("DELETE FROM branches WHERE id = ANY($1)", [[branchA, branchB]]);
    await pool.query("DELETE FROM agencies WHERE id = $1", [agencyId2]);
  });

  it("filters by team_id: only customers whose assigned agent is on that team", async () => {
    const res = await request(app)
      .get("/api/customers")
      .query({ team_id: teamA1 })
      .set("Authorization", `Bearer ${token2}`);
    expect(res.status).toBe(200);
    expect(res.body.customers.map((c: { loan_number: string }) => c.loan_number)).toEqual(["BF-A1"]);
  });

  it("filters by branch_id: customers whose assigned agent's team belongs to that branch", async () => {
    const res = await request(app)
      .get("/api/customers")
      .query({ branch_id: branchA })
      .set("Authorization", `Bearer ${token2}`);
    expect(res.status).toBe(200);
    const loanNumbers = res.body.customers
      .map((c: { loan_number: string }) => c.loan_number)
      .sort();
    expect(loanNumbers).toEqual(["BF-A1", "BF-A2"]); // both A-teams, not B1 or the unassigned one
  });

  it("combining branch_id and team_id narrows further than either alone", async () => {
    const res = await request(app)
      .get("/api/customers")
      .query({ branch_id: branchA, team_id: teamA2 })
      .set("Authorization", `Bearer ${token2}`);
    expect(res.status).toBe(200);
    expect(res.body.customers.map((c: { loan_number: string }) => c.loan_number)).toEqual(["BF-A2"]);
  });

  it("an unmatched (but well-formed) team_id returns an empty list, not an error", async () => {
    const res = await request(app)
      .get("/api/customers")
      .query({ team_id: "00000000-0000-0000-0000-000000000000" })
      .set("Authorization", `Bearer ${token2}`);
    expect(res.status).toBe(200);
    expect(res.body.customers).toEqual([]);
    expect(res.body.total).toBe(0);
  });

  it("an unmatched (but well-formed) branch_id returns an empty list, not an error", async () => {
    const res = await request(app)
      .get("/api/customers")
      .query({ branch_id: "00000000-0000-0000-0000-000000000000" })
      .set("Authorization", `Bearer ${token2}`);
    expect(res.status).toBe(200);
    expect(res.body.customers).toEqual([]);
    expect(res.body.total).toBe(0);
  });
});
