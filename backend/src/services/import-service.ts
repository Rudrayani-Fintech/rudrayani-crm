import ExcelJS from "exceljs";
import type { PoolClient } from "pg";
import { pool } from "../config/db";
import { HttpError } from "../middleware/error-handler";
import { detectAllocationConfirmation } from "./bucket-movement-service";
import { resolveFieldCatalog, type FieldCatalogEntry } from "./field-config-service";

// Owner feedback round, Phase 10: the field catalog (which keys exist, which
// are required-to-map) used to be the compile-time SYSTEM_FIELDS /
// REQUIRED_MAPPED_FIELDS consts below. Both are now resolved at runtime per
// company from system_field_definitions + company_field_settings (see
// field-config-service.ts) so an agency admin can add fields and a company
// admin can enable/require/reorder them without a code change or deploy.
//
// A field's routing (native customers column vs. custom_fields JSON,
// numeric/date/text parsing) is data-driven off FieldCatalogEntry.field_type
// and .storage_column, NOT a hardcoded array anymore -- see
// classifyMappingRow() below. The one exception is `agent_phone`: it never
// gets its own customers column (storage_column = NULL, field_type =
// 'resolver') because it isn't stored data at all -- it's a lookup key
// resolved against `users.phone` to set assigned_agent_id/assigned_team_id
// (see resolveAgents()/commitImport() below). It's treated like a plain text
// field in the per-row mapping loop (assigned straight onto MappedRow, not
// routed to custom_fields) purely because field_type === 'resolver' skips
// the "storage_column is NULL => custom_fields" branch, same as it always
// implicitly did when CUSTOM_FIELDS_PASSTHROUGH was a hardcoded array that
// simply didn't list it.

/** Fields whose per-row cell value may never be blank, once mapped -- this
 *  is a structural pipeline requirement (loan_number is the dedup/match key,
 *  customer_name is the identity fallback shown everywhere), not a
 *  per-company configurable, so it stays a fixed pair rather than reading
 *  off the catalog (mirrors STRUCTURALLY_REQUIRED_FIELDS in
 *  field-config-service.ts, which the admin UI uses to block disabling them). */
const REQUIRED_FIELDS = ["loan_number", "customer_name"];

/** {"Excel Column Header": "field_key"} — unmapped headers go to custom_fields. */
export type ColumnMapping = Record<string, string>;

export interface ParsedSheet {
  columns: string[];
  rows: Record<string, string>[]; // keyed by header, all values as trimmed strings
}

export interface RowProblem {
  row: number; // 1-based Excel row number (header = row 1)
  problems: string[];
}

export interface MappedRow {
  excelRow: number;
  loan_number: string;
  customer_name: string;
  mobile_number: string | null;
  product: string | null;
  bucket: string | null;
  due_amount: number | null;
  pos: number | null;
  emi: number | null;
  emi_due_date: string | null; // 'YYYY-MM-DD'
  agent_phone: string | null;
  customer_branch: string | null; // Branch name/code to resolve to branch_id
  custom_fields: Record<string, string>;
}

export type ImportMode = "new" | "allocation";

function cellToString(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    // Formula results, rich text, hyperlinks
    const v = value as { result?: ExcelJS.CellValue; text?: string; richText?: { text: string }[] };
    if (v.richText) return v.richText.map((t) => t.text).join("");
    if (v.text !== undefined) return String(v.text);
    if (v.result !== undefined) return cellToString(v.result);
    return "";
  }
  return String(value).trim();
}

// The same uploaded file is parsed at /upload, /preview, and /commit --
// previously three full re-reads and re-parses of potentially the same
// multi-thousand-row workbook. Keyed by the storage upload_key (immutable
// once written), so caching it is pure -- a hit is always correct, and a
// miss (e.g. a different server instance behind a load balancer, or the
// entry aged out) just falls back to the original parse-from-storage path
// with no behavior change.
const PARSED_SHEET_CACHE_TTL_MS = 60 * 60 * 1000;
const parsedSheetCache = new Map<string, { sheet: ParsedSheet; cachedAt: number }>();

export function cacheParsedSheet(key: string, sheet: ParsedSheet): void {
  parsedSheetCache.set(key, { sheet, cachedAt: Date.now() });
  for (const [k, v] of parsedSheetCache) {
    if (Date.now() - v.cachedAt > PARSED_SHEET_CACHE_TTL_MS) parsedSheetCache.delete(k);
  }
}

/** Returns the cached parse for this upload_key if still fresh, otherwise
 *  parses `buffer()` and caches the result under `key`. */
export async function getOrParseSheet(key: string, buffer: () => Promise<Buffer>): Promise<ParsedSheet> {
  const cached = parsedSheetCache.get(key);
  if (cached && Date.now() - cached.cachedAt <= PARSED_SHEET_CACHE_TTL_MS) return cached.sheet;
  const sheet = await parseWorkbook(await buffer());
  cacheParsedSheet(key, sheet);
  return sheet;
}

export async function parseWorkbook(buffer: Buffer): Promise<ParsedSheet> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  } catch {
    throw new HttpError(400, "Could not read the file — is it a valid .xlsx workbook?");
  }
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new HttpError(400, "The workbook has no worksheets");

  const headerRow = sheet.getRow(1);
  const columns: string[] = [];
  headerRow.eachCell({ includeEmpty: false }, (cell) => {
    const name = cellToString(cell.value);
    if (name) columns.push(name);
  });
  if (columns.length === 0) throw new HttpError(400, "The first row must contain column headers");

  const rows: Record<string, string>[] = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const record: Record<string, string> = {};
    let hasValue = false;
    columns.forEach((col, idx) => {
      const value = cellToString(row.getCell(idx + 1).value);
      record[col] = value;
      if (value) hasValue = true;
    });
    if (hasValue) {
      record.__excelRow = String(rowNumber);
      rows.push(record);
    }
  });
  return { columns, rows };
}

function parseAmount(raw: string): number | null | "invalid" {
  if (!raw) return null;
  const cleaned = raw.replace(/[,\s₹]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return "invalid";
  return Number(cleaned);
}

/**
 * EMI due dates arrive from lenders in whatever format their own sheet uses.
 * Genuine Excel date cells are already normalized to 'YYYY-MM-DD' by
 * cellToString(); this also accepts the common DD-MM-YYYY / DD/MM/YYYY text
 * forms (EMI due dates are conventionally day-of-month driven -- 8th, 15th,
 * 22nd -- so DD-first parsing matches lender convention, not MM-first).
 */
function parseDueDate(raw: string): string | null | "invalid" {
  if (!raw) return null;
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return raw;
  const dmy = raw.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (dmy) {
    const [, d, m, y] = dmy;
    const day = Number(d);
    const month = Number(m);
    if (month < 1 || month > 12 || day < 1 || day > 31) return "invalid";
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  return "invalid";
}

export interface ValidationResult {
  validRows: MappedRow[];
  errors: RowProblem[];
  duplicatesInFile: string[];
  duplicatesInDb: string[];
  unmappedColumns: string[];
}

/**
 * Classifies how one mapped field's raw cell value should be handled, purely
 * off catalog metadata -- replaces the old NUMERIC_FIELDS/DATE_FIELDS/
 * CUSTOM_FIELDS_PASSTHROUGH hardcoded arrays. An admin-added custom field
 * (is_core=false, storage_column=NULL) automatically falls into 'custom',
 * exactly how "address" always behaved.
 */
function classifyField(entry: FieldCatalogEntry): "numeric" | "date" | "custom" | "text" {
  if (entry.field_type === "resolver") return "text"; // agent_phone: not stored, resolved elsewhere
  if (entry.storage_column === null) return "custom";
  if (entry.field_type === "numeric") return "numeric";
  if (entry.field_type === "date") return "date";
  return "text";
}

export async function validateRows(
  companyId: string,
  sheet: ParsedSheet,
  mapping: ColumnMapping,
): Promise<ValidationResult> {
  const catalog = await resolveFieldCatalog(companyId);
  const byKey = new Map(catalog.filter((f) => f.is_enabled).map((f) => [f.field_key, f]));

  const mappedFields = Object.values(mapping);
  for (const entry of catalog) {
    if (entry.is_enabled && entry.is_required && !mappedFields.includes(entry.field_key)) {
      throw new HttpError(400, `The template must map a column to "${entry.field_key}"`);
    }
  }
  for (const [column, field] of Object.entries(mapping)) {
    if (!byKey.has(field)) {
      throw new HttpError(400, `Unknown system field "${field}" for column "${column}"`);
    }
    if (!sheet.columns.includes(column)) {
      throw new HttpError(400, `Mapped column "${column}" was not found in the file`);
    }
  }

  const unmappedColumns = sheet.columns.filter((c) => !(c in mapping));
  const seenLoanNumbers = new Map<string, number>();
  const validRows: MappedRow[] = [];
  const errors: RowProblem[] = [];
  const duplicatesInFile = new Set<string>();

  for (const record of sheet.rows) {
    const excelRow = Number(record.__excelRow);
    const problems: string[] = [];
    const mapped: Partial<MappedRow> & { custom_fields: Record<string, string> } = {
      excelRow,
      custom_fields: {},
    };

    for (const [column, field] of Object.entries(mapping)) {
      const raw = record[column] ?? "";
      const entry = byKey.get(field)!;
      const kind = classifyField(entry);
      if (kind === "custom") {
        if (raw) mapped.custom_fields[field] = raw;
      } else if (kind === "numeric") {
        const amount = parseAmount(raw);
        if (amount === "invalid") {
          problems.push(`"${column}" has a non-numeric value: "${raw}"`);
        } else {
          (mapped as Record<string, unknown>)[field] = amount;
        }
      } else if (kind === "date") {
        const date = parseDueDate(raw);
        if (date === "invalid") {
          problems.push(`"${column}" has an unrecognized date value: "${raw}"`);
        } else {
          (mapped as Record<string, unknown>)[field] = date;
        }
      } else {
        (mapped as Record<string, unknown>)[field] = raw || null;
      }
    }
    for (const column of unmappedColumns) {
      if (record[column]) mapped.custom_fields[column] = record[column];
    }

    for (const required of REQUIRED_FIELDS) {
      if (!(mapped as Record<string, unknown>)[required]) problems.push(`Missing required field "${required}"`);
    }

    const loanNumber = mapped.loan_number;
    if (loanNumber) {
      const firstRow = seenLoanNumbers.get(loanNumber);
      if (firstRow !== undefined) {
        problems.push(`Duplicate loan number "${loanNumber}" (first seen at row ${firstRow})`);
        duplicatesInFile.add(loanNumber);
      } else {
        seenLoanNumbers.set(loanNumber, excelRow);
      }
    }

    if (problems.length > 0) {
      errors.push({ row: excelRow, problems });
    } else {
      validRows.push(mapped as MappedRow);
    }
  }

  // Which of the file's loan numbers already exist for this company?
  const loanNumbers = validRows.map((r) => r.loan_number);
  let duplicatesInDb: string[] = [];
  if (loanNumbers.length > 0) {
    const { rows } = await pool.query(
      "SELECT loan_number FROM customers WHERE company_id = $1 AND loan_number = ANY($2)",
      [companyId, loanNumbers],
    );
    duplicatesInDb = rows.map((r) => r.loan_number as string);
  }

  return {
    validRows,
    errors,
    duplicatesInFile: [...duplicatesInFile],
    duplicatesInDb,
    unmappedColumns,
  };
}

/** Discovered-label return value lets callers surface "new this run" on import_runs (Phase 7). */
async function deriveProducts(
  client: PoolClient,
  companyId: string,
  rows: MappedRow[],
): Promise<string[]> {
  const labels = [...new Set(rows.map((r) => r.product).filter((p): p is string => !!p))];
  const newLabels: string[] = [];
  for (const label of labels) {
    // canonical starts equal to raw; normalization is a later admin action (brief §4)
    const { rows: inserted } = await client.query(
      `INSERT INTO products (company_id, raw_label, canonical_label)
       VALUES ($1, $2, $2) ON CONFLICT (company_id, raw_label) DO NOTHING
       RETURNING raw_label`,
      [companyId, label],
    );
    if (inserted[0]) newLabels.push(inserted[0].raw_label as string);
  }
  return newLabels;
}

/**
 * Bucket labels auto-register in the buckets master (Phase 5): new labels
 * append at the end of the order with default category; the admin fixes
 * ordering/flags on the Buckets page. Imports never block on bucket config.
 */
async function deriveBuckets(
  client: PoolClient,
  companyId: string,
  rows: MappedRow[],
): Promise<string[]> {
  const labels = [...new Set(rows.map((r) => r.bucket).filter((b): b is string => !!b))];
  const newLabels: string[] = [];
  for (const label of labels) {
    const { rows: inserted } = await client.query(
      `INSERT INTO buckets (company_id, label, sort_order)
       VALUES ($1, $2,
               COALESCE((SELECT MAX(sort_order) + 1 FROM buckets WHERE company_id = $1), 0))
       ON CONFLICT (company_id, label) DO NOTHING
       RETURNING label`,
      [companyId, label],
    );
    if (inserted[0]) newLabels.push(inserted[0].label as string);
  }
  return newLabels;
}

/**
 * Read-only preview of which product/bucket labels in this file are not yet
 * registered for the company -- lets the import wizard show "3 new buckets
 * will be created" before commit actually writes them.
 */
export async function previewNewLabels(
  companyId: string,
  validRows: MappedRow[],
): Promise<{ new_buckets: string[]; new_products: string[] }> {
  const productLabels = [...new Set(validRows.map((r) => r.product).filter((p): p is string => !!p))];
  const bucketLabels = [...new Set(validRows.map((r) => r.bucket).filter((b): b is string => !!b))];

  const existingProducts = productLabels.length
    ? await pool.query(`SELECT raw_label FROM products WHERE company_id = $1 AND raw_label = ANY($2)`, [
        companyId,
        productLabels,
      ])
    : { rows: [] as { raw_label: string }[] };
  const existingBuckets = bucketLabels.length
    ? await pool.query(`SELECT label FROM buckets WHERE company_id = $1 AND label = ANY($2)`, [
        companyId,
        bucketLabels,
      ])
    : { rows: [] as { label: string }[] };

  const existingProductSet = new Set(existingProducts.rows.map((r) => r.raw_label));
  const existingBucketSet = new Set(existingBuckets.rows.map((r) => r.label));
  return {
    new_products: productLabels.filter((l) => !existingProductSet.has(l)),
    new_buckets: bucketLabels.filter((l) => !existingBucketSet.has(l)),
  };
}

/** Case/whitespace-insensitive key used only to MATCH file rows to DB customers; storage stays as-is. */
function normalizeLoanNumber(loanNumber: string): string {
  return loanNumber.trim().toUpperCase();
}

export interface AllocationDiff {
  /** Valid rows whose loan number has no customer at all for this company yet. */
  additions: { loan_number: string; row: MappedRow }[];
  /** Valid rows matching an existing ACTIVE customer -- applies directly, as before. */
  updates: { row: MappedRow; customerId: string }[];
  /** Valid rows matching an existing RECALLED/CLOSED customer -- can't blind-update status. */
  reactivations: { row: MappedRow; customerId: string; previousStatus: string }[];
  /** Active customers of this company that the file does not mention at all. */
  removals: { customerId: string; loanNumber: string }[];
}

/**
 * Diffs a validated allocation file against the company's current book so
 * repeat/refresh imports (Phase 7 -- allocation files can arrive at any
 * point in the month, not just once) can be reviewed instead of applied
 * blind: additions/reactivations/removals all need a human decision; only
 * updates to already-active loans apply straight through, same as before.
 */
export async function computeAllocationDiff(
  companyId: string,
  validRows: MappedRow[],
): Promise<AllocationDiff> {
  const { rows: existing } = await pool.query(
    `SELECT id, loan_number, status FROM customers WHERE company_id = $1`,
    [companyId],
  );
  const dbByNormalized = new Map<string, { id: string; loan_number: string; status: string }>();
  for (const c of existing) {
    dbByNormalized.set(normalizeLoanNumber(c.loan_number as string), {
      id: c.id as string,
      loan_number: c.loan_number as string,
      status: c.status as string,
    });
  }
  const fileNormalized = new Set(validRows.map((r) => normalizeLoanNumber(r.loan_number)));

  const additions: AllocationDiff["additions"] = [];
  const updates: AllocationDiff["updates"] = [];
  const reactivations: AllocationDiff["reactivations"] = [];

  for (const row of validRows) {
    const match = dbByNormalized.get(normalizeLoanNumber(row.loan_number));
    if (!match) {
      additions.push({ loan_number: row.loan_number, row });
    } else if (match.status === "active") {
      updates.push({ row, customerId: match.id });
    } else {
      reactivations.push({ row, customerId: match.id, previousStatus: match.status });
    }
  }

  const removals = existing
    .filter(
      (c) => c.status === "active" && !fileNormalized.has(normalizeLoanNumber(c.loan_number as string)),
    )
    .map((c) => ({ customerId: c.id as string, loanNumber: c.loan_number as string }));

  return { additions, updates, reactivations, removals };
}

/**
 * Has this company already had a committed allocation run for this month?
 * Decides addition routing. Allocation files can arrive at any point in the
 * month (day 2, day 28 -- there is no calendar-day check here at all); what
 * matters is purely whether a PRIOR file for this exact allocation_month was
 * already committed, i.e. whether this is a repeat/refresh import.
 */
export async function hasExistingAllocationForMonth(
  companyId: string,
  allocationMonth: string,
): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT EXISTS(
       SELECT 1 FROM import_runs WHERE company_id = $1 AND mode = 'allocation' AND allocation_month = $2
     ) AS exists`,
    [companyId, allocationMonth],
  );
  return rows[0].exists as boolean;
}

function rowToReviewPayload(row: MappedRow): Record<string, unknown> {
  return {
    customer_name: row.customer_name,
    mobile_number: row.mobile_number,
    product: row.product,
    bucket: row.bucket,
    due_amount: row.due_amount,
    pos: row.pos,
    emi: row.emi,
    emi_due_date: row.emi_due_date,
    agent_phone: row.agent_phone,
    custom_fields: row.custom_fields,
  };
}

export interface CommitResult {
  import_run_id: string;
  total_rows: number;
  inserted_rows: number;
  updated_rows: number;
  duplicate_rows: number;
  error_rows: number;
  unknown_agent_phones: string[];
  /** Additions/reactivations waiting on agency_admin/operations_manager review (allocation mode). */
  pending_review: number;
  /** Active customers missing from this file, flagged for review as possible recalls (allocation mode). */
  removal_flagged: number;
  new_buckets: string[];
  new_products: string[];
  /** True when a prior allocation import already exists for this month (a repeat/refresh, not the first). */
  is_repeat_import: boolean;
  unknown_branches?: string[];
}

/** phone -> {id, team_id} for the agency's active users named in the file. */
async function resolveAgents(
  client: PoolClient,
  companyId: string,
  rows: MappedRow[],
): Promise<Map<string, { id: string; team_id: string | null }>> {
  const phones = [...new Set(rows.map((r) => r.agent_phone).filter((p): p is string => !!p))];
  const resolved = new Map<string, { id: string; team_id: string | null }>();
  if (phones.length === 0) return resolved;
  const { rows: users } = await client.query(
    `SELECT u.id, u.team_id, u.phone FROM users u
       JOIN companies co ON co.agency_id = u.agency_id
      WHERE co.id = $1 AND u.phone = ANY($2) AND u.is_active = true`,
    [companyId, phones],
  );
  for (const u of users) resolved.set(u.phone as string, { id: u.id, team_id: u.team_id });
  return resolved;
}

// Resolve branch names/codes to branch IDs (Track 3, Phase 3.4)
async function resolveBranches(
  client: PoolClient,
  companyId: string,
  rows: MappedRow[],
): Promise<Map<string, string>> {
  const branchNames = [...new Set(rows.map((r) => r.customer_branch).filter((b): b is string => !!b))];
  const resolved = new Map<string, string>();
  if (branchNames.length === 0) return resolved;
  const { rows: branches } = await client.query(
    `SELECT b.id, b.name FROM branches b
       JOIN companies co ON co.agency_id = b.agency_id
      WHERE co.id = $1 AND (b.name = ANY($2) OR b.id::text = ANY($2))`,
    [companyId, branchNames],
  );
  for (const b of branches) {
    resolved.set(b.name as string, b.id as string);
    // Also map by ID for flexibility
    resolved.set(b.id as string, b.id as string);
  }
  return resolved;
}

export async function commitImport(params: {
  companyId: string;
  templateId: string | null;
  uploadedBy: string;
  fileName: string | null;
  sheet: ParsedSheet;
  mapping: ColumnMapping;
  mode?: ImportMode;
  allocationMonth?: string | null; // 'YYYY-MM-01', required in allocation mode
}): Promise<CommitResult> {
  const mode: ImportMode = params.mode ?? "new";
  if (mode === "allocation" && !params.allocationMonth) {
    throw new HttpError(400, "allocation_month is required for a monthly allocation import");
  }
  const validation = await validateRows(params.companyId, params.sheet, params.mapping);

  let diff: AllocationDiff | null = null;
  let isRepeatImport = false;
  if (mode === "allocation") {
    isRepeatImport = await hasExistingAllocationForMonth(params.companyId, params.allocationMonth!);
    diff = await computeAllocationDiff(params.companyId, validation.validRows);
  }

  const dbDupes = new Set(validation.duplicatesInDb);
  // mode='new': unchanged -- straight insert, DB dupes rejected.
  // mode='allocation', first import of the month: additions are the expected new
  // book, so they insert directly. A repeat/refresh import for the same month
  // (whenever in the month it arrives) routes additions to review instead,
  // same as reactivations and removals always do (a lender pull-back or a
  // recalled/closed loan reappearing needs a human decision either way).
  const toInsert: MappedRow[] =
    mode === "new"
      ? validation.validRows.filter((r) => !dbDupes.has(r.loan_number))
      : isRepeatImport
        ? []
        : diff!.additions.map((a) => a.row);
  // A repeat/refresh import's changes to already-active customers (due_amount,
  // bucket, etc.) route to review too, same as additions do on a repeat import
  // -- those customers may already have calls/payments/PTPs logged against
  // the old numbers, so a silent overwrite isn't safe. The FIRST allocation
  // import of a month still applies updates directly (nothing to protect yet).
  const toUpdate: { row: MappedRow; customerId: string }[] =
    mode === "allocation" && !isRepeatImport ? diff!.updates : [];
  const reviewAdditions = mode === "allocation" && isRepeatImport ? diff!.additions : [];
  const reviewUpdates = mode === "allocation" && isRepeatImport ? diff!.updates : [];
  const reviewReactivations = mode === "allocation" ? diff!.reactivations : [];
  const reviewRemovals = mode === "allocation" ? diff!.removals : [];

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (mode === "allocation") {
      // The newest file is the truth for ITS month: a pending decision from an
      // older diff of the SAME month is moot once a fresher file for that month
      // exists. Scoped to the same allocation_month (not company-wide) so an
      // unrelated month's import can never silently discard a still-open review.
      await client.query(
        `UPDATE import_review_items iri SET status = 'superseded'
           FROM import_runs ir
          WHERE iri.import_run_id = ir.id
            AND iri.company_id = $1
            AND ir.allocation_month = $2
            AND iri.status = 'pending'`,
        [params.companyId, params.allocationMonth],
      );
    }

    // Run row first so snapshots can reference it; counts patched at the end.
    const run = await client.query(
      `INSERT INTO import_runs
         (company_id, template_id, uploaded_by, file_name, total_rows,
          inserted_rows, duplicate_rows, error_rows, errors, mode, allocation_month)
       VALUES ($1,$2,$3,$4,$5,0,0,0,'[]',$6,$7)
       RETURNING id`,
      [
        params.companyId,
        params.templateId,
        params.uploadedBy,
        params.fileName,
        params.sheet.rows.length,
        mode,
        params.allocationMonth ?? null,
      ],
    );
    const runId = run.rows[0].id as string;

    // Agent-phone resolution for review-pending additions/reactivations happens
    // fresh at approval time (Task 7.3) -- it's only resolved here for rows
    // actually being written now.
    const agents = await resolveAgents(client, params.companyId, [
      ...toInsert,
      ...toUpdate.map((u) => u.row),
    ]);
    // Branch resolution for customer_branch field (Track 3, Phase 3.4)
    const branches = await resolveBranches(client, params.companyId, [
      ...toInsert,
      ...toUpdate.map((u) => u.row),
    ]);
    const unknownPhones = new Set<string>();
    const unknownBranches = new Set<string>();
    const snapshotIds: string[] = [];

    for (const row of toInsert) {
      const agent = row.agent_phone ? agents.get(row.agent_phone) : undefined;
      if (row.agent_phone && !agent) unknownPhones.add(row.agent_phone);
      const branch = row.customer_branch ? branches.get(row.customer_branch) : undefined;
      if (row.customer_branch && !branch) unknownBranches.add(row.customer_branch);
      const inserted = await client.query(
        `INSERT INTO customers
           (company_id, loan_number, customer_name, mobile_number, product, bucket,
            due_amount, pos, emi, due_date, custom_fields, assigned_agent_id, assigned_team_id, branch_id, import_run_id, dpd)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
           CASE WHEN $10::date IS NULL THEN NULL ELSE GREATEST((now() AT TIME ZONE 'Asia/Kolkata')::date - $10::date, 0) END)
         ON CONFLICT (company_id, loan_number) DO NOTHING
         RETURNING id`,
        [
          params.companyId,
          row.loan_number,
          row.customer_name,
          row.mobile_number,
          row.product,
          row.bucket,
          row.due_amount,
          row.pos,
          row.emi,
          row.emi_due_date,
          JSON.stringify(row.custom_fields),
          agent?.id ?? null,
          agent?.team_id ?? null,
          branch ?? null,
          mode === "new" ? runId : null,
        ],
      );
      if (inserted.rows[0]) {
        snapshotIds.push(inserted.rows[0].id as string);
        if (agent) {
          await client.query(
            `INSERT INTO allocation_logs (customer_id, from_agent_id, to_agent_id, allocated_by, reason)
             VALUES ($1, NULL, $2, $3, 'Assigned by import')`,
            [inserted.rows[0].id, agent.id, params.uploadedBy],
          );
        }
      }
    }

    for (const { row, customerId } of toUpdate) {
      const agent = row.agent_phone ? agents.get(row.agent_phone) : undefined;
      if (row.agent_phone && !agent) unknownPhones.add(row.agent_phone);
      const branch = row.customer_branch ? branches.get(row.customer_branch) : undefined;
      if (row.customer_branch && !branch) unknownBranches.add(row.customer_branch);
      const existing = await client.query(
        `SELECT id, customer_name, mobile_number, product, bucket, due_amount, pos, emi, due_date,
                custom_fields, assigned_agent_id, assigned_team_id, branch_id
           FROM customers WHERE id = $1 FOR UPDATE`,
        [customerId],
      );
      const cust = existing.rows[0];
      if (!cust) continue; // deleted between validate and commit — skip quietly

      // Track 6.2: Backup prior state before update
      await client.query(
        `INSERT INTO import_row_backups (import_run_id, customer_id, kind, prior_values)
         VALUES ($1, $2, 'update', $3)
         ON CONFLICT (import_run_id, customer_id) DO NOTHING`,
        [
          runId,
          customerId,
          JSON.stringify({
            customer_name: cust.customer_name,
            mobile_number: cust.mobile_number,
            product: cust.product,
            bucket: cust.bucket,
            due_amount: cust.due_amount,
            pos: cust.pos,
            emi: cust.emi,
            due_date: cust.due_date,
            custom_fields: cust.custom_fields,
            assigned_agent_id: cust.assigned_agent_id,
            assigned_team_id: cust.assigned_team_id,
            branch_id: cust.branch_id,
          }),
        ],
      );

      // The month's file is authoritative for bucket/amounts; blanks keep old values.
      // dpd is recomputed from the effective due_date here too -- otherwise
      // a freshly imported/updated customer shows dpd = NULL (or a stale
      // value from before this import) until the nightly refresh-dpd job
      // next runs, up to ~24h later.
      await client.query(
        `UPDATE customers
            SET customer_name   = COALESCE($2, customer_name),
                mobile_number   = COALESCE($3, mobile_number),
                product         = COALESCE($4, product),
                bucket          = COALESCE($5, bucket),
                due_amount      = COALESCE($6, due_amount),
                pos             = COALESCE($7, pos),
                emi             = COALESCE($8, emi),
                due_date        = COALESCE($9, due_date),
                custom_fields   = custom_fields || $10::jsonb,
                assigned_agent_id = COALESCE($11, assigned_agent_id),
                assigned_team_id  = COALESCE($12, assigned_team_id),
                branch_id       = COALESCE($13, branch_id),
                dpd             = CASE WHEN COALESCE($9, due_date) IS NULL THEN NULL
                                       ELSE GREATEST((now() AT TIME ZONE 'Asia/Kolkata')::date - COALESCE($9, due_date), 0) END
          WHERE id = $1`,
        [
          cust.id,
          row.customer_name,
          row.mobile_number,
          row.product,
          row.bucket,
          row.due_amount,
          row.pos,
          row.emi,
          row.emi_due_date,
          JSON.stringify(row.custom_fields),
          agent?.id ?? null,
          agent?.team_id ?? null,
          branch ?? null,
        ],
      );
      snapshotIds.push(cust.id as string);
      if (agent && cust.assigned_agent_id !== agent.id) {
        await client.query(
          `INSERT INTO allocation_logs (customer_id, from_agent_id, to_agent_id, allocated_by, reason)
           VALUES ($1, $2, $3, $4, 'Monthly allocation import')`,
          [cust.id, cust.assigned_agent_id, agent.id, params.uploadedBy],
        );
      }
    }

    // Snapshot every loan in the file — this is the month's allocated book.
    if (mode === "allocation") {
      for (const customerId of snapshotIds) {
        await client.query(
          `INSERT INTO customer_month_snapshots
             (customer_id, company_id, month, bucket, due_amount, pos, emi, due_date, product,
              assigned_team_id, assigned_agent_id, branch_id, import_run_id)
           SELECT c.id, c.company_id, $2, c.bucket, c.due_amount, c.pos, c.emi, c.due_date, c.product,
                  c.assigned_team_id, c.assigned_agent_id, c.branch_id, $3
             FROM customers c WHERE c.id = $1
           ON CONFLICT (customer_id, month) DO UPDATE
             SET bucket = EXCLUDED.bucket,
                 due_amount = EXCLUDED.due_amount,
                 pos = EXCLUDED.pos,
                 emi = EXCLUDED.emi,
                 due_date = EXCLUDED.due_date,
                 product = EXCLUDED.product,
                 assigned_team_id = EXCLUDED.assigned_team_id,
                 assigned_agent_id = EXCLUDED.assigned_agent_id,
                 branch_id = EXCLUDED.branch_id,
                 import_run_id = EXCLUDED.import_run_id`,
          [customerId, params.allocationMonth, runId],
        );
        // Confirms (or no-ops on) any bucket drop vs. the customer's prior
        // month -- an in-house signal independent of whether a payment
        // already flagged it this month (Task 7.5).
        await detectAllocationConfirmation(
          client,
          customerId,
          params.companyId,
          params.allocationMonth!,
          runId,
        );
      }
    }

    // Additions/reactivations wait for a human decision; nothing is written to
    // customers yet, so their data lives entirely in the review item's payload.
    for (const { row, loan_number } of reviewAdditions) {
      await client.query(
        `INSERT INTO import_review_items (import_run_id, company_id, item_type, customer_id, loan_number, payload)
         VALUES ($1, $2, 'addition', NULL, $3, $4)`,
        [runId, params.companyId, loan_number, JSON.stringify(rowToReviewPayload(row))],
      );
    }
    for (const { row, customerId } of reviewReactivations) {
      await client.query(
        `INSERT INTO import_review_items (import_run_id, company_id, item_type, customer_id, loan_number, payload)
         VALUES ($1, $2, 'reactivation', $3, $4, $5)`,
        [runId, params.companyId, customerId, row.loan_number, JSON.stringify(rowToReviewPayload(row))],
      );
    }
    for (const { row, customerId } of reviewUpdates) {
      await client.query(
        `INSERT INTO import_review_items (import_run_id, company_id, item_type, customer_id, loan_number, payload)
         VALUES ($1, $2, 'update', $3, $4, $5)`,
        [runId, params.companyId, customerId, row.loan_number, JSON.stringify(rowToReviewPayload(row))],
      );
    }
    for (const { customerId, loanNumber } of reviewRemovals) {
      await client.query(
        `INSERT INTO import_review_items (import_run_id, company_id, item_type, customer_id, loan_number, payload)
         VALUES ($1, $2, 'removal', $3, $4, '{}'::jsonb)`,
        [runId, params.companyId, customerId, loanNumber],
      );
    }

    // Unique buckets/products drive reports regardless of whether the row that
    // carried the label ended up inserted, updated, or parked in review.
    const newProducts = await deriveProducts(client, params.companyId, validation.validRows);
    const newBuckets = await deriveBuckets(client, params.companyId, validation.validRows);

    const duplicateRows = mode === "new" ? validation.duplicatesInDb.length : 0;
    const pendingReviewRows = reviewAdditions.length + reviewReactivations.length + reviewUpdates.length;
    await client.query(
      `UPDATE import_runs
          SET inserted_rows = $2, updated_rows = $3, duplicate_rows = $4,
              error_rows = $5, errors = $6, pending_review_rows = $7,
              removal_rows = $8, new_buckets = $9, new_products = $10
        WHERE id = $1`,
      [
        runId,
        toInsert.length,
        toUpdate.length,
        duplicateRows,
        validation.errors.length,
        JSON.stringify(validation.errors.slice(0, 100)),
        pendingReviewRows,
        reviewRemovals.length,
        JSON.stringify(newBuckets),
        JSON.stringify(newProducts),
      ],
    );
    await client.query("COMMIT");
    return {
      import_run_id: runId,
      total_rows: params.sheet.rows.length,
      inserted_rows: toInsert.length,
      updated_rows: toUpdate.length,
      duplicate_rows: duplicateRows,
      error_rows: validation.errors.length,
      unknown_agent_phones: [...unknownPhones],
      unknown_branches: [...unknownBranches],
      pending_review: pendingReviewRows,
      removal_flagged: reviewRemovals.length,
      new_buckets: newBuckets,
      new_products: newProducts,
      is_repeat_import: isRepeatImport,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

