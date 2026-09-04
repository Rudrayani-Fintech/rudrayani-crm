import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { pool } from "../config/db";
import { asyncHandler } from "../middleware/async-handler";
import { authenticate, requirePermission } from "../middleware/authenticate";
import { HttpError } from "../middleware/error-handler";
import { refreshNextActionDate } from "../services/ptp-service";
import { customerWriteScopeClamp } from "../services/scope";
import { getStorage } from "../services/storage/storage-provider";

/**
 * Field-visit evidence (brief §8: "Field: photo upload, customer signature").
 * Photo and signature go through the StorageProvider like payment proofs.
 */
const router = Router();
router.use(authenticate, requirePermission("calls.log"));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
});

const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

const visitBody = z.object({
  customer_id: z.string().uuid(),
  remark: z.string().trim().max(500).optional(),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  client_key: z.string().uuid().optional(),
});

async function saveImage(file: Express.Multer.File | undefined, folder: string) {
  if (!file) return null;
  const ext = IMAGE_EXTENSIONS[file.mimetype];
  if (!ext) throw new HttpError(400, "Images must be JPEG, PNG, or WebP");
  return getStorage().save(folder, ext, file.buffer);
}

router.post(
  "/",
  upload.fields([
    { name: "photo", maxCount: 1 },
    { name: "signature", maxCount: 1 },
  ]),
  asyncHandler(async (req, res) => {
    const body = visitBody.parse(req.body);

    if (body.client_key) {
      const dup = await pool.query(
        "SELECT * FROM field_visits WHERE agent_id = $1 AND client_key = $2",
        [req.user!.id, body.client_key],
      );
      if (dup.rows[0]) {
        res.status(200).json({ field_visit: dup.rows[0], duplicate: true });
        return;
      }
    }

    // Previously checked only agency_id -- any user with calls.log could
    // record a field visit against any customer in the agency.
    const scopeParams: unknown[] = [body.customer_id, req.user!.agency_id];
    const scopeClause = await customerWriteScopeClamp(req.user!, scopeParams, "c");
    const cust = await pool.query(
      `SELECT c.id FROM customers c JOIN companies co ON co.id = c.company_id
        WHERE c.id = $1 AND co.agency_id = $2 AND c.status = 'active' ${scopeClause}`,
      scopeParams,
    );
    if (!cust.rows[0]) throw new HttpError(404, "Customer not found or already closed");

    const files = req.files as Record<string, Express.Multer.File[]> | undefined;
    const photo = files?.photo?.[0];
    const signature = files?.signature?.[0];
    // The most common field outcome -- door locked, nobody home -- has
    // nothing to photograph. Previously this forced the agent to either
    // fabricate a photo or abandon recording the visit at all. A visit with
    // no photo/signature is now allowed as long as the remark actually
    // explains why (mirrors the mobile "Could not access" outcome, which
    // requires the same remark before it lets the agent skip the photo).
    if (!photo && !signature && !(body.remark && body.remark.length >= 3)) {
      throw new HttpError(
        400,
        "A visit needs a photo, or a remark explaining why there isn't one",
      );
    }

    const photoKey = await saveImage(photo, "visits");
    const signatureKey = await saveImage(signature, "signatures");

    const hasGps = body.lat !== undefined && body.lng !== undefined;
    try {
      const { rows } = await pool.query(
        `INSERT INTO field_visits
           (customer_id, agent_id, photo_url, signature_url, remark, location, client_key)
         VALUES ($1, $2, $3, $4, $5,
                 CASE WHEN $6::boolean
                      THEN ST_SetSRID(ST_MakePoint($7::float8, $8::float8), 4326)::geography
                      ELSE NULL END,
                 $9)
         RETURNING id, customer_id, agent_id, remark, created_at,
                   (photo_url IS NOT NULL) AS has_photo,
                   (signature_url IS NOT NULL) AS has_signature`,
        [
          body.customer_id,
          req.user!.id,
          photoKey,
          signatureKey,
          body.remark ?? null,
          hasGps,
          body.lng ?? null,
          body.lat ?? null,
          body.client_key ?? null,
        ],
      );
      // Phase 4 (§4.2): a field visit counts toward the daily attempt cap
      // and can still resurface the customer via a pending PTP/reminder,
      // even though it can't drive the disposition-cadence source itself
      // yet (field_visits has no disposition_code_id column).
      await refreshNextActionDate(pool, body.customer_id);
      res.status(201).json({ field_visit: rows[0] });
    } catch (err) {
      // The photo/signature were already written to storage before this
      // INSERT -- if the row never lands, clean them up rather than leaving
      // orphaned files with nothing referencing them.
      if (photoKey) await getStorage().delete(photoKey);
      if (signatureKey) await getStorage().delete(signatureKey);
      throw err;
    }
  }),
);

/** Visit history for a customer (newest first). */
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const customerId = z.string().uuid().parse(req.query.customer_id);
    const { rows } = await pool.query(
      `SELECT fv.id, fv.remark, fv.created_at,
              (fv.photo_url IS NOT NULL) AS has_photo,
              (fv.signature_url IS NOT NULL) AS has_signature,
              ST_Y(fv.location::geometry) AS lat, ST_X(fv.location::geometry) AS lng,
              u.full_name AS agent_name
         FROM field_visits fv
         JOIN customers c ON c.id = fv.customer_id
         JOIN companies co ON co.id = c.company_id
         JOIN users u ON u.id = fv.agent_id
        WHERE fv.customer_id = $1 AND co.agency_id = $2
        ORDER BY fv.created_at DESC LIMIT 100`,
      [customerId, req.user!.agency_id],
    );
    res.json({ field_visits: rows });
  }),
);

const IMAGE_CONTENT_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

/** Streams the visit photo or signature (agency-scoped). */
router.get(
  "/:id/:kind(photo|signature)",
  asyncHandler(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const column = req.params.kind === "photo" ? "photo_url" : "signature_url";
    const { rows } = await pool.query(
      `SELECT fv.${column} AS key FROM field_visits fv
         JOIN customers c ON c.id = fv.customer_id
         JOIN companies co ON co.id = c.company_id
        WHERE fv.id = $1 AND co.agency_id = $2`,
      [id, req.user!.agency_id],
    );
    if (!rows[0]) throw new HttpError(404, "Field visit not found");
    const key: string | null = rows[0].key;
    if (!key) throw new HttpError(404, `No ${req.params.kind} attached to this visit`);

    const data = await getStorage().read(key);
    const ext = key.split(".").pop() ?? "jpg";
    res.setHeader("Content-Type", IMAGE_CONTENT_TYPES[ext] ?? "application/octet-stream");
    res.send(data);
  }),
);

const editRemarkBody = z.object({
  remark: z.string().trim().max(500),
});

/**
 * Same-day self-edit (MVP hardening), field-visit counterpart to
 * call-logs.ts's PATCH /:id/remark. A field visit's remark is already plain
 * free text (no disposition-template composition), so this just overwrites
 * it directly.
 */
router.patch(
  "/:id/remark",
  asyncHandler(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const body = editRemarkBody.parse(req.body);

    const { rows } = await pool.query(
      `SELECT fv.id, fv.created_at
         FROM field_visits fv
         JOIN customers c ON c.id = fv.customer_id
         JOIN companies co ON co.id = c.company_id
        WHERE fv.id = $1 AND co.agency_id = $2 AND fv.agent_id = $3`,
      [id, req.user!.agency_id, req.user!.id],
    );
    const visit = rows[0];
    if (!visit) throw new HttpError(404, "Field visit not found, or it isn't yours");

    const ageMs = Date.now() - new Date(visit.created_at).getTime();
    if (ageMs >= 24 * 3600 * 1000) {
      throw new HttpError(409, "This field visit is more than 24 hours old — submit a correction request instead");
    }

    const updated = await pool.query(
      `UPDATE field_visits SET remark = $1, edited_at = now() WHERE id = $2
        RETURNING id, remark, edited_at`,
      [body.remark || null, id],
    );
    res.json({ field_visit: updated.rows[0] });
  }),
);

export default router;
