import { afterAll, beforeAll, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import request from "supertest";
import { createApp } from "../src/app";
import { pool } from "../src/config/db";
import { hashPassword } from "../src/services/auth-service";

/**
 * Task 7.5: canonical buckets + payment-driven movement detection. A payment
 * that covers a customer's arrears (canonical_bucket * emi, or due_amount
 * when emi is missing) records an informational bucket_movements event --
 * `customers.bucket` is never touched, the lender's file stays authoritative.
 * An allocation import that drops a customer's bucket vs. their prior month
 * confirms the same fact independently.
 */
const app = createApp();

const PASSWORD = "Secret@123";
const ADMIN_PHONE = "7950000090";

let agencyId: string;
let companyId: string;
let adminToken: string;
let bucket1Id: string;

async function login(phone: string): Promise<string> {
  const res = await request(app).post("/api/auth/login").send({ phone, password: PASSWORD });
  return res.body.access_token;
}

async function pay(customerId: string, amount: number) {
  return request(app)
    .post("/api/payments")
    .set("Authorization", `Bearer ${adminToken}`)
    .field("customer_id", customerId)
    .field("amount", String(amount));
}

beforeAll(async () => {
  const agency = await pool.query(
    "INSERT INTO agencies (name) VALUES ('Bucket Movement Agency') RETURNING id",
  );
  agencyId = agency.rows[0].id;
  const company = await pool.query(
    "INSERT INTO companies (agency_id, name) VALUES ($1, 'Movement NBFC') RETURNING id",
    [agencyId],
  );
  companyId = company.rows[0].id;

  const hash = await hashPassword(PASSWORD);
  await pool.query(
    `INSERT INTO users (agency_id, full_name, phone, password_hash, is_agency_admin, designation)
     VALUES ($1, 'Movement Admin', $2, $3, true, 'agency_admin')`,
    [agencyId, ADMIN_PHONE, hash],
  );
  adminToken = await login(ADMIN_PHONE);

  // Bucket "1" canonically mapped to 1 (30 DPD -- one EMI overdue).
  const bucket1 = await pool.query(
    `INSERT INTO buckets (company_id, label, sort_order, canonical_bucket)
     VALUES ($1, '1', 1, 1) RETURNING id`,
    [companyId],
  );
  bucket1Id = bucket1.rows[0].id;
  await pool.query(
    `INSERT INTO buckets (company_id, label, sort_order, canonical_bucket, is_current)
     VALUES ($1, 'X', 0, 0, true)`,
    [companyId],
  );
  // Bucket "2" left deliberately unmapped (canonical_bucket NULL).
  await pool.query(`INSERT INTO buckets (company_id, label, sort_order) VALUES ($1, '2', 2)`, [
    companyId,
  ]);
});

afterAll(async () => {
  await pool.query(`DELETE FROM bucket_movements WHERE company_id = $1`, [companyId]);
  await pool.query(
    `DELETE FROM payments WHERE customer_id IN (SELECT id FROM customers WHERE company_id = $1)`,
    [companyId],
  );
  await pool.query(`DELETE FROM customer_month_snapshots WHERE company_id = $1`, [companyId]);
  await pool.query(`DELETE FROM import_runs WHERE company_id = $1`, [companyId]);
  await pool.query(`DELETE FROM buckets WHERE company_id = $1`, [companyId]);
  await pool.query(`DELETE FROM products WHERE company_id = $1`, [companyId]);
  await pool.query(`DELETE FROM customers WHERE company_id = $1`, [companyId]);
  await pool.query(`DELETE FROM companies WHERE id = $1`, [companyId]);
  await pool.query(`DELETE FROM users WHERE agency_id = $1`, [agencyId]);
  await pool.query(`DELETE FROM agencies WHERE id = $1`, [agencyId]);
  await pool.end();
});

describe("canonical bucket admin", () => {
  it("mapping a bucket to canonical 0 also marks it current, clearing any other current bucket", async () => {
    const res = await request(app)
      .patch(`/api/buckets/${bucket1Id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ canonical_bucket: 0 });
    expect(res.status).toBe(200);
    expect(res.body.bucket.is_current).toBe(true);

    const list = await request(app)
      .get(`/api/buckets?company_id=${companyId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    const currentOnes = list.body.buckets.filter((b: { is_current: boolean }) => b.is_current);
    expect(currentOnes).toHaveLength(1);
    expect(currentOnes[0].label).toBe("1");

    // Restore bucket "1" to canonical 1 and bucket "X" back to current for the
    // rest of the suite (setting canonical 0 above cleared every OTHER
    // bucket's is_current, including "X").
    await request(app)
      .patch(`/api/buckets/${bucket1Id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ canonical_bucket: 1, is_current: false });
    const bucketX = await pool.query(`SELECT id FROM buckets WHERE company_id = $1 AND label = 'X'`, [
      companyId,
    ]);
    await request(app)
      .patch(`/api/buckets/${bucketX.rows[0].id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ is_current: true });
  });
});

describe("payment-driven movement detection", () => {
  it("a bucket-1 customer who pays enough EMIs gets exactly one movement event, not one per payment", async () => {
    const cust = await pool.query(
      `INSERT INTO customers (company_id, loan_number, customer_name, bucket, emi, due_amount)
       VALUES ($1, 'MOV-001', 'Movement One', '1', 5000, 10000) RETURNING id`,
      [companyId],
    );
    const customerId = cust.rows[0].id;

    const first = await pay(customerId, 3000); // below threshold (1 * 5000)
    expect(first.status).toBe(201);
    let events = await pool.query(`SELECT * FROM bucket_movements WHERE customer_id = $1`, [
      customerId,
    ]);
    expect(events.rows).toHaveLength(0);

    const second = await pay(customerId, 2000); // total 5000 -- meets threshold
    expect(second.status).toBe(201);
    events = await pool.query(`SELECT * FROM bucket_movements WHERE customer_id = $1`, [customerId]);
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]).toMatchObject({ from_bucket: "1", trigger: "payment", from_canonical: 1 });
    expect(events.rows[0].to_bucket).toBe("X");

    const third = await pay(customerId, 1000); // still qualifies this month -- must NOT duplicate
    expect(third.status).toBe(201);
    events = await pool.query(`SELECT * FROM bucket_movements WHERE customer_id = $1`, [customerId]);
    expect(events.rows).toHaveLength(1);
  });

  it("an unmapped bucket produces no movement event even if payments clearly cover the due amount", async () => {
    const cust = await pool.query(
      `INSERT INTO customers (company_id, loan_number, customer_name, bucket, emi, due_amount)
       VALUES ($1, 'MOV-002', 'Movement Two (unmapped)', '2', 1000, 5000) RETURNING id`,
      [companyId],
    );
    const customerId = cust.rows[0].id;
    const res = await pay(customerId, 5000);
    expect(res.status).toBe(201);
    const events = await pool.query(`SELECT * FROM bucket_movements WHERE customer_id = $1`, [
      customerId,
    ]);
    expect(events.rows).toHaveLength(0);
  });

  it("falls back to due_amount as the threshold when emi is missing", async () => {
    const cust = await pool.query(
      `INSERT INTO customers (company_id, loan_number, customer_name, bucket, emi, due_amount)
       VALUES ($1, 'MOV-003', 'Movement Three (no emi)', '1', NULL, 8000) RETURNING id`,
      [companyId],
    );
    const customerId = cust.rows[0].id;

    const partial = await pay(customerId, 4000); // below due_amount
    expect(partial.status).toBe(201);
    let events = await pool.query(`SELECT * FROM bucket_movements WHERE customer_id = $1`, [
      customerId,
    ]);
    expect(events.rows).toHaveLength(0);

    const full = await pay(customerId, 4000); // total 8000 -- meets due_amount fallback
    expect(full.status).toBe(201);
    events = await pool.query(`SELECT * FROM bucket_movements WHERE customer_id = $1`, [customerId]);
    expect(events.rows).toHaveLength(1);
  });

  it("both emi and due_amount missing is undetectable -- no event, no error", async () => {
    const cust = await pool.query(
      `INSERT INTO customers (company_id, loan_number, customer_name, bucket, emi, due_amount)
       VALUES ($1, 'MOV-004', 'Movement Four (no data)', '1', NULL, NULL) RETURNING id`,
      [companyId],
    );
    const customerId = cust.rows[0].id;
    const res = await pay(customerId, 100000);
    expect(res.status).toBe(201); // payment still succeeds
    const events = await pool.query(`SELECT * FROM bucket_movements WHERE customer_id = $1`, [
      customerId,
    ]);
    expect(events.rows).toHaveLength(0);
  });

  it("a recalled customer can no longer receive payments (Task 7.8 hardening)", async () => {
    const cust = await pool.query(
      `INSERT INTO customers (company_id, loan_number, customer_name, bucket, emi, due_amount, status, recalled_at)
       VALUES ($1, 'MOV-005', 'Movement Five (recalled)', '1', 5000, 10000, 'recalled', now())
       RETURNING id`,
      [companyId],
    );
    const res = await pay(cust.rows[0].id, 5000);
    expect(res.status).toBe(400);
    const payments = await pool.query(`SELECT * FROM payments WHERE customer_id = $1`, [
      cust.rows[0].id,
    ]);
    expect(payments.rows).toHaveLength(0);
  });
});

describe("allocation-confirmed movement", () => {
  // Owner feedback round, Phase 2: mobile_number/product/pos/emi_due_date/
  // agent_phone are now required-to-map too -- buildSheet() appends synthetic
  // values for these so the fixtures below (keyed on bucket/due_amount/emi)
  // don't each need editing.
  const MAPPING = {
    Loan: "loan_number",
    Name: "customer_name",
    Bucket: "bucket",
    POS: "due_amount",
    EMI: "emi",
    Mobile: "mobile_number",
    Product: "product",
    RealPos: "pos",
    DueDate: "emi_due_date",
    Agent: "agent_phone",
  };

  async function buildSheet(rows: (string | number)[][]): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Allocation");
    ws.addRow(["Loan", "Name", "Bucket", "POS", "EMI", "Mobile", "Product", "RealPos", "DueDate", "Agent"]);
    for (const r of rows) {
      const dueAmount = r[3]; // POS column position -> due_amount, per MAPPING above
      ws.addRow([...r, "9800000000", "TestProduct", dueAmount, "2026-01-08", ""]);
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

  it("an allocation import that drops a customer's bucket vs. their prior month writes a confirmation event", async () => {
    const first = await uploadAndCommit(
      await buildSheet([["MOV-CONFIRM-1", "Confirm One", "1", 10000, 5000]]),
      "2026-06-01",
    );
    expect(first.status).toBe(201);

    const second = await uploadAndCommit(
      await buildSheet([["MOV-CONFIRM-1", "Confirm One", "X", 9000, 5000]]),
      "2026-07-01", // next month: bucket dropped from "1" to "X" (current)
    );
    expect(second.status).toBe(201);

    const events = await pool.query(
      `SELECT bm.* FROM bucket_movements bm
         JOIN customers c ON c.id = bm.customer_id
        WHERE c.loan_number = 'MOV-CONFIRM-1' AND bm.trigger = 'allocation'`,
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]).toMatchObject({ from_bucket: "1", to_bucket: "X", from_canonical: 1, to_canonical: 0 });
  });

  it("no confirmation event when the bucket is unchanged or there's no prior month", async () => {
    const firstMonth = await uploadAndCommit(
      await buildSheet([["MOV-CONFIRM-2", "Confirm Two", "1", 10000, 5000]]),
      "2026-08-01",
    );
    expect(firstMonth.status).toBe(201);
    let events = await pool.query(
      `SELECT bm.* FROM bucket_movements bm
         JOIN customers c ON c.id = bm.customer_id
        WHERE c.loan_number = 'MOV-CONFIRM-2' AND bm.trigger = 'allocation'`,
    );
    expect(events.rows).toHaveLength(0); // no prior month yet

    const sameBucket = await uploadAndCommit(
      await buildSheet([["MOV-CONFIRM-2", "Confirm Two", "1", 9500, 5000]]),
      "2026-09-01", // still bucket "1"
    );
    expect(sameBucket.status).toBe(201);
    events = await pool.query(
      `SELECT bm.* FROM bucket_movements bm
         JOIN customers c ON c.id = bm.customer_id
        WHERE c.loan_number = 'MOV-CONFIRM-2' AND bm.trigger = 'allocation'`,
    );
    expect(events.rows).toHaveLength(0); // unchanged bucket -- nothing to confirm
  });
});
