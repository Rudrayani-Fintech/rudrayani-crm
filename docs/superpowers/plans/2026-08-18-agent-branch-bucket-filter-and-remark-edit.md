# Agent Branch/Bucket Filter + Same-Day Remark Edit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let agents (telecallers + field agents) multi-select branch(es)/bucket(s) as a worklist filter on web and mobile, and let them directly edit the free-text portion of their own call-log/field-visit remark within a rolling 24-hour window, falling back to the existing correction-request approval flow after that.

**Architecture:** Backend: extend `GET /worklist` to accept comma-separated multi-value `bucket`/`customer_branch` params, add a new `GET /worklist/filter-options` endpoint scoped to the requesting agent's own allocated customers, and add two new owner-only `PATCH .../remark` endpoints (call logs, field visits) gated by a rolling-24h `created_at` check plus an extension of the existing `correction_requests` flow to cover `field_visit`. Frontend/mobile: convert existing single-select filter dropdowns to multi-select backed by the new options endpoint with client-local persistence, and add a small "Edit remark" affordance next to already-logged remarks that calls the new PATCH endpoints while inside the window and falls back to the existing "Report an error" flow outside it.

**Tech Stack:** Express + node-pg-migrate + Postgres (backend), React + antd + axios (web), Flutter + Riverpod + Hive + Dio (mobile), Vitest + Supertest (backend tests).

## Global Constraints

- Rolling 24h means wall-clock duration from `created_at`, not an IST calendar day — do not use `backend/src/utils/ist.ts` for this check.
- The 24h direct-edit path only ever touches the free-text note (`call_logs.extra_remark` / `field_visits.remark`) — never `disposition_code_id` or the structured `details` fields, so an already-created PTP is never affected.
- Direct-edit endpoints are owner-only: `agent_id = req.user!.id`. No branch_manager/TL override — that role already has the correction-request approval path.
- No edit-history table. Overwrite in place and stamp `edited_at`.
- Branch/bucket filter dropdown options come from the requesting agent's own currently-allocated active customers, not the agency-wide `GET /customers/branches` / `GET /buckets` lists.
- Filter selections persist client-locally per user (`localStorage` on web, a Hive box on mobile) — no new server-side preference storage.
- Follow existing code conventions exactly: positional `$N` Postgres params built by pushing onto a `params` array, `asyncHandler`/`HttpError` for backend routes, antd `Select`/`Modal` on web, Riverpod `FutureProvider`/`StateProvider` + existing Hive-box-per-store pattern on mobile.

---

## File Structure

**Backend (new/modified):**
- `backend/migrations/1788900000000_call-log-field-visit-edit-columns.sql` — new. `call_logs.extra_remark`, `call_logs.edited_at`, `field_visits.edited_at`.
- `backend/src/routes/call-logs.ts` — modify. Persist `extra_remark` on create; add `PATCH /:id/remark`.
- `backend/src/routes/field-visits.ts` — modify. Add `PATCH /:id/remark`.
- `backend/src/routes/correction-requests.ts` — modify. Add `field_visit` as a fourth `RECORD_TYPES` entry end-to-end.
- `backend/src/routes/customers.ts` — modify. Add `agent_id`/`extra_remark`/`edited_at` to the `:id` detail route's `call_logs`/`field_visits` selects.
- `backend/src/services/report-service.ts` — modify. Add `extra_remark`/`edited_at` to `agentRecentActivity()`'s unioned query and `AgentActivityRow`.
- `backend/src/routes/worklist.ts` — modify. Multi-value `bucket`/`customer_branch`; new `GET /worklist/filter-options`.
- `backend/test/call-log-remark-edit.test.ts` — new.
- `backend/test/field-visit-remark-edit.test.ts` — new.
- `backend/test/correction-requests.test.ts` — modify (add field_visit coverage).
- `backend/test/worklist-filters.test.ts` — new.

**Frontend (new/modified):**
- `frontend/src/components/EditRemarkModal.tsx` — new.
- `frontend/src/components/ReportCorrectionModal.tsx` — modify. Add `field_visit` to `CorrectableRecordType`/`FIELDS_BY_TYPE`.
- `frontend/src/components/CustomerDetailDrawer.tsx` — modify. Direct-edit affordance + edited badge on the call trail.
- `frontend/src/pages/MyWorklistPage.tsx` — modify. Multi-select branch/bucket filters sourced from `/worklist/filter-options`, persisted; direct-edit affordance + edited badge in "Today's Work".

**Mobile (new/modified):**
- `mobile/lib/core/offline/worklist_filter_store.dart` — new. Hive-backed persistence for selected branches/buckets, mirroring `read_cache.dart`'s per-store-box pattern.
- `mobile/lib/features/worklist/worklist_provider.dart` — modify. `worklistFiltersProvider`, `worklistFilterOptionsProvider`; `worklistProvider` passes multi-value params.
- `mobile/lib/features/worklist/worklist_screen.dart` — modify. Branch + bucket multi-select `FilterChip` sections replacing the single bucket dropdown; drop client-side bucket filtering.
- `mobile/lib/features/worklist/edit_remark_dialog.dart` — new.
- `mobile/lib/features/worklist/correction_request_dialog.dart` — modify. Accept `field_visit` record type.
- `mobile/lib/features/worklist/history_timeline.dart` — modify. Edited badge + "Edit" quick action wired to the new dialog for owned, in-window `call_log`/`field_visit` entries.

---

## Task 1: Migration — `extra_remark` / `edited_at` columns

**Files:**
- Create: `backend/migrations/1788900000000_call-log-field-visit-edit-columns.sql`

**Interfaces:**
- Produces: `call_logs.extra_remark TEXT`, `call_logs.edited_at TIMESTAMPTZ`, `field_visits.edited_at TIMESTAMPTZ` — every later backend task reads/writes these three columns.

- [ ] **Step 1: Write the migration**

```sql
-- Up Migration
-- Same-day remark edit (rolling 24h, owner-only): call_logs.remark is
-- server-composed from a disposition template + structured fields + a
-- free-text tail (see disposition-service.ts composeRemark() and
-- call-logs.ts's `${composed} — ${extra_remark}` concatenation) -- until now
-- extra_remark was folded into the final string and discarded, so there was
-- nothing to re-edit without redoing the whole composition. Storing it
-- separately lets an edit recompose remark = composed(disposition, details)
-- + " -- " + new extra_remark without touching the disposition-driven part.
ALTER TABLE call_logs ADD COLUMN extra_remark TEXT;
ALTER TABLE call_logs ADD COLUMN edited_at TIMESTAMPTZ;
ALTER TABLE field_visits ADD COLUMN edited_at TIMESTAMPTZ;

-- Down Migration
ALTER TABLE field_visits DROP COLUMN edited_at;
ALTER TABLE call_logs DROP COLUMN edited_at;
ALTER TABLE call_logs DROP COLUMN extra_remark;
```

- [ ] **Step 2: Apply the migration**

Run (from `backend/`): `npm run migrate:up`
Expected: output lists `1788900000000_call-log-field-visit-edit-columns` as migrated, no errors.

- [ ] **Step 3: Verify the columns exist**

Run: `node -e "require('dotenv').config(); const {Pool}=require('pg'); new Pool().query(\"SELECT column_name FROM information_schema.columns WHERE table_name IN ('call_logs','field_visits') AND column_name IN ('extra_remark','edited_at')\").then(r=>{console.log(r.rows); process.exit(0)})"` from `backend/`
Expected: 3 rows printed (`extra_remark`, `edited_at` for call_logs; `edited_at` for field_visits).

- [ ] **Step 4: Commit**

```bash
git add backend/migrations/1788900000000_call-log-field-visit-edit-columns.sql
git commit -m "feat: add extra_remark/edited_at columns for same-day remark edit"
```

---

## Task 2: `call-logs.ts` — persist `extra_remark`, add `PATCH /:id/remark`

**Files:**
- Modify: `backend/src/routes/call-logs.ts`
- Test: `backend/test/call-log-remark-edit.test.ts`

**Interfaces:**
- Consumes: `composeRemark(code: DispositionCodeRow, fields: DispositionFields): string` from `backend/src/services/disposition-service.ts`; `customerWriteScopeClamp` from `backend/src/services/scope.ts` (unchanged, already imported).
- Produces: `PATCH /api/call-logs/:id/remark` — body `{ extra_remark: string }`, response `{ call_log: { id, remark, extra_remark, edited_at } }`. Owner-only, 24h window, else 404/409.

- [ ] **Step 1: Write the failing tests**

Create `backend/test/call-log-remark-edit.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { pool } from "../src/config/db";
import { hashPassword } from "../src/services/auth-service";

const app = createApp();
const PASSWORD = "Secret@123";
const AGENT_PHONE = "7960000001";
const AGENT2_PHONE = "7960000002";

let agencyId: string;
let companyId: string;
let customerId: string;
let dispositionCodeId: string;
let agentToken: string;
let agent2Token: string;

async function login(phone: string): Promise<string> {
  const res = await request(app).post("/api/auth/login").send({ phone, password: PASSWORD });
  return res.body.access_token;
}

beforeAll(async () => {
  const agency = await pool.query("INSERT INTO agencies (name) VALUES ('CL Edit Agency') RETURNING id");
  agencyId = agency.rows[0].id;
  const company = await pool.query(
    "INSERT INTO companies (agency_id, name) VALUES ($1, 'CL Edit NBFC') RETURNING id",
    [agencyId],
  );
  companyId = company.rows[0].id;

  const hash = await hashPassword(PASSWORD);
  const agent = await pool.query(
    `INSERT INTO users (agency_id, full_name, phone, password_hash, is_telecaller)
     VALUES ($1, 'CL Edit Agent', $2, $3, true) RETURNING id`,
    [agencyId, AGENT_PHONE, hash],
  );
  await pool.query(
    `INSERT INTO users (agency_id, full_name, phone, password_hash, is_telecaller)
     VALUES ($1, 'CL Edit Agent 2', $2, $3, true)`,
    [agencyId, AGENT2_PHONE, hash],
  );

  const customer = await pool.query(
    `INSERT INTO customers (company_id, loan_number, customer_name, mobile_number, due_amount, assigned_agent_id)
     VALUES ($1, 'CLE-001', 'Edit Test Customer', '9800000001', 20000, $2) RETURNING id`,
    [companyId, agent.rows[0].id],
  );
  customerId = customer.rows[0].id;

  const code = await pool.query(
    `INSERT INTO disposition_codes (agency_id, action_code, category, result_code, description, remark_template)
     VALUES ($1, 'OC', 'NO CONTACT', 'RNR', 'Ringing No Response', 'Customer did not answer') RETURNING id`,
    [agencyId],
  );
  dispositionCodeId = code.rows[0].id;

  agentToken = await login(AGENT_PHONE);
  agent2Token = await login(AGENT2_PHONE);
});

afterAll(async () => {
  await pool.query("DELETE FROM call_logs WHERE customer_id = $1", [customerId]);
  await pool.query("DELETE FROM disposition_codes WHERE agency_id = $1", [agencyId]);
  await pool.query("DELETE FROM customers WHERE id = $1", [customerId]);
  await pool.query("DELETE FROM users WHERE agency_id = $1", [agencyId]);
  await pool.query("DELETE FROM companies WHERE id = $1", [companyId]);
  await pool.query("DELETE FROM agencies WHERE id = $1", [agencyId]);
  await pool.end();
});

describe("call log remark edit", () => {
  it("owner edits their extra_remark within the window; composed portion is preserved", async () => {
    const create = await request(app)
      .post("/api/call-logs")
      .set("Authorization", `Bearer ${agentToken}`)
      .send({
        customer_id: customerId,
        disposition_code_id: dispositionCodeId,
        fields: {},
        extra_remark: "will call back tomorrow",
      });
    expect(create.status).toBe(201);
    const callLogId = create.body.call_log.id;
    expect(create.body.call_log.remark).toBe("Ringing No Response — will call back tomorrow");

    const edit = await request(app)
      .patch(`/api/call-logs/${callLogId}/remark`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ extra_remark: "actually said call after 6pm" });
    expect(edit.status).toBe(200);
    expect(edit.body.call_log.remark).toBe("Ringing No Response — actually said call after 6pm");
    expect(edit.body.call_log.extra_remark).toBe("actually said call after 6pm");
    expect(edit.body.call_log.edited_at).not.toBeNull();
  });

  it("a non-owner cannot edit (404)", async () => {
    const create = await request(app)
      .post("/api/call-logs")
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ customer_id: customerId, disposition_code_id: dispositionCodeId, fields: {} });
    const callLogId = create.body.call_log.id;

    const edit = await request(app)
      .patch(`/api/call-logs/${callLogId}/remark`)
      .set("Authorization", `Bearer ${agent2Token}`)
      .send({ extra_remark: "not mine to edit" });
    expect(edit.status).toBe(404);
  });

  it("rejects an edit once the call log is more than 24h old (409)", async () => {
    const create = await request(app)
      .post("/api/call-logs")
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ customer_id: customerId, disposition_code_id: dispositionCodeId, fields: {} });
    const callLogId = create.body.call_log.id;
    await pool.query("UPDATE call_logs SET created_at = now() - interval '25 hours' WHERE id = $1", [callLogId]);

    const edit = await request(app)
      .patch(`/api/call-logs/${callLogId}/remark`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ extra_remark: "too late now" });
    expect(edit.status).toBe(409);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -- call-log-remark-edit` (from `backend/`)
Expected: FAIL — `PATCH /api/call-logs/:id/remark` doesn't exist (404 for the route, or the create test's `extra_remark` persistence assertion has nothing new to check yet since it already passes against current behavior — the edit calls must fail).

- [ ] **Step 3: Persist `extra_remark` on create + add the PATCH route**

In `backend/src/routes/call-logs.ts`, add the import and update the insert (around line 100-112):

```ts
import {
  composeRemark,
  createsPtp,
  missingRequiredFields,
  type DispositionCodeRow,
  type DispositionFields,
} from "../services/disposition-service";
```

Replace the `INSERT INTO call_logs` call:

```ts
      const callLog = await client.query(
        `INSERT INTO call_logs (customer_id, agent_id, disposition_code_id, remark, extra_remark, call_duration_seconds, details, client_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [
          body.customer_id,
          req.user!.id,
          code.id,
          remark,
          body.extra_remark ?? null,
          body.call_duration_seconds ?? null,
          JSON.stringify(body.fields),
          body.client_key ?? null,
        ],
      );
```

Add this route just before `export default router;`:

```ts
const editRemarkBody = z.object({
  extra_remark: z.string().trim().max(500),
});

/**
 * Same-day self-edit (MVP hardening): within 24h of logging it, the agent
 * who created the call log can fix a typo/omission in the free-text tail
 * without a TL approval round-trip. Only extra_remark is touched -- the
 * disposition code and structured `details` are re-read as-is and fed back
 * through composeRemark() so the template-driven portion of `remark` can
 * never drift from what missingRequiredFields()/createsPtp() validated at
 * creation time. After 24h, correction-requests.ts is the only path left.
 */
router.patch(
  "/:id/remark",
  asyncHandler(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const body = editRemarkBody.parse(req.body);

    const { rows } = await pool.query(
      `SELECT cl.id, cl.disposition_code_id, cl.details, cl.created_at
         FROM call_logs cl
         JOIN customers c ON c.id = cl.customer_id
         JOIN companies co ON co.id = c.company_id
        WHERE cl.id = $1 AND co.agency_id = $2 AND cl.agent_id = $3`,
      [id, req.user!.agency_id, req.user!.id],
    );
    const callLog = rows[0];
    if (!callLog) throw new HttpError(404, "Call log not found, or it isn't yours");

    const ageMs = Date.now() - new Date(callLog.created_at).getTime();
    if (ageMs > 24 * 3600 * 1000) {
      throw new HttpError(409, "This call log is more than 24 hours old — submit a correction request instead");
    }

    let composed = "";
    if (callLog.disposition_code_id) {
      const codeRes = await pool.query<DispositionCodeRow>("SELECT * FROM disposition_codes WHERE id = $1", [
        callLog.disposition_code_id,
      ]);
      if (codeRes.rows[0]) {
        composed = composeRemark(codeRes.rows[0], (callLog.details ?? {}) as DispositionFields);
      }
    }
    const remark = body.extra_remark ? (composed ? `${composed} — ${body.extra_remark}` : body.extra_remark) : composed;

    const updated = await pool.query(
      `UPDATE call_logs SET extra_remark = $1, remark = $2, edited_at = now()
        WHERE id = $3 RETURNING id, remark, extra_remark, edited_at`,
      [body.extra_remark || null, remark, id],
    );
    res.json({ call_log: updated.rows[0] });
  }),
);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -- call-log-remark-edit` (from `backend/`)
Expected: PASS (3 tests).

- [ ] **Step 5: Run the full backend suite to check for regressions**

Run: `npm run test` (from `backend/`)
Expected: PASS — in particular `disposition.test.ts`, `collection-workflow.test.ts`, `offline-idempotency.test.ts` (call-log creation paths) still pass.

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/call-logs.ts backend/test/call-log-remark-edit.test.ts
git commit -m "feat: same-day owner edit for call log remarks"
```

---

## Task 3: `field-visits.ts` — add `PATCH /:id/remark`

**Files:**
- Modify: `backend/src/routes/field-visits.ts`
- Test: `backend/test/field-visit-remark-edit.test.ts`

**Interfaces:**
- Produces: `PATCH /api/field-visits/:id/remark` — body `{ remark: string }`, response `{ field_visit: { id, remark, edited_at } }`. Owner-only, 24h window.

- [ ] **Step 1: Write the failing tests**

Create `backend/test/field-visit-remark-edit.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { pool } from "../src/config/db";
import { hashPassword } from "../src/services/auth-service";

const app = createApp();
const PASSWORD = "Secret@123";
const AGENT_PHONE = "7960000003";
const AGENT2_PHONE = "7960000004";

let agencyId: string;
let companyId: string;
let customerId: string;
let agentToken: string;
let agent2Token: string;

async function login(phone: string): Promise<string> {
  const res = await request(app).post("/api/auth/login").send({ phone, password: PASSWORD });
  return res.body.access_token;
}

beforeAll(async () => {
  const agency = await pool.query("INSERT INTO agencies (name) VALUES ('FV Edit Agency') RETURNING id");
  agencyId = agency.rows[0].id;
  const company = await pool.query(
    "INSERT INTO companies (agency_id, name) VALUES ($1, 'FV Edit NBFC') RETURNING id",
    [agencyId],
  );
  companyId = company.rows[0].id;

  const hash = await hashPassword(PASSWORD);
  const agent = await pool.query(
    `INSERT INTO users (agency_id, full_name, phone, password_hash, is_field_agent)
     VALUES ($1, 'FV Edit Agent', $2, $3, true) RETURNING id`,
    [agencyId, AGENT_PHONE, hash],
  );
  await pool.query(
    `INSERT INTO users (agency_id, full_name, phone, password_hash, is_field_agent)
     VALUES ($1, 'FV Edit Agent 2', $2, $3, true)`,
    [agencyId, AGENT2_PHONE, hash],
  );

  const customer = await pool.query(
    `INSERT INTO customers (company_id, loan_number, customer_name, mobile_number, due_amount, assigned_field_agent_id)
     VALUES ($1, 'FVE-001', 'FV Edit Test Customer', '9800000002', 20000, $2) RETURNING id`,
    [companyId, agent.rows[0].id],
  );
  customerId = customer.rows[0].id;

  agentToken = await login(AGENT_PHONE);
  agent2Token = await login(AGENT2_PHONE);
});

afterAll(async () => {
  await pool.query("DELETE FROM field_visits WHERE customer_id = $1", [customerId]);
  await pool.query("DELETE FROM customers WHERE id = $1", [customerId]);
  await pool.query("DELETE FROM users WHERE agency_id = $1", [agencyId]);
  await pool.query("DELETE FROM companies WHERE id = $1", [companyId]);
  await pool.query("DELETE FROM agencies WHERE id = $1", [agencyId]);
  await pool.end();
});

describe("field visit remark edit", () => {
  it("owner edits their remark within the window", async () => {
    const create = await request(app)
      .post("/api/field-visits")
      .set("Authorization", `Bearer ${agentToken}`)
      .field("customer_id", customerId)
      .field("remark", "Door locked, nobody home");
    expect(create.status).toBe(201);
    const visitId = create.body.field_visit.id;

    const edit = await request(app)
      .patch(`/api/field-visits/${visitId}/remark`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ remark: "Neighbour said they moved out" });
    expect(edit.status).toBe(200);
    expect(edit.body.field_visit.remark).toBe("Neighbour said they moved out");
    expect(edit.body.field_visit.edited_at).not.toBeNull();
  });

  it("a non-owner cannot edit (404)", async () => {
    const create = await request(app)
      .post("/api/field-visits")
      .set("Authorization", `Bearer ${agentToken}`)
      .field("customer_id", customerId)
      .field("remark", "Door locked, nobody home");
    const visitId = create.body.field_visit.id;

    const edit = await request(app)
      .patch(`/api/field-visits/${visitId}/remark`)
      .set("Authorization", `Bearer ${agent2Token}`)
      .send({ remark: "not mine" });
    expect(edit.status).toBe(404);
  });

  it("rejects an edit once the visit is more than 24h old (409)", async () => {
    const create = await request(app)
      .post("/api/field-visits")
      .set("Authorization", `Bearer ${agentToken}`)
      .field("customer_id", customerId)
      .field("remark", "Door locked, nobody home");
    const visitId = create.body.field_visit.id;
    await pool.query("UPDATE field_visits SET created_at = now() - interval '25 hours' WHERE id = $1", [visitId]);

    const edit = await request(app)
      .patch(`/api/field-visits/${visitId}/remark`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ remark: "too late now" });
    expect(edit.status).toBe(409);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -- field-visit-remark-edit` (from `backend/`)
Expected: FAIL — the route doesn't exist yet.

- [ ] **Step 3: Add the PATCH route**

In `backend/src/routes/field-visits.ts`, add this route just before `export default router;`:

```ts
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
    if (ageMs > 24 * 3600 * 1000) {
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -- field-visit-remark-edit` (from `backend/`)
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/field-visits.ts backend/test/field-visit-remark-edit.test.ts
git commit -m "feat: same-day owner edit for field visit remarks"
```

---

## Task 4: `correction-requests.ts` — add `field_visit` record type

**Files:**
- Modify: `backend/src/routes/correction-requests.ts`
- Test: `backend/test/correction-requests.test.ts`

**Interfaces:**
- Produces: `correction-requests` now accepts `record_type: "field_visit"` with `ALLOWED_FIELDS.field_visit = ["remark"]`, giving field agents a path to fix a field-visit remark after the 24h direct-edit window closes (mirrors the existing `call_log` entry).

- [ ] **Step 1: Write the failing test**

Add to the end of the `describe("correction requests", ...)` block in `backend/test/correction-requests.test.ts` (before the final closing `});`), and add a `fieldVisitId` variable + seed row alongside the existing `beforeAll` setup:

At the top of the file, add to the `let` block (near `let ptpId: string;`):

```ts
let fieldVisitId: string;
```

In `beforeAll`, after the existing `ptp` insert, add:

```ts
  const fieldVisit = await pool.query(
    `INSERT INTO field_visits (customer_id, agent_id, remark)
     VALUES ($1, $2, 'Door locked, nobody home') RETURNING id`,
    [customerId, agentId],
  );
  fieldVisitId = fieldVisit.rows[0].id;
```

In `afterAll`, add before the `ptps` cleanup line:

```ts
  await pool.query("DELETE FROM field_visits WHERE customer_id = $1", [customerId]);
```

Add this test inside the `describe` block:

```ts
  it("field visit remark correction applies on approval", async () => {
    const submit = await request(app)
      .post("/api/correction-requests")
      .set("Authorization", `Bearer ${agentToken}`)
      .send({
        record_type: "field_visit",
        record_id: fieldVisitId,
        proposed_changes: { remark: "Neighbour confirmed they still live there" },
        reason: "original remark was incomplete",
      });
    expect(submit.status).toBe(201);

    const decide = await request(app)
      .post(`/api/correction-requests/${submit.body.request.id}/decide`)
      .set("Authorization", `Bearer ${reviewerToken}`)
      .send({ approve: true });
    expect(decide.status).toBe(200);

    const visit = await pool.query("SELECT remark FROM field_visits WHERE id = $1", [fieldVisitId]);
    expect(visit.rows[0].remark).toBe("Neighbour confirmed they still live there");
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- correction-requests` (from `backend/`)
Expected: FAIL — `record_type: "field_visit"` is rejected by the `RECORD_TYPES` enum (Zod validation error, 400).

- [ ] **Step 3: Extend `correction-requests.ts` to support `field_visit`**

Change (line 28):

```ts
const RECORD_TYPES = ["payment", "call_log", "ptp", "field_visit"] as const;
```

Change `ALLOWED_FIELDS` (line 31-35):

```ts
const ALLOWED_FIELDS: Record<RecordType, readonly string[]> = {
  payment: ["amount", "mode", "paid_at"],
  call_log: ["remark"],
  ptp: ["amount", "promised_date"],
  field_visit: ["remark"],
};
```

Change `coalescedCustomerBranchClamp`'s expressions (line 60-61) to include the fourth join alias:

```ts
  const branchIdExpr = "COALESCE(cust_p.branch_id, cust_c.branch_id, cust_t.branch_id, cust_f.branch_id)";
  const customFieldsExpr =
    "COALESCE(cust_p.custom_fields, cust_c.custom_fields, cust_t.custom_fields, cust_f.custom_fields)";
```

Change `loadOwnedRecord`'s `queries` map (line 72-85):

```ts
  const queries: Record<RecordType, string> = {
    payment: `SELECT p.* FROM payments p
                JOIN customers c ON c.id = p.customer_id
                JOIN companies co ON co.id = c.company_id
               WHERE p.id = $1 AND co.agency_id = $2 AND p.collected_by_user_id = $3`,
    call_log: `SELECT cl.* FROM call_logs cl
                 JOIN customers c ON c.id = cl.customer_id
                 JOIN companies co ON co.id = c.company_id
                WHERE cl.id = $1 AND co.agency_id = $2 AND cl.agent_id = $3`,
    ptp: `SELECT p.* FROM ptps p
            JOIN customers c ON c.id = p.customer_id
            JOIN companies co ON co.id = c.company_id
           WHERE p.id = $1 AND co.agency_id = $2 AND p.agent_id = $3`,
    field_visit: `SELECT fv.* FROM field_visits fv
                    JOIN customers c ON c.id = fv.customer_id
                    JOIN companies co ON co.id = c.company_id
                   WHERE fv.id = $1 AND co.agency_id = $2 AND fv.agent_id = $3`,
  };
```

In the `GET /` handler's main query (around line 156-176), add a fourth LEFT JOIN pair and extend the three `COALESCE(...)` column lists:

```ts
    const { rows } = await pool.query(
      `SELECT cr.id, cr.record_type, cr.record_id, cr.reason, cr.proposed_changes,
              cr.status, cr.decided_at, cr.decision_note, cr.created_at,
              u.id AS requested_by_id, u.full_name AS requested_by_name,
              d.full_name AS decided_by_name,
              COALESCE(cust_p.id, cust_c.id, cust_t.id, cust_f.id) AS customer_id,
              COALESCE(cust_p.loan_number, cust_c.loan_number, cust_t.loan_number, cust_f.loan_number) AS loan_number,
              COALESCE(cust_p.customer_name, cust_c.customer_name, cust_t.customer_name, cust_f.customer_name) AS customer_name
         FROM correction_requests cr
         JOIN users u ON u.id = cr.requested_by
         LEFT JOIN users d ON d.id = cr.decided_by
         LEFT JOIN payments py ON cr.record_type = 'payment' AND py.id = cr.record_id
         LEFT JOIN customers cust_p ON cust_p.id = py.customer_id
         LEFT JOIN call_logs cl ON cr.record_type = 'call_log' AND cl.id = cr.record_id
         LEFT JOIN customers cust_c ON cust_c.id = cl.customer_id
         LEFT JOIN ptps pt ON cr.record_type = 'ptp' AND pt.id = cr.record_id
         LEFT JOIN customers cust_t ON cust_t.id = pt.customer_id
         LEFT JOIN field_visits fv ON cr.record_type = 'field_visit' AND fv.id = cr.record_id
         LEFT JOIN customers cust_f ON cust_f.id = fv.customer_id
        WHERE u.agency_id = $${agencyParamIndex}
          ${filters.map((f) => `AND ${f}`).join(" ")}
        ORDER BY cr.created_at DESC`,
      params,
    );
```

In `decideOne`'s lookup query (around line 199-209), add the same fourth join pair:

```ts
  const reqRes = await pool.query(
    `SELECT cr.* FROM correction_requests cr
       JOIN users u ON u.id = cr.requested_by
       LEFT JOIN payments py ON cr.record_type = 'payment' AND py.id = cr.record_id
       LEFT JOIN customers cust_p ON cust_p.id = py.customer_id
       LEFT JOIN call_logs cl ON cr.record_type = 'call_log' AND cl.id = cr.record_id
       LEFT JOIN customers cust_c ON cust_c.id = cl.customer_id
       LEFT JOIN ptps pt ON cr.record_type = 'ptp' AND pt.id = cr.record_id
       LEFT JOIN customers cust_t ON cust_t.id = pt.customer_id
       LEFT JOIN field_visits fv ON cr.record_type = 'field_visit' AND fv.id = cr.record_id
       LEFT JOIN customers cust_f ON cust_f.id = fv.customer_id
      WHERE cr.id = $1 AND u.agency_id = $2${reqClampSql}`,
    reqParams,
  );
```

And `decideOne`'s table map (line 223):

```ts
      const table = { payment: "payments", call_log: "call_logs", ptp: "ptps", field_visit: "field_visits" }[recordType];
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -- correction-requests` (from `backend/`)
Expected: PASS (all tests, including the new one).

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/correction-requests.ts backend/test/correction-requests.test.ts
git commit -m "feat: extend correction-requests to cover field visit remarks"
```

---

## Task 5: `customers.ts` detail route — expose `agent_id`/`extra_remark`/`edited_at`

**Files:**
- Modify: `backend/src/routes/customers.ts`

**Interfaces:**
- Produces: `GET /api/customers/:id`'s `trail[]` entries now include `agent_id`, `extra_remark`, `edited_at`; `field_visits[]` entries now include `agent_id`, `edited_at`. Consumed by Task 9 (web `CustomerDetailDrawer`) and Task 12 (mobile `history_timeline.dart`).

- [ ] **Step 1: Update the `call_logs` select** (around line 260-269 in `backend/src/routes/customers.ts`)

```ts
        pool.query(
          `SELECT cl.id, cl.remark, cl.extra_remark, cl.call_duration_seconds, cl.details, cl.created_at, cl.edited_at,
                  cl.agent_id, dc.action_code, dc.result_code, u.full_name AS agent_name
             FROM call_logs cl
             LEFT JOIN disposition_codes dc ON dc.id = cl.disposition_code_id
             LEFT JOIN users u ON u.id = cl.agent_id
            WHERE cl.customer_id = $1
            ORDER BY cl.created_at DESC LIMIT 50`,
          [id],
        ),
```

- [ ] **Step 2: Update the `field_visits` select** (around line 303-310)

```ts
          `SELECT fv.id, fv.remark, fv.created_at, fv.edited_at, fv.agent_id,
                  (fv.photo_url IS NOT NULL) AS has_photo,
                  u.full_name AS agent_name
             FROM field_visits fv
             JOIN users u ON u.id = fv.agent_id
            WHERE fv.customer_id = $1
            ORDER BY fv.created_at DESC LIMIT 50`,
          [id],
        ),
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck` (from `backend/`)
Expected: no errors (this route has no dedicated request-shape type to update; the added columns pass through the existing `any`-shaped `pool.query` result).

- [ ] **Step 4: Run the customer-detail test suite**

Run: `npm run test -- customer-detail` (from `backend/`)
Expected: PASS — existing assertions only check a subset of fields, so adding columns doesn't break them.

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/customers.ts
git commit -m "feat: expose agent_id/extra_remark/edited_at on customer detail trail"
```

---

## Task 6: `report-service.ts` — expose `extra_remark`/`edited_at` in agent activity

**Files:**
- Modify: `backend/src/services/report-service.ts`

**Interfaces:**
- Produces: `AgentActivityRow` gains `extra_remark: string | null` and `edited_at: string | null`. Consumed by Task 9 (`MyWorklistPage.tsx`'s "Today's Work").

- [ ] **Step 1: Update the interface** (line 2040-2051)

```ts
export interface AgentActivityRow {
  kind: "call" | "payment" | "ptp" | "field_visit";
  id: string;
  at: string;
  agent_id: string;
  customer_id: string;
  customer_name: string;
  loan_number: string;
  remark: string | null;
  extra_remark: string | null;
  amount: string | null;
  detail: string | null;
  edited_at: string | null;
}
```

- [ ] **Step 2: Update the unioned query's branches** (line 2090-2124)

```ts
  const branches = [
    `(SELECT 'call' AS kind, cl.id::text AS id, cl.created_at AS at, cl.agent_id,
             c.id::text AS customer_id, c.customer_name, c.loan_number,
             cl.remark, cl.extra_remark, NULL::text AS amount, dc.action_code AS detail, cl.edited_at
        FROM call_logs cl
        JOIN customers c ON c.id = cl.customer_id
        JOIN companies co ON co.id = c.company_id
        LEFT JOIN disposition_codes dc ON dc.id = cl.disposition_code_id
       WHERE cl.agent_id = ANY($1) AND co.agency_id = $2 ${todayFor("cl.created_at")} ${dispositionClause})`,
  ];

  if (!options.dispositionCodeId) {
    branches.push(
      `(SELECT 'payment', p.id::text, p.paid_at, p.collected_by_user_id,
               c.id::text, c.customer_name, c.loan_number,
               NULL::text, NULL::text, p.amount::text, p.mode, NULL::timestamptz
          FROM payments p
          JOIN customers c ON c.id = p.customer_id
          JOIN companies co ON co.id = c.company_id
         WHERE p.collected_by_user_id = ANY($1) AND co.agency_id = $2 ${todayFor("p.paid_at")})`,
      `(SELECT 'ptp', pt.id::text, pt.created_at, pt.agent_id,
               c.id::text, c.customer_name, c.loan_number,
               NULL::text, NULL::text, pt.amount::text, pt.promised_date::text, NULL::timestamptz
          FROM ptps pt
          JOIN customers c ON c.id = pt.customer_id
          JOIN companies co ON co.id = c.company_id
         WHERE pt.agent_id = ANY($1) AND co.agency_id = $2 ${todayFor("pt.created_at")})`,
      `(SELECT 'field_visit', fv.id::text, fv.created_at, fv.agent_id,
               c.id::text, c.customer_name, c.loan_number,
               fv.remark, NULL::text, NULL::text, NULL::text, fv.edited_at
          FROM field_visits fv
          JOIN customers c ON c.id = fv.customer_id
          JOIN companies co ON co.id = c.company_id
         WHERE fv.agent_id = ANY($1) AND co.agency_id = $2 ${todayFor("fv.created_at")})`,
    );
  }
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck` (from `backend/`)
Expected: no errors.

- [ ] **Step 4: Run the reports test suite**

Run: `npm run test -- reports` (from `backend/`)
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/report-service.ts
git commit -m "feat: expose extra_remark/edited_at in agent-activity feed"
```

---

## Task 7: `worklist.ts` — multi-value filters + `GET /worklist/filter-options`

**Files:**
- Modify: `backend/src/routes/worklist.ts`
- Test: `backend/test/worklist-filters.test.ts`

**Interfaces:**
- Consumes: `agentBranchClamp`, `resolveBranchClamp` from `backend/src/services/scope.ts` (already imported).
- Produces: `GET /api/worklist?bucket=A,B&customer_branch=X,Y` (comma-separated, backward compatible with a single value). `GET /api/worklist/filter-options?scope=team` → `{ branches: string[], buckets: string[] }` scoped to the caller's own allocated active customers (or their managed branch's, with `scope=team`).

- [ ] **Step 1: Write the failing test**

Create `backend/test/worklist-filters.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { pool } from "../src/config/db";
import { hashPassword } from "../src/services/auth-service";

const app = createApp();
const PASSWORD = "Secret@123";
const AGENT_PHONE = "7960000005";

let agencyId: string;
let companyId: string;
let branchAId: string;
let branchBId: string;
let agentToken: string;

async function login(phone: string): Promise<string> {
  const res = await request(app).post("/api/auth/login").send({ phone, password: PASSWORD });
  return res.body.access_token;
}

beforeAll(async () => {
  const agency = await pool.query("INSERT INTO agencies (name) VALUES ('WL Filter Agency') RETURNING id");
  agencyId = agency.rows[0].id;
  const company = await pool.query(
    "INSERT INTO companies (agency_id, name) VALUES ($1, 'WL Filter NBFC') RETURNING id",
    [agencyId],
  );
  companyId = company.rows[0].id;

  const branchA = await pool.query("INSERT INTO branches (agency_id, name) VALUES ($1, 'Branch A') RETURNING id", [
    agencyId,
  ]);
  branchAId = branchA.rows[0].id;
  const branchB = await pool.query("INSERT INTO branches (agency_id, name) VALUES ($1, 'Branch B') RETURNING id", [
    agencyId,
  ]);
  branchBId = branchB.rows[0].id;

  const hash = await hashPassword(PASSWORD);
  const agent = await pool.query(
    `INSERT INTO users (agency_id, full_name, phone, password_hash, is_telecaller)
     VALUES ($1, 'WL Filter Agent', $2, $3, true) RETURNING id`,
    [agencyId, AGENT_PHONE, hash],
  );
  const agentId = agent.rows[0].id;

  await pool.query(
    `INSERT INTO customers (company_id, loan_number, customer_name, mobile_number, due_amount, bucket, branch_id, assigned_agent_id)
     VALUES
       ($1, 'WLF-001', 'Cust A1', '9800000010', 1000, '0-30', $2, $4),
       ($1, 'WLF-002', 'Cust B1', '9800000011', 2000, '31-60', $3, $4)`,
    [companyId, branchAId, branchBId, agentId],
  );

  agentToken = await login(AGENT_PHONE);
});

afterAll(async () => {
  await pool.query("DELETE FROM customers WHERE company_id = $1", [companyId]);
  await pool.query("DELETE FROM users WHERE agency_id = $1", [agencyId]);
  await pool.query("DELETE FROM branches WHERE agency_id = $1", [agencyId]);
  await pool.query("DELETE FROM companies WHERE id = $1", [companyId]);
  await pool.query("DELETE FROM agencies WHERE id = $1", [agencyId]);
  await pool.end();
});

describe("worklist multi-value filters + filter-options", () => {
  it("filter-options returns only this agent's own branches/buckets", async () => {
    const res = await request(app).get("/api/worklist/filter-options").set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
    expect(res.body.branches.sort()).toEqual(["Branch A", "Branch B"]);
    expect(res.body.buckets.sort()).toEqual(["0-30", "31-60"]);
  });

  it("bucket accepts a comma-separated list", async () => {
    const res = await request(app)
      .get("/api/worklist?bucket=0-30,31-60")
      .set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
    expect(res.body.customers).toHaveLength(2);
  });

  it("bucket narrows to only the listed values", async () => {
    const res = await request(app).get("/api/worklist?bucket=0-30").set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
    expect(res.body.customers).toHaveLength(1);
    expect(res.body.customers[0].loan_number).toBe("WLF-001");
  });

  it("customer_branch accepts a comma-separated list", async () => {
    const res = await request(app)
      .get("/api/worklist?customer_branch=Branch A,Branch B")
      .set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
    expect(res.body.customers).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- worklist-filters` (from `backend/`)
Expected: FAIL — `filter-options` 404s (route doesn't exist), and comma-separated `bucket`/`customer_branch` currently only exact-match the whole string so the 2-value tests return 0 rows.

- [ ] **Step 3: Implement multi-value filters + the new route**

In `backend/src/routes/worklist.ts`, replace the `customerBranch`/`bucket` param reads and their conditions (lines 23-25, 63-75):

```ts
    const customerBranchParam = req.query.customer_branch as string | undefined;
    const bucketParam = req.query.bucket as string | undefined;
```

```ts
    if (customerBranchParam) {
      const values = customerBranchParam.split(",").map((s) => s.trim()).filter(Boolean);
      if (values.length > 0) {
        params.push(values);
        const n = params.length;
        conditions += ` AND (c.branch_id::text = ANY($${n}) OR (c.branch_id IS NULL AND (c.custom_fields->>'branch' ILIKE ANY($${n}) OR c.custom_fields->>'Branch' ILIKE ANY($${n}))))`;
      }
    }
    if (product) {
      params.push(product);
      conditions += ` AND c.product = $${params.length}`;
    }
    if (bucketParam) {
      const values = bucketParam.split(",").map((s) => s.trim()).filter(Boolean);
      if (values.length > 0) {
        params.push(values);
        conditions += ` AND c.bucket = ANY($${params.length})`;
      }
    }
```

Add this route in `backend/src/routes/worklist.ts` immediately before `router.get("/:id", ...)` (it must come first, or `/:id`'s `z.string().uuid()` would try to parse `"filter-options"` as an id):

```ts
/**
 * Branch/bucket dropdown options for the worklist filter (Track: agent
 * branch/bucket filtering) -- scoped to the requesting agent's own
 * currently-allocated active customers (or, with scope=team, everyone a
 * branch_manager manages), not the agency-wide GET /customers/branches or
 * GET /buckets lists. Mirrors the exact scope block the list route above
 * uses, so the options offered here always match what that same query would
 * actually return.
 */
router.get(
  "/filter-options",
  asyncHandler(async (req, res) => {
    const scope = req.query.scope as string | undefined;
    const wantsTeamScope = scope === "team" && req.user!.designation === "branch_manager";
    const clamp = wantsTeamScope ? await resolveBranchClamp(req.user!) : null;

    const params: unknown[] = [req.user!.id];
    let conditions: string;
    if (clamp) {
      const agentMatch = agentBranchClamp(clamp, params, "u").replace(/^ AND /, "");
      const fieldAgentMatch = agentBranchClamp(clamp, params, "u").replace(/^ AND /, "");
      conditions = `(
          EXISTS (SELECT 1 FROM users u WHERE u.id = c.assigned_agent_id AND ${agentMatch})
          OR EXISTS (SELECT 1 FROM users u WHERE u.id = c.assigned_field_agent_id AND ${fieldAgentMatch})
        ) AND c.status = 'active'`;
    } else {
      conditions = `(c.assigned_agent_id = $1 OR c.assigned_field_agent_id = $1) AND c.status = 'active'`;
    }

    const { rows } = await pool.query<{ branch: string | null; bucket: string | null }>(
      `SELECT DISTINCT
              COALESCE(b.name, NULLIF(TRIM(COALESCE(c.custom_fields->>'branch', c.custom_fields->>'Branch')), '')) AS branch,
              c.bucket
         FROM customers c
         LEFT JOIN branches b ON b.id = c.branch_id
        WHERE ${conditions}`,
      params,
    );
    const branches = Array.from(new Set(rows.map((r) => r.branch).filter((v): v is string => !!v))).sort();
    const buckets = Array.from(new Set(rows.map((r) => r.bucket).filter((v): v is string => !!v))).sort();
    res.json({ branches, buckets });
  }),
);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -- worklist-filters` (from `backend/`)
Expected: PASS (4 tests).

- [ ] **Step 5: Run the full backend suite**

Run: `npm run test` (from `backend/`)
Expected: PASS — in particular `field-workflow.test.ts`, `day-plan.test.ts`, `bucket-movements.test.ts`, anything else touching `/worklist`, still pass (single-value `bucket=`/`customer_branch=` still works — a single value has no comma, `split(",")` yields a 1-element array).

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/worklist.ts backend/test/worklist-filters.test.ts
git commit -m "feat: multi-value worklist branch/bucket filters + filter-options endpoint"
```

---

## Task 8: Web — multi-select branch/bucket filters on `MyWorklistPage`

**Files:**
- Modify: `frontend/src/pages/MyWorklistPage.tsx`

**Interfaces:**
- Consumes: `GET /worklist/filter-options` (Task 7), `GET /worklist?bucket=&customer_branch=` (Task 7, now comma-joined).

- [ ] **Step 1: Replace branch/bucket state with multi-select + persistence**

Replace the branch/bucket related state (lines 94, 100, 102) and add a persistence helper. Near the top of the file, after the `dayjs.extend(relativeTime);` line, add:

```ts
const FILTER_STORAGE_PREFIX = "rcrm_worklist_filters_";

function loadPersistedFilters(userId: string | undefined): { branches: string[]; buckets: string[] } {
  if (!userId) return { branches: [], buckets: [] };
  try {
    const raw = localStorage.getItem(FILTER_STORAGE_PREFIX + userId);
    if (!raw) return { branches: [], buckets: [] };
    const parsed = JSON.parse(raw) as { branches?: string[]; buckets?: string[] };
    return { branches: parsed.branches ?? [], buckets: parsed.buckets ?? [] };
  } catch {
    return { branches: [], buckets: [] };
  }
}

function savePersistedFilters(userId: string | undefined, branches: string[], buckets: string[]): void {
  if (!userId) return;
  try {
    localStorage.setItem(FILTER_STORAGE_PREFIX + userId, JSON.stringify({ branches, buckets }));
  } catch {
    // Private browsing / storage disabled -- filters still work for this session.
  }
}
```

Replace the state declarations (lines 94-102):

```ts
  const [filterOptions, setFilterOptions] = useState<{ branches: string[]; buckets: string[] }>({
    branches: [],
    buckets: [],
  });
  const [products, setProducts] = useState<{ raw_label: string; canonical_label: string }[]>([]);

  const [search, setSearch] = useState("");
  const [filterCompany, setFilterCompany] = useState<string | undefined>();
  const [filterCustomerBranches, setFilterCustomerBranches] = useState<string[]>([]);
  const [filterProduct, setFilterProduct] = useState<string | undefined>();
  const [filterBuckets, setFilterBuckets] = useState<string[]>([]);
```

(Note: `customerBranches`/`buckets` state and the `/customers/branches` + `/buckets` fetches are removed — replaced by `filterOptions` below.)

- [ ] **Step 2: Load persisted filters once the user is known, and load filter options**

Replace the `useEffect` that fetches dispositions/branches/products/buckets (lines 186-190):

```ts
  useEffect(() => {
    api.get("/dispositions").then((res) => setDispositionCodes(res.data.disposition_codes)).catch((err) => message.error(errorMessage(err)));
    api.get("/products").then((res) => setProducts(res.data.products)).catch((err) => message.error(errorMessage(err)));
  }, []);

  useEffect(() => {
    if (!user?.id) return;
    const persisted = loadPersistedFilters(user.id);
    setFilterCustomerBranches(persisted.branches);
    setFilterBuckets(persisted.buckets);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  useEffect(() => {
    const params = isBranchManager && scope === "team" ? { scope: "team" } : undefined;
    api
      .get("/worklist/filter-options", { params })
      .then((res) => setFilterOptions({ branches: res.data.branches, buckets: res.data.buckets }))
      .catch((err) => message.error(errorMessage(err)));
  }, [isBranchManager, scope]);
```

- [ ] **Step 3: Update `load()` to send comma-joined filters and persist on change**

Replace the `load` callback's params build and dependency array (lines 159-183):

```ts
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const today = dayjs().format("YYYY-MM-DD");
      const params: Record<string, string> = {};
      if (search) params.q = search;
      if (filterCustomerBranches.length > 0) params.customer_branch = filterCustomerBranches.join(",");
      if (filterProduct) params.product = filterProduct;
      if (filterBuckets.length > 0) params.bucket = filterBuckets.join(",");
      if (isBranchManager && scope === "team") params.scope = "team";

      const [worklistRes, remindersRes, ptpsRes] = await Promise.all([
        api.get("/worklist", { params }),
        api.get("/reminders", { params: { status: "pending", date: today } }),
        api.get("/ptps/due", { params: { date: today } }),
      ]);
      setCustomers(worklistRes.data.customers);
      setReminders(remindersRes.data.reminders);
      setPtpsDue(ptpsRes.data.ptps);
    } catch (err) {
      message.error(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [search, filterCustomerBranches, filterProduct, filterBuckets, isBranchManager, scope]);
```

Add a small effect right after `load`'s declaration (before the `useEffect(() => { void load(); }, [load]);` one) to persist on change:

```ts
  useEffect(() => {
    savePersistedFilters(user?.id, filterCustomerBranches, filterBuckets);
  }, [user?.id, filterCustomerBranches, filterBuckets]);
```

- [ ] **Step 4: Convert the Branch/Bucket `Select`s to multi-select**

Replace the Branch and Bucket `Select` elements (lines 247-277):

```tsx
        <Select
          mode="multiple"
          title="All branches" placeholder="All branches"
          allowClear
          showSearch
          style={{ width: 220 }}
          value={filterCustomerBranches}
          onChange={(v) => setFilterCustomerBranches(v)}
          options={filterOptions.branches.map((b) => ({ value: b, label: b }))}
          maxTagCount="responsive"
        />
        <Select
          title="All products" placeholder="All products"
          allowClear
          style={{ width: 160 }}
          value={filterProduct}
          onChange={(v) => setFilterProduct(v ?? undefined)}
          options={Array.from(new Set(products.map((p) => p.raw_label))).map((label) => ({
            value: label,
            label,
          }))}
        />
        <Select
          mode="multiple"
          title="All buckets" placeholder="All buckets"
          allowClear
          style={{ width: 180 }}
          value={filterBuckets}
          onChange={(v) => setFilterBuckets(v)}
          options={filterOptions.buckets.map((b) => ({ value: b, label: b }))}
          maxTagCount="responsive"
        />
```

- [ ] **Step 5: Typecheck and build**

Run: `npm run typecheck` (from `frontend/`)
Expected: no errors — in particular confirm no other reference to the removed `customerBranches`/`buckets` state remains in this file.

Run: `npm run build` (from `frontend/`)
Expected: succeeds.

- [ ] **Step 6: Manual verification in the browser**

Start the dev servers (backend `npm run dev`, frontend `npm run dev`), log in as a telecaller/field_agent test account, open "My Worklist", and confirm: the Branch and Bucket dropdowns are multi-select, populated only with values among that agent's own customers; selecting values narrows the table; reloading the page keeps the same selection (persisted); clearing returns to the full list.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/pages/MyWorklistPage.tsx
git commit -m "feat: multi-select branch/bucket worklist filters on web"
```

---

## Task 9: Web — same-day remark edit UI (`EditRemarkModal`, "Today's Work", customer trail)

**Files:**
- Create: `frontend/src/components/EditRemarkModal.tsx`
- Modify: `frontend/src/pages/MyWorklistPage.tsx`
- Modify: `frontend/src/components/CustomerDetailDrawer.tsx`

**Interfaces:**
- Consumes: `PATCH /call-logs/:id/remark`, `PATCH /field-visits/:id/remark` (Tasks 2-3).
- Produces: `EditRemarkModal` — reusable, `kind: "call" | "field_visit"`.

- [ ] **Step 1: Create `EditRemarkModal.tsx`**

```tsx
import { useEffect, useState } from "react";
import { Input, Modal, Typography, message } from "antd";
import { api, errorMessage } from "../api/client";

export type DirectEditableKind = "call" | "field_visit";

const ENDPOINT: Record<DirectEditableKind, (id: string) => string> = {
  call: (id) => `/call-logs/${id}/remark`,
  field_visit: (id) => `/field-visits/${id}/remark`,
};
const BODY_KEY: Record<DirectEditableKind, "extra_remark" | "remark"> = {
  call: "extra_remark",
  field_visit: "remark",
};

/**
 * Same-day (rolling 24h) owner-only remark edit -- distinct from
 * ReportCorrectionModal's "Report an error" (manager-approved, no time
 * limit). For a call log this edits only the free-text tail
 * (extra_remark); the disposition-driven portion of the composed remark is
 * recomputed server-side and never touched here.
 */
export default function EditRemarkModal({
  kind,
  recordId,
  currentText,
  open,
  onClose,
  onSaved,
}: {
  kind: DirectEditableKind;
  recordId: string;
  currentText: string;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [text, setText] = useState(currentText);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) setText(currentText);
  }, [open, currentText]);

  const submit = async () => {
    setSubmitting(true);
    try {
      await api.patch(ENDPOINT[kind](recordId), { [BODY_KEY[kind]]: text.trim() });
      message.success("Remark updated");
      onSaved();
      onClose();
    } catch (err) {
      message.error(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal title="Edit remark" open={open} onCancel={onClose} onOk={submit} confirmLoading={submitting} okText="Save">
      <Typography.Text type="secondary">
        You can only edit this within 24 hours of logging it. After that, use "Report an error" instead.
      </Typography.Text>
      <Input.TextArea
        style={{ marginTop: 8 }}
        rows={3}
        value={text}
        onChange={(e) => setText(e.target.value)}
        maxLength={500}
      />
    </Modal>
  );
}
```

- [ ] **Step 2: Extend `ReportCorrectionModal`'s `CorrectableRecordType`**

In `frontend/src/components/ReportCorrectionModal.tsx`, change line 6 and the `FIELDS_BY_TYPE` map (lines 14-25):

```ts
export type CorrectableRecordType = "payment" | "call_log" | "ptp" | "field_visit";
```

```ts
const FIELDS_BY_TYPE: Record<CorrectableRecordType, FieldDef[]> = {
  payment: [
    { key: "amount", label: "Amount", kind: "amount" },
    { key: "mode", label: "Mode", kind: "mode" },
    { key: "paid_at", label: "Paid At", kind: "date" },
  ],
  call_log: [{ key: "remark", label: "Remark", kind: "text" }],
  ptp: [
    { key: "amount", label: "Amount", kind: "amount" },
    { key: "promised_date", label: "Promised Date", kind: "date" },
  ],
  field_visit: [{ key: "remark", label: "Remark", kind: "text" }],
};
```

- [ ] **Step 3: Wire the edit affordance into `MyWorklistPage.tsx`'s "Today's Work"**

Add the import near the other component imports (after the `LogCallModal` import):

```ts
import EditRemarkModal, { type DirectEditableKind } from "../components/EditRemarkModal";
```

Update the local `AgentActivityRow` interface (lines 38-50) to add the two new fields:

```ts
interface AgentActivityRow {
  kind: "call" | "payment" | "ptp" | "field_visit";
  id: string;
  at: string;
  agent_id: string;
  agent_name?: string | null;
  customer_id: string;
  customer_name: string;
  loan_number: string;
  remark: string | null;
  extra_remark: string | null;
  amount: string | null;
  detail: string | null;
  edited_at: string | null;
}
```

Update `CORRECTABLE_KIND` (lines 66-72) to include `field_visit`:

```ts
const CORRECTABLE_KIND: Partial<Record<AgentActivityRow["kind"], CorrectableRecordType>> = {
  call: "call_log",
  payment: "payment",
  ptp: "ptp",
  field_visit: "field_visit",
};

const DIRECT_EDIT_KIND: Partial<Record<AgentActivityRow["kind"], DirectEditableKind>> = {
  call: "call",
  field_visit: "field_visit",
};

function canDirectEdit(a: AgentActivityRow, userId: string | undefined): boolean {
  if (!DIRECT_EDIT_KIND[a.kind]) return false;
  if (a.agent_id !== userId) return false;
  return dayjs().diff(dayjs(a.at), "hour", true) < 24;
}
```

Add state near `correctionTarget` (line 138):

```ts
  const [editRemarkTarget, setEditRemarkTarget] = useState<AgentActivityRow | null>(null);
```

Replace the timestamp/edited display and the action buttons in the Today's Work list item (lines 391-393 for the timestamp, and 403-416 for the buttons):

```tsx
                              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                                {dayjs(a.at).format("HH:mm")}
                              </Typography.Text>
                              {a.edited_at && (
                                <Tag color="default" style={{ fontSize: 11 }}>
                                  edited {dayjs(a.edited_at).format("HH:mm")}
                                </Tag>
                              )}
```

```tsx
                          <Space>
                            <Button size="small" onClick={() => setDetailId(a.customer_id)}>
                              View Customer
                            </Button>
                            {canDirectEdit(a, user?.id) ? (
                              <Button size="small" icon={<EditOutlined />} onClick={() => setEditRemarkTarget(a)}>
                                Edit
                              </Button>
                            ) : (
                              CORRECTABLE_KIND[a.kind] &&
                              a.agent_id === user?.id && (
                                <Button size="small" icon={<EditOutlined />} onClick={() => setCorrectionTarget(a)}>
                                  Edit
                                </Button>
                              )
                            )}
                          </Space>
```

Update the `ReportCorrectionModal` wiring's `currentValues` (lines 608-613) to handle `field_visit`:

```tsx
          currentValues={
            correctionTarget.kind === "call"
              ? { remark: correctionTarget.remark ?? "" }
              : correctionTarget.kind === "payment"
                ? { amount: Number(correctionTarget.amount), mode: correctionTarget.detail, paid_at: correctionTarget.at }
                : correctionTarget.kind === "field_visit"
                  ? { remark: correctionTarget.remark ?? "" }
                  : { amount: Number(correctionTarget.amount), promised_date: correctionTarget.detail }
          }
```

Add the `EditRemarkModal` render, right after the `ReportCorrectionModal` block (after line 622's closing `)}`):

```tsx
      {editRemarkTarget && DIRECT_EDIT_KIND[editRemarkTarget.kind] && (
        <EditRemarkModal
          kind={DIRECT_EDIT_KIND[editRemarkTarget.kind]!}
          recordId={editRemarkTarget.id}
          currentText={
            editRemarkTarget.kind === "call"
              ? (editRemarkTarget.extra_remark ?? "")
              : (editRemarkTarget.remark ?? "")
          }
          open={editRemarkTarget !== null}
          onClose={() => setEditRemarkTarget(null)}
          onSaved={() => {
            setEditRemarkTarget(null);
            void loadTodayActivity();
          }}
        />
      )}
```

- [ ] **Step 4: Add the same affordance to `CustomerDetailDrawer.tsx`'s call trail**

Add imports at the top:

```ts
import EditRemarkModal from "./EditRemarkModal";
import { useAuth } from "../auth/AuthContext";
```

Update the `trail` type in the `CustomerDetail` interface (lines 63-70):

```ts
  trail: {
    id: string;
    remark: string | null;
    extra_remark: string | null;
    action_code: string | null;
    result_code: string | null;
    agent_id: string;
    agent_name: string | null;
    created_at: string;
    edited_at: string | null;
  }[];
```

Inside the component, after `const [detail, setDetail] = useState<CustomerDetail | null>(null);`, add:

```ts
  const { user } = useAuth();
  const [editRemarkTrailId, setEditRemarkTrailId] = useState<string | null>(null);
```

Replace the trail item's remark/action block (lines 299-315):

```tsx
                      <div>
                        {orDash(t.remark)}{" "}
                        {t.edited_at && (
                          <Tag color="default" style={{ fontSize: 11 }}>
                            edited {dayjs(t.edited_at).format("DD MMM, HH:mm")}
                          </Tag>
                        )}
                        {t.agent_id === user?.id && dayjs().diff(dayjs(t.created_at), "hour", true) < 24 ? (
                          <Button
                            size="small"
                            type="link"
                            style={{ padding: 0, height: "auto" }}
                            onClick={() => setEditRemarkTrailId(t.id)}
                          >
                            Edit
                          </Button>
                        ) : (
                          <Button
                            size="small"
                            type="link"
                            style={{ padding: 0, height: "auto" }}
                            onClick={() =>
                              setCorrectionTarget({
                                recordType: "call_log",
                                recordId: t.id,
                                currentValues: { remark: t.remark },
                              })
                            }
                          >
                            Report an error
                          </Button>
                        )}
                      </div>
```

Add the modal render just after the closing tag of the `ReportCorrectionModal` block near the bottom of the component (find it via the existing `<ReportCorrectionModal` usage and add right after its closing `/>`):

```tsx
      {editRemarkTrailId && (
        <EditRemarkModal
          kind="call"
          recordId={editRemarkTrailId}
          currentText={detail?.trail.find((t) => t.id === editRemarkTrailId)?.extra_remark ?? ""}
          open={editRemarkTrailId !== null}
          onClose={() => setEditRemarkTrailId(null)}
          onSaved={() => {
            setEditRemarkTrailId(null);
            loadDetail();
          }}
        />
      )}
```

- [ ] **Step 5: Typecheck and build**

Run: `npm run typecheck` (from `frontend/`)
Expected: no errors.

Run: `npm run build` (from `frontend/`)
Expected: succeeds.

- [ ] **Step 6: Manual verification in the browser**

Log a call as a telecaller test account, confirm "Today's Work" shows an "Edit" button that opens `EditRemarkModal` (not the correction modal), edit the note, confirm the composed remark's disposition-driven prefix is unchanged and an "edited HH:mm" tag appears. Open the same customer's detail drawer and confirm the trail entry shows the same edit affordance. Directly PATCH the call log's `created_at` in the DB to 25h ago (or wait), reload, and confirm the button now says nothing but "Report an error" appears instead (i.e. `canDirectEdit` correctly falls back).

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/EditRemarkModal.tsx frontend/src/components/ReportCorrectionModal.tsx frontend/src/pages/MyWorklistPage.tsx frontend/src/components/CustomerDetailDrawer.tsx
git commit -m "feat: same-day remark edit UI on web"
```

---

## Task 10: Mobile — Hive-backed filter persistence + server-side branch/bucket filters

**Files:**
- Create: `mobile/lib/core/offline/worklist_filter_store.dart`
- Modify: `mobile/lib/features/worklist/worklist_provider.dart`
- Modify: `mobile/lib/features/worklist/worklist_screen.dart`

**Interfaces:**
- Produces: `WorklistFilterStore.load(userId)` → `WorklistFilterSelection`; `WorklistFilterStore.save(userId, selection)`. `worklistFiltersProvider: StateProvider<WorklistFilterSelection>`. `worklistFilterOptionsProvider: FutureProvider<WorklistFilterOptions>`.

- [ ] **Step 1: Create the Hive-backed filter store**

```dart
import 'package:hive_flutter/hive_flutter.dart';

/// Selected branch/bucket worklist filter -- multi-select, persisted
/// per-user so it survives app restarts. Mirrors read_cache.dart's
/// per-store-box pattern (its own Hive box, not shared with the offline
/// read cache or the offline action queue).
class WorklistFilterSelection {
  final List<String> branches;
  final List<String> buckets;
  const WorklistFilterSelection({this.branches = const [], this.buckets = const []});
}

class WorklistFilterStore {
  static Box<String>? _box;

  static Future<Box<String>> _ensureOpen() async {
    final existing = _box;
    if (existing != null) return existing;
    await Hive.initFlutter();
    final box = await Hive.openBox<String>('worklist_filters');
    _box = box;
    return box;
  }

  static Future<WorklistFilterSelection> load(String userId) async {
    final box = await _ensureOpen();
    final branches = box.get('${userId}_branches')?.split('|').where((s) => s.isNotEmpty).toList() ?? [];
    final buckets = box.get('${userId}_buckets')?.split('|').where((s) => s.isNotEmpty).toList() ?? [];
    return WorklistFilterSelection(branches: branches, buckets: buckets);
  }

  static Future<void> save(String userId, WorklistFilterSelection selection) async {
    final box = await _ensureOpen();
    await box.put('${userId}_branches', selection.branches.join('|'));
    await box.put('${userId}_buckets', selection.buckets.join('|'));
  }
}
```

- [ ] **Step 2: Add filter/options providers and thread filters through `worklistProvider`**

In `mobile/lib/features/worklist/worklist_provider.dart`, add the import:

```dart
import '../../core/offline/worklist_filter_store.dart';
```

Add these providers after `worklistScopeProvider`:

```dart
/// Selected branch/bucket filter -- starts empty (show all); WorklistScreen
/// loads the persisted selection for the current user on first build and
/// writes it back here via the notifier whenever the agent changes it.
final worklistFiltersProvider = StateProvider<WorklistFilterSelection>((ref) => const WorklistFilterSelection());

/// Options for the filter chips -- scoped to this agent's own allocated
/// customers (web equivalent: GET /worklist/filter-options), not the
/// agency-wide branch/bucket admin lists.
final worklistFilterOptionsProvider = FutureProvider<({List<String> branches, List<String> buckets})>((ref) async {
  final api = ref.watch(apiClientProvider);
  final scope = ref.watch(worklistScopeProvider);
  final res = await api.get<Map<String, dynamic>>(
    '/worklist/filter-options',
    query: scope == 'team' ? {'scope': 'team'} : null,
  );
  return (
    branches: (res.data!['branches'] as List).cast<String>(),
    buckets: (res.data!['buckets'] as List).cast<String>(),
  );
});
```

Replace `worklistProvider` (lines 42-53):

```dart
final worklistProvider = FutureProvider<List<Customer>>((ref) async {
  final api = ref.watch(apiClientProvider);
  final scope = ref.watch(worklistScopeProvider);
  final filters = ref.watch(worklistFiltersProvider);
  final query = <String, dynamic>{};
  if (scope == 'team') query['scope'] = 'team';
  if (filters.branches.isNotEmpty) query['customer_branch'] = filters.branches.join(',');
  if (filters.buckets.isNotEmpty) query['bucket'] = filters.buckets.join(',');
  final cacheKey = 'worklist_${scope}_${filters.branches.join("_")}_${filters.buckets.join("_")}';
  final list = await _fetchWithCacheFallback(ref, cacheKey, () async {
    final res = await api.get<Map<String, dynamic>>(
      '/worklist',
      query: query.isEmpty ? null : query,
    );
    return (res.data!['customers'] as List).cast<Map<String, dynamic>>();
  });
  return list.map(Customer.fromJson).toList();
});
```

- [ ] **Step 3: Replace the single bucket dropdown with branch + bucket multi-select chips**

In `mobile/lib/features/worklist/worklist_screen.dart`, add imports:

```dart
import '../../core/offline/worklist_filter_store.dart';
```

Remove the `_selectedBucket` field (line 34) — it's replaced by the shared `worklistFiltersProvider`.

In `initState` (lines 39-42), load the persisted filters once the widget mounts (after the first frame, since `ref`/auth user must be ready):

```dart
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _loadPersistedFilters());
  }

  Future<void> _loadPersistedFilters() async {
    final userId = ref.read(authProvider).user?['id'] as String?;
    if (userId == null) return;
    final selection = await WorklistFilterStore.load(userId);
    if (mounted) ref.read(worklistFiltersProvider.notifier).state = selection;
  }

  void _updateFilters(WorklistFilterSelection selection) {
    ref.read(worklistFiltersProvider.notifier).state = selection;
    final userId = ref.read(authProvider).user?['id'] as String?;
    if (userId != null) WorklistFilterStore.save(userId, selection);
  }
```

Replace the company/bucket filter `wl.maybeWhen(...)` block (lines 165-261) — this drops the client-side bucket derivation/dropdown (bucket is now a server-side multi-select fed by `worklistFilterOptionsProvider`) and keeps the company dropdown + quick-filter chips as they were:

```dart
                wl.maybeWhen(
                  data: (customers) {
                    final companies = customers
                        .map((c) => c.companyName)
                        .toSet()
                        .toList()
                        ..sort();
                    final filters = ref.watch(worklistFiltersProvider);
                    final options = ref.watch(worklistFilterOptionsProvider);
                    return Column(
                      children: [
                        Row(
                          children: [
                            Expanded(
                              child: DropdownButton<String?>(
                                isExpanded: true,
                                value: _selectedCompany,
                                hint: const Text('Filter by company'),
                                items: [
                                  const DropdownMenuItem<String?>(
                                    value: null,
                                    child: Text('All companies'),
                                  ),
                                  ...companies.map(
                                    (company) => DropdownMenuItem(
                                      value: company,
                                      child: Text(company),
                                    ),
                                  ),
                                ],
                                onChanged: (value) =>
                                    setState(() => _selectedCompany = value),
                              ),
                            ),
                          ],
                        ),
                        const SizedBox(height: 8),
                        options.when(
                          data: (opts) => Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              if (opts.branches.isNotEmpty) ...[
                                const Text('Branch', style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600)),
                                Wrap(
                                  spacing: 6,
                                  runSpacing: 4,
                                  children: opts.branches
                                      .map(
                                        (b) => FilterChip(
                                          label: Text(b),
                                          selected: filters.branches.contains(b),
                                          onSelected: (sel) {
                                            final next = List<String>.from(filters.branches);
                                            if (sel) {
                                              next.add(b);
                                            } else {
                                              next.remove(b);
                                            }
                                            _updateFilters(
                                              WorklistFilterSelection(branches: next, buckets: filters.buckets),
                                            );
                                          },
                                        ),
                                      )
                                      .toList(),
                                ),
                                const SizedBox(height: 6),
                              ],
                              if (opts.buckets.isNotEmpty) ...[
                                const Text('Bucket', style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600)),
                                Wrap(
                                  spacing: 6,
                                  runSpacing: 4,
                                  children: opts.buckets
                                      .map(
                                        (b) => FilterChip(
                                          label: Text(b),
                                          selected: filters.buckets.contains(b),
                                          onSelected: (sel) {
                                            final next = List<String>.from(filters.buckets);
                                            if (sel) {
                                              next.add(b);
                                            } else {
                                              next.remove(b);
                                            }
                                            _updateFilters(
                                              WorklistFilterSelection(branches: filters.branches, buckets: next),
                                            );
                                          },
                                        ),
                                      )
                                      .toList(),
                                ),
                              ],
                            ],
                          ),
                          loading: () => const SizedBox.shrink(),
                          error: (_, __) => const SizedBox.shrink(),
                        ),
                        const SizedBox(height: 8),
                        Wrap(
                          spacing: 8,
                          runSpacing: 4,
                          children: [
                            ChoiceChip(
                              label: const Text('PTP due today'),
                              selected: _quickFilter == _QuickFilter.ptpDueToday,
                              onSelected: (sel) => setState(
                                () => _quickFilter = sel ? _QuickFilter.ptpDueToday : _QuickFilter.none,
                              ),
                            ),
                            ChoiceChip(
                              label: const Text('Overdue'),
                              selected: _quickFilter == _QuickFilter.overdue,
                              onSelected: (sel) => setState(
                                () => _quickFilter = sel ? _QuickFilter.overdue : _QuickFilter.none,
                              ),
                            ),
                            ChoiceChip(
                              label: const Text('Not yet worked'),
                              selected: _quickFilter == _QuickFilter.notWorked,
                              onSelected: (sel) => setState(
                                () => _quickFilter = sel ? _QuickFilter.notWorked : _QuickFilter.none,
                              ),
                            ),
                          ],
                        ),
                      ],
                    );
                  },
                  orElse: () => const SizedBox.shrink(),
                ),
```

Remove the now-dead client-side bucket filtering (former lines 291-293, `if (_selectedBucket != null) { filtered = filtered.where(...) }`) and the `_selectedBucket = null` reset in the "Clear all filters" action (former line 366) — bucket filtering is now entirely server-side via `worklistFiltersProvider`, applied before `customers` ever reaches this widget.

Also invalidate `worklistFilterOptionsProvider` alongside `worklistProvider`/`dispositionCodesProvider` everywhere they're already invalidated together (the refresh `IconButton`, `RefreshIndicator.onRefresh`, and the error retry callback) so a stale option list doesn't linger after a pull-to-refresh.

- [ ] **Step 4: Analyze**

Run: `flutter analyze` (from `mobile/`)
Expected: no errors (warnings pre-existing elsewhere are fine, but nothing new in the touched files).

- [ ] **Step 5: Run the existing mobile test suite**

Run: `flutter test` (from `mobile/`)
Expected: PASS — no existing test directly exercises `WorklistScreen`'s bucket dropdown, but confirm nothing else regresses.

- [ ] **Step 6: Manual verification**

Run the app on an emulator/device (`flutter run`), log in as a telecaller/field_agent test account, open the worklist, confirm Branch and Bucket chips appear (sourced from that agent's own customers), selecting one re-fetches a narrowed list from the server, and the selection survives an app restart.

- [ ] **Step 7: Commit**

```bash
git add mobile/lib/core/offline/worklist_filter_store.dart mobile/lib/features/worklist/worklist_provider.dart mobile/lib/features/worklist/worklist_screen.dart
git commit -m "feat: server-side multi-select branch/bucket worklist filters on mobile"
```

---

## Task 11: Mobile — same-day remark edit UI

**Files:**
- Create: `mobile/lib/features/worklist/edit_remark_dialog.dart`
- Modify: `mobile/lib/features/worklist/correction_request_dialog.dart`
- Modify: `mobile/lib/features/worklist/history_timeline.dart`

**Interfaces:**
- Consumes: `PATCH /call-logs/:id/remark`, `PATCH /field-visits/:id/remark` (Tasks 2-3); `customerDetailProvider` (already includes `agent_id`/`extra_remark`/`edited_at` per Task 5).
- Produces: `showEditRemarkDialog(context, ref, {recordType, recordId, currentText, onSaved})`.

- [ ] **Step 1: Create the edit-remark dialog**

```dart
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../core/api/api_client.dart';
import '../../core/theme/app_theme.dart';

/// Same-day (rolling 24h) owner-only remark edit -- mobile counterpart to
/// web's EditRemarkModal. Distinct from correction_request_dialog.dart's
/// "Report an error" (manager-approved, no time limit); for a call_log this
/// edits only the free-text tail (extra_remark), never the disposition or
/// structured fields.
Future<void> showEditRemarkDialog(
  BuildContext context,
  WidgetRef ref, {
  required String recordType, // 'call_log' | 'field_visit'
  required String recordId,
  required String currentText,
  required VoidCallback onSaved,
}) async {
  final controller = TextEditingController(text: currentText);

  final result = await showDialog<bool>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: const Text('Edit remark'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(
            'You can only edit this within 24 hours of logging it. After that, use "Report an error" instead.',
            style: TextStyle(fontSize: 12, color: AppColors.textSecondary),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: controller,
            maxLines: 3,
            autofocus: true,
            decoration: const InputDecoration(border: OutlineInputBorder()),
          ),
        ],
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
        TextButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Save')),
      ],
    ),
  );

  if (result != true || !context.mounted) return;

  final path = recordType == 'field_visit'
      ? '/field-visits/$recordId/remark'
      : '/call-logs/$recordId/remark';
  final bodyKey = recordType == 'field_visit' ? 'remark' : 'extra_remark';

  try {
    await ref.read(apiClientProvider).patch(path, data: {bodyKey: controller.text.trim()});
    if (context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Remark updated'), backgroundColor: AppColors.success),
      );
    }
    onSaved();
  } on DioException catch (e) {
    if (context.mounted) {
      final msg =
          e.response?.data is Map && (e.response?.data as Map)['error'] != null
          ? (e.response!.data as Map)['error'].toString()
          : 'Could not save — check your connection';
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg), backgroundColor: AppColors.error));
    }
  }
}
```

- [ ] **Step 2: Extend `correction_request_dialog.dart` for `field_visit`**

In `mobile/lib/features/worklist/correction_request_dialog.dart`, extend the `remarkCtrl`-gated block (line 115) to also cover `field_visit`:

```dart
              if (recordType == 'call_log' || recordType == 'field_visit') ...[
```

And the proposed-changes assembly (line 180):

```dart
  if ((recordType == 'call_log' || recordType == 'field_visit') &&
      remarkCtrl.text.trim() != (currentValues['remark']?.toString() ?? '')) {
    proposedChanges['remark'] = remarkCtrl.text.trim();
  }
```

- [ ] **Step 3: Wire the edit affordance into `history_timeline.dart`**

Add the import:

```dart
import 'edit_remark_dialog.dart';
import '../../core/auth/auth_provider.dart';
```

Extend `_HistoryEntry` to carry ownership/edit-window/edited data:

```dart
class _HistoryEntry {
  final DateTime at;
  final IconData icon;
  final Color color;
  final String title;
  final String? subtitle;
  final String? correctableRecordType;
  final String? recordId;
  final Map<String, dynamic>? rawFields;
  final String? agentId;
  final String? directEditText;
  final DateTime? editedAt;
  const _HistoryEntry({
    required this.at,
    required this.icon,
    required this.color,
    required this.title,
    this.subtitle,
    this.correctableRecordType,
    this.recordId,
    this.rawFields,
    this.agentId,
    this.directEditText,
    this.editedAt,
  });
}
```

Update `_merge` (a top-level function — thread the current user id in as a parameter) — change its signature and the call trail / field_visit branches:

```dart
List<_HistoryEntry> _merge(Map<String, dynamic> detail, String? currentUserId) {
  final entries = <_HistoryEntry>[];

  for (final t in (detail['trail'] as List? ?? [])) {
    final m = t as Map<String, dynamic>;
    entries.add(
      _HistoryEntry(
        at: DateTime.parse(m['created_at'] as String),
        icon: Icons.phone_in_talk,
        color: AppColors.info,
        title:
            [
              m['result_code'],
              m['action_code'],
            ].where((v) => v != null).join(' · ').isEmpty
            ? 'Call logged'
            : [
                m['result_code'],
                m['action_code'],
              ].where((v) => v != null).join(' · '),
        subtitle: [
          m['agent_name'],
          m['remark'],
        ].whereType<String>().where((v) => v.isNotEmpty).join(' — '),
        correctableRecordType: 'call_log',
        recordId: m['id'] as String?,
        rawFields: {'remark': m['remark']},
        agentId: m['agent_id'] as String?,
        directEditText: (m['extra_remark'] as String?) ?? '',
        editedAt: m['edited_at'] != null ? DateTime.parse(m['edited_at'] as String) : null,
      ),
    );
  }
  for (final p in (detail['payments'] as List? ?? [])) {
    final m = p as Map<String, dynamic>;
    entries.add(
      _HistoryEntry(
        at: DateTime.parse(m['paid_at'] as String),
        icon: Icons.currency_rupee,
        color: AppColors.success,
        title: 'Payment: ${_rupee(parseDouble(m['amount']) ?? 0.0)}',
        subtitle: m['mode'] as String?,
        correctableRecordType: 'payment',
        recordId: m['id'] as String?,
        rawFields: {
          'amount': m['amount'],
          'mode': m['mode'],
          'paid_at': m['paid_at'],
        },
      ),
    );
  }
  for (final v in (detail['field_visits'] as List? ?? [])) {
    final m = v as Map<String, dynamic>;
    entries.add(
      _HistoryEntry(
        at: DateTime.parse(m['created_at'] as String),
        icon: Icons.location_on,
        color: AppColors.warning,
        title: 'Field visit${m['has_photo'] == true ? ' (photo)' : ''}',
        subtitle: [
          m['agent_name'],
          m['remark'],
        ].whereType<String>().where((v) => v.isNotEmpty).join(' — '),
        correctableRecordType: 'field_visit',
        recordId: m['id'] as String?,
        rawFields: {'remark': m['remark']},
        agentId: m['agent_id'] as String?,
        directEditText: (m['remark'] as String?) ?? '',
        editedAt: m['edited_at'] != null ? DateTime.parse(m['edited_at'] as String) : null,
      ),
    );
  }
```

(The `ptps`/`attachments` loops below are unchanged.)

Update the `build` method's call to `_merge` and the trailing icon logic. Change:

```dart
    final detail = ref.watch(customerDetailProvider(customerId));
```

to also read the current user id:

```dart
    final detail = ref.watch(customerDetailProvider(customerId));
    final currentUserId = ref.watch(authProvider).user?['id'] as String?;
```

And change `final entries = _merge(d);` to `final entries = _merge(d, currentUserId);`.

Update the `ListTile`'s `subtitle` to show the edited badge, and `trailing` to prefer the direct-edit action when it's owned and in-window:

```dart
                          subtitle: Text(
                            [
                              _dateTime.format(e.at.toLocal()),
                              if (e.editedAt != null) 'edited ${_dateTime.format(e.editedAt!.toLocal())}',
                              if (e.subtitle != null && e.subtitle!.isNotEmpty)
                                e.subtitle,
                            ].join(' — '),
                            style: const TextStyle(
                              fontSize: 11,
                              color: AppColors.textTertiary,
                            ).tabular,
                          ),
                          trailing: () {
                            final canDirectEdit = e.directEditText != null &&
                                e.agentId != null &&
                                e.agentId == currentUserId &&
                                DateTime.now().difference(e.at).inHours < 24;
                            if (canDirectEdit) {
                              return IconButton(
                                icon: const Icon(Icons.edit_outlined, size: 18),
                                tooltip: 'Edit remark',
                                onPressed: () => showEditRemarkDialog(
                                  context,
                                  ref,
                                  recordType: e.correctableRecordType!,
                                  recordId: e.recordId!,
                                  currentText: e.directEditText!,
                                  onSaved: () => ref.invalidate(customerDetailProvider(customerId)),
                                ),
                              );
                            }
                            if (e.correctableRecordType != null) {
                              return IconButton(
                                icon: const Icon(Icons.flag_outlined, size: 18),
                                tooltip: 'Report an error',
                                onPressed: () => showCorrectionRequestDialog(
                                  context,
                                  ref,
                                  recordType: e.correctableRecordType!,
                                  recordId: e.recordId!,
                                  currentValues: e.rawFields!,
                                  onSubmitted: () =>
                                      ref.invalidate(customerDetailProvider(customerId)),
                                ),
                              );
                            }
                            return null;
                          }(),
```

- [ ] **Step 4: Analyze**

Run: `flutter analyze` (from `mobile/`)
Expected: no new errors.

- [ ] **Step 5: Run the existing mobile test suite**

Run: `flutter test` (from `mobile/`)
Expected: PASS.

- [ ] **Step 6: Manual verification**

Run the app, log a call, open the customer's History panel, confirm the pencil icon opens the quick-edit dialog and saves; confirm a field visit's remark is also directly editable the same way; confirm after simulating a 25h-old record (backend timestamp tweak) the flag icon ("Report an error") appears instead.

- [ ] **Step 7: Commit**

```bash
git add mobile/lib/features/worklist/edit_remark_dialog.dart mobile/lib/features/worklist/correction_request_dialog.dart mobile/lib/features/worklist/history_timeline.dart
git commit -m "feat: same-day remark edit UI on mobile"
```

---

## Task 12: Full regression pass

**Files:** none (verification only)

- [ ] **Step 1: Backend**

Run: `npm run typecheck && npm run lint && npm run test` (from `backend/`)
Expected: all pass.

- [ ] **Step 2: Frontend**

Run: `npm run typecheck && npm run build` (from `frontend/`)
Expected: both succeed.

- [ ] **Step 3: Mobile**

Run: `flutter analyze && flutter test` (from `mobile/`)
Expected: both pass.

- [ ] **Step 4: End-to-end manual walkthrough**

With backend + frontend dev servers and a mobile emulator running against the same backend: log in as a telecaller on web, select a branch+bucket filter, confirm persistence across a reload; log in as a field agent on mobile, confirm the same branch/bucket options (scoped to that agent) and selection persistence across an app restart; on each platform, log a call/visit, edit its remark within the window via the new direct-edit affordance, confirm the disposition-driven portion of a call log's remark is untouched, then confirm the correction-request ("Report an error") flow still works for out-of-window records on both platforms.

- [ ] **Step 5: Update the dev log**

Add a short entry to `docs/DEVLOG.md` describing this feature (branch/bucket worklist filter + same-day remark edit), following the file's existing phase-entry style.

- [ ] **Step 6: Commit**

```bash
git add docs/DEVLOG.md
git commit -m "docs: log branch/bucket filter + same-day remark edit feature"
```

---

## Self-Review Notes

- **Spec coverage:** Every item in `docs/superpowers/specs/2026-08-18-agent-branch-bucket-filter-and-remark-edit-design.md` maps to a task: multi-select branch/bucket filter (web: Task 8, mobile: Task 10), filter-options scoped to the agent's own customers (Task 7), persistence (Task 8/10), 24h direct edit for call logs and field visits (Task 2/3), free-text-only scope (Tasks 2/3's `extra_remark`/`remark`-only PATCH bodies), `edited_at` badge (Tasks 6, 9, 11), correction-requests extended to `field_visit` (Task 4), UI wiring on both platforms (Tasks 9, 11).
- **Type consistency:** `AgentActivityRow.extra_remark`/`edited_at` (Task 6) match the frontend's `AgentActivityRow` interface fields added in Task 9. `EditRemarkModal`'s `DirectEditableKind` ("call" | "field_visit") is a distinct, narrower type from `CorrectableRecordType` ("payment" | "call_log" | "ptp" | "field_visit") — intentional, since only two of the four correctable kinds get a direct-edit path; `DIRECT_EDIT_KIND` in `MyWorklistPage.tsx` is the explicit map between `AgentActivityRow["kind"]` and `DirectEditableKind`. Mobile's `edit_remark_dialog.dart` takes a `recordType` string (`'call_log' | 'field_visit'`) matching `correction_request_dialog.dart`'s existing convention rather than a Dart enum, for consistency with the file it sits beside.
- **Placeholder scan:** no TODO/TBD; every step has runnable code or an exact command.
