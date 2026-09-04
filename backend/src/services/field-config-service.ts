import type { Pool, PoolClient } from "pg";
import { pool } from "../config/db";

/**
 * Owner feedback round, Phase 10: system fields are now an agency-level
 * master catalog (system_field_definitions) with per-company configuration
 * (company_field_settings), replacing the compile-time SYSTEM_FIELDS /
 * REQUIRED_MAPPED_FIELDS consts that used to live in import-service.ts.
 */

export interface FieldCatalogEntry {
  field_key: string;
  label: string;
  storage_column: string | null;
  /** 'text' | 'numeric' | 'date' | 'resolver' (agent_phone -- see import-service.ts) */
  field_type: string;
  is_core: boolean;
  is_enabled: boolean;
  is_required: boolean;
  sort_order: number;
}

/**
 * Field keys the import pipeline structurally depends on -- loan_number is
 * the dedup/match key (unique per company, used to diff allocation files
 * against the current book) and customer_name is the row-identity fallback
 * shown everywhere a customer is referenced. Disabling either would break
 * the pipeline itself, not just hide a column, so the admin UI/API must
 * never allow it (see PUT /field-config/settings).
 */
export const STRUCTURALLY_REQUIRED_FIELDS = ["loan_number", "customer_name"];

/**
 * Default "must be mapped at import" set for a company with no explicit
 * override (mirrors the historical REQUIRED_MAPPED_FIELDS const, and the
 * Phase 10 migration's seed for pre-existing companies). Deliberately
 * excludes emi_due_date -- see import-service.ts's long-standing comment: a
 * company may not share due dates from day one, and forcing it blocks
 * onboarding for a real scenario (e2e-allocation-lifecycle.test.ts).
 */
const DEFAULT_REQUIRED_CORE_FIELDS = [
  "loan_number",
  "customer_name",
  "mobile_number",
  "product",
  "bucket",
  "due_amount",
  "pos",
  "emi",
  "agent_phone",
  // Phase 5 (N1, N2, §4.3): address is now a real column, and is required
  // at the import column-mapping step -- a lender file with no address
  // column is rejected at import (loud, intentional).
  "address",
];

/**
 * The 10 core loan-ledger fields (former SYSTEM_FIELDS) plus "address",
 * which was already a mappable system field pre-Phase-10 (routed to
 * custom_fields, no native column). Order matches the old SYSTEM_FIELDS
 * array. Shared by the Phase 10 migration's historical seed AND
 * ensureAgencyFieldDefinitions() below, which self-heals any agency that
 * doesn't have its catalog seeded yet -- there is no app route that creates
 * agencies (only seed scripts/tests insert directly), so definitions can't
 * only be seeded once at migration time.
 */
const CORE_FIELD_DEFINITIONS_SQL = `(VALUES
  ('loan_number',   'Loan Number',                  'loan_number',   'text',     true,  0),
  ('customer_name', 'Customer Name',                'customer_name', 'text',     true,  1),
  ('mobile_number', 'Mobile Number',                'mobile_number', 'text',     true,  2),
  ('product',       'Product',                      'product',       'text',     true,  3),
  ('bucket',        'Bucket',                       'bucket',        'text',     true,  4),
  ('due_amount',    'Due Amount',                   'due_amount',    'numeric',  true,  5),
  ('pos',           'POS — Principal Outstanding',  'pos',           'numeric',  true,  6),
  ('emi',           'EMI Amount',                   'emi',           'numeric',  true,  7),
  ('emi_due_date',  'EMI Due Date',                 'due_date',      'date',     true,  8),
  ('agent_phone',   'Agent Phone',                  NULL,            'resolver', true,  9),
  ('address',       'Address',                      'address',       'text',     true,  10)
) AS f(field_key, label, storage_column, field_type, is_core, sort_order)`;

/**
 * Idempotent (ON CONFLICT DO NOTHING): seeds the agency's core catalog if
 * it's missing. Cheap to call on every resolve/list -- a single indexed
 * upsert-shaped insert, not a per-row round trip.
 */
export async function ensureAgencyFieldDefinitions(executor: Pool | PoolClient, agencyId: string): Promise<void> {
  await executor.query(
    `INSERT INTO system_field_definitions (agency_id, field_key, label, storage_column, field_type, is_core, sort_order)
     SELECT $1, f.field_key, f.label, f.storage_column, f.field_type, f.is_core, f.sort_order
       FROM ${CORE_FIELD_DEFINITIONS_SQL}
     ON CONFLICT (agency_id, field_key) DO NOTHING`,
    [agencyId],
  );
}

/**
 * Resolves the effective field catalog for one company: every field defined
 * for its agency, joined against that company's overrides. A field with no
 * company_field_settings row yet -- a brand new custom field, or a company
 * whose settings row genuinely doesn't exist (e.g. inserted directly, not
 * through POST /companies) -- falls back to is_enabled = its definition's
 * is_core, is_required = whether it's one of the historically-required core
 * fields. That fallback (not just a bare `false`) is what keeps this
 * runtime-driven path behaviorally identical to the old compile-time
 * REQUIRED_MAPPED_FIELDS const even for a company with zero settings rows.
 */
export async function resolveFieldCatalog(companyId: string): Promise<FieldCatalogEntry[]> {
  const agencyRow = await pool.query<{ agency_id: string }>(
    "SELECT agency_id FROM companies WHERE id = $1",
    [companyId],
  );
  const agencyId = agencyRow.rows[0]?.agency_id;
  if (agencyId) await ensureAgencyFieldDefinitions(pool, agencyId);

  const { rows } = await pool.query(
    `SELECT d.field_key, d.label, d.storage_column, d.field_type, d.is_core,
            COALESCE(s.is_enabled, d.is_core) AS is_enabled,
            COALESCE(s.is_required, d.field_key = ANY($2::text[])) AS is_required,
            COALESCE(s.sort_order, d.sort_order) AS sort_order
       FROM system_field_definitions d
       JOIN companies c ON c.agency_id = d.agency_id
       LEFT JOIN company_field_settings s ON s.company_id = c.id AND s.field_key = d.field_key
      WHERE c.id = $1
      ORDER BY sort_order, d.label`,
    [companyId, DEFAULT_REQUIRED_CORE_FIELDS],
  );
  return rows as FieldCatalogEntry[];
}

/** Full agency master catalog (used by the admin FieldConfigPage, no per-company join). */
export async function listAgencyDefinitions(agencyId: string) {
  await ensureAgencyFieldDefinitions(pool, agencyId);
  const { rows } = await pool.query(
    `SELECT id, field_key, label, storage_column, field_type, is_core, sort_order, created_at
       FROM system_field_definitions
      WHERE agency_id = $1
      ORDER BY sort_order, label`,
    [agencyId],
  );
  return rows;
}

/**
 * New-company bootstrap: gives a freshly created company the same
 * all-enabled catalog every other company of the agency has, with the
 * historical core fields marked required -- keeps the "every company has
 * required core fields" guarantee for companies created AFTER Phase 10,
 * not just the ones the migration back-filled. Called from POST /companies.
 */
export async function seedCompanyFieldSettings(
  client: PoolClient,
  companyId: string,
  agencyId: string,
): Promise<void> {
  await ensureAgencyFieldDefinitions(client, agencyId);
  await client.query(
    `INSERT INTO company_field_settings (company_id, field_key, is_enabled, is_required, sort_order)
     SELECT $1, d.field_key, true, d.field_key = ANY($3::text[]), d.sort_order
       FROM system_field_definitions d
      WHERE d.agency_id = $2
     ON CONFLICT (company_id, field_key) DO NOTHING`,
    [companyId, agencyId, DEFAULT_REQUIRED_CORE_FIELDS],
  );
}
