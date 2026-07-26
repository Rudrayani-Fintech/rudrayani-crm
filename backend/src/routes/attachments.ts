import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { pool } from "../config/db";
import { asyncHandler } from "../middleware/async-handler";
import { authenticate, requirePermission } from "../middleware/authenticate";
import { HttpError } from "../middleware/error-handler";
import { customerWriteScopeClamp } from "../services/scope";
import { getStorage } from "../services/storage/storage-provider";
import type { UserRow } from "../types/user";

/**
 * Generic supporting documents against a customer (KYC docs, agreements, ID
 * proofs) -- distinct from the single hard-coded photo fields on
 * payments/field_visits. Follows the same StorageProvider + client_key
 * idempotency pattern as field-visits.ts.
 */
const router = Router();
router.use(authenticate, requirePermission("customers.view"));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

const FILE_EXTENSIONS: Record<string, { ext: string; kind: "photo" | "document" }> = {
  "image/jpeg": { ext: "jpg", kind: "photo" },
  "image/png": { ext: "png", kind: "photo" },
  "image/webp": { ext: "webp", kind: "photo" },
  "application/pdf": { ext: "pdf", kind: "document" },
};

const uploadBody = z.object({
  customer_id: z.string().uuid(),
  note: z.string().trim().max(500).optional(),
  client_key: z.string().uuid().optional(),
});

// Previously checked only agency_id -- any user with calls.log could
// attach a document to any customer in the agency.
async function assertCustomerInScope(customerId: string, user: UserRow): Promise<void> {
  const params: unknown[] = [customerId, user.agency_id];
  const scopeClause = await customerWriteScopeClamp(user, params, "c");
  const { rows } = await pool.query(
    `SELECT 1 FROM customers c JOIN companies co ON co.id = c.company_id
      WHERE c.id = $1 AND co.agency_id = $2 ${scopeClause}`,
    params,
  );
  if (rows.length === 0) throw new HttpError(404, "Customer not found");
}

router.post(
  "/",
  requirePermission("calls.log"),
  upload.single("file"),
  asyncHandler(async (req, res) => {
    const body = uploadBody.parse(req.body);

    if (body.client_key) {
      const dup = await pool.query(
        "SELECT * FROM attachments WHERE uploaded_by = $1 AND client_key = $2",
        [req.user!.id, body.client_key],
      );
      if (dup.rows[0]) {
        res.status(200).json({ attachment: dup.rows[0], duplicate: true });
        return;
      }
    }

    await assertCustomerInScope(body.customer_id, req.user!);

    const file = req.file;
    if (!file) throw new HttpError(400, "No file uploaded");
    const meta = FILE_EXTENSIONS[file.mimetype];
    if (!meta) throw new HttpError(400, "Only JPEG, PNG, WebP images or PDF documents are allowed");

    const fileKey = await getStorage().save("attachments", meta.ext, file.buffer);
    try {
      const { rows } = await pool.query(
        `INSERT INTO attachments
           (agency_id, customer_id, uploaded_by, kind, file_key, file_name, mime_type, size_bytes, note, client_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING *`,
        [
          req.user!.agency_id,
          body.customer_id,
          req.user!.id,
          meta.kind,
          fileKey,
          file.originalname,
          file.mimetype,
          file.size,
          body.note ?? null,
          body.client_key ?? null,
        ],
      );
      res.status(201).json({ attachment: rows[0] });
    } catch (err) {
      // The file was already written to storage before this INSERT -- if
      // the row never lands, clean it up rather than leaving an orphan.
      await getStorage().delete(fileKey);
      throw err;
    }
  }),
);

/** Attachment list for a customer (newest first). */
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const customerId = z.string().uuid().parse(req.query.customer_id);
    const { rows } = await pool.query(
      `SELECT a.id, a.kind, a.file_name, a.mime_type, a.size_bytes, a.note, a.created_at,
              u.full_name AS uploaded_by_name
         FROM attachments a
         JOIN customers c ON c.id = a.customer_id
         JOIN companies co ON co.id = c.company_id
         JOIN users u ON u.id = a.uploaded_by
        WHERE a.customer_id = $1 AND co.agency_id = $2
        ORDER BY a.created_at DESC LIMIT 100`,
      [customerId, req.user!.agency_id],
    );
    res.json({ attachments: rows });
  }),
);

/** Streams the stored file (agency-scoped). */
router.get(
  "/:id/file",
  asyncHandler(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const { rows } = await pool.query(
      `SELECT a.file_key, a.file_name, a.mime_type
         FROM attachments a
         JOIN customers c ON c.id = a.customer_id
         JOIN companies co ON co.id = c.company_id
        WHERE a.id = $1 AND co.agency_id = $2`,
      [id, req.user!.agency_id],
    );
    if (!rows[0]) throw new HttpError(404, "Attachment not found");

    const data = await getStorage().read(rows[0].file_key);
    res.setHeader("Content-Type", rows[0].mime_type);
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${encodeURIComponent(rows[0].file_name)}"`,
    );
    res.send(data);
  }),
);

export default router;
