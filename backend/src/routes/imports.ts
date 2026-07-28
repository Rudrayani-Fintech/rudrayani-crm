import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { pool } from "../config/db";
import { asyncHandler } from "../middleware/async-handler";
import { authenticate, requirePermission } from "../middleware/authenticate";
import { HttpError } from "../middleware/error-handler";
import {
  cacheParsedSheet,
  commitImport,
  computeAllocationDiff,
  getOrParseSheet,
  hasExistingAllocationForMonth,
  parseWorkbook,
  previewNewLabels,
  validateRows,
  type ColumnMapping,
} from "../services/import-service";
import { resolveFieldCatalog } from "../services/field-config-service";
import { recordAuditLog } from "../services/audit-log-service";
import { getStorage } from "../services/storage/storage-provider";

// import_row_backups.prior_values is only ever written by this app's own
// fixed SELECT lists (see commitImport()'s "update" backup and
// import-reviews.ts's "removal" backup) -- never from a user/CSV-supplied
// column name -- so there's no live SQL-injection path today. This allow-
// list exists as the same explicit, self-documenting guard
// correction-requests.ts's assertAllowedFields() already uses for its own
// dynamic UPDATE, so a future change to either SELECT can't silently start
// interpolating an unvetted key here without this throwing first.
const ROLLBACK_ALLOWED_FIELDS = new Set([
  "customer_name",
  "mobile_number",
  "product",
  "bucket",
  "due_amount",
  "pos",
  "emi",
  "due_date",
  "custom_fields",
  "assigned_agent_id",
  "assigned_team_id",
  "branch_id",
  "status",
]);

function assertRollbackFieldsAllowed(fields: string[]): void {
  const bad = fields.filter((f) => !ROLLBACK_ALLOWED_FIELDS.has(f));
  if (bad.length > 0) {
    throw new HttpError(500, `Rollback cannot restore unexpected field(s): ${bad.join(", ")}`);
  }
}

const router = Router();
router.use(authenticate, requirePermission("imports.manage"));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB
});

// Owner feedback round, Phase 10: field keys are no longer a compile-time
// enum (they're per-agency data now, see field-config-service.ts) -- Zod can
// only check shape here, unknown/disabled field keys are rejected against
// the runtime catalog inside validateRows().
const mappingSchema = z.record(z.string().min(1), z.string().min(1));
const uploadKeySchema = z
  .string()
  .regex(/^imports\/[a-f0-9-]+\.xlsx$/, "Invalid upload reference");

async function assertCompanyInAgency(companyId: string, agencyId: string): Promise<void> {
  const { rows } = await pool.query("SELECT 1 FROM companies WHERE id = $1 AND agency_id = $2", [
    companyId,
    agencyId,
  ]);
  if (rows.length === 0) throw new HttpError(404, "Company not found in this agency");
}

async function resolveMapping(
  agencyId: string,
  companyId: string,
  templateId: string | undefined,
  rawMapping: unknown,
): Promise<{ mapping: ColumnMapping; templateId: string | null }> {
  if (templateId) {
    const { rows } = await pool.query(
      `SELECT t.column_mapping FROM import_templates t
         JOIN companies c ON c.id = t.company_id
        WHERE t.id = $1 AND t.company_id = $2 AND c.agency_id = $3 AND t.is_active = true`,
      [templateId, companyId, agencyId],
    );
    if (!rows[0]) throw new HttpError(404, "Template not found");
    return { mapping: rows[0].column_mapping as ColumnMapping, templateId };
  }
  if (rawMapping) {
    return { mapping: mappingSchema.parse(rawMapping), templateId: null };
  }
  throw new HttpError(400, "Provide either template_id or column_mapping");
}

const uploadQuerySchema = z.object({ company_id: z.string().uuid().optional() });

/**
 * Step 1 — upload the raw .xlsx. Returns the detected columns plus an
 * upload_key used by preview/commit (file is kept via the StorageProvider).
 *
 * Phase 10: accepts an optional ?company_id= so the mapping-step field list
 * (`system_fields`) reflects that company's actual enabled/required catalog
 * instead of the old agency-wide constant. The frontend's Step 0 already
 * collects company_id before this call (ImportPage.tsx) -- optional here
 * only so existing callers that don't send it yet keep working; without it,
 * mapping still validates fully at /preview and /commit (which always
 * require company_id), this only affects what the wizard offers up front.
 */
router.post(
  "/upload",
  upload.single("file"),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new HttpError(400, "Attach the Excel file as the 'file' field");
    if (!req.file.originalname.toLowerCase().endsWith(".xlsx")) {
      throw new HttpError(400, "Only .xlsx files are supported");
    }
    const query = uploadQuerySchema.parse(req.query);
    let systemFields: Awaited<ReturnType<typeof resolveFieldCatalog>> = [];
    if (query.company_id) {
      await assertCompanyInAgency(query.company_id, req.user!.agency_id);
      systemFields = (await resolveFieldCatalog(query.company_id)).filter((f) => f.is_enabled);
    }
    const sheet = await parseWorkbook(req.file.buffer);
    const key = await getStorage().save("imports", "xlsx", req.file.buffer);
    // Already parsed above -- cache it now under the key /preview and
    // /commit will use, so they don't re-read and re-parse the same file.
    cacheParsedSheet(key, sheet);
    res.status(201).json({
      upload_key: key,
      file_name: req.file.originalname,
      columns: sheet.columns,
      row_count: sheet.rows.length,
      system_fields: systemFields,
    });
  }),
);

const previewSchema = z
  .object({
    upload_key: uploadKeySchema,
    company_id: z.string().uuid(),
    template_id: z.string().uuid().optional(),
    column_mapping: mappingSchema.optional(),
    mode: z.enum(["new", "allocation"]).default("new"),
    allocation_month: z
      .string()
      .regex(/^\d{4}-\d{2}-01$/, "allocation_month must be the 1st of a month (YYYY-MM-01)")
      .optional(),
  })
  .refine((b) => b.mode !== "allocation" || !!b.allocation_month, {
    message: "allocation_month is required for a monthly allocation import",
    path: ["allocation_month"],
  });

/** Step 2 — dry run: full validation report, nothing written. */
router.post(
  "/preview",
  asyncHandler(async (req, res) => {
    const body = previewSchema.parse(req.body);
    await assertCompanyInAgency(body.company_id, req.user!.agency_id);
    const { mapping } = await resolveMapping(
      req.user!.agency_id,
      body.company_id,
      body.template_id,
      body.column_mapping,
    );
    const sheet = await getOrParseSheet(body.upload_key, () => getStorage().read(body.upload_key));
    const result = await validateRows(body.company_id, sheet, mapping);

    if (body.mode !== "allocation") {
      res.json({
        mode: body.mode,
        total_rows: sheet.rows.length,
        valid_rows: result.validRows.length - result.duplicatesInDb.length,
        error_rows: result.errors.length,
        duplicates_in_db: result.duplicatesInDb.length,
        unmapped_columns: result.unmappedColumns,
        errors: result.errors.slice(0, 50),
        duplicate_loan_numbers: result.duplicatesInDb.slice(0, 50),
        // Remapped to the same shape as the allocation-mode diff's sample
        // rows below (customer_branch -> branch) so the frontend can render
        // both with the same column set.
        sample_rows: result.validRows.slice(0, 5).map((r) => ({
          loan_number: r.loan_number,
          customer_name: r.customer_name,
          bucket: r.bucket,
          due_amount: r.due_amount,
          pos: r.pos,
          product: r.product,
          emi: r.emi,
          branch: r.customer_branch,
        })),
      });
      return;
    }

    // Allocation mode: show the actual diff against the active book, not just
    // a dupes/missing count, so the reviewer knows what will need a decision.
    const isRepeatImport = await hasExistingAllocationForMonth(body.company_id, body.allocation_month!);
    const diff = await computeAllocationDiff(body.company_id, result.validRows);
    const labels = await previewNewLabels(body.company_id, result.validRows);

    const removalCustomerIds = diff.removals.map((r) => r.customerId);
    const removalDetails = removalCustomerIds.length
      ? await pool.query(
          `SELECT c.id, c.customer_name, c.bucket, c.due_amount, c.pos, u.full_name AS agent_name
             FROM customers c LEFT JOIN users u ON u.id = c.assigned_agent_id
            WHERE c.id = ANY($1)`,
          [removalCustomerIds],
        )
      : {
          rows: [] as {
            id: string;
            customer_name: string;
            bucket: string | null;
            due_amount: string | null;
            pos: string | null;
            agent_name: string | null;
          }[],
        };
    const removalById = new Map(removalDetails.rows.map((r) => [r.id, r]));

    res.json({
      mode: "allocation",
      total_rows: sheet.rows.length,
      error_rows: result.errors.length,
      is_repeat_import: isRepeatImport,
      will_update: diff.updates.length,
      additions: {
        count: diff.additions.length,
        sample: diff.additions.slice(0, 20).map((a) => ({
          loan_number: a.loan_number,
          customer_name: a.row.customer_name,
          bucket: a.row.bucket,
          due_amount: a.row.due_amount,
          pos: a.row.pos,
          product: a.row.product,
          emi: a.row.emi,
          branch: a.row.customer_branch,
        })),
      },
      removals: {
        count: diff.removals.length,
        sample: diff.removals.slice(0, 20).map((r) => ({
          loan_number: r.loanNumber,
          customer_name: removalById.get(r.customerId)?.customer_name ?? null,
          bucket: removalById.get(r.customerId)?.bucket ?? null,
          due_amount: removalById.get(r.customerId)?.due_amount ?? null,
          pos: removalById.get(r.customerId)?.pos ?? null,
          agent_name: removalById.get(r.customerId)?.agent_name ?? null,
        })),
      },
      reactivations: {
        count: diff.reactivations.length,
        sample: diff.reactivations.slice(0, 20).map((r) => ({
          loan_number: r.row.loan_number,
          customer_name: r.row.customer_name,
          previous_status: r.previousStatus,
        })),
      },
      new_buckets: labels.new_buckets,
      new_products: labels.new_products,
      unmapped_columns: result.unmappedColumns,
      errors: result.errors.slice(0, 50),
      sample_rows: result.validRows.slice(0, 5),
    });
  }),
);

const commitSchema = z
  .object({
    upload_key: uploadKeySchema,
    company_id: z.string().uuid(),
    template_id: z.string().uuid().optional(),
    column_mapping: mappingSchema.optional(),
    mode: z.enum(["new", "allocation"]).default("new"),
    allocation_month: z
      .string()
      .regex(/^\d{4}-\d{2}-01$/, "allocation_month must be the 1st of a month (YYYY-MM-01)")
      .optional(),
    file_name: z.string().max(300).optional(),
  })
  .refine((b) => b.mode !== "allocation" || !!b.allocation_month, {
    message: "allocation_month is required for a monthly allocation import",
    path: ["allocation_month"],
  });

/** Step 3 — transactional commit into customers (+ product derivation + audit). */
router.post(
  "/commit",
  asyncHandler(async (req, res) => {
    const body = commitSchema.parse(req.body);
    await assertCompanyInAgency(body.company_id, req.user!.agency_id);
    const { mapping, templateId } = await resolveMapping(
      req.user!.agency_id,
      body.company_id,
      body.template_id,
      body.column_mapping,
    );
    const sheet = await getOrParseSheet(body.upload_key, () => getStorage().read(body.upload_key));
    const result = await commitImport({
      companyId: body.company_id,
      templateId,
      uploadedBy: req.user!.id,
      fileName: body.file_name ?? null,
      sheet,
      mapping,
      mode: body.mode,
      allocationMonth: body.allocation_month ?? null,
    });
    res.status(201).json(result);
  }),
);

/** Import history for a company. */
router.get(
  "/runs",
  asyncHandler(async (req, res) => {
    const companyId = z.string().uuid().parse(req.query.company_id);
    await assertCompanyInAgency(companyId, req.user!.agency_id);
    const { rows } = await pool.query(
      `SELECT r.*, u.full_name AS uploaded_by_name, t.name AS template_name
         FROM import_runs r
         LEFT JOIN users u ON u.id = r.uploaded_by
         LEFT JOIN import_templates t ON t.id = r.template_id
        WHERE r.company_id = $1
        ORDER BY r.created_at DESC
        LIMIT 100`,
      [companyId],
    );
    res.json({ runs: rows });
  }),
);

/**
 * Delete a new-mode import run and all the customers it created, provided
 * none of those customers have been assigned an agent or worked (payments,
 * call logs, PTPs). Marks the run record as deleted rather than removing it.
 */
router.delete(
  "/runs/:id",
  asyncHandler(async (req, res) => {
    const runId = z.string().uuid().parse(req.params.id);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Previously both of the checks below ran as separate pool.query()
      // calls before this transaction even started (before client.connect(),
      // before BEGIN) -- a concurrent allocation or payment could land in
      // that gap and be silently destroyed by the DELETE below. Running them
      // on `client` inside the transaction, with FOR UPDATE locking the
      // customer rows, closes the race against any writer that itself locks
      // the row (payments.ts does). It narrows but does not fully close the
      // race against call_logs/field_visits/ptps inserts, since those write
      // paths don't take a row lock on customers -- closing that fully would
      // mean adding FOR UPDATE to those insert paths too, which is out of
      // scope for this pass.
      const runRow = await client.query(
        `SELECT r.id, r.mode, r.company_id FROM import_runs r
          JOIN companies c ON c.id = r.company_id
         WHERE r.id = $1 AND c.agency_id = $2 AND r.deleted_at IS NULL
         FOR UPDATE OF r`,
        [runId, req.user!.agency_id],
      );
      if (!runRow.rows[0]) throw new HttpError(404, "Import run not found");
      if (runRow.rows[0].mode !== "new") {
        throw new HttpError(400, "Only new-mode import runs can be deleted");
      }

      const worked = await client.query(
        `SELECT 1 FROM customers c
          WHERE c.import_run_id = $1
            AND (c.assigned_agent_id IS NOT NULL
              OR c.assigned_field_agent_id IS NOT NULL
              OR EXISTS (SELECT 1 FROM payments p WHERE p.customer_id = c.id)
              OR EXISTS (SELECT 1 FROM call_logs cl WHERE cl.customer_id = c.id)
              OR EXISTS (SELECT 1 FROM ptps pt WHERE pt.customer_id = c.id))
          LIMIT 1
          FOR UPDATE OF c`,
        [runId],
      );
      if (worked.rows.length > 0) {
        throw new HttpError(
          400,
          "Cannot delete: some customers from this run have been assigned or worked. Recall them first.",
        );
      }

      // delete dependents before customers (FK order)
      await client.query(
        `DELETE FROM import_review_items WHERE import_run_id = $1`,
        [runId],
      );
      await client.query(
        `DELETE FROM customer_month_snapshots WHERE customer_id IN
           (SELECT id FROM customers WHERE import_run_id = $1)`,
        [runId],
      );
      await client.query(
        `DELETE FROM allocation_logs WHERE customer_id IN
           (SELECT id FROM customers WHERE import_run_id = $1)`,
        [runId],
      );
      await client.query(
        `DELETE FROM customers WHERE import_run_id = $1`,
        [runId],
      );
      await client.query(
        `UPDATE import_runs SET deleted_at = now() WHERE id = $1`,
        [runId],
      );
      await recordAuditLog(client, {
        agencyId: req.user!.agency_id,
        actorId: req.user!.id,
        action: "import.delete_run",
        entityType: "import_run",
        entityId: runId,
      });
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    res.status(204).end();
  }),
);

/**
 * Track 6.4: Rollback allocation-mode (review-approval) imports.
 * Reverses changes per backup kind (update, addition, reactivation, removal).
 * All-or-nothing: blocks entire rollback if any customer has been worked since.
 */
router.post(
  "/runs/:id/rollback",
  asyncHandler(async (req, res) => {
    const runId = z.string().uuid().parse(req.params.id);
    let rolledBackCount = 0;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Previously the run/backups/blocked-customer checks below all ran as
      // separate pool.query() calls before this transaction started -- a
      // concurrent payment, call log or PTP could land in that gap and be
      // silently overwritten by the restores below. Running them on `client`
      // inside the transaction, with FOR UPDATE locking both the run row and
      // the affected customer rows, closes the race against any writer that
      // itself locks the row (payments.ts does). It narrows but does not
      // fully close the race against call_logs/field_visits/ptps inserts,
      // since those write paths don't take a row lock on customers.
      const runRow = await client.query(
        `SELECT r.id, r.company_id, r.rolled_back_at FROM import_runs r
          JOIN companies c ON c.id = r.company_id
         WHERE r.id = $1 AND c.agency_id = $2
         FOR UPDATE OF r`,
        [runId, req.user!.agency_id],
      );
      if (!runRow.rows[0]) throw new HttpError(404, "Import run not found");
      if (runRow.rows[0].rolled_back_at) {
        throw new HttpError(400, "This import run has already been rolled back");
      }

      // Get all backups for this run
      const backups = await client.query(
        `SELECT id, customer_id, kind, prior_values, created_at FROM import_row_backups
          WHERE import_run_id = $1
          ORDER BY created_at`,
        [runId],
      );

      if (backups.rows.length === 0) {
        throw new HttpError(400, "No backups found for this import run");
      }
      rolledBackCount = backups.rows.length;

      // Lock every customer row this rollback will touch before checking
      // or reversing anything, so a concurrent locked writer (payments.ts)
      // blocks here rather than racing past this check.
      await client.query(
        `SELECT 1 FROM customers WHERE id = ANY($1::uuid[]) FOR UPDATE`,
        [backups.rows.map((b) => b.customer_id)],
      );

      // Check which customers have been worked since their backup was created
      const blockedResult = await client.query(
        `SELECT DISTINCT irb.customer_id, c.loan_number
           FROM import_row_backups irb
           JOIN customers c ON c.id = irb.customer_id
          WHERE irb.import_run_id = $1
            AND (
              EXISTS (SELECT 1 FROM allocation_logs al WHERE al.customer_id = irb.customer_id AND al.created_at > irb.created_at)
              OR EXISTS (SELECT 1 FROM payments p WHERE p.customer_id = irb.customer_id AND p.created_at > irb.created_at)
              OR EXISTS (SELECT 1 FROM call_logs cl WHERE cl.customer_id = irb.customer_id AND cl.created_at > irb.created_at)
              OR EXISTS (SELECT 1 FROM ptps pt WHERE pt.customer_id = irb.customer_id AND pt.created_at > irb.created_at)
              OR EXISTS (SELECT 1 FROM import_runs ir2 WHERE ir2.id != $1 AND ir2.created_at > irb.created_at AND EXISTS (SELECT 1 FROM customers c2 WHERE c2.id = irb.customer_id AND c2.import_run_id = ir2.id))
            )`,
        [runId],
      );

      if (blockedResult.rows.length > 0) {
        throw new HttpError(409, `Rollback blocked: ${blockedResult.rows.length} customer(s) have been worked since. ${blockedResult.rows.map((r: { loan_number: string }) => r.loan_number).join(", ")}`);
      }

      // Process each backup and reverse it per kind
      for (const backup of backups.rows) {
        const { customer_id, kind, prior_values } = backup;

        if (kind === "update") {
          // Restore prior field values
          const priorData = prior_values as Record<string, unknown>;
          assertRollbackFieldsAllowed(Object.keys(priorData));
          const setClauses: string[] = [];
          const values: unknown[] = [customer_id];
          let paramIdx = 2;

          // Build dynamic SET clause for all fields in prior_values
          for (const [field, value] of Object.entries(priorData)) {
            if (field === "custom_fields" && value) {
              setClauses.push(`${field} = $${paramIdx}::jsonb`);
            } else {
              setClauses.push(`${field} = $${paramIdx}`);
            }
            values.push(value ?? null);
            paramIdx++;
          }

          await client.query(
            `UPDATE customers SET ${setClauses.join(", ")} WHERE id = $1`,
            values,
          );
        } else if (kind === "addition") {
          // Delete the customer (with safety: already verified no work done since).
          // Dependents with no ON DELETE CASCADE must go first (FK order) --
          // import_row_backups references this very customer (including the
          // backup row we're processing right now), and allocation_logs holds
          // the auto-assignment made at approval time, which predates this
          // backup's timestamp and so isn't caught by the "worked since" check.
          await client.query(`DELETE FROM import_row_backups WHERE customer_id = $1`, [customer_id]);
          await client.query(`DELETE FROM allocation_logs WHERE customer_id = $1`, [customer_id]);
          await client.query(`DELETE FROM customers WHERE id = $1`, [customer_id]);
        } else if (kind === "reactivation") {
          // Re-deactivate by setting status = 'recalled', recalled_at = now()
          await client.query(
            `UPDATE customers SET status = 'recalled', recalled_at = now() WHERE id = $1`,
            [customer_id],
          );
        } else if (kind === "removal") {
          // Reactivate by restoring prior state
          const priorData = prior_values as Record<string, unknown>;
          assertRollbackFieldsAllowed(Object.keys(priorData));
          const setClauses: string[] = [];
          const values: unknown[] = [customer_id];
          let paramIdx = 2;

          for (const [field, value] of Object.entries(priorData)) {
            if (field === "custom_fields" && value) {
              setClauses.push(`${field} = $${paramIdx}::jsonb`);
            } else {
              setClauses.push(`${field} = $${paramIdx}`);
            }
            values.push(value ?? null);
            paramIdx++;
          }

          await client.query(
            `UPDATE customers SET ${setClauses.join(", ")} WHERE id = $1`,
            values,
          );
        }
      }

      // Mark as rolled back
      await client.query(
        `UPDATE import_runs SET rolled_back_at = now() WHERE id = $1`,
        [runId],
      );

      await recordAuditLog(client, {
        agencyId: req.user!.agency_id,
        actorId: req.user!.id,
        action: "import.rollback",
        entityType: "import_run",
        entityId: runId,
        details: { backups_reversed: rolledBackCount },
      });

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    res.json({ ok: true, rolled_back_count: rolledBackCount });
  }),
);

export default router;
