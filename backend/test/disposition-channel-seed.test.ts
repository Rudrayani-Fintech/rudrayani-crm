import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/config/db";
import { seedDispositionCodesForAgency } from "../src/migrations/seed_disposition_codes";

// Regression guard for X1: seed_disposition_codes.ts used to insert every
// row without a `channel`, and a re-seed after 1785600000000_add-disposition-
// channel.sql had already run silently duplicated every code at
// channel = NULL. Both mobile and web filter the Result Code picker strictly
// on channel, so a NULL channel makes the picker empty and no call/visit can
// be logged. This class of bug must not recur.

let agencyId: string;

beforeAll(async () => {
  const agency = await pool.query(
    "INSERT INTO agencies (name) VALUES ('Disposition Channel Seed Test Agency') RETURNING id",
  );
  agencyId = agency.rows[0].id;
});

afterAll(async () => {
  await pool.query("DELETE FROM disposition_codes WHERE agency_id = $1", [agencyId]);
  await pool.query("DELETE FROM agencies WHERE id = $1", [agencyId]);
  await pool.end();
});

describe("seed_disposition_codes.ts channel derivation (X1)", () => {
  it("seeds no active disposition code with a NULL channel, and both FV and OC are populated", async () => {
    await seedDispositionCodesForAgency(agencyId);

    const { rows } = await pool.query(
      `SELECT channel, COUNT(*)::int AS count
         FROM disposition_codes
        WHERE agency_id = $1 AND is_active
        GROUP BY channel`,
      [agencyId],
    );

    const byChannel = Object.fromEntries(rows.map((r) => [r.channel ?? "NULL", r.count]));
    expect(byChannel.NULL).toBeUndefined();
    expect(byChannel.FV).toBeGreaterThan(0);
    expect(byChannel.OC).toBeGreaterThan(0);
  });

  it("is idempotent — seeding the same agency twice does not duplicate rows", async () => {
    const before = await pool.query(
      "SELECT COUNT(*)::int AS count FROM disposition_codes WHERE agency_id = $1",
      [agencyId],
    );

    const insertedOnRerun = await seedDispositionCodesForAgency(agencyId);

    const after = await pool.query(
      "SELECT COUNT(*)::int AS count FROM disposition_codes WHERE agency_id = $1",
      [agencyId],
    );

    expect(insertedOnRerun).toBe(0);
    expect(after.rows[0].count).toBe(before.rows[0].count);
  });
});
