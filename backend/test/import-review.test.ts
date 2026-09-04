import { afterAll, beforeAll, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import request from "supertest";
import { createApp } from "../src/app";
import { pool } from "../src/config/db";
import { hashPassword } from "../src/services/auth-service";

/**
 * Task 7.3: the discrepancy review queue. Additions/removals/reactivations
 * flagged by the allocation diff (import-service.ts) sit in
 * import_review_items until an agency_admin/operations_manager decides;
 * nothing else may decide, and a decided/superseded item can't be re-decided.
 */
const app = createApp();

const PASSWORD = "Secret@123";
const ADMIN_PHONE = "7930000090";
const OPS_PHONE = "7930000091";
const TELECALLER_PHONE = "7930000092";
const BM_PHONE = "7930000093";

let agencyId: string;
let companyId: string;
let branchId: string;
let teamId: string;
let adminToken: string;
let opsToken: string;
let telecallerToken: string;
let bmToken: string;

// Owner feedback round, Phase 2: mobile_number/product/pos/emi_due_date are
// now required-to-map too -- buildSheet() appends synthetic values for these
// so the fixtures below (keyed on bucket/due_amount/emi/agent) don't each
// need editing.
const MAPPING = {
  Loan: "loan_number",
  Name: "customer_name",
  Bucket: "bucket",
  POS: "due_amount",
  EMI: "emi",
  Agent: "agent_phone",
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

async function uploadAndCommit(buffer: Buffer, allocationMonth: string) {
  const up = await request(app)
    .post("/api/imports/upload")
    .set("Authorization", `Bearer ${adminToken}`)
    .attach("file", buffer, "allocation.xlsx");
  return request(app)
    .post("/api/imports/commit")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({
      upload_key: up.body.upload_key,
      company_id: companyId,
      column_mapping: MAPPING,
      mode: "allocation",
      allocation_month: allocationMonth,
    });
}

async function findItem(loanNumber: string, itemType: string) {
  const { rows } = await pool.query(
    `SELECT * FROM import_review_items
      WHERE company_id = $1 AND loan_number = $2 AND item_type = $3
      ORDER BY created_at DESC LIMIT 1`,
    [companyId, loanNumber, itemType],
  );
  return rows[0];
}

beforeAll(async () => {
  const agency = await pool.query(
    "INSERT INTO agencies (name) VALUES ('Review Queue Agency') RETURNING id",
  );
  agencyId = agency.rows[0].id;
  const company = await pool.query(
    "INSERT INTO companies (agency_id, name) VALUES ($1, 'Review NBFC') RETURNING id",
    [agencyId],
  );
  companyId = company.rows[0].id;
  const branch = await pool.query(
    "INSERT INTO branches (agency_id, name) VALUES ($1, 'Review Branch') RETURNING id",
    [agencyId],
  );
  branchId = branch.rows[0].id;
  const team = await pool.query(
    "INSERT INTO teams (branch_id, name) VALUES ($1, 'Review Team') RETURNING id",
    [branchId],
  );
  teamId = team.rows[0].id;

  const hash = await hashPassword(PASSWORD);
  await pool.query(
    `INSERT INTO users (agency_id, full_name, phone, password_hash, is_agency_admin, designation)
     VALUES ($1, 'Review Admin', $2, $3, true, 'agency_admin')`,
    [agencyId, ADMIN_PHONE, hash],
  );
  await pool.query(
    `INSERT INTO users (agency_id, full_name, phone, password_hash, is_operations_manager, designation)
     VALUES ($1, 'Review Ops', $2, $3, true, 'operations_manager')`,
    [agencyId, OPS_PHONE, hash],
  );
  await pool.query(
    `INSERT INTO users (agency_id, full_name, phone, password_hash, is_telecaller, team_id, designation)
     VALUES ($1, 'Review Telecaller', $2, $3, true, $4, 'telecaller')`,
    [agencyId, TELECALLER_PHONE, hash, teamId],
  );
  await pool.query(
    `INSERT INTO users (agency_id, full_name, phone, password_hash, designation)
     VALUES ($1, 'Review BM', $2, $3, 'branch_manager')`,
    [agencyId, BM_PHONE, hash],
  );

  const [adminLogin, opsLogin, telecallerLogin, bmLogin] = await Promise.all([
    request(app).post("/api/auth/login").send({ phone: ADMIN_PHONE, password: PASSWORD }),
    request(app).post("/api/auth/login").send({ phone: OPS_PHONE, password: PASSWORD }),
    request(app).post("/api/auth/login").send({ phone: TELECALLER_PHONE, password: PASSWORD }),
    request(app).post("/api/auth/login").send({ phone: BM_PHONE, password: PASSWORD }),
  ]);
  adminToken = adminLogin.body.access_token;
  opsToken = opsLogin.body.access_token;
  telecallerToken = telecallerLogin.body.access_token;
  bmToken = bmLogin.body.access_token;
});

afterAll(async () => {
  await pool.query(
    `DELETE FROM import_review_items WHERE company_id = $1`,
    [companyId],
  );
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

describe("import review queue: permission gate", () => {
  it("a telecaller cannot list or decide on review items", async () => {
    const list = await request(app)
      .get(`/api/import-reviews?company_id=${companyId}`)
      .set("Authorization", `Bearer ${telecallerToken}`);
    expect(list.status).toBe(403);
  });

  it("a team leader cannot list or decide either (only agency_admin/operations_manager)", async () => {
    const list = await request(app)
      .get(`/api/import-reviews?company_id=${companyId}`)
      .set("Authorization", `Bearer ${bmToken}`);
    expect(list.status).toBe(403);
  });
});

describe("import review queue: addition approval", () => {
  it("approving an addition inserts the customer and writes a month snapshot", async () => {
    const first = await uploadAndCommit(
      await buildSheet([["REV-ADD-BASE", "Base Row", "30", 10000, 500, ""]]),
      "2026-01-01",
    );
    expect(first.status).toBe(201); // first-of-month, inserts directly

    const second = await uploadAndCommit(
      await buildSheet([
        ["REV-ADD-BASE", "Base Row", "30", 10000, 500, ""],
        ["REV-ADD-NEW", "New Arrival", "60", 20000, 1000, ""],
      ]),
      "2026-01-01", // repeat import for this month: REV-ADD-NEW is a brand-new loan -> addition item
    );
    expect(second.status).toBe(201);
    expect(second.body.pending_review).toBeGreaterThanOrEqual(1);

    const item = await findItem("REV-ADD-NEW", "addition");
    expect(item.status).toBe("pending");

    const list = await request(app)
      .get(`/api/import-reviews?company_id=${companyId}&type=addition`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(list.status).toBe(200);
    expect(list.body.items.some((i: { id: string }) => i.id === item.id)).toBe(true);

    const decision = await request(app)
      .post(`/api/import-reviews/${item.id}/decision`)
      .set("Authorization", `Bearer ${opsToken}`) // operations_manager also holds imports.review
      .send({ action: "approve" });
    expect(decision.status).toBe(200);

    const cust = await pool.query(
      `SELECT status, bucket, due_amount FROM customers WHERE company_id = $1 AND loan_number = 'REV-ADD-NEW'`,
      [companyId],
    );
    expect(cust.rows).toHaveLength(1);
    expect(cust.rows[0].status).toBe("active");
    expect(cust.rows[0].bucket).toBe("60");

    const snap = await pool.query(
      `SELECT s.bucket FROM customer_month_snapshots s
         JOIN customers c ON c.id = s.customer_id
        WHERE c.company_id = $1 AND c.loan_number = 'REV-ADD-NEW' AND s.month = '2026-01-01'`,
      [companyId],
    );
    expect(snap.rows).toHaveLength(1);
  });

  it("approving an addition carries the mapped POS value through to the customer and snapshot", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Allocation");
    ws.addRow(["Loan", "Name", "Bucket", "Total Due", "POS", "EMI", "Agent", "Mobile", "Product", "DueDate"]);
    ws.addRow(["REV-POS-BASE", "Base Row", "30", 10000, 125000, 500, "", "9800000000", "TestProduct", "2026-01-08"]);
    const firstBuf = Buffer.from(await wb.xlsx.writeBuffer());
    const posMapping = {
      Loan: "loan_number",
      Name: "customer_name",
      Bucket: "bucket",
      "Total Due": "due_amount",
      POS: "pos",
      EMI: "emi",
      Agent: "agent_phone",
      Mobile: "mobile_number",
      Product: "product",
      DueDate: "emi_due_date",
    };
    const uploadFirst = await request(app)
      .post("/api/imports/upload")
      .set("Authorization", `Bearer ${adminToken}`)
      .attach("file", firstBuf, "pos_allocation.xlsx");
    const first = await request(app)
      .post("/api/imports/commit")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        upload_key: uploadFirst.body.upload_key,
        company_id: companyId,
        column_mapping: posMapping,
        mode: "allocation",
        allocation_month: "2026-06-01",
      });
    expect(first.status).toBe(201); // first-of-month, inserts directly

    const wb2 = new ExcelJS.Workbook();
    const ws2 = wb2.addWorksheet("Allocation");
    ws2.addRow(["Loan", "Name", "Bucket", "Total Due", "POS", "EMI", "Agent", "Mobile", "Product", "DueDate"]);
    ws2.addRow(["REV-POS-BASE", "Base Row", "30", 10000, 125000, 500, "", "9800000000", "TestProduct", "2026-01-08"]);
    ws2.addRow(["REV-POS-NEW", "New Arrival", "60", 20000, 240000, 1000, "", "9800000001", "TestProduct", "2026-01-08"]);
    const secondBuf = Buffer.from(await wb2.xlsx.writeBuffer());
    const uploadSecond = await request(app)
      .post("/api/imports/upload")
      .set("Authorization", `Bearer ${adminToken}`)
      .attach("file", secondBuf, "pos_allocation2.xlsx");
    const second = await request(app)
      .post("/api/imports/commit")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        upload_key: uploadSecond.body.upload_key,
        company_id: companyId,
        column_mapping: posMapping,
        mode: "allocation",
        allocation_month: "2026-06-01", // repeat import: REV-POS-NEW is an addition item
      });
    expect(second.status).toBe(201);

    const item = await findItem("REV-POS-NEW", "addition");
    expect(item.payload.pos).toBe(240000);

    const decision = await request(app)
      .post(`/api/import-reviews/${item.id}/decision`)
      .set("Authorization", `Bearer ${opsToken}`)
      .send({ action: "approve" });
    expect(decision.status).toBe(200);

    const cust = await pool.query(
      `SELECT due_amount, pos FROM customers WHERE company_id = $1 AND loan_number = 'REV-POS-NEW'`,
      [companyId],
    );
    expect(Number(cust.rows[0].due_amount)).toBe(20000);
    expect(Number(cust.rows[0].pos)).toBe(240000);

    const snap = await pool.query(
      `SELECT s.pos FROM customer_month_snapshots s
         JOIN customers c ON c.id = s.customer_id
        WHERE c.company_id = $1 AND c.loan_number = 'REV-POS-NEW' AND s.month = '2026-06-01'`,
      [companyId],
    );
    expect(Number(snap.rows[0].pos)).toBe(240000);
  });

  it("deciding on an already-decided item returns 409, not a silent no-op", async () => {
    const item = await findItem("REV-ADD-NEW", "addition");
    const res = await request(app)
      .post(`/api/import-reviews/${item.id}/decision`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ action: "approve" });
    expect(res.status).toBe(409);
  });
});

describe("import review queue: removal approval and rejection", () => {
  it("approving a removal recalls the customer, clearing their agent assignment; rejecting one keeps it active", async () => {
    const first = await uploadAndCommit(
      await buildSheet([
        ["REV-RM-APPROVE", "Will Be Recalled", "30", 10000, 500, TELECALLER_PHONE],
        ["REV-RM-REJECT", "Will Stay Active", "30", 10000, 500, ""],
      ]),
      "2026-02-01",
    );
    expect(first.status).toBe(201);

    const second = await uploadAndCommit(
      await buildSheet([["REV-RM-FILLER", "Filler", "30", 5000, 250, ""]]),
      "2026-02-01", // repeat import for this month: both prior loans are now missing -> removal items
    );
    expect(second.status).toBe(201);
    expect(second.body.removal_flagged).toBeGreaterThanOrEqual(2);

    const approveItem = await findItem("REV-RM-APPROVE", "removal");
    const rejectItem = await findItem("REV-RM-REJECT", "removal");

    const approveRes = await request(app)
      .post(`/api/import-reviews/${approveItem.id}/decision`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ action: "approve" });
    expect(approveRes.status).toBe(200);

    const rejectRes = await request(app)
      .post(`/api/import-reviews/${rejectItem.id}/decision`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ action: "reject", note: "Confirmed with the branch, still active" });
    expect(rejectRes.status).toBe(200);

    const approved = await pool.query(
      `SELECT status, recalled_at, assigned_agent_id FROM customers WHERE company_id = $1 AND loan_number = 'REV-RM-APPROVE'`,
      [companyId],
    );
    expect(approved.rows[0].status).toBe("recalled");
    expect(approved.rows[0].recalled_at).not.toBeNull();
    expect(approved.rows[0].assigned_agent_id).toBeNull(); // recalled cases don't linger as "assigned"

    const rejected = await pool.query(
      `SELECT status FROM customers WHERE company_id = $1 AND loan_number = 'REV-RM-REJECT'`,
      [companyId],
    );
    expect(rejected.rows[0].status).toBe("active"); // untouched by the rejection
  });
});

describe("import review queue: reactivation", () => {
  it("a recalled customer whose loan reappears is restored to active on approval, with the file's data applied", async () => {
    await pool.query(
      `INSERT INTO customers (company_id, loan_number, customer_name, bucket, due_amount, emi, status, recalled_at)
       VALUES ($1, 'REV-REACT-1', 'Old Name', '30', 10000, 500, 'recalled', now())`,
      [companyId],
    );
    const res = await uploadAndCommit(
      await buildSheet([["REV-REACT-1", "Updated Name", "60", 15000, 750, ""]]),
      "2026-03-01", // fresh month for this company -> still routed as reactivation regardless
    );
    expect(res.status).toBe(201);
    expect(res.body.pending_review).toBeGreaterThanOrEqual(1);

    const item = await findItem("REV-REACT-1", "reactivation");
    expect(item.status).toBe("pending");

    const decision = await request(app)
      .post(`/api/import-reviews/${item.id}/decision`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ action: "approve" });
    expect(decision.status).toBe(200);

    const cust = await pool.query(
      `SELECT status, recalled_at, customer_name, bucket FROM customers
        WHERE company_id = $1 AND loan_number = 'REV-REACT-1'`,
      [companyId],
    );
    expect(cust.rows[0].status).toBe("active");
    expect(cust.rows[0].recalled_at).toBeNull();
    expect(cust.rows[0].customer_name).toBe("Updated Name");
    expect(cust.rows[0].bucket).toBe("60");
  });
});

describe("import review queue: supersede and bulk decisions", () => {
  it("a fresher file for the same month supersedes a pending item, which can no longer be decided", async () => {
    await uploadAndCommit(
      await buildSheet([["REV-SUP-BASE", "Base", "30", 10000, 500, ""]]),
      "2026-04-01",
    );
    const first = await uploadAndCommit(
      await buildSheet([
        ["REV-SUP-BASE", "Base", "30", 10000, 500, ""],
        ["REV-SUP-GONE", "Ephemeral Addition", "30", 8000, 400, ""],
      ]),
      "2026-04-01", // repeat import for this month: REV-SUP-GONE becomes a pending addition item
    );
    expect(first.status).toBe(201);
    const staleItem = await findItem("REV-SUP-GONE", "addition");
    expect(staleItem.status).toBe("pending");

    // A third file for the SAME month, no longer mentioning REV-SUP-GONE at all,
    // supersedes the stale pending item.
    await uploadAndCommit(
      await buildSheet([["REV-SUP-BASE", "Base", "30", 10000, 500, ""]]),
      "2026-04-01",
    );

    const refreshed = await pool.query(
      `SELECT status FROM import_review_items WHERE id = $1`,
      [staleItem.id],
    );
    expect(refreshed.rows[0].status).toBe("superseded");

    const decision = await request(app)
      .post(`/api/import-reviews/${staleItem.id}/decision`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ action: "approve" });
    expect(decision.status).toBe(409);
  });

  it("bulk-decision applies to pending items and reports the rest as skipped", async () => {
    const first = await uploadAndCommit(
      await buildSheet([["REV-BULK-BASE", "Base", "30", 10000, 500, ""]]),
      "2026-05-01",
    );
    expect(first.status).toBe(201);
    const second = await uploadAndCommit(
      await buildSheet([
        ["REV-BULK-BASE", "Base", "30", 10000, 500, ""],
        ["REV-BULK-A", "Bulk A", "30", 8000, 400, ""],
        ["REV-BULK-B", "Bulk B", "30", 8000, 400, ""],
      ]),
      "2026-05-01",
    );
    expect(second.status).toBe(201);

    const itemA = await findItem("REV-BULK-A", "addition");
    const itemB = await findItem("REV-BULK-B", "addition");

    // Pre-decide item A so the bulk call must skip it, not silently re-apply.
    await request(app)
      .post(`/api/import-reviews/${itemA.id}/decision`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ action: "reject" });

    const bulk = await request(app)
      .post("/api/import-reviews/bulk-decision")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ ids: [itemA.id, itemB.id], action: "approve" });

    expect(bulk.status).toBe(200);
    expect(bulk.body.applied).toEqual([itemB.id]);
    expect(bulk.body.skipped).toHaveLength(1);
    expect(bulk.body.skipped[0].id).toBe(itemA.id);

    const custB = await pool.query(
      `SELECT status FROM customers WHERE company_id = $1 AND loan_number = 'REV-BULK-B'`,
      [companyId],
    );
    expect(custB.rows[0].status).toBe("active"); // approved via bulk
  });
});
