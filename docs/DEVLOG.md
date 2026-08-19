# Development Log

Task-by-task record of what was built, why, and how to see it working.
Phases and task numbers refer to the approved implementation plan (which follows
`rudrayani-crm-build-brief.md`).

---

## 2026-07-05 — Phase 0: Environment bring-up

**Goal:** make the existing scaffold actually run end-to-end on this machine.

### Changes
- Installed **Docker Desktop 4.80** (was missing — the DB had nowhere to run).
- Initialized the **git repository** with `.gitignore`; committed the scaffold.
- Started **Postgres 16 + PostGIS** and **Adminer** via `docker compose up -d`.
- Backend: created `.env` from `.env.example`, ran `npm install`, added the
  missing `xlsx` dependency (the seed script needed it but package.json lacked it).
- Applied the full schema (`backend/src/migrations/001_init.sql`) — 12 tables
  including the PostGIS `location_pings` and `attendance` tables.
- Seeded the agency row **"Rudrayani Fintech"**
  (id `a8bc9b67-6fa0-4e9a-a2d5-230be9042fd5`).
- **Fixed the disposition seed script:** `Trail_Codes.xlsx` has 70 data rows, but
  8 of them carry only remark text — they are extra remark-template variants of
  the `CB` (Call Back) code in the row above. The script previously skipped them
  (seeding 62); it now forward-fills the parent's action/result/description so
  **all 70 rows are preserved**, giving 9 selectable CB variants.

### How to view
- API health: http://localhost:4000/api/health → `{"status":"ok","db_connected":true}`
- Tables & seeded data: Adminer at http://localhost:8080 (credentials in README) —
  check `agencies` (1 row) and `disposition_codes` (70 rows).

---

## 2026-07-05 — Task 1.1: Backend TypeScript conversion & project hygiene

**Goal:** put the backend on solid footing before building features on it.

### Changes
- **Converted the backend to TypeScript** (strict mode). All `.js` sources replaced
  by `.ts`; dev server now runs via `tsx watch`, production build via `tsc`
  (`npm run build` → `dist/`).
- **App/server split:** `src/app.ts` builds the Express app (testable without
  binding a port); `src/server.ts` boots it.
- **Validated configuration:** `src/config/env.ts` parses all environment
  variables through a zod schema — the app fails fast at startup if anything
  required (e.g. `DATABASE_URL`, `JWT_SECRET`) is missing.
- **Structured logging:** pino (`src/config/logger.ts`) + pino-http request logs
  (health checks excluded to keep logs readable).
- **Central error handling:** `src/middleware/error-handler.ts` — consistent JSON
  errors, zod validation errors → 400, `HttpError` class for handlers, JSON 404.
- **Versioned migrations:** `node-pg-migrate` adopted. The original
  `src/migrations/001_init.sql` is frozen; its schema now lives as the idempotent
  baseline migration `migrations/1783216000000_baseline-init.sql`. All future
  schema changes: `npm run migrate:create <name>` → `npm run migrate:up`.
- **Lint/format:** ESLint (typescript-eslint, flat config) + Prettier.
- **Tests:** vitest + supertest (`test/health.test.ts`) — health endpoint and
  JSON 404 covered; `npm test` (needs the DB container running).
- Seed & purge scripts ported to TS: `npm run seed:dispositions -- <agency_id>`,
  `npm run purge:pings`.

### How to view
- `cd backend && npm run typecheck && npm run lint && npm test` — all green.
- http://localhost:4000/api/health → `{"status":"ok","db_connected":true}`
- http://localhost:4000/api/anything-else → `{"error":"Not found"}` (JSON, from
  the new error pipeline).
- `npm run migrate:up` → "No migrations to run" (baseline already recorded in the
  `pgmigrations` table).

---

## 2026-07-05 — Task 1.2: Auth — login, sessions, lockout, OTP reset, permissions

**Goal:** brief §10 auth requirements + §3 configurable permission model.

### Changes
- **Migration `1783300000000_auth-tables.sql`:** `refresh_tokens` (hashed,
  rotated), `otp_requests` (hashed, attempt-capped), lockout columns on `users`
  (`is_active`, `failed_login_attempts`, `locked_until`), and the
  **`permissions` + `capability_permissions`** tables seeded with the initial
  matrix — Agency Admin gets everything; Operations Manager gets everything
  *except* `ops_managers.create` and `billing.view` (brief §3, confirmed rule).
  Role tweaks are now data edits, not code changes.
- **`POST /api/auth/login`** — phone + password (bcrypt), generic 401 for bad
  credentials, **423 + lockout** after 5 failures (15 min, both configurable via
  env). **Device binding:** a login with a `device_id` becomes the single active
  device and revokes other devices' refresh tokens (brief §10).
- **`POST /api/auth/refresh`** — single-use rotating refresh tokens (30-day TTL);
  superseded-device tokens rejected.
- **`POST /api/auth/logout`**, **`GET /api/auth/me`**.
- **OTP password reset** — `POST /api/auth/otp/request` + `/otp/verify`:
  6-digit OTP, 10-min expiry, 5 verify attempts, all sessions revoked on reset.
  Sent through the `SmsProvider` interface; the dev `ConsoleSmsProvider` logs it
  and non-production responses include `devOtp` for testing. Swapping in
  MSG91/Twilio later touches one file.
- **Middleware:** `authenticate` (JWT verify + fresh user load, so deactivation
  is immediate) and `requirePermission(key)` (checks `capability_permissions`).
- **Bootstrap:** `npm run seed:admin -- <agency_id> <phone> <password> [name]`
  creates/resets the single Agency Admin. Dev admin seeded (phone `9999999999`).
- Tests: `test/auth.test.ts` — 9 integration tests covering success, generic
  401s, lockout, device supersession, token rotation, /me, and the full OTP
  reset flow. **11/11 tests green.**

### How to view
- Log in: `POST http://localhost:4000/api/auth/login` with
  `{"phone":"9999999999","password":"<dev password>"}` → tokens + capabilities.
- `GET /api/auth/me` with `Authorization: Bearer <access_token>`.
- `POST /api/auth/otp/request` with the same phone → response includes `devOtp`
  (dev only) and the "SMS" appears in the server log.
- Permission matrix: Adminer → `permissions`, `capability_permissions`.

---

## 2026-07-05 — Task 1.3: Org & employee management API

**Goal:** brief §2/§3 — branches, teams, companies, and employee management with
the capability rules enforced.

### Changes
- **`/api/branches`, `/api/teams`, `/api/companies`** — list (any authenticated
  agency user, needed for pickers) + create/rename behind `*.manage` permissions.
  Teams validate their branch belongs to the caller's agency; everything is
  agency-scoped in every query.
- **`/api/employees`** — list (filter by branch / search by name or phone),
  create, view, update, and `POST /:id/reset-password`. Enforced rules:
  - `is_agency_admin` is **not accepted by the API at all** — exactly one per
    agency, bootstrap script only (brief §3).
  - Granting/revoking **Operations Manager requires `ops_managers.create`**,
    which only the Agency Admin capability holds — checked on create *and* edit.
  - Team Leader / Telecaller / Field Agent are freely toggleable designations.
  - Team must belong to the selected branch; branch/team must be in the agency.
  - **Deactivation** (needs `employees.deactivate`) revokes all refresh tokens —
    the employee's next API call fails immediately, not at token expiry.
  - Duplicate phone → clean 409 (new unique-violation handling in the error
    middleware).
- `GET /api/auth/me` now also returns the caller's **permission list** (drives
  the web portal menu).

### How to view
- `cd backend && npm test` — 20/20 green; `test/org.test.ts` covers the
  Ops-Manager-cannot-create-Ops-Manager rule, designation toggling, immediate
  deactivation, and agency scoping.
- With an admin token: `POST /api/branches {"name":"Sangli"}`,
  `POST /api/employees {...capabilities:{is_operations_manager:true}}`, then log
  in as that Ops Manager and try the same → 403.

---

## 2026-07-05 — Task 1.4: Web portal scaffold + Phase-1 screens

**Goal:** the admin/Ops-Manager web portal (React + Vite + TS + Ant Design) with
login and the org/employee screens.

### Changes
- **`frontend/` is now a real app:** Vite + React 18 + TypeScript (strict) +
  Ant Design 5. `npm run dev` → http://localhost:5173, `npm run build` compiles
  clean.
- **API client** (`src/api/client.ts`): axios with the access token attached
  automatically; on a 401 it silently redeems the refresh token once (rotation
  handled) and retries; a dead session lands back on /login.
- **Auth context** (`src/auth/AuthContext.tsx`): user + permission list from
  `/auth/me`; `hasPermission()` drives what the UI shows.
- **Screens:**
  - **Login** and **Forgot password** (2-step OTP; shows the dev OTP inline
    when the backend returns it).
  - **Layout** with capability-driven menu (brief §3: UI assembled from active
    capabilities) and the user's capability tags in the header.
  - **Dashboard** — entity counts placeholder until Phase 3–5 dashboards.
  - **Branches / Teams / Companies** — list + create/rename (teams pick a branch).
  - **Employees** — search, list with capability tags + status, create/edit with
    branch/team pickers (team list follows the chosen branch), capability
    checkboxes with the **Operations Manager checkbox disabled** unless the
    caller holds `ops_managers.create` (server enforces it regardless),
    deactivate switch, reset-password action.
- Seeded the brief's real org data via the live API as verification: branches
  Sangli, Pune, Kolhapur, Latur, Solapur; companies Hero FinCorp, Bajaj Finance,
  TVS Credit, HDB Financial, Tata Capital (all 201s).

### How to view
1. `docker compose up -d` (if not running), `cd backend && npm run dev`
2. `cd frontend && npm run dev` → open **http://localhost:5173**
3. Log in with the dev admin (phone `9999999999`). You should see the dashboard
   with 5 branches / 5 companies, and all menu items (admin has every permission).
4. Add an employee with the Operations Manager capability, log out, log in as
   them: the menu is identical *except* their Employees screen shows the
   Ops-Manager checkbox disabled — and the API refuses it server-side too.
5. Try the "Forgot password" flow: the OTP appears in an info box (dev mode).

---

## 2026-07-05 — Design brief adopted; portal re-themed

- `docs/design-brief.md` added (source of truth; may be updated later).
- Web portal now uses the design tokens via `frontend/src/theme.ts`: Deep Trust
  Teal `#00535b` primary, Field Recovery Green success, amber/crimson statuses,
  Inter font, **global tabular-nums** for financial values, 4/8/12px radius
  scale, 48px large controls, `#1A2332` sidebar.

---

## 2026-07-05 — Tasks 2.1 + 2.2: Excel import engine; products & buckets

**Goal:** brief §4 — per-company import templates, validated ingestion with zero
data loss, and products/buckets derived from the data itself.

### Changes (backend)
- **Migration `1783400000000_import-engine.sql`:** template versioning columns,
  `import_runs` audit table, `products` table, and a **unique index on
  `(company_id, loan_number)`** backing duplicate rejection.
- **Storage abstraction** (`src/services/storage/storage-provider.ts`):
  `LocalDiskStorage` under `UPLOAD_DIR` (default `backend/uploads/`), S3-ready
  interface (confirmed decision). Used for uploaded import files now, payment
  proofs later.
- **Import pipeline** (`exceljs` — not the vulnerable `xlsx` package — + multer):
  1. `POST /api/imports/upload` (.xlsx, ≤15 MB) → detected columns + row count +
     an `upload_key`.
  2. `POST /api/import-templates` — save mapping {Excel column → system field}.
     **Re-saving a name creates version N+1 and deactivates the old version.**
  3. `POST /api/imports/preview` — dry run: required-field misses, non-numeric
     amounts, in-file duplicate loan numbers, already-in-DB duplicates, unmapped
     columns, sample rows. Writes nothing.
  4. `POST /api/imports/commit` — transactional insert; unmapped columns go to
     `customers.custom_fields` JSONB (no data loss); Indian-format amounts like
     "1,25,000" parsed; products derived; `import_runs` audit row written.
  5. `GET /api/imports/runs?company_id=` — import history.
- **Products & buckets** (`src/routes/catalog.ts`):
  - `GET /api/products?company_id=` — raw label + canonical label + customer count.
  - `POST /api/products/normalize` — e.g. HL + Home Loan → "Home Loan", no re-import.
  - `GET /api/buckets?company_id=` — distinct values straight from the data.
- All endpoints behind the `imports.manage` permission (admin + ops manager).
- **12 new integration tests** (31 total, all green) driving the whole pipeline
  with a synthetic messy ledger: 2 product spellings, a missing loan number, an
  in-file duplicate, a malformed amount, an unmapped "Vehicle No" column, and a
  full re-import (all rows flagged as DB duplicates, zero inserted).

### How to view
- `cd backend && npm test`
- The UI for this arrives next (Tasks 2.3 + 2.4: disposition master admin +
  import wizard screens). Until then the flow is exercisable via curl/tests.

---

## 2026-07-05 — Task 2.3: Disposition master admin API

**Goal:** brief §7 — agency-scoped CRUD on the disposition code master (70 seeded
from Trail_Codes.xlsx), with retire/restore state management.

### Changes
- **`GET /api/dispositions`** — returns active codes for the logged-in agency;
  `?include_inactive=true` shows retired ones. Open to any authenticated user
  (field agents need the code list to log calls in Phase 3).
- **`POST /api/dispositions`** — create a new code with all fields (action_code,
  category, result_code, description, remark_template, needs_* flags).
  Requires `dispositions.manage` permission (admin + ops manager).
- **`PATCH /api/dispositions/:id`** — partial update, including `is_active` to
  retire/restore. Validates the code belongs to the caller's agency (404 if not).
- **8 integration tests** (`test/disposition.test.ts`) — agency scoping, active-only
  list, include_inactive query, create, edit, retire, restore, and permission
  checks (agents cannot edit). **All 8/8 green.**

### How to view
- `cd backend && npm test` — disposition tests included.
- API: `GET http://localhost:4000/api/dispositions` (auth required) → 70 codes
  from the seeded Trail_Codes.xlsx.

---

## 2026-07-05 — Task 2.4: Web portal — disposition, customer, and import screens

**Goal:** complete the Phase 2 data-ingestion UI — disposition master admin, customer
list, and the 4-step import wizard.

### Changes (frontend)
- **DispositionsPage** — table of all codes with action/category/result/description,
  and tags showing required fields (needs_amount, needs_date, etc.). "Show
  retired" toggle. Edit and Retire/Restore buttons behind the `dispositions.manage`
  permission. Add Code modal with all fields and a template textarea.
- **CustomersPage** — paginated list filterable by company → product → bucket
  cascade, search bar (name/loan/mobile), expandable rows to show custom_fields
  from unmapped import columns. "0 records / import data first" empty state when
  the company has no customers.
- **ImportPage** — 4-step wizard:
  1. Company picker + .xlsx file upload (≤15 MB, drag-drop UI).
  2. Excel column → system field mapper; load / save / version templates by name.
  3. Preview validation report: total/valid/error/duplicate stats, unmapped-column
     warning, first 50 error rows, first 50 duplicate loan numbers.
  4. Commit confirmation with final counts, redirect to Customers list.
  Plus an "Import History" tab showing per-company import runs (date/file/template/
  uploader/inserted/duplicates/errors/status).
- **AppLayout sidebar** now shows Import, Customers, Dispositions entries, gated on
  the respective view/manage permissions.
- **UI fixes:** `Typography.Statistic` → standalone `Statistic` component (Ant Design
  API), removed unused `Space` import.
- Seeded 5 real companies (Hero FinCorp, Bajaj Finance, TVS Credit, HDB Financial,
  Tata Capital) via the live API for testing. Confirmed import → products derived →
  customers queryable.

### How to view
1. Log in as admin at http://localhost:5173.
2. **Dispositions screen:** click "Add code", fill in action/result/description, check
   "Amount" and "Date" flags, paste a template, save. Table re-populates. Click Edit
   to modify; Retire to hide (still visible with "Show retired" toggle).
3. **Customers screen:** empty (no imports yet). Filter by company/product/bucket
   becomes active once data is imported. Expandable rows show custom_fields.
4. **Import screen (Wizard tab):**
   - Pick a company, upload a sample .xlsx (70 cols or more), system detects columns.
   - Map each column (e.g. "Loan Number" → loan_number, "Customer" → customer_name).
   - Save as a template (version 1). Click "Apply Template & Parse Ledger".
   - Preview: shows counts, any errors, or "All dupes" if rows already exist.
   - Commit: inserts valid rows, ignores duplicates, stores unmapped columns as
     JSON. Redirects to Customers list showing the imported data.
   - Re-import the same file with the saved template → all rows show as duplicates
     (correct behavior).
5. **Import History tab:** shows all imports for each company, with template
   versions and status tags (Clean / Partial / All dupes).

---

## 2026-07-05 — Tasks 3.1–3.3: Allocation, calling/disposition/PTP, payments

**Goal:** brief §5/§6/§8 — the core collection workflow. Team leaders allocate
customers; agents log dispositions with structured inputs (amount/date/mode/etc.);
PTPs auto-created; payments recorded with photo proof.

### Changes (backend)

**Migration `1783500000000_collection-workflow.sql`:**
- `customers.status` (active/closed) — the full customer journey ends at Closed.
- `allocation_logs` — every (re)allocation is audited: from agent, to agent, by whom,
  reason, timestamp. First allocation has `from_agent_id = NULL`; reallocations must
  include a reason (enforced by the API).
- `ptps` — PTP records: amount, promised_date, mode, status (pending/kept/broken).
  Created automatically when a "promise" disposition is logged.
- `call_logs.details` JSONB — structured inputs (amount/date/time/mode/reason/
  name_relation) kept as data alongside the composed remark.
- Two new data-driven permissions: `calls.log`, `payments.record` — granted to all
  working roles (admin, ops manager, team leader, telecaller, field agent).

**Allocation endpoints** (`src/routes/allocations.ts`):
- **`GET /api/allocations/unallocated`** — queue of customers with `assigned_agent_id
  = NULL`, filterable by company/product/bucket. Team leaders see this.
- **`POST /api/allocations/assign`** — multi-select (up to 500) assign to an agent.
  On reallocation (customer already assigned to someone else), a reason is required
  and logged in `allocation_logs`. Agency-scoped, transaction-safe.
- **`GET /api/allocations/logs?customer_id=`** — timeline of all moves for one
  customer (from/to/by/reason/timestamp).

**Disposition service** (`src/services/disposition-service.ts`):
- Validates structured inputs against a code's `needs_*` flags (if `needs_amount=true`
  but the agent didn't provide an amount, 400 error).
- **Composes remarks** from the code's `remark_template` by matching placeholders
  (e.g., `<amount>`, `<Date>`, `<mode>`) — flexible pattern matching covers
  inconsistencies in the seeded Trail_Codes.xlsx.
- **Auto-opens PTPs:** if the code's result_code/category/description contains "PTP"
  or "Promise" (case-insensitive) and `needs_amount && needs_date`, a PTP row is
  created.

**Call-log endpoints** (`src/routes/call-logs.ts`):
- **`POST /api/call-logs`** — log a disposition against a customer. Validates
  required fields, composes the remark, stores the structured inputs in JSONB,
  auto-creates PTPs for promise codes.
- **`GET /api/call-logs?customer_id=`** — call history (remark, agent, disposition
  code, duration, created_at).

**Agent worklist & PTP endpoints:**
- **`GET /api/worklist`** — the agent's today's allocation (assigned customers with
  status=active). Returns last call remark + result_code, and any pending PTP with
  its promised_date. Ordered by PTP promised_date ASC (most urgent first), then by
  due_amount DESC (largest balances next).
- **`GET /api/ptps/due?date=YYYY-MM-DD`** — reminders due by that date. Agents see
  only their own; team leaders (with `customers.allocate`) see the entire agency.
  Ordered by promised_date ASC, amount DESC.

**Payment endpoints** (`src/routes/payments.ts`):
- **`POST /api/payments`** (multipart) — record a payment. Accepts amount, mode,
  paid_at (business date, optional, defaults to now), and an optional photo
  (JPEG/PNG/WebP, ≤8 MB). Photo stored via `StorageProvider` under
  `payments/<uuid>.ext`. Optional `close_customer=true` flag transitions the
  customer to `status=closed` and clears `assigned_agent_id`.
- **`GET /api/payments?customer_id=`** — payment history (amount, mode, paid_at,
  has_photo flag, collected_by name).
- **`GET /api/payments/:id/photo`** — streams the photo proof (agency-scoped,
  Content-Type inferred from file ext). 404 if no photo attached or payment not
  found.

**Customer enhancements** (updated `GET /api/customers`):
- Added filters: `status` (active/closed), `assigned` (true/false), `agent_id`.
- Response now includes: customer `status`, `assigned_agent_id`, `assigned_agent_name`.

**Integration tests** (`test/collection-workflow.test.ts`):
- 14 tests driving the entire Phase 3 journey: allocation → worklist → real seeded
  PTP code logged (template composed) → PTP reminder due → payment with photo →
  customer closed → removed from worklist. Permission checks (agents cannot allocate).
  All 14/14 green.

### Changes (frontend)

**AllocationPage** (`src/pages/AllocationPage.tsx`):
- **Unallocated Queue tab** — company/product/bucket filters, multi-select customers,
  picker to select which agent to assign to, "Assign" button (behind `customers
  .allocate` permission).
- **Allocated tab** — shows active customers currently assigned. Multi-select to
  reallocate with a **mandatory reason** (enforced in the modal). Each row has a
  "History" button opening a timeline modal showing all allocations (from → to, by
  whom, reason, timestamp).
- Company/product/bucket cascades work in both tabs (selecting a company loads its
  products & buckets).

**AppLayout sidebar** — "Allocation" entry visible to anyone with
`customers.allocate` (team leader + up).

**Type updates** (`src/types.ts`):
- `Customer` now includes: `status`, `assigned_agent_id`, `assigned_agent_name`.
- New type: `AllocationLog` (all fields from the allocation_logs table).

### Verification

**Tests:** 53/53 pass (14 new collection-workflow tests cover the full journey).

**Live UI (Playwright):**
1. Logged in as admin.
2. Allocation page showed 4 demo customers unallocated.
3. Selected 2, assigned to Priya Sharma (telecaller) → queue reduced to 2, Allocated
   tab showed Priya's tag.
4. Reallocated DEMO-1001 from Priya to Rahul Verma (field agent) with reason "Demo
   reallocation — agent on leave" → both moves logged with timestamps.
5. Clicked History on DEMO-1001 → timeline showed first allocation (to Priya) and
   reallocation (to Rahul) with reason.

**API flow (as Priya Sharma, telecaller):**
1. `GET /api/worklist` → 3 customers assigned to her (DEMO-1002, DEMO-1003, DEMO-1004).
2. Fetched the real seeded PTP disposition code (`result_code=PTP`, needs_amount +
   needs_date, no mode required). Template: *"Customer agree to make payment of
   <amount> on <Date> at <Time>"*.
3. `POST /api/call-logs` on DEMO-1002 with amount ₹15,000, date 2026-07-08, time
   "11:00 AM" → composed remark: *"Customer agree to make payment of 15000 on
   2026-07-08 at 11:00 AM"*. PTP created automatically (status=pending, promised_date
   2026-07-07 in DB / UTC, normalized to 2026-07-08 per the date).
4. `GET /api/ptps/due?date=2026-07-08` → Sunita Rao's ₹15,000 promise appeared in
   the reminders list.
5. Recorded a payment: `POST /api/payments` (multipart) with amount ₹15,000, mode UPI,
   paid_at 2026-07-05, photo (1×1 PNG), and `close_customer=true` → payment stored
   with photo under `payments/1f1158d1….png`.
6. `GET /api/worklist` afterward → customer removed (now closed, status=closed,
   assigned_agent_id=NULL).

**DB state after run:**
- DEMO-1002: `status=closed`, no agent assigned, 1 call_log with JSONB details, 1
  pending PTP, 1 payment with photo.
- allocation_logs: 5 rows (4 first allocations, 1 reallocation with reason).

### How to view
1. Start the servers: `cd backend && npm run dev` (in another shell: `cd frontend &&
   npm run dev`).
2. Log in as the dev admin at http://localhost:5173 (phone 9999999999 / Admin@1234).
3. **Allocation page** → Unallocated Queue tab shows demo customers (if seeded).
   Multi-select → assign to an agent → table refreshes.
4. Click the Allocated tab → see assigned customers with their agent tags. Select
   one → "Reallocate" button → pick new agent + mandatory reason → history timeline
   shows both moves.
5. To log a disposition and payment manually: switch to a telecaller account
   (create one via Employees screen, log in). Their worklist shows only their
   customers. Log a disposition via the API (not yet a UI screen — Phase 3 agent
   app gets this). Record a payment with photo via the API. Watch the customer
   disappear from the worklist after close_customer=true.
6. `cd backend && npm test` — 53/53 green (disposition, org, auth, import, and
   new collection-workflow tests all pass).

---

## 2026-07-06 — Tasks 3.4 + 3.5: Flutter mobile app — foundation + agent workflow

**Goal:** brief §8 + §10 — the Android agent app: login with device binding,
today's worklist, click-to-call, disposition logging with dynamic forms,
payment capture with photo proof, and PTP history. Backend Tasks 3.1–3.3 were
re-verified before starting (routes, tests, and web allocation screen all in
place; `npm test` 53/53 green).

### Changes (mobile/ — new Flutter project, Android-only)

**Project setup**
- `flutter create` project `rudrayani_mobile` (Flutter 3.44.3 / Dart 3.12.2),
  Android platform only per the confirmed plan.
- `pubspec.yaml` dependencies: `dio` (HTTP), `flutter_secure_storage` (encrypted
  token persistence), `device_info_plus` (device binding), `go_router`
  (navigation), `flutter_riverpod` (state), `intl` (₹/date formatting),
  `url_launcher` (tel: handoff), `image_picker` (camera/gallery).
- `AndroidManifest.xml`: INTERNET, CALL_PHONE, CAMERA, READ_MEDIA_IMAGES
  permissions + a `tel:` intent query so `canLaunchUrl` works on Android 11+.

**Core (`lib/core/`)**
- `api/api_client.dart` — Dio client pointed at `http://10.0.2.2:3000/api` by
  default (Android-emulator bridge to host; override with
  `--dart-define=API_URL=...`). Interceptor attaches the Bearer token from
  secure storage; on 401 it exchanges the refresh token once via
  `/auth/refresh`, retries the original request, and clears tokens if the
  refresh fails (go_router's guard then lands the user on /login).
- `auth/auth_provider.dart` — `AuthNotifier` (Riverpod StateNotifier): `login()`
  sends phone/password plus `device_id` from `device_info_plus` (brief §10
  device binding); `init()` restores the session from secure storage on app
  start; `logout()` clears tokens. Exposes `isTeamLeader` / `isTelecaller` /
  `isFieldAgent` getters for role-aware UI.
- `models/customer.dart`, `models/disposition_code.dart` — worklist row (incl.
  JSONB custom fields, last disposition, active PTP) and disposition code with
  the `needs_*` flags that drive the dynamic call-log form.
- `router.dart` — GoRouter with an auth redirect guard. Routes: `/login`,
  `/home` (worklist), `/customer/:id`, `/call-log`, `/payment`, `/ptps`;
  customer object passed via `extra` so detail screens render instantly.
- `main.dart` — Material 3 theme seeded with Deep Trust Teal `#00535B` from
  `docs/design-brief.md`; session restore on startup.

**Screens (`lib/features/`)**
- `auth/login_screen.dart` — 10-digit phone + password, loading state, lockout
  and generic error handling.
- `worklist/worklist_screen.dart` — today's allocation with search (name /
  loan number / mobile), pull-to-refresh, per-card last-result code and PTP
  badge (orange when due/overdue), logout confirmation.
- `worklist/customer_detail_screen.dart` — full customer context: loan card
  (loan no., company, product, bucket, due, EMI), custom fields from the
  import template, last disposition, active PTP; 48px action buttons for
  Call / Log Call / Payment / PTPs. **Click-to-call** launches the OS dialer
  via `url_launcher` `tel:` — handoff only, no VoIP (brief §8).
- `call_log/call_log_screen.dart` — disposition picker loaded from
  `/api/dispositions`; the form renders only the fields the selected code's
  `needs_*` flags require (amount/date/time/mode/reason/name-relation), with
  client-side required-field validation, a live composed-remark preview, and
  submit to `POST /api/call-logs` (server composes the final remark from the
  `remark_template` and creates the PTP row when applicable).
- `payment/payment_screen.dart` — amount, mode, date + **photo proof** via
  camera or gallery (`image_picker`, resized to ≤1920px q80), preview +
  remove, "Mark customer as Closed" toggle, multipart upload to
  `POST /api/payments`.
- `ptps/ptps_screen.dart` — the customer's PTP history with status badges
  (pending/kept/broken) and an overdue indicator on past-due pending promises.

### Verification
- `dart analyze lib/` — **No issues found** (fixed 9 warnings along the way:
  unused import, deprecated `value`/`activeColor` Material 3 APIs, string
  interpolation braces, if-block style, BuildContext-across-async-gap).
- Backend re-verification: `cd backend && npm test` — 53/53 green.

### How to view
1. Start the backend (`cd backend && npm run dev`) and an Android emulator.
2. `cd mobile && flutter run` (emulator reaches the host API via 10.0.2.2; on
   a physical device pass `--dart-define=API_URL=http://<your-LAN-IP>:3000`).
3. Log in as the demo telecaller (8888888801 / Admin@1234). The worklist shows
   customers allocated to them (allocate on the web portal first).
4. Tap a customer → Call opens the dialer → Log Call → pick a PTP code → the
   form asks for amount/date/mode → preview → save → worklist refreshes.
5. Record Payment → amount + photo from camera → save; with "Mark as Closed"
   on, the customer drops off the worklist. PTPs screen shows the promise.

---

## 2026-07-06 — Task 4.1: Attendance & location-ping ingestion (backend)

**Goal:** brief §9 + §10 — punch-in/out attendance with GPS points, batch
location-ping ingestion (offline-catch-up friendly), tunable ping interval,
and the 60-day retention purge running in-process.

### Changes (backend)
- **Migration `1783600000000_location-tracking.sql`**
  - `agencies.settings JSONB` — per-agency config blob; the ping interval
    lives here (`ping_interval_seconds`) so it's data, not code (§9: "easy to
    tune later via a config value"). Phase 6 adds the admin screen.
  - `attendance.punch_in_at` now NOT NULL with default `now()` (rows are only
    ever created by a punch-in).
  - **One open shift per user** enforced by a partial unique index
    (`WHERE punch_out_at IS NULL`) — the API's 409 is race-proof.
  - **`(user_id, recorded_at)` unique on `location_pings`** — a re-sent
    offline batch inserts with `ON CONFLICT DO NOTHING`, so catch-up
    re-sends are idempotent (groundwork for Task 4.3 offline mode).
  - New permission `attendance.punch` granted to all five capabilities
    (every employee is tracked punch-in to punch-out, §9).
- **`POST /api/attendance/punch-in`** — body `{lat, lng}`; writes the GPS
  point as PostGIS `GEOGRAPHY(POINT)`; 409 if a shift is already open.
- **`POST /api/attendance/punch-out`** — closes the open shift with its GPS
  point; 409 if none open.
- **`GET /api/attendance/status`** — `{punched_in, attendance}` so a
  restarted phone can resume (or stop) tracking to match the server.
- **`POST /api/location/pings`** — batch of 1–500 pings
  (`recorded_at`/`lat`/`lng`/`accuracy_meters`), single multi-row INSERT,
  duplicates skipped; responds `{received, inserted}`.
- **`GET /api/location/config`** — `{ping_interval_seconds, retention_days}`;
  reads the agency override, defaults to 120s (§9: every 2 minutes).
- **Purge job wired in-process**: `src/jobs/purge-pings.ts` (shared 60-day
  delete) + `src/jobs/scheduler.ts` (node-cron, daily 03:00, started from
  `server.ts` only — never in tests). `npm run purge:pings` still works
  standalone for external cron.
- **13 integration tests** (`test/attendance.test.ts`): punch lifecycle,
  double-punch 409s, GPS round-trip through PostGIS, batch ingest, duplicate
  re-send idempotency, coordinate validation, config default + per-agency
  override. **Suite 66/66 green.**

### How to view
1. `cd backend && npm run migrate:up && npm test` — 66/66.
2. Punch in via API:
   `POST /api/attendance/punch-in` `{"lat":18.52,"lng":73.85}` (agent token) →
   201; repeat → 409. `GET /api/location/config` → `{"ping_interval_seconds":120,"retention_days":60}`.

---

## 2026-07-06 — Task 4.2: Flutter background location tracking

**Goal:** brief §9 — punch-in starts a foreground-service GPS loop that pings
every 2 minutes until punch-out, with the tracking state explicit in the UI
(§10). Flagged in the brief as the riskiest feature (battery/permissions), so
the design keeps the permission story minimal.

### Design choice
- `geolocator` + `flutter_foreground_task` (both free) instead of the paid
  `flutter_background_geolocation`. The service is started **while the app is
  in the foreground** with `foregroundServiceType="location"`, so plain
  while-in-use location permission keeps GPS access in the background — no
  "Allow all the time" settings round-trip for agents.

### Changes (mobile/)
- **`core/tracking/tracking_task.dart`** — the foreground-service isolate:
  every tick (interval from `/api/location/config`) it takes a GPS fix and
  POSTs the batch. Failed sends (offline) stay queued in memory (capped at
  300 ≈ 10 duty hours) and ride along with the next batch — safe because the
  server skips duplicate `(user_id, recorded_at)` rows. Notification text
  shows last-ping time, or queued count when offline.
- **`core/tracking/tracking_service.dart`** — UI-side control: permission
  flow (notification + location, with clear error strings for denied/GPS-off),
  service init (persistent low-priority notification "On duty — location
  tracking active"), start/stop.
- **`core/tracking/attendance_provider.dart`** — punch state
  (StateNotifier): `punchIn()` = permissions → GPS fix → `POST punch-in` →
  fetch interval → start service; `punchOut()` = GPS fix → `POST punch-out` →
  stop service. `init()` reconciles with `GET /attendance/status` on startup
  (open shift + dead service → resume tracking; closed shift + live service →
  stop). 409s adopt the server's view instead of erroring.
- **Worklist duty banner** — green "On duty — location tracking active" with
  punch-in time + red Punch Out button, or grey "Off duty" + teal Punch In
  button (brief §10: explicit, not implicit). Logout stops the service so it
  never outlives the session's tokens.
- **`api_client.dart`** — `buildDio()` exported; the tracking isolate can't
  reach Riverpod, but tokens live in secure storage so the same interceptor
  stack (Bearer + one-shot refresh) works there.
- **AndroidManifest** — `ACCESS_FINE/COARSE_LOCATION`,
  `FOREGROUND_SERVICE_LOCATION`, and the `flutter_foreground_task` service
  declared with `foregroundServiceType="location"`.

### Verification
- `dart analyze lib/` — No issues found.
- `flutter build apk --debug` — builds clean with the new plugins.
- **Real-device testing still pending** (the brief explicitly calls for early
  battery/permission testing on hardware — emulators fake GPS and don't
  exercise OEM battery killers).

### How to view
1. Backend + emulator up, `cd mobile && flutter run`.
2. Log in as the field agent (8888888802 / Admin@1234) → worklist shows the
   grey "Off duty" banner → Punch In → grant notification + location →
   banner turns green, a persistent notification appears.
3. Emulator: Extended controls → Location → set a point/route. Every 2 min a
   ping lands in `location_pings` (watch in Adminer, or
   `SELECT count(*) FROM location_pings`).
4. Airplane-mode the emulator for a few ticks → notification shows "N ping(s)
   queued" → reconnect → next tick flushes the queue, no duplicate rows.
5. Punch Out → banner grey, notification gone, `attendance` row closed.

---

## 2026-07-06 — Task 4.5 (pulled forward): Web live tracking, route replay, stationary alerts

**Goal:** brief §9 — managers see where field agents are live, replay the
day's route as a highlighted path, and get alerted when an agent sits at one
location too long (new requirement: > 20 minutes). Verified the permission
model along the way.

### Changes (backend)
- **Migration `1783700000000_tracking-view.sql`** — permission
  `tracking.view` granted to `agency_admin`, `operations_manager`,
  `team_leader` (agents excluded).
- **`GET /api/tracking/live`** — every on-duty user in scope with their
  latest ping and an actionable status:
  - `moving` · `stationary` (inside 100 m of the current spot for ≥ 20 min;
    both thresholds overridable per agency via `agencies.settings`) ·
    `no_signal` (last ping > 10 min old — app killed / GPS off / no network,
    a different problem than standing still) · `awaiting_first_ping`.
  - `stationary_since` is the first ping of the *current dwell* (only pings
    since punch-in count, so yesterday's parking spot can't trigger it).
  - Response includes an `alerts` array (stationary + no_signal).
- **`GET /api/tracking/route?user_id&date`** — the day's ordered pings
  (day boundaries in IST, not server timezone), total path length via
  PostGIS `ST_MakeLine`/`ST_Length`, and that day's shifts. Scope-checked:
  404 for users outside the caller's scope or agency.
- **Scoping** (brief §3): Agency Admin / Ops Manager → whole agency;
  Team Leader → own team only (a TL with no team sees nothing, not
  everything); agents → 403.
- **16 integration tests** (`test/tracking.test.ts`), including a
  **permission audit**: agency_admin holds *every* permission in the
  catalog, operations_manager everything except `ops_managers.create` +
  `billing.view` — a regression net for future migrations that forget
  grants. Suite **82/82 green**.

### Changes (frontend)
- `leaflet` + `react-leaflet@4` (React-18 compatible), OSM tiles (free, per
  the brief's map-provider decision).
- **`TrackingPage.tsx`** (menu item "Tracking", visible only with
  `tracking.view`):
  - **Live Map tab** — auto-refresh every 30 s; colored dot per agent
    (green moving, red stationary, orange no-signal); red **alert banners**
    ("X has been at one location for N minutes…") and an on-duty table with
    status tags, last-ping and punch-in times.
  - **Route Replay tab** — employee + date (limited to the 60-day retention
    window) → the day's path drawn as a teal polyline with per-ping dots
    (timestamps on hover), Start/End markers, ping count and km total.
    A pure Team Leader's employee dropdown is pre-filtered to their team,
    mirroring the server's scope.

### Verification (all run)
- `npm test` — 82/82, including scoping, stationary/no-signal/first-ping
  edge cases, IST date handling, empty-day routes, malformed dates, and the
  cross-agency leak checks.
- Playwright against live servers: logged in as admin → Tracking → the
  seeded demo agent (Rahul Verma) shows a red "stationary 28 min" alert on
  the live map; Route Replay draws his seeded 2.48 km route (screenshots
  under the job tmp dir).

### How to view
1. `cd backend && npm run dev` + `cd frontend && npm run dev`.
2. Log in as admin (9999999999 / Admin@1234) → **Tracking** in the sidebar.
3. Live Map shows anyone punched in (demo data seeded for Rahul Verma —
   his pings have gone stale by now, so he demos the *no-signal* alert).
4. Route Replay → pick Rahul Verma + today → highlighted path with
   start/end markers and distance.
5. Log in as a TL → only their team is visible; as a telecaller/field agent
   the Tracking menu item is absent and the API returns 403.

---

## 2026-07-06 — Tracking alerts made app-wide (bell + toasts + consolidated list)

**Goal:** alerts must follow the manager to every screen, not just the
Tracking page, and multiple alerting agents must read as one list.

### Changes (frontend)
- **`components/AlertsBell.tsx`** — header bell (every portal screen, users
  with `tracking.view` only): polls `/tracking/live` every 30 s, badge shows
  the alert count, clicking opens a list of alerting agents by name
  (Stationary N min / No signal since HH:mm, team name) — any row jumps to
  the live map. Newly appearing alerts also pop a toast with an "Open live
  map" button; an agent who resumes moving and stalls again re-alerts.
- **Live Map tab** — the per-agent banners became one consolidated alert
  panel: "N tracking alerts — stationary threshold 20 min" with a bulleted
  agent list.

### Verification (Playwright, live servers)
- Seeded a second stationary agent (Priya). On the **Dashboard** (not the
  tracking screen): badge = 2, toasts for both agents, bell popover lists
  "Priya Sharma — Stationary 29 min" and "Rahul Verma — No signal, last ping
  12:16". Clicking through lands on Tracking with the consolidated 2-alert
  list and both markers on the map.

---

## 2026-07-06 — Fix: stationary alert applies to field agents only

A telecaller works a desk all day — "at one location for 20+ minutes" is
their job, not a problem. `/api/tracking/live` now computes the stationary
dwell only for users with the `field_agent` capability; telecallers (and
other desk roles) on duty stay "moving". **No-signal alerts still apply to
everyone punched in** — a tracker that stopped reporting matters regardless
of role. New regression test: a telecaller parked 28 minutes never alerts
(17/17 tracking tests green).

---

## 2026-07-06 — Task 4.3: Offline mode (durable queue + idempotent sync)

**Goal:** brief §8 — "queue actions locally, sync when connectivity returns",
without ever double-recording a call log or (worse) a payment.

### Changes (backend) — idempotency keys
- **Migration `1783800000000_offline-idempotency.sql`** — `client_key UUID`
  on `call_logs` and `payments`, unique per author
  (`(agent_id, client_key)` / `(collected_by_user_id, client_key)`).
- `POST /api/call-logs` and `POST /api/payments` accept an optional
  `client_key`. A re-send with a known key returns the **existing** row
  (200 + `duplicate: true`) instead of creating another; a race between two
  retries is caught via the unique index (23505 → re-select). For payments
  the duplicate check runs **before** the photo is stored, so re-sends don't
  orphan photo copies. Requests without a key behave exactly as before.
- **6 idempotency tests** (`test/offline-idempotency.test.ts`) — suite
  **88/88 green**.

### Changes (mobile)
- New packages: `hive`/`hive_flutter` (durable queue), `connectivity_plus`
  (reconnect trigger), `uuid` (client keys), `path_provider` (photo copies).
- **`core/offline/offline_queue.dart`** — Hive-backed FIFO of queued call
  logs and payments. Flush runs on app start, on every connectivity-restored
  event, and on demand. Network failure mid-flush stops (still offline);
  a permanent server rejection (validation, closed customer) **drops that
  item and surfaces the reason** so one bad record can't block the queue.
- **Submit flows** — the client key is generated **once per submit** and
  used for both the direct POST and the queued copy, so a request whose
  response was lost can't double-record. On a connectivity error the action
  is queued and the agent sees an orange "saved offline, will sync
  automatically" confirmation instead of an error.
- **Payment photos** — copied out of the image_picker cache (which Android
  may clear) into the app documents dir while queued; deleted after sync.
- **Worklist sync banner** — "N action(s) waiting to sync" with a Sync-now
  button while pending; rejection messages show in red with Dismiss.
- **Ping queue made durable** — the tracking isolate now persists unsent
  pings in its own Hive box (`pending_pings`, never touched by the UI
  isolate); they survive punch-out, app kills, and reboots, and go out with
  the first ping of the next shift. Server-side dedupe on
  `(user_id, recorded_at)` was already in place from Task 4.1.

### Verification
- Backend: `npm test` — 88/88 (re-send with same key → 200 duplicate, single
  row for both call logs and payments; PTP not duplicated; keyless requests
  unaffected).
- Mobile: `dart analyze lib/` — no issues; `flutter build apk --debug` green.
- Manual airplane-mode walk-through on a device/emulator still recommended:
  log a disposition + payment offline → orange banners + "2 actions waiting
  to sync" → reconnect → banner clears, exactly one row each server-side.

---

## 2026-07-06 — Task 4.4: Field extras + Team Leader mobile view

**Goal:** brief §8 — field-visit evidence (photo + customer signature),
navigate-to-address, and the TL toggle view (team live status, attendance,
performance, reallocation approvals).

### Changes (backend)
- **Migration `1783900000000_field-visits-reallocation.sql`** —
  `field_visits` (photo/signature keys, optional GPS point, `client_key`
  for offline idempotency) and `reallocation_requests` (reason, status,
  decider, decision note; **one pending request per customer** enforced by a
  partial unique index).
- **`/api/field-visits`** (permission `calls.log`) — POST multipart
  photo + signature through the StorageProvider (at least one required),
  offline-idempotent via `client_key`; GET history per customer; streaming
  endpoints for photo and signature (agency-scoped, never raw paths).
- **`/api/reallocation-requests`** — POST (agents, own-assigned customers
  only; duplicate pending → 409); GET pending/history (needs
  `customers.allocate`); POST `/:id/decide` — approve reassigns (writing
  `allocation_logs` like any reallocation) or returns the customer to the
  unallocated pool when no new agent is chosen; reject just closes it.
  Deciding twice → 409.
- **`GET /api/tracking/team-day`** — per team member for a date (IST):
  shifts, minutes worked, on-duty flag, calls, PTPs, payments count + total.
  Same scope rules as tracking (TL → own team).
- **15 new tests** (`test/field-workflow.test.ts`) — suite **102/102 green**.

### Changes (mobile)
- **Customer detail** — new Field Visit + **Navigate** buttons (finds the
  first address-like column among the imported custom fields and opens the
  maps app via `geo:`), and a Request Reallocation menu action (reason
  dialog; friendly 409 message when one is already pending).
- **`field_visit_screen.dart`** — visit photo (camera/gallery), customer
  **signature pad** (`signature` package → PNG), optional remark, best-effort
  GPS point; submits multipart, and **works offline** — photo and signature
  are persisted to app documents and queued with the same client_key.
- **TL toggle view** (brief §3/§10 role-aware landing): Team Leaders land on
  a two-tab shell — **My Worklist / My Team**. The Team tab shows pending
  reallocation approvals (approve → bottom sheet: return-to-pool or pick a
  team member; reject) and each member's day: duty chip (On duty /
  Stationary N min / No signal / Off duty), hours worked, calls, PTPs,
  payments with ₹ total, last ping time. Agents see no change.
- Manifest: `geo:` intent query for the maps handoff.

### Verification
- Backend `npm test` — 102/102 (visit uploads + streaming, own-customer
  guard, duplicate-pending 409, approve-reassign writes allocation log,
  approve-to-pool unassigns, double-decide 409, team-day scope + numbers).
- Mobile: `dart analyze lib/` — no issues; `flutter build apk --debug` green.

### How to view
1. Backend + emulator; log in as the field agent (8888888802) → open a
   customer → **Field Visit** → photo + sign + save; **Navigate** opens maps
   if the customer has an imported address column; ⋮ → Request Reallocation.
2. Log in as a TL (create one via Employees, or grant the demo user
   `is_team_leader`) → bottom tabs appear → **My Team** shows the pending
   request → Approve → pick an agent or return to pool → the customer moves
   (verify on the web Allocation page's history timeline).

---

## 2026-07-06 — Phase 5 (Tasks 5.1–5.8): Performance Dashboard, Targets, Monthly Allocations

**Goal:** the full dashboard blueprint from `web dashboard view/*.png` —
Resolution / Rollback / Normalization / Recovery gauges vs targets, daily run
rate, Deposited + Trail cards, monthly overview chart — with maximally
granular filters, filtered Excel export, role-scoped visibility, and a mobile
"My Performance" view. Plus the mobile-login fix and signature removal.

### 5.1 Buckets master
`buckets` table per company (label, sort_order, category normal|npa,
is_current) — metric math needs bucket ORDER and flags, and labels differ per
company. Labels auto-register on every import; BucketsPage (under
companies.manage) reorders and flags them. One is_current bucket per company
enforced.

### 5.2 Monthly allocation imports + snapshots
`customer_month_snapshots` = the month's allocated book (bucket, POS, EMI,
agent at import). Import wizard gained a **Monthly allocation** mode + month
picker: existing loans are UPDATED (file authoritative; blanks keep old
values), new loans insert, a snapshot row is upserted per (customer, month) —
re-uploading a corrected file replaces the month. New `agent_phone` mapping
column assigns/reassigns loans (allocation_logs audit; unknown phones are
warnings). Preview shows updates + "N active loans missing from this file".

### 5.3 Targets
`targets`: month × metric (collection/resolution/rollback/normalization/
recovery) × scope (agency/branch/team/agent) with optional company/product/
bucket slices; unique per dimension combo. `targets.manage` (admin/ops).
TargetsPage: month + scope-level grid, Amount/Count toggle, Excel import
(branch/team by name, agent by phone). Resolution rule: most specific row at
the effective scope wins; a missing level falls back to the SUM of
child-scope rows (never mixes levels).

### 5.4 Deposits
`payments.deposited_at/deposited_by_user_id` + `payments.deposit` permission.
DepositsPage: pending/deposited filter, bulk "Mark deposited" (idempotent,
agency-scoped). Feeds the dashboard's Deposited Metrics card.

### 5.5 Report engine (backend/src/services/report-service.ts)
- Metric classification per account, **two bases** (response says which):
  transition (once month M+1's file exists): resolution = didn't flow
  forward (closed = resolved; dropped-from-file = excluded), rollback =
  strictly back but not current, normalization = landed in is_current.
  payments proxy (live MTD): resolution = paid ≥ 1 EMI, rollback = ≥ 1 EMI
  but < arrears, normalization = paid full arrears.
  Recovery is always ₹ collected on NPA-bucket accounts vs the NPA POS base.
- Trail = accounts with ≥1 call log or field visit in month. IST windows.
- Attribution: book = snapshot's agent; money = collected_by_user_id.
- Scope clamps: admin/ops agency; TL own team; everyone else self —
  new `reports.view_self` permission for all capabilities (mobile).
- `GET /api/reports/dashboard | /overview?months=3|all | /agents | /export`
  (two-sheet exceljs workbook honoring the active filters).
- `npm run seed:payments -- file.xlsx` loads sample payment Excel files.

### 5.6 Web dashboard (frontend/src/components/dashboard/)
DashboardPage rebuilt to the blueprint: product tabs, month picker, bucket/
company/branch/team/agent filters (auto-hidden when the server clamps),
Amount/Count toggle, Days-Left chip, collection strip, dark MetricTabsCard
with a custom SVG gauge ("Your MTD (x%)", dashed target arc, away-note),
MetricPanel cards (Allocated/Target/Target %/MTD/MTD % + run rate with NA),
Deposited + Trail cards, @ant-design/plots Column overview with View All,
Export button (blob download). Dashboard route lazy-loads so the chart
runtime stays out of the login bundle.

### 5.7 Mobile
- **Login fix:** api_client default was `10.0.2.2:3000` but the backend runs
  on **4000** — every emulator login failed with a generic error. Now 4000.
- PerformanceScreen (self-scoped /reports/dashboard): collection vs target
  progress + required-per-day, my-book and trail cards, per-metric rows.
- HomeShell: agents = My Worklist / My Performance; TL = + My Team.

### 5.8 Cleanups
- Customer **signature removed entirely** from field visits (photo is the
  required evidence); `signature` package dropped; offline queue tolerates
  old queued items that still carry a signature_path. Backend column stays
  dormant.
- `npm run seed:demo`: idempotent Demo Branch/Team + telecaller 8888888801,
  field agent 8888888802, team leader 8888888803, ops manager 8888888804
  (password Admin@1234). TEST_CREDENTIALS.md (gitignored) corrected.

### Verification
- Backend `npm test` — **140/140** (buckets 7, allocation-import 9,
  targets 7, deposits 4, reports 11 incl. IST month-edge payments,
  transition vs proxy classification, target fallback summing, TL/self
  clamps, xlsx export).
- Frontend `tsc --noEmit` + `vite build` green (dashboard chunk split).
- Mobile `dart analyze` clean; debug APK builds.

### Data contract (sample files the user will provide, 3 months)
1. **Allocation `allocation_YYYY_MM.xlsx`** — Loan Number*, Customer Name*,
   Mobile Number, Product, Bucket*, POS Amount*, EMI*, Agent Phone. Keep
   product/bucket spellings identical across months; move 15–25% of loans
   between buckets month-to-month; some NPA loans; ~5% drop out / ~5% new.
2. **Payments `payments_YYYY_MM.xlsx`** (loaded via seed:payments) — Loan
   Number*, Amount*, Paid At* (IST), Mode, Collected By Phone*, Deposited
   (Y/N). Mix: < EMI, = EMI, ≥ full POS, some against NPA loans.
3. **Targets** (optional, Excel import or UI) — Month (YYYY-MM), Metric,
   Scope Type, Scope Name/Phone, Company?, Product?, Bucket?, Target
   Amount, Target Count.

### How to view
1. `npm run seed:demo` → log in as admin → **Buckets**: order + flag NPA/
   Current for the company → **Import**: Monthly allocation mode, pick month,
   map columns (incl. Agent Phone) → commit for 3 consecutive months.
2. `npm run seed:payments -- payments_2026_04.xlsx` (etc.) for each month.
3. **Targets**: set agent/branch/agency targets for those months.
4. **Dashboard**: past months show transition-based metrics, the current
   month shows the payments basis (info tooltip says which); flip Amount/
   Count, drill every filter, **Export** and check the xlsx mirrors the view.
5. Mobile: log in as Rahul (8888888802) → **My Performance** shows his own
   collection vs target.

---

## 2026-07-07 — Phase 7 (Tasks 7.1–7.8): Allocation Lifecycle, Discrepancy Review, Customer 360, Granular Reporting

**Why:** allocation files stopped arriving once a month — companies now send
a **refreshed full list mid-month**, adding and pulling back customers.
Before this phase the import engine only warned about active loans missing
from a file; nothing was flagged, persisted, or reviewable, and a lender
pull-back was indistinguishable from a customer paying off. This phase adds
the review layer, a customer 360 view, lender-independent bucket-movement
signals, and the granular reporting cuts the owner needs to run the book with
confidence instead of guesswork.

### 7.1 Schema
`customers.status` gains **`recalled`** (+ `recalled_at`) — distinct from
`closed` so billing/reporting never conflate "lender withdrew the case" with
"customer paid off". New `import_review_items` (the discrepancy queue: type
addition/removal/reactivation, payload, pending/approved/rejected/superseded).
`import_runs` gains `pending_review_rows`, `removal_rows`, `new_buckets`,
`new_products`. `import_templates.detail_fields` (customer-detail column
selection). `buckets.canonical_bucket` (0=X/current, 1=30 DPD, 2=60 DPD, …).
New `bucket_movements` event log (payment-detected vs allocation-confirmed,
partial unique index dedupes payment events per customer-month). New
`imports.review` permission (agency_admin + operations_manager only).

### 7.2 Diff engine (backend/src/services/import-service.ts)
`computeAllocationDiff` matches file rows to the active book by
case/whitespace-normalized loan number: **additions** (no existing
customer), **updates** (existing active — applies directly, unchanged),
**reactivations** (existing recalled/closed — can't blind-update status),
**removals** (active customers missing from the file). First allocation
import of a month inserts additions directly (expected new book); every
mid-month refresh routes additions to review too — reactivations and
removals always go to review, regardless of month. A fresher file supersedes
older pending items **for that month only** (scoped by `allocation_month`,
not company-wide, so an unrelated month's import can never silently discard
a still-open review). `deriveProducts`/`deriveBuckets` now return the
genuinely-new labels for the run to surface. Verified end-to-end against the
real "Hero Fincorp allocations july.xlsx": a modified re-import (10 loans
dropped, 3 fabricated ones added) produced exactly 3 pending additions + 10
pending removals, zero rows applied without review.

### 7.3 Review API + queue UI
`backend/src/routes/import-reviews.ts` (list/detail-with-context/decision/
bulk-decision, gated on `imports.review`): approving an addition inserts the
customer + writes its month snapshot; approving a removal recalls the
customer; approving a reactivation restores active status while applying the
file's data. Deciding twice, or deciding on a superseded item, is a 409.
`ImportReviewPage` (filterable, row + bulk approve/reject, payload +
trail/PTP/payment context on expand); the import wizard's preview/done steps
show the real diff and link straight to the queue when anything's pending.

### 7.4 Customer 360 (backend/src/routes/customers.ts)
`GET /customers/:id`: identity, the source columns the agency chose to keep
as "detail" fields at import time (from the company's most-recently-touched
active template — version numbers can't be compared across differently-named
templates, so `updated_at` decides "latest"), and every trail of activity —
calls, PTPs, payments, bucket movements, allocation history, month snapshots.
Scope is a 404 (not 403) for agents opening a customer not assigned to them,
so the check never leaks whether an out-of-scope loan number exists.
`CustomerDetailDrawer` renders it (missing detail values as "-"); wired from
CustomersPage, which also gains a status filter/column for `recalled`.

### 7.5 Canonical buckets + movement detection
`backend/src/services/bucket-movement-service.ts`: payment-driven detection
(canonical_bucket × emi, falling back to due_amount) records an
informational event when a customer's payments this month cover their
arrears — `customers.bucket` is never touched, the lender's file stays
authoritative. Allocation-confirmed detection compares an updated customer's
bucket to their prior month's snapshot (ranked by canonical_bucket, falling
back to sort_order) and records a confirmation when it dropped or landed on
the current bucket. BucketsPage gets an editable canonical-bucket column
with an "Unmapped" warning; setting canonical 0 also marks the bucket
current, since they encode the same fact.

### 7.6 Report engine extensions (backend/src/services/report-service.ts)
`GET /reports/breakdown?dimension=company|product|bucket|branch|team|agent`
generalizes the existing classification CTE to every axis — the "product
wise view" the dashboard mockup calls for. Targets/achievement only apply to
organizational dimensions; product/bucket are narrowing filters in the
targets model, not their own scope level, so those rows carry a null target
rather than a misleading one. New `GET /reports/trail` (date-range
action/result-code counts, PTP conversion), `/reports/recalls` (recalled
counts/amounts, separate from closed), `/reports/bucket-movements`
(payment-detected vs allocation-confirmed per bucket — "detected not
confirmed" is the owner-level watch item). A `status` filter is now
available across the snapshot-based reports. `/reports/export` gains
Breakdown/Trail/Recalls/Bucket Movements sheets. Every new number was
hand-reconciled against the existing May/June test fixture, not just trusted
from a fixture round-trip.

### 7.7 Dashboard wiring
`BreakdownTable` (dimension selector, achievement progress bars),
`TrailAnalyticsCard` (result-code chart + PTP stat tiles, date range
defaulting to the selected month), `RecalledStatTile` (drill-down modal),
`BucketMovementCard`. Manually driving the new endpoints against a live
server (not just the test suite) caught a real bug: `recallReport`'s
lifetime-count query reused the byCompany query's parameter numbering,
500ing whenever `company_id` was passed — a path the original test never hit
over HTTP. Fixed with its own independent param array + a regression test.

### 7.8 Hardening
Payments are now blocked on `recalled` customers (mirrors the existing
`closed` guard) — a lender pull-back means there's nothing left to collect
through this agency. Approving a removal now also clears the agent
assignment (mirrors how closing a customer already does), so a recalled case
never lingers as "assigned" even though every current query already filters
`status='active'` first. Swept every `status`-based query in the codebase —
all of them use explicit `= 'active'` equality (never a `!= 'closed'`
negation), so `recalled` was automatically excluded everywhere it should be
without further changes. `seed:demo` now seeds a full allocation lifecycle
(first-of-month import → mid-month refresh leaving 1 addition + 1 removal
pending in Import Review, canonical bucket mappings, a payment-driven
movement event, one already-recalled customer) — idempotent, using
`commitImport`/`detectPaymentNormalization` directly rather than duplicating
their logic. Caught and fixed a real idempotency bug in the process: the new
company lookup relied on `ON CONFLICT DO NOTHING`, but `companies` has no
unique constraint on `(agency_id, name)` (the same latent issue already
present in the pre-existing branches/teams seeding), so every re-run created
a duplicate "Demo Finance Co" — fixed with a select-first pattern.

### Verification
Backend `npm test` — **177/177** across 18 files (up from 140 at the start
of this phase): allocation-import (13, incl. supersede-scoping and
case-insensitive loan matching), import-review (8), customer-detail (6),
bucket-movements (8, incl. the recalled-payment guard), reports (23, incl.
hand-reconciled breakdown/branch/team totals and the recall-report param-bug
regression). `tsc --noEmit` and `vite build` green on both. Real-file
verification against `Hero Fincorp allocations july.xlsx` (Task 7.2) and a
live server smoke-test of every new report endpoint (Task 7.7) — the latter
is what caught the recalls param bug that no unit test exercised.

### How to view
1. `npm run seed:demo` → log in as admin → **Import Review**: 2 pending
   items (1 addition, 1 removal) for "Demo Finance Co" this month — approve/
   reject either and watch the customer list update.
2. **Buckets**: "Demo Finance Co" already has canonical buckets mapped
   (X=0, 1=1, 2=2); DEMO-002 already has a payment-driven movement event.
3. **Customers**: open DEMO-000 (recalled) or any Demo Finance Co customer —
   the drawer shows detail fields, trail, PTPs, payments, movements,
   allocation history, and snapshots.
4. **Dashboard**: Breakdown table (switch dimension), Trail Analytics
   (date-range chart + PTP conversion), Recalled tile (click for the
   drill-down), Bucket Movements card — all filter-aware, all exportable.

---

## 2026-07-07 — Phase 7 correction round: owner feedback on real-world collection-agency practice

**Why:** after Phase 7 shipped, the owner reviewed it with fresh eyes and
flagged five things: (1) "mid-month" sounded like a calendar-day rule when
it isn't one, (2) buckets should be cross-checked against EMI due dates like
a real collection agency does, not taken 100% on faith from the lender file,
(3) field agents/telecallers needed the same capability on mobile, (4) the
recalled-customer report needed a real downloadable list, not just a count,
and (5) the test coverage needed genuinely realistic multi-company,
multi-month data, not just single-scenario unit fixtures. Six groups of
work, each independently committed and verified.

### Terminology: "mid-month" → accurate naming
`isMidMonthImport()` never checked a calendar day anywhere — it purely asked
"does a prior allocation import already exist for this company+month."
Allocation files can arrive at any point in the month, so the logic was
already right but the name implied a date check that never existed. Renamed
throughout: `isMidMonthImport` → `hasExistingAllocationForMonth`,
`is_mid_month` → `is_repeat_import`; reworded the import wizard/review queue
UI copy and test comments to match. Pure rename — full suite unchanged.

### DPD cross-check (EMI due date vs. lender bucket)
Buckets had been 100% lender-supplied with no independent aging calculation
— matching the original brief, not standard collection-agency practice
(EMIs fall due on different days of the month, and buckets are
conventionally derived from that). Added a new mappable `emi_due_date`
system field → `customers.due_date` / `customer_month_snapshots.due_date`.
New `GET /reports/bucket-mismatches` (live, as-of-today, not month-scoped —
a mismatch is a right-now fact): computes DPD = today − due_date using the
standard 30-day-increment convention (0-29=X, 30-59=1, 60-89=2, …) and flags
disagreement with the lender's canonical bucket. **Informational only** —
`customers.bucket` is never touched, same as `bucket_movements`. New
dashboard card + export sheet; due_date/DPD shown on the customer drawer.

Fixed a real, broadly-impactful bug this feature's own tests surfaced:
node-postgres's default `DATE` parser builds a JS `Date` at LOCAL midnight,
and serializing it (`res.json`, `JSON.stringify`) converts to UTC — silently
rolling the date back a day in any timezone ahead of UTC (IST included).
This affected every `DATE` column in the schema (`due_date`,
`allocation_month`, `month`, `promised_date`), not just the new one. Fixed
with a global type-parser override in `db.ts` returning the raw
`'YYYY-MM-DD'` string; confirmed via code search that no application code
anywhere relied on these values being actual `Date` objects.

### Mobile (Flutter): a real bug fix + Phase 7 parity
Found and fixed a severe, **pre-existing** bug while verifying "action
code/result code/remarks" worked end-to-end as required: `worklist_provider.dart`
fetched `GET /dispositions` expecting a `'codes'` JSON key, but the backend
responds with `'disposition_codes'` — a cast error at runtime that silently
broke the call-log disposition dropdown for every field agent and
telecaller. The rest of the pipeline (dynamic `needs_*` fields, remark
composition, PTP auto-creation, offline idempotency) was already correct;
only this one wrong key blocked it from mobile entirely. `Customer` model
gains `status`/`recalledAt`/`normalizedPending`; the "normalized, pending
lender confirmation" badge now shows on both the worklist card and the
customer detail screen, mirroring the web drawer.

### Recalled-customer report: a real downloadable list
`recallReport()` gains a per-customer array (loan number, name, recalled
date, last known bucket/due amount, last assigned agent — resolved from
`allocation_logs`, since the assignment itself is cleared at recall time)
alongside the existing by-company summary. New "Recalled Customers" sheet in
`/reports/export`; the dashboard's recalled-cases modal gets a tabbed view
(Customer List / By Company).

### Realistic multi-company, multi-month test fixtures + end-to-end test
Two synthetic companies with deliberately different column layouts (mirrors
how real lenders never agree on a schema): "Alpha Finance NBFC" (Hero-style:
`loan_agreement_no, customername, Bkt, PROD, pos, emi_amount`) and "Beta
Credit Corp" (Indifi-style: `App Id, Promoter Name, Updated Bucket, POS,
EMI`), each with a real three-file reporting cycle (first-of-month, then two
repeat/refresh imports for that month) plus a genuinely later calendar
month. `backend/test/fixtures/build-scenarios.ts` is the single source of
truth, used both by `generate.ts` (writes tracked `.xlsx` files under
`backend/test/fixtures/` for manual QA/demo through the actual Import
wizard — see that folder's README) and by
`backend/test/e2e-allocation-lifecycle.test.ts` (drives the same scenario
through the real HTTP API), so the demo files and the automated coverage
can never silently drift apart.

The end-to-end test covers: first-of-month vs. repeat-import addition
routing, a removal and an addition waiting in Import Review, a reactivation
of a recalled loan, canonical bucket mapping across two entirely different
label schemes, the DPD cross-check catching a deliberate mismatch on each
company, allocation-confirmed bucket movement events on real drops (and
confirming a rollback never produces one), a payment-driven movement event
independent of any import, dimension breakdown reconciling against the
dashboard's headline total, and the recalled-customer report + full export
workbook listing a genuinely-recalled customer with its last agent resolved
from allocation history. Caught one bug in the test's own first draft:
`recalled_at` is the real wall-clock approval time, not the allocation
month the review belonged to — fixed to query the actual current month,
which is the correct real-world behavior.

### Hardening
Payments blocked on `recalled` customers (mirrors the existing `closed`
guard — nothing left to collect through this agency once the lender pulls a
case). Approving a removal now also clears the agent assignment, mirroring
how closing a customer already does. Swept every `status`-based query in
the codebase: all use explicit `= 'active'` equality, never a `!= 'closed'`
negation, so `recalled` was automatically excluded everywhere it should be.

### Verification
Backend `npm test` — **198/198** across 20 files (up from 178 before this
round). `tsc --noEmit` + `npm run lint` clean on backend (one pre-existing,
unrelated lint error in `buckets.test.ts`, confirmed untouched by this work).
Frontend `tsc -b` + `vite build` clean. Mobile `flutter analyze` clean (the
one pre-existing `test/widget_test.dart` issue, also confirmed unrelated —
Android licenses aren't accepted in this environment so a debug APK build
wasn't possible here). Live-server verification against a real database (uploading a real file with
an EMI due date column, committing it, and reading `due_date` back over
HTTP) confirmed the DATE-parser fix end-to-end, not just in the test
runner — reinforcing that the test suite passing is necessary but not
sufficient on its own; the mobile disposition-key bug was likewise only
caught by reading the actual runtime data flow, not by an existing test.

---

## 2026-08-19 — Agent branch/bucket worklist filter + same-day remark edit

**Why:** two independent asks from the field: agents working a large book
wanted to narrow "Today's Work" down to a branch or bucket instead of
scrolling the whole list, and agents kept discovering typos in their own
call/visit remarks minutes after logging them with no way to fix them short
of a manager-approved correction request — overkill for a same-day typo.

### Backend
- **Migration `1788900000000_call-log-field-visit-edit-columns.sql`** —
  `call_logs.extra_remark` (free-text tail kept separate from the
  disposition-composed remark) + `edited_at` on both `call_logs` and
  `field_visits`.
- **`PATCH /api/call-logs/:id/remark`** and **`PATCH /api/field-visits/:id/remark`**
  — owner-only, rolling 24h window from `created_at`, and scoped to
  free text only: a call log's `extra_remark` field never touches the
  disposition-composed `remark`, action/result codes, or structured
  `details` JSONB; a field visit's `remark` is the only field it accepts.
  Past the 24h window, both return 409 pointing at the existing
  correction-request flow.
- **Migration `1789000000000_correction-requests-field-visit.sql`** +
  `correction-requests.ts` — extended the existing payment/call_log/PTP
  correction-request record types to cover `field_visit`, so an out-of-window
  remark fix still has an approval path (unchanged for the other three types).
- **`GET /api/customers/:id`** and the report-service agent-activity feed
  now expose `agent_id`, `extra_remark`, and `edited_at` on call log and
  field visit trail entries — what the UI needs to decide whether "Edit
  remark" (owner + in-window) or "Report an error" (everyone else / out of
  window) should show.
- **`GET /api/worklist`** — `customer_branch` and `bucket` query params now
  accept comma-separated multi-value lists (previously single-value only).
  New **`GET /api/worklist/filter-options`** returns the distinct
  branch/bucket values across the *calling agent's own* allocated customers
  (or their team's, with `?scope=team`) — deliberately narrower than the
  agency-wide branch/bucket admin lists, since an agent only ever needs to
  filter within what they can already see.
- **14 new/extended tests** (`call-log-remark-edit.test.ts`,
  `field-visit-remark-edit.test.ts`, `worklist-filters.test.ts`, extended
  `correction-requests.test.ts`) — owner-edit happy path, non-owner
  rejection (404), rejection once past the 24h window (409), a PTP call log
  whose `disposition_code_id`/`details`/linked `ptps` row are asserted
  unchanged by a remark-only edit, multi-value filter combinations, and
  (added in the final review pass, closing the bug below) `filter-options`
  and the main list route both succeeding for a branch_manager on
  `scope=team`.

### Web
- **`MyWorklistPage.tsx`** — branch and bucket filters became Ant Design
  multi-select dropdowns, options loaded from `/worklist/filter-options`;
  selection persists across reload via `localStorage`. Fixed a load-time
  race along the way: the page had been firing one unfiltered `/worklist`
  request before the persisted selection re-applied, momentarily flashing
  the full list.
- **`EditRemarkModal.tsx`** (new) + **`CustomerDetailDrawer.tsx`** — the
  history timeline now shows an "Edit remark" pencil (owner, within 24h) or
  the existing "Report an error" flag (`ReportCorrectionModal.tsx`, now also
  offered for field visits), never both on the same entry. An `edited_at`
  badge marks rows that have been directly edited.

### Mobile
- **`worklist_filter_store.dart`** (new) — Hive-backed persistence of the
  selected branches/buckets per user, restored on app restart the same way
  the offline read cache and action queue already persist across sessions.
  `worklist_provider.dart` gained the matching `customer_branch`/`bucket`
  query params and a `filter-options` provider scoped the same way as web.
- **`worklist_screen.dart`** — bucket filtering moved from a client-side
  single-select dropdown (filtering whatever page of customers happened to
  be loaded) to server-side multi-select `FilterChip` rows fed by
  `filter-options`, matching the web behavior. Getting this right took two
  follow-up fixes: an unfiltered-fetch race on first load mirroring the web
  one (the screen now gates its first `worklistProvider` watch behind
  loading the persisted selection from Hive, with a 3s timeout safety valve
  since `AuthNotifier.init()` doesn't guarantee `user` is populated by
  `initState`), and an offline-cache-key collision (`branches.join('_')`
  could map two different filter selections onto the same cache key
  whenever a name itself contained an underscore — fixed with two distinct
  control-character separators, one between names within a list and one
  between the scope/branches/buckets segments).
- **`edit_remark_dialog.dart`** (new) — mobile counterpart to
  `EditRemarkModal.tsx`; `history_timeline.dart` picks it over
  `correction_request_dialog.dart` under the same owner+in-window rule as
  web. `correction_request_dialog.dart` extended to accept `field_visit`.

### Verification
- Backend: `npm run typecheck` clean (2 pre-existing unrelated errors in
  `e2e-allocation-lifecycle.test.ts`/`reports.test.ts`, confirmed unchanged
  by this work via `git diff main`); `npm run lint` clean in every file this
  plan touched (3 pre-existing errors elsewhere, likewise confirmed
  untouched); `npm test` — the known, pre-existing baseline of 24/32 test
  files failing on an unrelated `designation` not-null constraint (predates
  this plan) plus `reports.test.ts`'s one known-unrelated assertion; every
  file this plan added or touched (`call-log-remark-edit`,
  `field-visit-remark-edit`, `worklist-filters`, `correction-requests`,
  `branches`, `ist`, `health`, `teams`) passes.
- Frontend: `npm run typecheck && npm run build` clean.
- Mobile: `flutter analyze` — 0 new issues (the 4 pre-existing
  `ptps_screen.dart` info-lints only); `flutter test` — 43/43 passing.
- Live-server walkthrough (backend + frontend dev servers, browser
  automation): logged in as the demo telecaller — worklist and correction-
  requests pages render cleanly, `/worklist/filter-options` returns
  correctly (empty arrays, since this agent has zero allocated customers in
  the dev DB — a standing data-limitation noted in every prior mobile task
  of this plan, so the actual filter-selection and remark-edit interactions
  couldn't be exercised against real records). No mobile emulator available
  in this environment either; substituted a full structural read-through of
  the Tasks 10-11 mobile diff instead.

### How to view
1. `cd backend && npm run dev`, `cd frontend && npm run dev`, log in as the
   demo telecaller (8888888801 / Admin@1234).
2. **My Worklist** — once customers are allocated (Allocation page, or
   `seed:demo`), the Branch/Bucket dropdowns show that agent's own
   branches/buckets; multi-select, reload the page, selection holds.
3. Log a call or field visit, open the customer's history timeline within
   24h — the entry shows a pencil "Edit remark" icon instead of the flag;
   edit the free-text remark, save, an "edited" badge appears. Wait past 24h
   (or edit `created_at` in the DB for a quick check) — the icon reverts to
   "Report an error", which still creates a pending correction request.
4. Mobile: same flow via the worklist screen's FilterChip rows and the
   history timeline's edit-remark dialog, once an emulator/device is
   available to verify against.

### Final review fix wave
Whole-branch code review after all 12 tasks landed found one Critical bug
and several Important/Minor issues, fixed in a follow-up commit:
- **Critical:** `GET /worklist/filter-options?scope=team` 500'd for every
  branch_manager — the query seeded `$1` for the caller's own id but the
  clamped (team-scope) branch of the built SQL never referenced `$1`
  anywhere, only `$2`/`$3` from the two `agentBranchClamp()` calls, so
  Postgres couldn't determine `$1`'s type. Fixed by only pushing/referencing
  `$1` in the branch that actually uses it (the non-clamped, self-scope
  case). `GET /worklist` (the main list route) was checked and does not
  have this problem — its SELECT list references `$1` unconditionally
  (`is_primary_for_me`/`is_field_agent_for_me`), so the placeholder is
  always referenced regardless of scope.
- **Important (mobile):** a stale persisted branch/bucket filter that no
  longer matched any allocated customer was an unrecoverable dead end —
  no chip renders for a value missing from `filter-options`, and the
  existing "Clear all filters" button didn't reset the server-side
  branch/bucket selection. `worklist_screen.dart`'s clear action now also
  resets and persists `worklistFiltersProvider`, and the
  "no customers assigned" empty state gained its own "Clear filters" button
  whenever a branch/bucket filter is active.
- Minor cleanup: the mobile Hive-backed filter store's `|` item separator
  became the same `\u0001` control character `worklist_provider.dart`'s
  cache key already uses, for the same delimiter-collision reason; the 24h
  edit windows in both PATCH routes changed from `>` to `>=` for exact
  spec fidelity; stale "three source tables" / "no correction flow for
  field visits" comments in `correction-requests.ts`, `history_timeline.dart`,
  and `ReportCorrectionModal.tsx` were updated to mention `field_visit`.
  See `.superpowers/sdd/2026-08-18-agent-branch-bucket-filter-and-remark-edit/final-review-fix-report.md`
  for the full list, including items deliberately left as follow-ups.

---
