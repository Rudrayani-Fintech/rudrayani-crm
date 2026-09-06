import { Router } from "express";
import { z } from "zod";
import { pool } from "../config/db";
import { asyncHandler } from "../middleware/async-handler";
import { authenticate } from "../middleware/authenticate";
import { HttpError } from "../middleware/error-handler";

/**
 * Products & buckets — both DERIVED from imported data per company (brief §4):
 * products get an admin normalization layer; buckets are used verbatim.
 */
// NOTE: this router is mounted at the bare /api prefix, so middleware is applied
// per-route — a router-wide `use(authenticate)` would swallow unknown /api/*
// paths and break the JSON 404 handler.
const router = Router();

async function assertCompanyInAgency(companyId: string, agencyId: string): Promise<void> {
  const { rows } = await pool.query("SELECT 1 FROM companies WHERE id = $1 AND agency_id = $2", [
    companyId,
    agencyId,
  ]);
  if (rows.length === 0) throw new HttpError(404, "Company not found in this agency");
}

router.get(
  "/products",
  authenticate,
  asyncHandler(async (req, res) => {
    const companyId = req.query.company_id ? z.string().uuid().parse(req.query.company_id) : undefined;
    if (companyId) {
      await assertCompanyInAgency(companyId, req.user!.agency_id);
    }
    const { rows } = await pool.query(
      `SELECT p.id, p.raw_label, p.canonical_label,
              (SELECT COUNT(*)::int FROM customers c
                WHERE c.company_id = p.company_id AND c.product = p.raw_label) AS customer_count
         FROM products p
         JOIN companies co ON co.id = p.company_id
        WHERE co.agency_id = $1 AND ($2::uuid IS NULL OR p.company_id = $2)
        ORDER BY p.canonical_label, p.raw_label`,
      [req.user!.agency_id, companyId ?? null],
    );
    res.json({ products: rows });
  }),
);

// POST /products/normalize ("HL" + "Home Loan" -> canonical "Home Loan") was
// removed after an audit found no caller in either the web or mobile client.
// products.canonical_label is still read by GET /products above; if product
// normalisation is wanted again it needs a UI to drive it.

// Buckets moved to routes/buckets.ts (Phase 5 buckets master).

export default router;
