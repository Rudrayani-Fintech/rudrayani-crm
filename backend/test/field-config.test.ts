import { afterAll, beforeAll, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import request from "supertest";
import { createApp } from "../src/app";
import { pool } from "../src/config/db";
import { hashPassword } from "../src/services/auth-service";

/**
 * Phase 10: system_field_definitions (agency master catalog) +
 * company_field_settings (per-company enable/require/order) replace the old
 * compile-time SYSTEM_FIELDS / REQUIRED_MAPPED_FIELDS consts in
 * import-service.ts. This suite covers: catalog resolution, admin CRUD on
 * the catalog, that Phase 2's required-field enforcement behaves identically
 * against the new runtime path, and that pre-existing import_templates rows
 * still validate unchanged.
 */
const app = createApp();

const PASSWORD = "Secret@123";
const ADMIN_PHONE = "7920000001";
const NO_RIGHTS_PHONE = "7920000002";

let agencyId: string;
// companyId is created via raw SQL, deliberately bypassing POST /companies --
// this is exactly how every pre-Phase-10 test (import.test.ts etc.) creates
// its company, so it's the right fixture to prove resolveFieldCatalog()'s
// fallback defaults (no company_field_settings rows at all) still reproduce
// the old REQUIRED_MAPPED_FIELDS behavior.
let companyId: string;
// apiCompanyId is created through POST /companies, exercising the
// seedCompanyFieldSettings() bootstrap that gives new companies explicit
// settings rows instead of relying on the fallback.
let apiCompanyId: string;
let adminToken: string;
let noRightsToken: string;

async function login(phone: string): Promise<string> {
  const res = await request(app).post("/api/auth/login").send({ phone, password: PASSWORD });
  return res.body.access_token;
}

beforeAll(async () => {
  const agency = await pool.query(
    "INSERT INTO agencies (name) VALUES ('Field Config Agency') RETURNING id",
  );
  agencyId = agency.rows[0].id;
  await pool.query(
    `INSERT INTO users (agency_id, full_name, phone, password_hash, is_agency_admin, designation)
     VALUES ($1, 'Field Config Admin', $2, $3, true, 'agency_admin')`,
    [agencyId, ADMIN_PHONE, await hashPassword(PASSWORD)],
  );
  await pool.query(
    `INSERT INTO users (agency_id, full_name, phone, password_hash, is_field_agent, designation)
     VALUES ($1, 'No Rights', $2, $3, true, 'field_agent')`,
    [agencyId, NO_RIGHTS_PHONE, await hashPassword(PASSWORD)],
  );
  const company = await pool.query(
    "INSERT INTO companies (agency_id, name) VALUES ($1, 'Field Config FinCorp') RETURNING id",
    [agencyId],
  );
  companyId = company.rows[0].id;

  adminToken = await login(ADMIN_PHONE);
  noRightsToken = await login(NO_RIGHTS_PHONE);

  const created = await request(app)
    .post("/api/companies")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ name: "Field Config API FinCorp" });
  apiCompanyId = created.body.company.id;
});

afterAll(async () => {
  await pool.query("DELETE FROM company_field_settings WHERE company_id = ANY($1)", [
    [companyId, apiCompanyId],
  ]);
  await pool.query("DELETE FROM system_field_definitions WHERE agency_id = $1", [agencyId]);
  await pool.query("DELETE FROM products WHERE company_id = ANY($1)", [[companyId, apiCompanyId]]);
  await pool.query("DELETE FROM buckets WHERE company_id = ANY($1)", [[companyId, apiCompanyId]]);
  await pool.query("DELETE FROM customers WHERE company_id = ANY($1)", [[companyId, apiCompanyId]]);
  await pool.query("DELETE FROM import_runs WHERE company_id = ANY($1)", [[companyId, apiCompanyId]]);
  await pool.query("DELETE FROM import_templates WHERE company_id = ANY($1)", [[companyId, apiCompanyId]]);
  await pool.query("DELETE FROM companies WHERE id = ANY($1)", [[companyId, apiCompanyId]]);
  await pool.query("DELETE FROM users WHERE agency_id = $1", [agencyId]);
  await pool.query("DELETE FROM agencies WHERE id = $1", [agencyId]);
  await pool.end();
});

describe("agency master catalog (system_field_definitions)", () => {
  it("self-seeds the 11 core fields (address included, Phase 5) on first access, in order", async () => {
    const res = await request(app)
      .get("/api/field-config/definitions")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const keys = res.body.definitions.map((d: { field_key: string }) => d.field_key);
    expect(keys).toEqual([
      "loan_number",
      "customer_name",
      "mobile_number",
      "product",
      "bucket",
      "due_amount",
      "pos",
      "emi",
      "emi_due_date",
      "agent_phone",
      "address",
    ]);
    const core = res.body.definitions.filter((d: { is_core: boolean }) => d.is_core);
    expect(core).toHaveLength(11);
    const agentPhone = res.body.definitions.find((d: { field_key: string }) => d.field_key === "agent_phone");
    expect(agentPhone.field_type).toBe("resolver");
    expect(agentPhone.storage_column).toBeNull();
    const emiDueDate = res.body.definitions.find((d: { field_key: string }) => d.field_key === "emi_due_date");
    expect(emiDueDate.storage_column).toBe("due_date");
    // Phase 5 (N1, N2, §4.3): address is now a real column and core, not a
    // mappable-but-optional custom field.
    const address = res.body.definitions.find((d: { field_key: string }) => d.field_key === "address");
    expect(address.storage_column).toBe("address");
    expect(address.is_core).toBe(true);
  });

  it("an agency admin can add a custom field to the catalog", async () => {
    const res = await request(app)
      .post("/api/field-config/definitions")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ field_key: "vehicle_type", label: "Vehicle Type", field_type: "text" });
    expect(res.status).toBe(201);
    expect(res.body.definition.is_core).toBe(false);
    expect(res.body.definition.storage_column).toBeNull();
  });

  it("rejects a duplicate field_key for the same agency", async () => {
    const res = await request(app)
      .post("/api/field-config/definitions")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ field_key: "vehicle_type", label: "Vehicle Type Dup", field_type: "text" });
    expect(res.status).toBe(409);
  });

  it("core fields can't be hard-deleted", async () => {
    const list = await request(app)
      .get("/api/field-config/definitions")
      .set("Authorization", `Bearer ${adminToken}`);
    const loanNumber = list.body.definitions.find((d: { field_key: string }) => d.field_key === "loan_number");
    const res = await request(app)
      .delete(`/api/field-config/definitions/${loanNumber.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
  });

  it("a custom field CAN be hard-deleted", async () => {
    const list = await request(app)
      .get("/api/field-config/definitions")
      .set("Authorization", `Bearer ${adminToken}`);
    const vehicleType = list.body.definitions.find((d: { field_key: string }) => d.field_key === "vehicle_type");
    const res = await request(app)
      .delete(`/api/field-config/definitions/${vehicleType.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(204);
  });

  it("a user without companies.manage cannot reach field-config admin routes", async () => {
    const res = await request(app)
      .get("/api/field-config/definitions")
      .set("Authorization", `Bearer ${noRightsToken}`);
    expect(res.status).toBe(403);
  });
});

describe("per-company catalog resolution (company_field_settings)", () => {
  it("a raw-SQL company with no settings rows falls back to the historical required set", async () => {
    const res = await request(app)
      .get(`/api/field-config/settings?company_id=${companyId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const byKey = Object.fromEntries(
      res.body.fields.map((f: { field_key: string; is_enabled: boolean; is_required: boolean }) => [
        f.field_key,
        f,
      ]),
    );
    // Matches the old REQUIRED_MAPPED_FIELDS const exactly (owner feedback
    // round, Phase 2): 9 required core fields, emi_due_date deliberately not.
    for (const key of [
      "loan_number",
      "customer_name",
      "mobile_number",
      "product",
      "bucket",
      "due_amount",
      "pos",
      "emi",
      "agent_phone",
      // Phase 5 (N1, N2, §4.3): address is now core and required, same
      // fallback behavior as every other field in this list.
      "address",
    ]) {
      expect(byKey[key].is_enabled, `${key} enabled`).toBe(true);
      expect(byKey[key].is_required, `${key} required`).toBe(true);
    }
    expect(byKey.emi_due_date.is_enabled).toBe(true);
    expect(byKey.emi_due_date.is_required).toBe(false);
  });

  it("a company created via POST /companies gets explicit all-enabled settings", async () => {
    const res = await request(app)
      .get(`/api/field-config/settings?company_id=${apiCompanyId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const byKey = Object.fromEntries(
      res.body.fields.map((f: { field_key: string; is_enabled: boolean }) => [f.field_key, f]),
    );
    expect(byKey.address.is_enabled).toBe(true); // explicit bootstrap enables everything
  });

  it("disabling a field for one company doesn't affect another", async () => {
    const patch = await request(app)
      .patch("/api/field-config/settings")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ company_id: apiCompanyId, field_key: "pos", is_enabled: false, is_required: false });
    expect(patch.status).toBe(200);

    const apiCatalog = await request(app)
      .get(`/api/field-config/settings?company_id=${apiCompanyId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    const posInApi = apiCatalog.body.fields.find((f: { field_key: string }) => f.field_key === "pos");
    expect(posInApi.is_enabled).toBe(false);

    const otherCatalog = await request(app)
      .get(`/api/field-config/settings?company_id=${companyId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    const posInOther = otherCatalog.body.fields.find((f: { field_key: string }) => f.field_key === "pos");
    expect(posInOther.is_enabled).toBe(true);

    // Restore for later tests in this file.
    await request(app)
      .patch("/api/field-config/settings")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ company_id: apiCompanyId, field_key: "pos", is_enabled: true, is_required: true });
  });

  it("loan_number and customer_name can never be disabled", async () => {
    const res = await request(app)
      .patch("/api/field-config/settings")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ company_id: apiCompanyId, field_key: "loan_number", is_enabled: false });
    expect(res.status).toBe(400);
  });

  it("a required field cannot also be disabled", async () => {
    const res = await request(app)
      .patch("/api/field-config/settings")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ company_id: apiCompanyId, field_key: "emi", is_enabled: false, is_required: true });
    expect(res.status).toBe(400);
  });

  it("reorders a company's field list", async () => {
    const current = await request(app)
      .get(`/api/field-config/settings?company_id=${apiCompanyId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    const keys = current.body.fields.map((f: { field_key: string }) => f.field_key);
    const reversed = [...keys].reverse();

    const res = await request(app)
      .put("/api/field-config/settings/reorder")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ company_id: apiCompanyId, ordered_field_keys: reversed });
    expect(res.status).toBe(200);

    const after = await request(app)
      .get(`/api/field-config/settings?company_id=${apiCompanyId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(after.body.fields.map((f: { field_key: string }) => f.field_key)).toEqual(reversed);
  });
});

describe("import pipeline reads the runtime catalog (re-run of Phase 2 required-field cases)", () => {
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
    // Phase 5 (N1, N2, §4.3): address is now required by default -- kept
    // last so every dataRow below only needs one appended value.
    Address: "address",
  };

  async function buildSheet(mapping: Record<string, string>, dataRow: (string | number)[]): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Ledger");
    ws.addRow(Object.keys(mapping));
    ws.addRow(dataRow);
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  it("commit rejects a mapping missing a runtime-required field (pos)", async () => {
    const missingPos = Object.fromEntries(
      Object.entries(FULL_MAPPING).filter(([, field]) => field !== "pos"),
    );
    const buffer = await buildSheet(missingPos, ["FC001", "Runtime Required", "9810000001", "HL", "B1", "5000", 500, "2026-01-08", "", "1 Test Rd"]);
    const upload = await request(app)
      .post("/api/imports/upload")
      .set("Authorization", `Bearer ${adminToken}`)
      .attach("file", buffer, "missing_pos.xlsx");

    const preview = await request(app)
      .post("/api/imports/preview")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ upload_key: upload.body.upload_key, company_id: companyId, column_mapping: missingPos });
    expect(preview.status).toBe(400);
    expect(preview.body.error).toContain('must map a column to "pos"');
  });

  it("commit accepts a mapping with every runtime-enabled field mapped", async () => {
    const buffer = await buildSheet(FULL_MAPPING, ["FC002", "Runtime Full", "9810000002", "HL", "B1", "5000", "125000", 500, "2026-01-08", "", "1 Test Rd"]);
    const upload = await request(app)
      .post("/api/imports/upload")
      .set("Authorization", `Bearer ${adminToken}`)
      .attach("file", buffer, "full.xlsx");

    const commit = await request(app)
      .post("/api/imports/commit")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        upload_key: upload.body.upload_key,
        company_id: companyId,
        column_mapping: FULL_MAPPING,
        file_name: "full.xlsx",
      });
    expect(commit.status).toBe(201);
    expect(commit.body.inserted_rows).toBe(1);
  });

  it("mapping a disabled field is rejected as an unknown system field", async () => {
    // pos is enabled for apiCompanyId (restored above) but let's disable it
    // here to prove /preview rejects it as a mapping target, not just
    // "unrequired" -- disabled fields are hidden from new mapping entirely.
    await request(app)
      .patch("/api/field-config/settings")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ company_id: apiCompanyId, field_key: "pos", is_enabled: false, is_required: false });

    const buffer = await buildSheet(FULL_MAPPING, ["FC003", "Disabled Pos", "9810000003", "HL", "B1", "5000", "125000", 500, "2026-01-08", "", "1 Test Rd"]);
    const upload = await request(app)
      .post("/api/imports/upload")
      .set("Authorization", `Bearer ${adminToken}`)
      .attach("file", buffer, "disabled_pos.xlsx");

    const preview = await request(app)
      .post("/api/imports/preview")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ upload_key: upload.body.upload_key, company_id: apiCompanyId, column_mapping: FULL_MAPPING });
    expect(preview.status).toBe(400);
    expect(preview.body.error).toContain('Unknown system field "pos"');

    // Restore.
    await request(app)
      .patch("/api/field-config/settings")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ company_id: apiCompanyId, field_key: "pos", is_enabled: true, is_required: true });
  });

  it("upload with ?company_id= returns that company's enabled catalog, not the whole agency's", async () => {
    // Phase 5 (N1, N2, §4.3): address is required by default for a
    // POST-/companies-created company (seedCompanyFieldSettings), so
    // disabling it needs is_required: false in the same call too -- same
    // "required field must also be enabled" rule already exercised above
    // for pos.
    const disable = await request(app)
      .patch("/api/field-config/settings")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ company_id: apiCompanyId, field_key: "address", is_enabled: false, is_required: false });
    expect(disable.status).toBe(200);

    const buffer = await buildSheet(FULL_MAPPING, ["FC004", "Scoped Catalog", "9810000004", "HL", "B1", "5000", "125000", 500, "2026-01-08", "", "1 Test Rd"]);
    const res = await request(app)
      .post(`/api/imports/upload?company_id=${apiCompanyId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .attach("file", buffer, "scoped.xlsx");
    expect(res.status).toBe(201);
    const keys = res.body.system_fields.map((f: { field_key: string }) => f.field_key);
    expect(keys).not.toContain("address");
    expect(keys).toContain("pos");

    await request(app)
      .patch("/api/field-config/settings")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ company_id: apiCompanyId, field_key: "address", is_enabled: true, is_required: true });
  });

  it("a custom admin-added field routes into custom_fields, same as address did before Phase 5", async () => {
    await request(app)
      .post("/api/field-config/definitions")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ field_key: "vehicle_no", label: "Vehicle Number", field_type: "text" });
    await request(app)
      .patch("/api/field-config/settings")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ company_id: companyId, field_key: "vehicle_no", is_enabled: true });

    const mappingWithCustom = { ...FULL_MAPPING, "Vehicle No": "vehicle_no" };
    const buffer = await buildSheet(mappingWithCustom, [
      "FC005", "Custom Field", "9810000005", "HL", "B1", "5000", "125000", 500, "2026-01-08", "", "1 Test Rd", "MH12ZZ9999",
    ]);
    const upload = await request(app)
      .post("/api/imports/upload")
      .set("Authorization", `Bearer ${adminToken}`)
      .attach("file", buffer, "custom_field.xlsx");

    const commit = await request(app)
      .post("/api/imports/commit")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        upload_key: upload.body.upload_key,
        company_id: companyId,
        column_mapping: mappingWithCustom,
        file_name: "custom_field.xlsx",
      });
    expect(commit.status).toBe(201);
    expect(commit.body.inserted_rows).toBe(1);

    const { rows } = await pool.query(
      "SELECT custom_fields FROM customers WHERE company_id = $1 AND loan_number = 'FC005'",
      [companyId],
    );
    expect(rows[0].custom_fields.vehicle_no).toBe("MH12ZZ9999");
  });
});

describe("backwards compatibility: pre-existing import_templates (except the new address requirement, Phase 5)", () => {
  const LEGACY_MAPPING = {
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
  };
  let legacyTemplateId: string;

  it("a template saved before Phase 10 (plain INSERT, bypassing the API) still loads and validates", async () => {
    const tpl = await pool.query(
      `INSERT INTO import_templates (company_id, name, column_mapping, detail_fields, version, created_by)
       VALUES ($1, 'Legacy Pre-Phase-10 Template', $2, '[]', 1,
               (SELECT id FROM users WHERE agency_id = $3 LIMIT 1))
       RETURNING id`,
      [companyId, JSON.stringify(LEGACY_MAPPING), agencyId],
    );
    legacyTemplateId = tpl.rows[0].id;

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Ledger");
    ws.addRow(Object.keys(LEGACY_MAPPING));
    ws.addRow(["FC006", "Legacy Template Row", "9810000006", "HL", "B1", "5000", "125000", 500, "2026-01-08", ""]);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());

    const upload = await request(app)
      .post("/api/imports/upload")
      .set("Authorization", `Bearer ${adminToken}`)
      .attach("file", buffer, "legacy.xlsx");

    const preview = await request(app)
      .post("/api/imports/preview")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ upload_key: upload.body.upload_key, company_id: companyId, template_id: legacyTemplateId });
    // Phase 5 (N1, N2, §4.3) intentionally breaks this guarantee for address
    // specifically -- the spec's own operational warning: "a lender file
    // with no address column will now be rejected at import." A legacy
    // template that predates the address requirement is exactly that case.
    expect(preview.status).toBe(400);
    expect(preview.body.error).toContain('must map a column to "address"');
  });
});
