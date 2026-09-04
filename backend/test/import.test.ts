import { afterAll, beforeAll, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import request from "supertest";
import { createApp } from "../src/app";
import { pool } from "../src/config/db";
import { hashPassword } from "../src/services/auth-service";

// Integration tests: require the Postgres container running with migrations applied.
const app = createApp();

const PASSWORD = "Secret@123";
const ADMIN_PHONE = "7200000001";

let agencyId: string;
let companyId: string;
let token: string;
let uploadKey: string;
let templateId: string;

/** A realistic messy company sheet: 4 valid rows (2 product spellings),
 *  1 missing loan number, 1 in-file duplicate, 1 bad amount, 1 custom column. */
async function buildTestSheet(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Ledger");
  ws.addRow([
    "Loan No", "Cust Name", "Mobile", "Prod", "BKT", "Total Due", "POS", "EMI Amt",
    "Due Date", "Agent Ph", "Address", "Vehicle No",
  ]);
  ws.addRow(["LN001", "Ramesh Kumar", "9800000001", "HL", "B1", "1,25,000", 150000, 5200, "2026-01-08", "", "1 MG Road", "MH10AB1234"]);
  ws.addRow(["LN002", "Suresh Patil", "9800000002", "Home Loan", "B2", 78000, 90000, 3100, "2026-01-08", "", "2 Park St", ""]);
  ws.addRow(["LN003", "Ganesh Jadhav", "9800000003", "PL", "B1", 56000, 65000, 2500, "2026-01-08", "", "3 Church Rd", "MH09XY7777"]);
  ws.addRow(["LN004", "Mahesh Pawar", "9800000004", "PL", "B3", 91000, 105000, 4100, "2026-01-08", "", "4 Lake View", ""]);
  ws.addRow(["", "No LoanNumber", "9800000005", "PL", "B1", 10000, 12000, 500, "2026-01-08", "", "5 Hill Rd", ""]); // missing required
  ws.addRow(["LN001", "Dup LoanNumber", "9800000006", "HL", "B1", 20000, 24000, 900, "2026-01-08", "", "6 Sea Face", ""]); // in-file dup
  ws.addRow(["LN005", "Bad Amount", "9800000007", "HL", "B2", "not-a-number", 70000, 700, "2026-01-08", "", "7 River Side", ""]); // malformed
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const MAPPING = {
  "Loan No": "loan_number",
  "Cust Name": "customer_name",
  Mobile: "mobile_number",
  Prod: "product",
  BKT: "bucket",
  "Total Due": "due_amount",
  POS: "pos",
  "EMI Amt": "emi",
  "Due Date": "emi_due_date",
  "Agent Ph": "agent_phone",
  // Phase 5 (N1, N2, §4.3): address is now required by default.
  Address: "address",
  // "Vehicle No" deliberately unmapped -> custom_fields
};

beforeAll(async () => {
  const agency = await pool.query(
    "INSERT INTO agencies (name) VALUES ('Test Agency (import.test)') RETURNING id",
  );
  agencyId = agency.rows[0].id;
  const hash = await hashPassword(PASSWORD);
  await pool.query(
    `INSERT INTO users (agency_id, full_name, phone, password_hash, is_agency_admin, designation)
     VALUES ($1, 'Import Admin', $2, $3, true, 'agency_admin')`,
    [agencyId, ADMIN_PHONE, hash],
  );
  const company = await pool.query(
    "INSERT INTO companies (agency_id, name) VALUES ($1, 'Test FinCorp') RETURNING id",
  [agencyId]);
  companyId = company.rows[0].id;

  const login = await request(app)
    .post("/api/auth/login")
    .send({ phone: ADMIN_PHONE, password: PASSWORD });
  token = login.body.access_token;
});

afterAll(async () => {
  await pool.query("DELETE FROM products WHERE company_id = $1", [companyId]);
  await pool.query("DELETE FROM customers WHERE company_id = $1", [companyId]);
  await pool.query("DELETE FROM import_runs WHERE company_id = $1", [companyId]);
  await pool.query("DELETE FROM import_templates WHERE company_id = $1", [companyId]);
  await pool.query("DELETE FROM companies WHERE id = $1", [companyId]);
  await pool.query("DELETE FROM users WHERE agency_id = $1", [agencyId]);
  await pool.query("DELETE FROM agencies WHERE id = $1", [agencyId]);
  await pool.end();
});

describe("Excel import pipeline (brief §4)", () => {
  it("upload detects the columns", async () => {
    const res = await request(app)
      .post("/api/imports/upload")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", await buildTestSheet(), "hero_ledger.xlsx");
    expect(res.status).toBe(201);
    expect(res.body.columns).toEqual([
      "Loan No",
      "Cust Name",
      "Mobile",
      "Prod",
      "BKT",
      "Total Due",
      "POS",
      "EMI Amt",
      "Due Date",
      "Agent Ph",
      "Address",
      "Vehicle No",
    ]);
    expect(res.body.row_count).toBe(7);
    uploadKey = res.body.upload_key;
  });

  it("saves the mapping as a reusable template", async () => {
    const res = await request(app)
      .post("/api/import-templates")
      .set("Authorization", `Bearer ${token}`)
      .send({ company_id: companyId, name: "Standard Ledger", column_mapping: MAPPING });
    expect(res.status).toBe(201);
    expect(res.body.template.version).toBe(1);
    templateId = res.body.template.id;
  });

  it("re-saving the same template name creates version 2 and deactivates v1", async () => {
    const res = await request(app)
      .post("/api/import-templates")
      .set("Authorization", `Bearer ${token}`)
      .send({ company_id: companyId, name: "Standard Ledger", column_mapping: MAPPING });
    expect(res.status).toBe(201);
    expect(res.body.template.version).toBe(2);
    templateId = res.body.template.id;

    const list = await request(app)
      .get(`/api/import-templates?company_id=${companyId}`)
      .set("Authorization", `Bearer ${token}`);
    const versions = list.body.templates.filter(
      (t: { name: string }) => t.name === "Standard Ledger",
    );
    expect(versions).toHaveLength(2);
    expect(versions.find((t: { version: number }) => t.version === 1).is_active).toBe(false);
  });

  it("preview reports errors, dupes, and unmapped columns without writing", async () => {
    const res = await request(app)
      .post("/api/imports/preview")
      .set("Authorization", `Bearer ${token}`)
      .send({ upload_key: uploadKey, company_id: companyId, template_id: templateId });
    expect(res.status).toBe(200);
    expect(res.body.total_rows).toBe(7);
    expect(res.body.valid_rows).toBe(4);
    expect(res.body.error_rows).toBe(3); // missing loan no, in-file dup, bad amount
    expect(res.body.duplicates_in_db).toBe(0);
    expect(res.body.unmapped_columns).toEqual(["Vehicle No"]);

    const allProblems = res.body.errors.flatMap((e: { problems: string[] }) => e.problems).join(" | ");
    expect(allProblems).toContain('Missing required field "loan_number"');
    expect(allProblems).toContain('Duplicate loan number "LN001"');
    expect(allProblems).toContain("non-numeric");

    const count = await pool.query("SELECT COUNT(*)::int AS n FROM customers WHERE company_id = $1", [
      companyId,
    ]);
    expect(count.rows[0].n).toBe(0); // preview writes nothing
  });

  it("commit inserts the valid rows with custom_fields preserved", async () => {
    const res = await request(app)
      .post("/api/imports/commit")
      .set("Authorization", `Bearer ${token}`)
      .send({
        upload_key: uploadKey,
        company_id: companyId,
        template_id: templateId,
        file_name: "hero_ledger.xlsx",
      });
    expect(res.status).toBe(201);
    expect(res.body.inserted_rows).toBe(4);
    expect(res.body.error_rows).toBe(3);

    const { rows } = await pool.query(
      "SELECT * FROM customers WHERE company_id = $1 AND loan_number = 'LN001'",
      [companyId],
    );
    expect(rows[0].customer_name).toBe("Ramesh Kumar");
    expect(Number(rows[0].due_amount)).toBe(125000); // "1,25,000" parsed
    expect(rows[0].custom_fields["Vehicle No"]).toBe("MH10AB1234"); // nothing lost
  });

  it("commit stores a mapped POS column separately from due_amount", async () => {
    // Own company so this doesn't add an extra import_runs row to companyId's
    // history, which the later "records the import history" test counts exactly.
    const posCompany = await pool.query(
      "INSERT INTO companies (agency_id, name) VALUES ($1, 'Pos Test FinCorp') RETURNING id",
      [agencyId],
    );
    const posCompanyId = posCompany.rows[0].id;

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Ledger");
    ws.addRow(["Loan No", "Cust Name", "Mobile", "Prod", "BKT", "Total Due", "POS", "EMI Amt", "Due Date", "Agent Ph", "Address"]);
    ws.addRow(["LN900", "Pos Test Customer", "9800000099", "HL", "B1", "5,000", "1,25,000", 500, "2026-01-08", "", "1 Test Rd"]);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());

    const upload = await request(app)
      .post("/api/imports/upload")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", buffer, "pos_test.xlsx");
    expect(upload.status).toBe(201);

    const commit = await request(app)
      .post("/api/imports/commit")
      .set("Authorization", `Bearer ${token}`)
      .send({
        upload_key: upload.body.upload_key,
        company_id: posCompanyId,
        column_mapping: {
          "Loan No": "loan_number",
          "Cust Name": "customer_name",
          Mobile: "mobile_number",
          Prod: "product",
          BKT: "bucket",
          "Total Due": "due_amount",
          POS: "pos",
          "EMI Amt": "emi",
          "Due Date": "emi_due_date",
          "Agent Ph": "agent_phone",
          Address: "address",
        },
        file_name: "pos_test.xlsx",
      });
    expect(commit.status).toBe(201);
    expect(commit.body.inserted_rows).toBe(1);

    const { rows } = await pool.query(
      "SELECT due_amount, pos FROM customers WHERE company_id = $1 AND loan_number = 'LN900'",
      [posCompanyId],
    );
    expect(Number(rows[0].due_amount)).toBe(5000);
    expect(Number(rows[0].pos)).toBe(125000);

    await pool.query("DELETE FROM products WHERE company_id = $1", [posCompanyId]);
    await pool.query("DELETE FROM buckets WHERE company_id = $1", [posCompanyId]);
    await pool.query("DELETE FROM customers WHERE company_id = $1", [posCompanyId]);
    await pool.query("DELETE FROM import_runs WHERE company_id = $1", [posCompanyId]);
    await pool.query("DELETE FROM companies WHERE id = $1", [posCompanyId]);
  });

  it("re-importing the same file flags all rows as DB duplicates, inserts none", async () => {
    const preview = await request(app)
      .post("/api/imports/preview")
      .set("Authorization", `Bearer ${token}`)
      .send({ upload_key: uploadKey, company_id: companyId, template_id: templateId });
    expect(preview.body.duplicates_in_db).toBe(4);
    expect(preview.body.valid_rows).toBe(0);

    const commit = await request(app)
      .post("/api/imports/commit")
      .set("Authorization", `Bearer ${token}`)
      .send({ upload_key: uploadKey, company_id: companyId, template_id: templateId });
    expect(commit.body.inserted_rows).toBe(0);
    expect(commit.body.duplicate_rows).toBe(4);
  });

  it("records the import history", async () => {
    const res = await request(app)
      .get(`/api/imports/runs?company_id=${companyId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.runs).toHaveLength(2);
    expect(res.body.runs.map((r: { inserted_rows: number }) => r.inserted_rows).sort()).toEqual([
      0, 4,
    ]);
  });
});

describe("Products & buckets derivation (brief §4)", () => {
  it("products were derived from the imported data", async () => {
    const res = await request(app)
      .get(`/api/products?company_id=${companyId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const labels = res.body.products.map((p: { raw_label: string }) => p.raw_label).sort();
    expect(labels).toEqual(["HL", "Home Loan", "PL"]);
  });

  it("normalizes HL + Home Loan into one canonical product without re-import", async () => {
    const res = await request(app)
      .post("/api/products/normalize")
      .set("Authorization", `Bearer ${token}`)
      .send({
        company_id: companyId,
        raw_labels: ["HL", "Home Loan"],
        canonical_label: "Home Loan",
      });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(2);

    const list = await request(app)
      .get(`/api/products?company_id=${companyId}`)
      .set("Authorization", `Bearer ${token}`);
    const canonicals = new Set(
      list.body.products.map((p: { canonical_label: string }) => p.canonical_label),
    );
    expect(canonicals).toEqual(new Set(["Home Loan", "PL"]));
  });

  it("imported bucket labels auto-register in the buckets master", async () => {
    const res = await request(app)
      .get(`/api/buckets?company_id=${companyId}`)
      .set("Authorization", `Bearer ${token}`);
    const labels = res.body.buckets.map((b: { label: string }) => b.label);
    expect(new Set(labels)).toEqual(new Set(["B1", "B2", "B3"]));
    // Fresh labels come in with safe defaults the admin can then adjust.
    for (const b of res.body.buckets) {
      expect(b.category).toBe("normal");
      expect(b.is_current).toBe(false);
    }
  });

  it("an agent (customers.view only) cannot run imports", async () => {
    await pool.query(
      `INSERT INTO users (agency_id, full_name, phone, password_hash, is_field_agent, designation)
     VALUES ($1, 'No Import Rights', '7200000002', $2, true, 'field_agent')`,
      [agencyId, await hashPassword(PASSWORD)],
    );
    const login = await request(app)
      .post("/api/auth/login")
      .send({ phone: "7200000002", password: PASSWORD });
    const res = await request(app)
      .post("/api/imports/preview")
      .set("Authorization", `Bearer ${login.body.access_token}`)
      .send({ upload_key: uploadKey, company_id: companyId, template_id: templateId });
    expect(res.status).toBe(403);
  });
});

describe("all system fields required (owner feedback round, Phase 2)", () => {
  const FULL_MAPPING = {
    "Loan No": "loan_number",
    "Cust Name": "customer_name",
    Mobile: "mobile_number",
    Prod: "product",
    BKT: "bucket",
    "Total Due": "due_amount",
    POS: "pos",
    "EMI Amt": "emi",
    "Due Date": "emi_due_date",
    "Agent Ph": "agent_phone",
    // Phase 5 (N1, N2, §4.3): address is now required by default too.
    Address: "address",
  };

  it("commit rejects a mapping missing a newly-required field (e.g. pos)", async () => {
    const missingPos = Object.fromEntries(
      Object.entries(FULL_MAPPING).filter(([, field]) => field !== "pos"),
    );
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Ledger");
    ws.addRow(Object.keys(missingPos));
    ws.addRow(["LN800", "Full Fields", "9800000010", "HL", "B1", "5000", 500, "2026-01-08", "", "1 Test Rd"]);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());

    const upload = await request(app)
      .post("/api/imports/upload")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", buffer, "missing_pos.xlsx");

    const preview = await request(app)
      .post("/api/imports/preview")
      .set("Authorization", `Bearer ${token}`)
      .send({
        upload_key: upload.body.upload_key,
        company_id: companyId,
        column_mapping: missingPos,
      });
    expect(preview.status).toBe(400);
    expect(preview.body.error).toContain('must map a column to "pos"');
  });

  it("commit accepts a mapping with every system field mapped", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Ledger");
    ws.addRow(Object.keys(FULL_MAPPING));
    ws.addRow(["LN801", "Full Fields", "9800000011", "HL", "B1", "5000", "125000", 500, "2026-01-08", "", "1 Test Rd"]);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());

    const upload = await request(app)
      .post("/api/imports/upload")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", buffer, "full_fields.xlsx");

    const commit = await request(app)
      .post("/api/imports/commit")
      .set("Authorization", `Bearer ${token}`)
      .send({
        upload_key: upload.body.upload_key,
        company_id: companyId,
        column_mapping: FULL_MAPPING,
        file_name: "full_fields.xlsx",
      });
    expect(commit.status).toBe(201);
    expect(commit.body.inserted_rows).toBe(1);
  });

  it("saving a template missing a newly-required field is rejected", async () => {
    const missingPos = Object.fromEntries(
      Object.entries(FULL_MAPPING).filter(([, field]) => field !== "pos"),
    );
    const res = await request(app)
      .post("/api/import-templates")
      .set("Authorization", `Bearer ${token}`)
      .send({ company_id: companyId, name: "Missing POS Template", column_mapping: missingPos });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('must map a column to "pos"');
  });
});

describe("customers.address backfill (Phase 5, §4.3)", () => {
  // The migration (1789600000000_customer-address-column.sql) only ever
  // runs once, against whatever rows existed at migration time -- it can't
  // be re-exercised against a customer created fresh during a test run. This
  // runs the exact same backfill UPDATE against freshly-inserted rows
  // instead, to prove the SQL logic itself (the same fuzzy match mobile's
  // customer_detail_screen.dart already uses: the first custom_fields key
  // whose lower-cased name contains "address" or "addr", non-empty).
  it("populates address from the first address-like custom_fields key, skips rows with none", async () => {
    const known = await pool.query<{ id: string }>(
      `INSERT INTO customers (company_id, loan_number, customer_name, mobile_number, bucket, custom_fields)
       VALUES
         ($1, 'ADDR-BF-1', 'Backfill One', '9820000001', 'B1', '{"Village": "X", "Customer Address": "12 MG Road, Pune"}'),
         ($1, 'ADDR-BF-2', 'Backfill Two', '9820000002', 'B1', '{"addr_line1": "45 Park St"}'),
         ($1, 'ADDR-BF-3', 'Backfill Three', '9820000003', 'B1', '{"Village": "Y"}')
       RETURNING id`,
      [companyId],
    );
    expect(known.rows).toHaveLength(3);

    await pool.query(
      `UPDATE customers c
          SET address = sub.v
         FROM (
           SELECT DISTINCT ON (c2.id) c2.id, TRIM(kv.value) AS v
             FROM customers c2, jsonb_each_text(c2.custom_fields) kv
            WHERE (lower(kv.key) LIKE '%address%' OR lower(kv.key) LIKE '%addr%')
              AND TRIM(kv.value) <> ''
            ORDER BY c2.id, kv.key
         ) sub
        WHERE c.id = sub.id AND c.company_id = $1`,
      [companyId],
    );

    const { rows } = await pool.query<{ loan_number: string; address: string | null }>(
      "SELECT loan_number, address FROM customers WHERE company_id = $1 AND loan_number LIKE 'ADDR-BF-%' ORDER BY loan_number",
      [companyId],
    );
    expect(rows).toEqual([
      { loan_number: "ADDR-BF-1", address: "12 MG Road, Pune" },
      { loan_number: "ADDR-BF-2", address: "45 Park St" },
      { loan_number: "ADDR-BF-3", address: null },
    ]);
  });
});
