import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { pool } from "../config/db";
import { asyncHandler } from "../middleware/async-handler";
import { authenticate, requirePermission } from "../middleware/authenticate";
import { HttpError } from "../middleware/error-handler";
import { detectPaymentNormalization } from "../services/bucket-movement-service";
import { listDeposits } from "../services/report-service";
import { customerWriteScopeClamp } from "../services/scope";
import { getStorage } from "../services/storage/storage-provider";

/**
 * Payment capture (build brief Section 8): whichever agent closes the payment
 * records amount, mode, date, and a photo proof (camera/gallery upload). The
 * photo goes through the StorageProvider; closing the customer is an explicit
 * flag so a part-payment doesn't end the journey by accident.
 */
const router = Router();
router.use(authenticate, requirePermission("payments.record"));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8 MB — phone camera photos
});

const PHOTO_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

const paymentBody = z.object({
  customer_id: z.string().uuid(),
  amount: z.coerce.number().positive(),
  mode: z.string().trim().min(1).max(60).optional(),
  // Phase 12 (Management Dashboard "Settlement vs EMI Collections" KPI):
  // captured at collection time, defaults to the overwhelmingly common case.
  type: z.enum(["emi", "settlement"]).default("emi"),
  paid_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").optional(),
  close_customer: z
    .union([z.boolean(), z.enum(["true", "false"]).transform((v) => v === "true")])
    .default(false),
  client_key: z.string().uuid().optional(), // offline-sync idempotency key
});

/** Look up a payment previously created with this idempotency key. */
async function findByClientKey(userId: string, clientKey: string) {
  const { rows } = await pool.query(
    "SELECT * FROM payments WHERE collected_by_user_id = $1 AND client_key = $2",
    [userId, clientKey],
  );
  return rows[0] ?? null;
}

router.post(
  "/",
  upload.single("photo"),
  asyncHandler(async (req, res) => {
    const body = paymentBody.parse(req.body);
    const agencyId = req.user!.agency_id;

    // Checked before the photo is stored so a re-send doesn't orphan a copy.
    if (body.client_key) {
      const dup = await findByClientKey(req.user!.id, body.client_key);
      if (dup) {
        res.status(200).json({ payment: dup, customer_closed: false, duplicate: true });
        return;
      }
    }

    let photoKey: string | null = null;
    if (req.file) {
      const ext = PHOTO_EXTENSIONS[req.file.mimetype];
      if (!ext) throw new HttpError(400, "Photo must be JPEG, PNG, or WebP");
      photoKey = await getStorage().save("payments", ext, req.file.buffer);
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Previously read outside the transaction (TOCTOU: a concurrent
      // close/recall could land in the gap between this check and the
      // INSERT below) and scoped by agency_id only -- any user holding
      // payments.record could record a payment against any customer in the
      // agency, not just one assigned to them or their branch. FOR UPDATE
      // serializes concurrent writers on this row; the scope clamp
      // restricts which customers this caller may pay against at all.
      const scopeParams: unknown[] = [body.customer_id, agencyId];
      const scopeClause = await customerWriteScopeClamp(req.user!, scopeParams, "c");
      const custRes = await client.query(
        `SELECT c.id, c.status, c.due_amount FROM customers c
           JOIN companies co ON co.id = c.company_id
          WHERE c.id = $1 AND co.agency_id = $2 ${scopeClause}
          FOR UPDATE OF c`,
        scopeParams,
      );
      if (!custRes.rows[0]) throw new HttpError(404, "Customer not found in this agency");
      if (custRes.rows[0].status === "closed") throw new HttpError(400, "Customer is already closed");
      if (custRes.rows[0].status === "recalled") {
        throw new HttpError(400, "Customer was recalled by the lender -- no longer collectible here");
      }

      // Stamped server-side from the customer's actual due_amount, ignoring
      // whatever the client believes — a reliable ops signal even if a future
      // client build forgets to show the warning (product decision: never
      // block on this, just flag it for later spot-checking).
      const dueAmount = custRes.rows[0].due_amount as string | null;
      const exceedsDueAmount = dueAmount != null && body.amount > Number(dueAmount);

      // A bare `$6::date` cast to timestamptz is anchored to UTC midnight of
      // that date, not IST midnight -- it happened to still land on the
      // right IST calendar day only by coincidence of the 5.5h offset,
      // while every report boundary elsewhere in the codebase anchors to
      // IST midnight. Anchor the same way here for one consistent contract.
      const payRes = await client.query(
        `INSERT INTO payments (customer_id, collected_by_user_id, amount, mode, photo_proof_url, paid_at, client_key, exceeds_due_amount, type)
         VALUES ($1, $2, $3, $4, $5, COALESCE($6::date::timestamp AT TIME ZONE 'Asia/Kolkata', now()), $7, $8, $9)
         RETURNING *`,
        [
          body.customer_id,
          req.user!.id,
          body.amount,
          body.mode ?? null,
          photoKey,
          body.paid_at ?? null,
          body.client_key ?? null,
          exceedsDueAmount,
          body.type,
        ],
      );

      if (body.close_customer) {
        await client.query(
          `UPDATE customers SET status = 'closed', assigned_agent_id = NULL WHERE id = $1`,
          [body.customer_id],
        );
      }

      await detectPaymentNormalization(client, body.customer_id, payRes.rows[0].id);

      await client.query("COMMIT");
      res.status(201).json({
        payment: payRes.rows[0],
        customer_closed: body.close_customer,
      });
    } catch (err) {
      await client.query("ROLLBACK");
      // The photo was already written to storage before this transaction --
      // if the row never committed (genuine failure, or this request lost
      // a client_key race to a concurrent retry), it's orphaned either way.
      if (photoKey) await getStorage().delete(photoKey);
      // Two retries raced: the other one won, answer with its row.
      if (
        body.client_key &&
        err instanceof Error &&
        "code" in err &&
        (err as { code?: string }).code === "23505"
      ) {
        const dup = await findByClientKey(req.user!.id, body.client_key);
        if (dup) {
          res.status(200).json({ payment: dup, customer_closed: false, duplicate: true });
          return;
        }
      }
      throw err;
    } finally {
      client.release();
    }
  }),
);

/** Payment history for a customer. */
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const customerId = z.string().uuid().parse(req.query.customer_id);
    const { rows } = await pool.query(
      `SELECT p.id, p.amount, p.mode, p.type, p.paid_at, p.created_at,
              (p.photo_proof_url IS NOT NULL) AS has_photo,
              u.full_name AS collected_by_name
         FROM payments p
         JOIN customers c ON c.id = p.customer_id
         JOIN companies co ON co.id = c.company_id
         JOIN users u ON u.id = p.collected_by_user_id
        WHERE p.customer_id = $1 AND co.agency_id = $2
        ORDER BY p.paid_at DESC`,
      [customerId, req.user!.agency_id],
    );
    res.json({ payments: rows });
  }),
);

/**
 * Deposit reconciliation (Phase 5 "Deposited Metrics"): payments are pending
 * until admin/ops mark the cash as banked. Listing + bulk marking.
 */
router.get(
  "/deposits",
  requirePermission("payments.deposit"),
  asyncHandler(async (req, res) => {
    const query = z
      .object({
        deposited: z.enum(["true", "false"]).optional(),
        month: z
          .string()
          .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
          .optional(),
        agent_id: z.string().uuid().optional(),
        company_id: z.string().uuid().optional(),
        // Phase 9: branch drill-down reuses this same list -- filters by the
        // COLLECTING agent's branch (see listDeposits()).
        branch_id: z.string().uuid().optional(),
      })
      .parse(req.query);

    const payments = await listDeposits(req.user!.agency_id, {
      deposited: query.deposited === undefined ? undefined : query.deposited === "true",
      month: query.month ? `${query.month}-01` : undefined,
      agent_id: query.agent_id,
      company_id: query.company_id,
      branch_id: query.branch_id,
    });
    res.json({ payments });
  }),
);

const markDepositedSchema = z.object({
  payment_ids: z.array(z.string().uuid()).min(1).max(500),
});

/** Idempotent bulk mark: already-deposited and foreign-agency ids are skipped. */
router.patch(
  "/mark-deposited",
  requirePermission("payments.deposit"),
  asyncHandler(async (req, res) => {
    const body = markDepositedSchema.parse(req.body);
    const { rowCount } = await pool.query(
      `UPDATE payments p
          SET deposited_at = now(), deposited_by_user_id = $1
         FROM customers c
         JOIN companies co ON co.id = c.company_id
        WHERE p.customer_id = c.id
          AND co.agency_id = $2
          AND p.id = ANY($3)
          AND p.deposited_at IS NULL`,
      [req.user!.id, req.user!.agency_id, body.payment_ids],
    );
    res.json({ ok: true, marked: rowCount ?? 0 });
  }),
);

const PHOTO_CONTENT_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

/** Streams the photo proof (agency-scoped — never a raw file path). */
router.get(
  "/:id/photo",
  asyncHandler(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const { rows } = await pool.query(
      `SELECT p.photo_proof_url FROM payments p
         JOIN customers c ON c.id = p.customer_id
         JOIN companies co ON co.id = c.company_id
        WHERE p.id = $1 AND co.agency_id = $2`,
      [id, req.user!.agency_id],
    );
    if (!rows[0]) throw new HttpError(404, "Payment not found");
    const key: string | null = rows[0].photo_proof_url;
    if (!key) throw new HttpError(404, "No photo attached to this payment");

    const data = await getStorage().read(key);
    const ext = key.split(".").pop() ?? "jpg";
    res.setHeader("Content-Type", PHOTO_CONTENT_TYPES[ext] ?? "application/octet-stream");
    res.send(data);
  }),
);

export default router;
