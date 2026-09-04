# Rudrayani CRM — Mobile & Web Revamp Implementation Specification

**Status:** approved for implementation · **Last updated:** 2026-09-04
**Companion:** `docs/mobile-revamp-decisions.md` — the dated decision history and the *why*.
This document is the *what* and the *how*.

---

## 0. How to use this document

You are implementing this specification. Read Sections 1–7 in full before writing any code.

1. **Do not deviate.** Where this document names a file, column, endpoint or behaviour, use
   exactly that. Where it says **DECIDE**, the choice is genuinely open — pick the simplest
   option consistent with the rest of the spec and record it in a code comment.
2. **Phases run in order.** Phase 0 is a production incident and blocks everything else.
3. **Mobile and web move together** (Rule R1). Every phase names both clients where both are
   affected. Do not ship one without the other.
4. **Every phase has acceptance criteria.** Do not mark a phase complete until every criterion
   passes, you have run the stated tests, and you have seen and reported the actual output.
5. **Deleting is part of the job.** Several phases are net-negative in line count. That is
   intended. Do not preserve code "just in case" unless the phase says so.
6. **Do not invent features.** If a screen in the design mockup is not in this document, it is
   out of scope. The mockup is stale — see §1.4.

---

## 1. System context

### 1.1 Repository layout

```
backend/    Express + TypeScript + Postgres (PostGIS). Shared by both clients.
mobile/     Flutter (Dart). Riverpod + go_router + Dio + Hive.
frontend/   React 18 + TypeScript + Vite + Ant Design 5.
```

### 1.2 Who uses what

| Role | Client | Notes |
|---|---|---|
| Field agent | **Mobile** | The only mobile persona for now. |
| Telecaller | **Web** | |
| Branch manager | **Both** | Is *also* a telecaller or field agent (`users.agent_type`). Sees their own branch. |
| Operations manager / Agency admin | **Web** | Agency-wide. |

Cross-support (telecallers on mobile, field agents on web) is planned but **out of scope**.

### 1.3 Org model — authoritative; the backend already models this correctly

- Multiple **branches**, each with telecallers and field agents.
- **Agent work is not confined to their branch** — `telecaller_branches` handles multi-branch.
- Each branch has **one branch manager** (`branches.branch_manager_id`, UNIQUE) who is also an
  agent, sees their whole branch, and owns branch performance.
- **There is no Team Leader tier.** Removed by `1788000000000_remove-team-leader.sql`. Any
  reference to one is stale.

### 1.4 The design mockup is stale — it is not a spec

`Mobile redesign/Mobile Redesign Standalone.html` is a self-extracting bundle. To read it, unpack
the `__bundler/manifest` script (gzip + base64 per entry) and the `__bundler/template` `<x-dc>`
body. It is **input, not instruction.** Where it disagrees with this document, this document wins.

| Mockup shows | Reality |
|---|---|
| A Team Leader role and its four screens | Removed from the product (§1.3) |
| OTP login + "this device will be bound to your account for security" | No SMS gateway; no device binding (A2, A3) |
| Incentive calculator, legal cases, compliance/KYC alerts, revenue and commission | No backend model for any of these |
| Planned-visit queue and route map on mobile | No visit-queue model; the live map is **web-only** (F3) |
| Teal `#0B5D63` palette and dark mode | Palette is **Navy & Emerald**; mobile is deliberately single-theme for sunlight readability |
| Receipt `RCT-04821` | Real format is `RD/<BRANCH4>/<FY>/<5-digit seq>` |

Carry these mockup ideas **forward**: grouped disposition pills instead of a dropdown; amount as
the visually dominant field; a remark preview; a persistent sync/status line in the header;
per-row worked state with a timestamp; company / product / bucket as header filters.

### 1.5 Domain glossary

| Term | Meaning |
|---|---|
| **Trail code** (= disposition code) | `disposition_codes`. The *only* outcome taxonomy. Sourced from `resource files/Trail Codes.xlsx`. |
| **Action code / channel** | `OC` on-call, `FV` field visit, `LG` legal, `PIOC`/`PIFV` penal, `OC/FV` both |
| **Bucket** | Delinquency stage, lender-supplied verbatim. Never computed by us. |
| **PTP** | Promise to Pay: amount + promised date. The most important record type in the business. |
| **POS** | Principal outstanding. |
| **DPD** | Days past due, derived from `customers.due_date`. |
| **Allocation** | Admin assigns customers to an agent — roughly a month's worth in one drop. |
| **Ledger** | The work-done view: who contacted whom, for which lender, with what outcome, how much collected. Replaces all KPIs. |

---

## 2. Consolidated decisions

Supersessions are already applied. This table is authoritative.

### 2.1 Auth and session

| # | Decision |
|---|---|
| A1 | A user may hold **one mobile session and one web session at once**. Login on either must not disturb the other. |
| A2 | **Auth is phone + password.** No OTP anywhere in the new UI. Existing OTP code stays in the repo, dormant, until an SMS gateway is bought. |
| A3 | **No device binding.** Last device wins. **Remove any UI copy claiming the device is bound for security.** |
| A4 | Mobile password recovery is a **request to an admin**: free-text screen, admin resets from the Employees page, admin is alerted. |
| A5 | An admin password reset must **not** destroy the user's other live sessions. |
| A6 | **Remove the server-URL gear icon** from the mobile login screen. |
| A7 | Security hardening (web `localStorage` tokens, biometric/PIN, idle timeout, screenshot blocking) is **deferred**. Do not implement. |

### 2.2 Product scope

| # | Decision |
|---|---|
| P1 | **Mobile is a field-agent app.** Telecallers use web. |
| P2 | **Delete every KPI** — Resolution / Rollback / Normalization / Recovery, targets, run rates, achievement %, gauges — on both clients. |
| P3 | **Delete the `targets` feature entirely**: table, admin page, Excel import, every consumer. |
| P4 | Replace KPIs with the **ledger**: per agent, per day, per company — contacted, outcome by trail code, amount collected, and for field agents the movement trail. |
| P5 | **No targets for agents.** No monthly number, no percentage. |
| P6 | **The app decides the order.** Agents get **search and filter**, not sort. Primary filter is **customer branch**. |
| P7 | Mobile home is a **day plan**: PTPs due (collapsible, highlighted) above the assigned list. Full list is a lazy scroll with search. |
| P8 | Worked rows **grey out and sink to the bottom**. They never disappear. |
| P9 | **No push notifications.** PTPs are *highlighted* on the homepage of both clients instead. |
| P10 | **Agents work multiple lenders daily.** Company is visible on every row and available as a filter. |
| P11 | **English only.** No localisation. |
| P12 | No deadline, no demo. **Build the foundation properly first.** |

### 2.3 Interaction capture

| # | Decision |
|---|---|
| I1 | **Trail codes are the only outcome taxonomy.** Part payment is trail code `PP`; full payment is `PAID`. Do not add a second taxonomy or a completeness column. |
| I2 | **Money is recorded inside the interaction** — inside the field visit (mobile) and the call log (web). No separate payment screen. |
| I3 | **Field agents record visits only.** No channel picker on mobile; their code list is FV plus shared codes. |
| I4 | Logging one interaction must take **≤10 seconds**. Most-used codes float to the top. |
| I5 | Where a code implies a future commitment (PTP, or part payment with a promise), the agent **must capture a date**. That creates a PTP and puts the customer in the PTP list. |
| I6 | **Photo proof is not mandatory** in any case, including cash. |
| I7 | **Calls are self-reported.** Do not read the device call log. Do not add telephony integration. |
| I8 | Field-referral auto-routing (`PICK UP` / `FIELD REFERRAL`) is **deferred**. |

### 2.4 Field work, attendance and tracking

| # | Decision |
|---|---|
| F1 | **GPS is mandatory** for every mobile user. The punch-in gate stays. |
| F2 | A punch-in with **no fix is still allowed**, marked unverified; the background service **backfills and verifies** it when a fix arrives. |
| F3 | **The live map is web-only.** Mobile gets no map. |
| F4 | Branch manager sees **their own team's** locations; ops/admin see **everyone**; agents see **no one**. |
| F5 | The 2-minute ping interval is correct; **pings are unreliable and must be fixed** (X2). |
| F6 | Offline stays light: keep the durable write queue, **add an explicit offline-mode alert**, no pre-download, no delta sync. |

### 2.5 Data

| # | Decision |
|---|---|
| N1 | **Address is lender-sourced and read-only.** Nobody edits it directly. |
| N2 | Address is promoted to a real **`customers.address`** column and is **required at the import column-mapping step**. |
| N3 | An agent may **request an address correction**, approved by a manager — reusing the correction-request pattern, extended to customer fields. |
| N4 | Money credits **whoever recorded it** (`payments.collected_by_user_id`). |
| N5 | `GET /worklist` **must paginate**. |
| N6 | Ledger visibility: agent → self, branch manager → branch, ops/admin → everyone. |

### 2.6 Supplementary decisions and open assumptions

S4, S5 and S6 were **confirmed by the owner on 2026-09-04** and are binding. The rest remain
working assumptions — implement them as stated, but they can be overridden cheaply.

| # | Status | Decision / assumption |
|---|---|---|
| S1 | assumed | Password-reset alerts route to the agent's **branch manager**, falling back to agency admin when the branch has none. |
| S2 | assumed | The agent sees request status on the mobile login screen ("Request sent — waiting on your manager"). |
| S3 | assumed | **One open password-reset request per user**; a second submission updates the existing one. |
| S4 | **CONFIRMED** | The web KPI Dashboard is **deleted** and **Agent Daily Activity (`/agent-activity`) becomes the owner's landing page**. Nothing new is built to replace the dashboard. |
| S5 | **CONFIRMED** | `tracking.view` is **split**: it stays self-scoped for agents (so their own attendance still loads), and a new `tracking.view_team` gates the Tracking nav item, the live map and route replay for branch managers, ops and admin. |
| S6 | **CONFIRMED** | Mobile's six read-only admin lists (All Customers, Employees, Teams, Branches, Companies, Catalog) are **all cut**, along with `generic_list_screen.dart` and `employee_detail_screen.dart`. Account keeps name, phone, branch and Log out only. |
| S7 | assumed | Punch-out lives in a **persistent duty bar** at the top of the mobile home screen, not buried in Account (see §5.1). |
| S8 | assumed | Worklist page size is **50**, infinite scroll, no page numbers. |

---

## 3. Known defects

These are pre-existing bugs, independent of the redesign. Fix them where the phase says so.

### X1 — PRODUCTION BLOCKER: disposition codes may all have `channel = NULL`

`backend/src/migrations/seed_disposition_codes.ts` **never writes the `channel` column** — it is
absent from the INSERT. Channel was assigned once, by migration
`1785600000000_add-disposition-channel.sql`, which also duplicated each `OC/FV` code into an FV
row and an OC row. Production was re-seeded with the 70-code master list **after** that migration
ran, so every code is likely `channel = NULL`.

Both clients filter strictly on channel — mobile `codes.where((c) => c.channel == channel)`,
web `dispositionCodes.filter(c => c.channel === channel)` — so a NULL channel is invisible in
both. **Effect: the Result Code picker is empty and no call can be logged on either client.**

Confirm with:
```sql
SELECT channel, COUNT(*) FROM disposition_codes
 WHERE agency_id = '<agency>' AND is_active GROUP BY channel;
```

**Fix:** teach the seeder to derive `channel` from the sheet's Action Code column, expanding
`OC/FV` into both channels, and make it idempotent. Then backfill production.

### X2 — Location pings are unreliable

Three causes, in order of impact:

1. **Battery-optimisation exemption is never requested.** `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`
   is not in `mobile/android/app/src/main/AndroidManifest.xml`, and
   `FlutterForegroundTask.requestIgnoreBatteryOptimization()` is never called. On MIUI, ColorOS,
   FuntouchOS and One UI — most of the Indian budget-Android market — the tracking foreground
   service is throttled or killed.
2. **All-or-nothing accuracy.** `tracking_task.dart` `_capturePing()` requests
   `LocationAccuracy.high` with a 30-second limit and, on failure, records **nothing**. Indoors
   that produces silence rather than a degraded fix.
3. **Silent de-duplication.** `recorded_at` is taken from the GPS fix's own timestamp, while
   `location_pings` has a unique `(user_id, recorded_at)` index with `ON CONFLICT DO NOTHING`. A
   repeated cached fix is discarded without trace.

### X3 — Field-visit outcome is discarded

`mobile/lib/features/field_visit/field_visit_screen.dart`: the *Met customer* / *Could not
access* segmented control drives validation but is **never added to the request payload**. The
outcome is lost on submit.

### X4 — Customer detail pull-to-refresh does nothing

`customer_detail_screen.dart` renders `customerByIdProvider` but its `RefreshIndicator`
invalidates `customerDetailProvider`. The header never refreshes.

### X5 — Mobile login vs. web session

`backend/src/services/auth-service.ts` `login()` runs the device-binding revoke whenever a
`device_id` is supplied. Mobile always supplies one; web never does. Because
`NULL IS DISTINCT FROM 'abc'` is **true** in SQL, a mobile login revokes the web refresh token.
The web tab's next refresh then hits the revoked-token branch, which treats it as token replay
and **revokes every remaining session for that user**.

### X6 — Dead and mislabelled code

- `field_executive_dashboard_screen.dart` labels field visits as "Receipts Generated" and shows a
  "With Signature" KPI for signature capture removed on 2026-07-06.
- `TodaySection(heroMode:)` documents a HomeShell usage that does not exist.
- `riverpod_annotation` and `riverpod_generator` are dependencies that generate nothing — zero
  `@riverpod`, zero `.g.dart`.
- Mobile login validates exactly 10 digits; the backend accepts 8–15.

---

## 4. Backend contract changes

All under `backend/`. Write a migration for every schema change; never edit an applied migration.

### 4.1 `GET /worklist` — pagination and ordering (N5, P6, P7)

Currently returns every assigned row with `total: rows.length` and no LIMIT.

- Accept `page` (default 1) and `limit` (default 50, max 200), mirroring `/customers`.
- Return a real `total` from a `COUNT(*)` over the same WHERE clause.
- Keep the existing `ORDER BY c.next_action_date ASC NULLS LAST, c.due_amount DESC NULLS LAST`
  and add worked-state as the **primary** sort key so worked rows sink (P8):
  `ORDER BY (worked_today) ASC, c.next_action_date ASC NULLS LAST, c.due_amount DESC NULLS LAST`.
- Add to the SELECT: `worked_today` (boolean — a call log or field visit exists for this customer
  within the current IST day) and `collected_today` (sum of that agent's payments against this
  customer within the current IST day).
- Keep the existing `q`, `company_id`, `customer_branch`, `product`, `bucket`, `scope` filters.
  **Both clients must use these instead of filtering client-side.**

### 4.2 Disposition cadence (P6, P7, P8)

New nullable columns on `disposition_codes`, all admin-editable from the Dispositions page:

| Column | Type | Meaning |
|---|---|---|
| `followup_after_hours` | INT | Hours until this customer should resurface. NULL = no automatic follow-up. |
| `exits_agent_queue` | BOOLEAN NOT NULL DEFAULT false | The customer leaves the agent's queue entirely. |
| `routes_to` | TEXT | Where it goes when it exits: `field`, `manager`, `data_correction`, `closed`. |

Seed defaults by category (admin can override any):

| Category | `followup_after_hours` | `exits_agent_queue` | `routes_to` |
|---|---|---|---|
| Promise to Pay | (uses the PTP date) | false | — |
| Call Back | (uses the captured time) | false | — |
| Pick Up / Left Message | 24 | false | — |
| Not connected (NC, RNR, Phone Out Of Service) | 4 | false | — |
| Out of Station | 168 | false | — |
| Refuse to Pay | 72 | false | — |
| Inability to Pay | 360 | false | — |
| Re Visit | 24 | false | — |
| Wrong Number / New Mobile Number | NULL | true | `data_correction` |
| Field Referral / Pick Up (field) | NULL | true | `field` |
| Escalated Case / Legal Proceedings | NULL | true | `manager` |
| Cleared From Bank / Paid | NULL | true | `closed` |

Extend `refreshNextActionDate()` in `services/ptp-service.ts` to take a **third** source
alongside pending PTPs and pending reminders: the latest call log or field visit for that
customer, plus its code's `followup_after_hours`.

Enforce a **per-customer daily attempt cap of 3** (configurable via `agencies.settings`). Once
hit, the customer does not resurface until the next day regardless of cadence. Without this, a
4-hour cadence on "not connected" cycles the same twenty numbers all day.

### 4.3 `customers.address` (N1, N2)

- Migration: add `customers.address TEXT`.
- Backfill from `custom_fields` using the same fuzzy match mobile uses today: the first key whose
  lower-cased name contains `address` or `addr` with a non-empty value.
- In `field-config-service.ts`, change the `address` definition to `storage_column = 'address'`
  and include it in `DEFAULT_REQUIRED_CORE_FIELDS` so the column-mapping step demands it.
- `import-service.ts` `classifyField()` will then route it to the real column automatically.
- **Warn loudly:** a lender file with no address column will now be **rejected at import**.

### 4.4 Link money to the interaction (I2)

`payments` has no link to the interaction that produced it (only `ptps.call_log_id` exists).

- Add nullable `payments.call_log_id UUID REFERENCES call_logs(id)` and
  `payments.field_visit_id UUID REFERENCES field_visits(id)`, with a CHECK that at most one is set.
- `POST /field-visits` and `POST /call-logs` accept an optional embedded payment
  (`amount`, `mode`, `paid_at`) and create both rows **in one transaction**, reusing the caller's
  `client_key` for idempotency on both.
- Keep standalone `POST /payments` working — web and the offline queue still use it.

### 4.5 Idempotency completion

Add `client_key` handling (matching `call_logs`) to:
- `POST /ptps` — currently the only write mobile cannot queue offline.
- `POST /attendance/punch-out`.
- `PATCH /reminders/:id`.

Each needs a nullable `client_key UUID` column plus a partial unique index on
`(owner_column, client_key) WHERE client_key IS NOT NULL`.

### 4.6 Password-reset requests (A4, S1–S3)

New table:

```sql
CREATE TABLE password_reset_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id UUID NOT NULL REFERENCES agencies(id),
  user_id UUID NOT NULL REFERENCES users(id),
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','resolved','rejected')),
  resolved_by UUID REFERENCES users(id),
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_prr_open ON password_reset_requests (user_id) WHERE status = 'pending';
```

Endpoints:
- `POST /auth/password-reset-request` — **unauthenticated** (the user cannot log in). Body:
  `{ phone, message }`. Respond identically whether or not the phone exists, matching the existing
  OTP-request convention, so the endpoint cannot be used to enumerate accounts.
- `GET /auth/password-reset-request?phone=` — unauthenticated status check for S2. Return only
  `{ status }`, never user details.
- `GET /password-reset-requests` — authenticated, `employees.update`, scoped by
  `resolveBranchClamp()`.
- `POST /password-reset-requests/:id/resolve` — marks resolved. The actual reset stays
  `POST /employees/:id/reset-password`.

**Rate-limit the unauthenticated POST** with the existing `otpRequestRateLimiter` pattern.

### 4.7 Session fixes (A1, A5) — see X5

- In `login()`, change the revoke to
  `AND device_id IS NOT NULL AND device_id IS DISTINCT FROM $2` so web (NULL) sessions survive.
- In `POST /employees/:id/reset-password`, stop revoking every refresh token. **RESOLVED (O4,
  owner, 2026-09-04):** revoke only tokens whose `device_id` is NULL (web sessions) — a mobile
  session survives an admin reset.
- **Found during Phase 1 verification, not originally listed here:** `refresh()`'s replay defense
  (a revoked token being presented again revokes *every* session for the user) doesn't distinguish
  a genuinely-suspicious rotated-token replay from a client presenting a token that was revoked for
  an ordinary reason (this reset, a device login superseding another, deactivation, logout, a
  self-service password change). Without fixing that too, the web client's very next ordinary
  refresh after this reset would cascade-revoke the mobile session the reset was supposed to
  protect — defeating O4 in practice. Added `refresh_tokens.revoked_reason`; every revoke site
  tags why, and only `'rotated'` triggers the cascade.

### 4.8 Permission changes

- **Add** `tracking.view_team` and grant it to `agency_admin`, `operations_manager`,
  `branch_manager`. Gate the Tracking nav item, the live map and route replay on it.
  `tracking.view` stays granted to `telecaller` and `field_agent` for their **own** data (S5).
- **Delete** `targets.manage` and every row referencing it (P3).

### 4.9 Extend correction requests to customer fields (N3)

In `routes/correction-requests.ts`, add `customer` to `RECORD_TYPES` with
`ALLOWED_FIELDS.customer = ['address']`. `loadOwnedRecord()` must accept a customer the requester
is assigned to (primary or field agent) rather than one they authored.

### 4.10 Deletions (P2, P3)

Delete from `backend/`:
- `routes/targets.ts`, its mount in `app.ts`, `test/targets.test.ts`.
- From `services/report-service.ts`: `resolveTarget`, `bookTotals`, `bookTotalsByScope`,
  `classifiedCtes`, `classify`, `AGGREGATE_SELECT`, `dashboard`, `agentBreakdown`,
  `dimensionBreakdown`, `recallReport`, `bucketMovementReport`, `bucketMismatchReport`,
  `MetricBlock`, `DashboardResult`, and the `REPORT_METRICS` model.
- From `routes/reports.ts`: `/dashboard`, `/agents`, `/breakdown`, `/recalls`,
  `/bucket-movements`, `/bucket-mismatches`, `/export`.
- A migration dropping the `targets` table.

**Keep:** `/reports/agent-activity` and its export, `/reports/trail`, `/reports/overview`,
`/reports/trend`, `/reports/deposits-range`, `/reports/exceptions`, `filterOptions`,
`collectedToday`, `collectionByType`, `collectionByChannel`, `listDeposits`, `depositTotals`.
These back the ledger.

---

## 5. Target information architecture

### 5.1 Mobile — field agent

Four destinations. Bottom navigation.

```
┌─ Duty bar (persistent, top of every tab) ──────────────┐
│ ● On duty · 4h 12m · Punch Out        ⚡ 3 to sync     │
└────────────────────────────────────────────────────────┘

1. TODAY  (home)
   ├─ PTP Follow-ups  [collapsible, highlighted, count badge]  ← opens expanded
   ├─ Progress line: "12 of 40 worked · ₹8,400 collected"
   └─ Assigned list (lazy scroll, page 50)
        row: name · company · loan no · due · bucket · last outcome
             worked rows greyed, sunk to the bottom, with a ✓ and time

2. CUSTOMER  (pushed, not a tab)
   ├─ Header: name, due, company, product, bucket, address
   ├─ Primary actions: Call · Navigate · Log Visit
   ├─ Active PTP (if any)
   └─ History timeline

3. LOG VISIT  (pushed from Customer — the ≤10s screen)
   ├─ Amount collected (dominant)  + mode pills
   ├─ Trail code — grouped pills, most-used first
   ├─ Date picker (only when the code requires it)
   ├─ Remark + live preview
   └─ Save  [single button, persistent bar]

4. MY DAY  (ledger — replaces My Performance)
   └─ contacted · collected · PTPs set · visits — today and this month.
      NO targets, NO percentages.

5. BRANCH  (branch managers only — replaces the role dashboards)
   └─ per-agent rows: on duty, contacted, collected, PTPs. Tap for that agent's day.

6. ACCOUNT
   └─ name, phone, branch · Log out. Nothing else.
```

**Duty bar (S7).** Punch-out is the single most important control after logging work — it ends
the shift and stops GPS tracking. Burying it in Account is why it is currently missed. It lives
in a persistent bar at the top of every tab, showing duty state and elapsed shift time, and it
doubles as the sync indicator and the offline-mode alert surface (F6).

### 5.2 Web — telecaller

Same day-plan restructure as mobile (P7, Rule R1): `MyWorklistPage` keeps its dense table (a desk
tool with a keyboard is legitimately different from a phone) but is reorganised so that PTPs due
are a pinned, highlighted section above it, worked rows grey and sink, and search/filter run
server-side. The existing "Today's Work" collapsible becomes the ledger view.

### 5.3 Web — branch manager, ops, admin

- **Landing page: Agent Daily Activity** (`/agent-activity`), the ledger (S4).
- Tracking (live map + route replay), gated on `tracking.view_team`, scoped by role.
- Admin surfaces unchanged: Import, Import Review, Allocation, Employees, Branches, Teams,
  Companies, Buckets, Field Config, Dispositions, Deposits, Attendance, Day Plan,
  Reallocation Requests, Correction Requests, Password Reset Requests (new).
- **Deleted:** Dashboard (`/`), Reports (`/reports`), Targets (`/targets`).

### 5.4 Navigation changes

| Item | Before | After |
|---|---|---|
| Web `/` Dashboard | KPI widget grid | **Deleted** — redirect to `/agent-activity` |
| Web `/reports` | Metric reports | **Deleted** |
| Web `/targets` | Target admin | **Deleted** |
| Web Tracking / Day Plan / Attendance | visible to telecallers | gated on `tracking.view_team` |
| Mobile tabs | Worklist · Dashboard · Performance · Account | Today · My Day · Branch* · Account (*BM only) |
| Mobile Account lists | 6 admin lists | **All cut** (S6) |
| Mobile reallocation / correction requests | present | **Cut** — web only |

---

## 6. Design system (Phase 4 output)

The single largest cost driver: mobile has design tokens but **no component layer** — 117 inline
`fontSize:` literals and 37 hardcoded `BorderRadius.circular()` across `lib/`. Build these
in `mobile/lib/core/ui/` **before** any screen work.

| Component | Replaces |
|---|---|
| `AppScaffold` | Per-screen `Scaffold` + `AppBar` duplication |
| `AppCard` | 37 hand-rolled `Card` + `BorderRadius.circular(8)` |
| `AppListRow` | Every bespoke `ListTile` (enforces the 56px minimum) |
| `AppStatTile` | `DashboardStatCard`, `_StatCard`, `SummaryStat` |
| `AppFormField` | Every inline `TextField` + `InputDecoration` |
| `AppPrimaryButton` / `AppSecondaryButton` | Inline `ElevatedButton.styleFrom` (enforces the 48px tap target) |
| `AppSectionHeader` | `_StepLabel`, `DashboardSectionHeader`, inline bold `Text` |
| `AppMoney` | `_rupee` re-aliased in five files (enforces tabular figures) |
| `AppEmptyState` / `AppErrorState` / `AppLoadingState` | Already exist in `state_views.dart` — fold in |
| `AppChipGroup` | The disposition pill grid |
| `DutyBar` | New (§5.1) |

**Rules, enforced by review:**
1. Set a real `TextTheme` in `app_theme.dart`. **No screen may declare `fontSize:` directly.**
2. All radii from `AppRadius`, all spacing from `AppSpacing`, all colours from `AppColors`.
3. Minimum 48px tap targets and 56px list rows (`AppDimens`) — enforced inside the components,
   not per call site.
4. Every money figure renders through `AppMoney` (tabular figures are mandatory).
5. Mobile stays **single-theme**. No dark mode.

---

## 7. State and navigation (Phase 5 output)

**Problem:** four state patterns coexist — `StateNotifier`, `StateProvider`, `FutureProvider`,
and seven screens doing raw `setState` data-loading with hand-rolled `_error`/`_data` fields and
no provider at all. One customer entity has three incompatible shapes.

**Target:**
1. **One `Account` model** replacing `Customer` + the raw `Map` used for detail. Fields: identity,
   loan, company, branch, address, due/POS/EMI, bucket, DPD, `next_action_date`, last outcome,
   active PTP, `worked_today`, `collected_today`.
2. **One `AccountRepository`** owning all reads and writes, and owning the offline read-cache and
   write-queue interaction. Screens never touch Dio.
3. **One provider pattern.** Either turn on `riverpod_generator` (already a dependency, currently
   generating nothing) or remove it. Do not leave both.
4. **Delete `IndexedStack`.** It builds every tab at once — the documented cause of 6–8 parallel
   requests at login. Use lazy tab construction.
5. **Named tab identity**, not a bare `int` index into a conditionally-built list.
6. **Split the router redirect.** Auth and attendance are currently one coupled `redirect`. Make
   punch-in a route guard on the shell, not on every route.

---

## 8. Implementation plan

18 phases. Run them in order. Each phase is independently shippable and independently testable.
**Do not begin a phase until the one before it meets its acceptance criteria.**

Legend — **G** goal · **D** depends on · **F** files · **C** changes · **A** acceptance · **T** tests

---

### Phase 0 — Production triage (BLOCKING)

**G** Restore the ability to log a call in production, and make GPS pings arrive.
**D** none. **Nothing else starts until this is done.**

**C**
1. Run the X1 query in §3. Record the result.
2. Rewrite `backend/src/migrations/seed_disposition_codes.ts` to read the Action Code column and
   set `channel`: `OC`→`OC`, `FV`→`FV`, `LG`→`OC`, `PIOC`→`OC`, `PIFV`→`FV`, and `OC/FV`→insert
   the row **twice**, once per channel. Make it idempotent (`ON CONFLICT DO NOTHING` on a natural
   key of `(agency_id, action_code, result_code, description)` — add that unique index).
3. Write a one-off backfill script applying the same derivation to existing NULL-channel rows.
4. Mobile: add `<uses-permission android:name="android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS"/>`
   to `AndroidManifest.xml`; call `FlutterForegroundTask.requestIgnoreBatteryOptimization()` from
   the punch-in flow, after location permission is granted and before `TrackingService.start()`.
5. Mobile `tracking_task.dart` `_capturePing()`: on high-accuracy failure, retry once at
   `LocationAccuracy.medium` with a 15s limit before giving up; record whichever succeeds.
6. Mobile `tracking_task.dart`: set `recorded_at` from `DateTime.now().toUtc()`, not
   `pos.timestamp`, so a repeated cached fix is not silently dropped by the unique index.

**A**
- The X1 query returns non-zero counts for both `FV` and `OC`, and **zero** NULL rows.
- Logging in as a field agent on mobile shows a non-empty Result Code list.
- Logging in as a telecaller on web shows a non-empty Result Code list for both channels.
- On a physical Android device, after punch-in, `location_pings` gains a row roughly every 2
  minutes for 30 minutes, including with the app backgrounded.

**T** New backend test asserting no active disposition code has a NULL channel. Add it to CI —
this class of bug must not recur.

---

### Phase 1 — Backend: session and auth fixes

**G** Mobile and web sessions coexist (A1, A5). **D** Phase 0.
**F** `backend/src/services/auth-service.ts`, `backend/src/routes/employees.ts`

**C**
1. In `login()`, change the device revoke to
   `AND device_id IS NOT NULL AND device_id IS DISTINCT FROM $2`.
2. In `POST /employees/:id/reset-password`, replace the blanket
   `UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1` with the O4-resolved,
   web-only-scoped revoke (§4.7).
3. Leave the deactivation revoke (line ~959) untouched — deactivating a user *should* kill
   every session.
4. Add `refresh_tokens.revoked_reason` and tag every revoke site; scope `refresh()`'s replay
   cascade to `revoked_reason = 'rotated'` only (§4.7 note).

**A** Log in on web, then on mobile as the same user. The web session still works: a page
refresh succeeds and no "Session revoked" error appears. Then reset that user's password as an
admin — the agent's *other* session is unaffected.

**T** New `backend/test/auth.test.ts` cases: "mobile login preserves an existing web session" and
"admin password reset does not revoke other sessions".

---

### Phase 2 — Backend: password-reset requests

**G** A4, S1–S3. **D** Phase 1.
**F** new migration; `backend/src/routes/auth.ts`; new `backend/src/routes/password-reset-requests.ts`; `app.ts`

**C** Implement §4.6 exactly — table, unique partial index, four endpoints, rate limiting on the
unauthenticated POST, identical responses regardless of whether the phone exists.

**A** An unauthenticated POST with a valid phone creates one pending row; a second POST updates
it rather than creating a duplicate; a POST with an unknown phone returns the same response and
creates nothing. `GET /password-reset-requests` as a branch manager returns only their branch.

**T** New `backend/test/password-reset-requests.test.ts` covering: create, duplicate-collapses,
unknown-phone-is-indistinguishable, branch scoping, resolve.

---

### Phase 3 — Backend: worklist pagination, worked state, server-side filtering

**G** N5, P6, P7, P8, P10. **D** Phase 1.
**F** `backend/src/routes/worklist.ts`

**C** Implement §4.1. Add `page`/`limit`, a real `COUNT(*)` total, `worked_today`,
`collected_today`, and worked-state as the primary sort key.

**A** `GET /worklist?page=2&limit=50` returns rows 51–100 and a `total` larger than the page.
A customer with a call log today returns `worked_today = true` and sorts below unworked rows.
`?customer_branch=` filters server-side.

**T** Extend `backend/test/worklist-filters.test.ts`: pagination boundaries, `total` correctness
under filters, `worked_today` toggling after a call log, worked rows sorting last.

---

### Phase 4 — Backend: disposition cadence

**G** The engine that makes the day plan self-driving (§4.2). **D** Phase 3.
**F** new migration; `backend/src/services/ptp-service.ts`; `backend/src/routes/dispositions.ts`

**C** Add the three columns, seed the category defaults, extend `refreshNextActionDate()` to a
third source, implement the daily attempt cap, and expose the new fields on the Dispositions
admin API.

**A** Logging a "not connected" code sets `next_action_date` to roughly 4 hours later. Logging
`Wrong Number` sets `exits_agent_queue` behaviour so the customer no longer appears in the day
plan. A fourth attempt on the same customer in one day does not resurface them.

**T** New `backend/test/disposition-cadence.test.ts`: each category's default cadence, the cap,
and `exits_agent_queue` removing a customer from `/worklist`.

---

### Phase 5 — Backend: address column

**G** N1, N2. **D** Phase 3.
**F** new migration; `backend/src/services/field-config-service.ts`; `backend/src/routes/worklist.ts`, `customers.ts`

**C** Implement §4.3 — add the column, backfill from `custom_fields`, change the field definition
to `storage_column = 'address'`, add it to `DEFAULT_REQUIRED_CORE_FIELDS`, and return `address`
from `/worklist` and `/customers/:id`.

**A** After the migration, existing customers that had an address-like custom field have a
populated `customers.address`. Creating an import template without mapping address is rejected
with a clear message.

**T** Extend `backend/test/field-config.test.ts` and `import.test.ts`: address is required in a
template; the backfill populated known rows.

> **Operational warning to surface to the owner before deploying:** from this point a lender file
> with no address column is rejected at import.

---

### Phase 6 — Backend: money inside the interaction, and idempotency completion

**G** I2, §4.4, §4.5. **D** Phase 5.
**F** new migration; `backend/src/routes/field-visits.ts`, `call-logs.ts`, `ptps.ts`, `attendance.ts`, `reminders.ts`

**C** Implement §4.4 (embedded payment, one transaction, shared `client_key`) and §4.5
(`client_key` on PTPs, punch-out, reminder PATCH).

**A** `POST /field-visits` with an embedded amount creates one `field_visits` row and one
`payments` row linked to it, atomically; re-sending the same `client_key` returns the original
pair without creating duplicates. `POST /ptps` is now idempotent.

**T** Extend `backend/test/offline-idempotency.test.ts` to cover visit-with-payment replay, PTP
replay, and punch-out replay. Assert that a rolled-back visit leaves no orphan payment.

---

### Phase 7 — Backend: permissions, and delete the KPI/targets surface

**G** P2, P3, §4.8, §4.10. **D** Phase 6.
**F** new migration; `backend/src/routes/reports.ts`, `targets.ts`, `app.ts`; `services/report-service.ts`

**C** Add `tracking.view_team` and grant it to admin/ops/branch_manager. Delete `targets.manage`
and the `targets` table. Delete the routes, service functions and tests listed in §4.10.
**Keep** everything listed as kept there.

**A** `backend` compiles with no unused-export warnings. `GET /reports/dashboard` returns 404.
`GET /reports/agent-activity` still works. A telecaller calling `/tracking/live` gets 403; a
branch manager gets only their branch; an admin gets everyone.

**T** Delete `targets.test.ts`. Extend `tracking.test.ts` with the three-role scoping cases.
Run the full backend suite — every remaining test must pass.

---

### Phase 8 — Mobile: design system

**G** §6. The foundation everything else is built on. **D** Phase 7.
**F** new `mobile/lib/core/ui/*`; `mobile/lib/core/theme/app_theme.dart`

**C** Build every component in the §6 table. Set a real `TextTheme`. Do **not** touch feature
screens in this phase — build the library and a small gallery screen that renders every component
for visual review.

**A** Every component exists, is documented with a doc comment, and appears in the gallery.
`AppMoney` renders tabular figures. `AppListRow` cannot render below 56px; `AppPrimaryButton`
cannot render below 48px.

**T** Widget tests per component asserting the minimum tap-target and row-height constraints.

---

### Phase 9 — Mobile: state and navigation foundation

**G** §7. **D** Phase 8.
**F** `mobile/lib/core/models/`, new `mobile/lib/core/data/account_repository.dart`, `core/router.dart`, `features/home/home_shell.dart`

**C** Implement §7 — one `Account` model, one `AccountRepository`, one provider pattern, no
`IndexedStack`, named tab identity, split router redirect. Migrate the seven raw-`setState`
screens onto the repository. Fix X4 while you are here (the refresh invalidates the provider the
screen actually renders).

**A** Only the visible tab issues network requests at login — verify by logging outbound requests
and confirming there is no longer a 6–8 request burst. Pull-to-refresh on customer detail visibly
updates the header. `flutter analyze` is clean.

**T** Keep the existing pure-function tests passing. Add repository tests for the read-cache
fallback path.

---

### Phase 10 — Mobile: Today (day plan) and the duty bar

**G** P7, P8, P9, P10, S7, F6. **D** Phase 9.
**F** new `mobile/lib/features/today/*`; `core/ui/duty_bar.dart`

**C** Build the §5.1 home: the persistent duty bar (duty state, shift timer, punch-out, sync
count, offline alert), the collapsible highlighted PTP section, the progress line, and the lazy
paginated list with server-side search and the customer-branch filter. Worked rows grey and sink.

**A** With 400 assigned accounts the list scrolls smoothly and loads 50 at a time. PTPs due today
appear above everything. Logging a visit greys the row and sinks it without a full reload.
Turning off the network raises the offline alert once. Punch-out is reachable in one tap from
every tab.

**T** Widget tests: PTP section renders when PTPs exist and collapses; a worked row renders
greyed; the offline alert appears on connectivity loss.

---

### Phase 11 — Mobile: Customer and Log Visit

**G** I1–I6, the ≤10s screen. **D** Phase 10.
**F** `mobile/lib/features/worklist/customer_detail_screen.dart` → rework; `features/field_visit/*`; **delete** `features/call_log/`, `features/payment/`

**C** Rebuild customer detail per §5.1 — header, three primary actions (Call, Navigate, Log
Visit), active PTP, history. `Navigate` reads the real `customers.address` column, not the
`custom_fields` scan. Build the merged Log Visit screen: amount + mode pills, grouped trail-code
pills ordered most-used-first, conditional date capture, remark with live preview, one save
button. Remove the channel picker (I3). Fix X3 — the outcome must reach the payload. Delete the
separate call-log and payment screens.

**A** A visit with a payment can be logged in **under 10 seconds** on a mid-range Android — time
it and report the number. The trail code list shows FV plus shared codes and never shows an empty
picker. Choosing a PTP-flavoured code demands a date and creates a PTP visible in the Today
section. `Navigate` opens maps for any customer with an address.

**T** Widget tests: required-date enforcement, most-used ordering, the outcome reaching the
payload, and offline queueing of a visit-with-payment.

---

### Phase 12 — Mobile: My Day and Branch views

**G** P4, P5, N6, and the Q3 branch view. **D** Phase 11.
**F** new `mobile/lib/features/myday/*`, `mobile/lib/features/branch/*`; **delete** `features/dashboard/`, `features/performance/`

**C** Build **My Day** — contacted, collected, PTPs set, visits, today and this month, from
`/reports/agent-activity` and `/tracking/team-day`. **No targets, no percentages, no gauges.**
Build **Branch** (branch managers only) — per-agent rows with on-duty, contacted, collected and
PTPs, tapping through to that agent's day. Delete the three role dashboards and My Performance.

**A** A field agent sees only their own numbers. A branch manager additionally sees a Branch tab
listing only their branch's agents. Neither screen shows a target or a percentage anywhere.

**T** Widget tests for role-based tab presence, replacing `home_shell_dashboard_role_test.dart`.

---

### Phase 13 — Mobile: the cut list

**G** S6, A3, A6, A4, P1. **D** Phase 12.
**F** `features/account/`, `features/auth/login_screen.dart`, `core/notifications/`, `pubspec.yaml`, `core/router.dart`

**C**
1. Delete the six Account admin lists and `generic_list_screen.dart`, `employee_detail_screen.dart`
   and their routes. Account keeps name, phone, branch and Log out.
2. Delete reallocation and correction request UI from mobile (web only).
3. Remove the server-URL gear icon and `setServerUrlOverride` from the login screen (A6). Keep
   `--dart-define=API_URL` for builds.
4. Remove any device-binding copy (A3).
5. Add the password-reset request screen (A4) and its status line (S2).
6. Delete `NotificationService`, and drop `flutter_local_notifications`, `timezone` and
   `flutter_timezone` from `pubspec.yaml` (P9).
7. Remove `riverpod_annotation`/`riverpod_generator` **or** adopt them — not both (§7.3).
8. Fix the phone-length mismatch (X6): accept 8–15 digits, matching the backend.

**A** The app builds with the reduced dependency set. No route reaches a deleted screen. A
locked-out user can submit a reset request and see its status.

**T** Update `widget_test.dart` and the router tests for the reduced surface.

---

### Phase 14 — Web: worklist day-plan restructure

**G** P7, P8, Rule R1. **D** Phase 7 (backend), can run parallel to mobile phases.
**F** `frontend/src/pages/MyWorklistPage.tsx`

**C** Reorganise per §5.2 — PTPs due as a pinned highlighted section, worked rows greyed and
sunk, server-side pagination/search/filter using the Phase 3 parameters (remove the client-side
company filter and the client-side search), customer branch as the primary filter.

**A** The table paginates server-side and `total` reflects the filtered set. Worked rows are
visually distinct and sorted last. PTPs due are visible without scrolling.

**T** Manual verification against a seeded 400-account agent, plus a typecheck (`npm run typecheck`).

---

### Phase 15 — Web: delete the KPI surface, rework navigation

**G** P2, P3, S4, S5, F4. **D** Phase 7.
**F** `frontend/src/App.tsx`, `components/AppLayout.tsx`; **delete** `pages/DashboardPage.tsx`, `pages/ReportsPage.tsx`, `pages/TargetsPage.tsx`, `components/dashboard/*` (except as noted), `scrapped-features/`, `hooks/useDashboardPreferences.ts`

**C** Delete the Dashboard, Reports and Targets pages and routes. Redirect `/` to
`/agent-activity` (S4). Delete the widget registry, the customizer, `Gauge`, `MetricPanel`,
`MetricTabsCard`, `RecalledStatTile`, `BucketMovementCard`, `BucketMismatchCard`, `SummaryStat`
and `format.ts` **only if no remaining page imports them** — check `BreakdownTable` and
`OrgChartPage` first. Gate Tracking, Day Plan and Attendance nav items on `tracking.view_team`.
Delete `scrapped-features/` (it archives a page whose backend is being removed).

**A** Logging in as an owner lands on Agent Daily Activity. A telecaller sees no Tracking, Day
Plan or Attendance nav item. `npm run build` succeeds with no unresolved imports.

**T** Typecheck plus a manual pass of every remaining nav item per role.

---

### Phase 16 — Web: admin surfaces for the new flows

**G** A4, N3. **D** Phase 15.
**F** new `frontend/src/pages/PasswordResetRequestsPage.tsx`; `components/AlertsBell.tsx`; `pages/EmployeesPage.tsx`; `components/ReportCorrectionModal.tsx`

**C** Add the password-reset request queue and surface a count in `AlertsBell` (which currently
only polls tracking alerts). Link each request to that employee's reset action on the Employees
page. Extend `ReportCorrectionModal` to accept `record_type = 'customer'` with `address` as the
only editable field (N3), and surface it from the customer drawer.

**A** A request raised on mobile appears in the web queue within one poll cycle and is visible to
the branch manager but not to other branches. An agent-raised address correction appears in the
existing Correction Requests queue and, on approval, updates `customers.address`.

**T** Extend `backend/test/correction-requests.test.ts` for the `customer` record type and the
address allow-list.

---

### Phase 17 — Verification and regression

**G** Prove the whole thing works. **D** all phases.

**C**
1. Run the full backend suite. Every test passes. Report the actual output.
2. `flutter analyze` and `flutter test` clean.
3. `npm run typecheck && npm run build` clean in `frontend/`.
4. Manual end-to-end on a **physical Android device**: punch in → day plan loads → PTP section
   populated → open a customer → navigate → log a visit with a payment in under 10 seconds →
   row greys and sinks → go offline → log another → alert appears → come back online → it syncs →
   punch out → tracking stops.
5. Manual end-to-end on web for telecaller, branch manager and owner.
6. Confirm the ledger answers the owner's question: *"field_agent_1 contacted 20 Hero customers
   today — 5 PTP, 10 part paid, 10 paid in full."*

**A** Every step above passes and is reported with real output, not assertion.

---

## 9. Deferred — do not build

| Item | Decision |
|---|---|
| OTP login and password reset | A2 — no SMS gateway. Code stays dormant. |
| Device binding / trusted devices | A3 |
| Biometric or PIN unlock, idle timeout, screenshot blocking, moving web tokens off `localStorage` | A7 |
| Push notifications | P9 |
| Mandatory photo proof | I6 |
| Field-referral auto-routing | I8 — plan is in the decision log |
| Offline pre-download and delta sync | F6 |
| Call verification / telephony integration | I7 |
| Localisation | P11 |
| Telecallers on mobile, field agents on web | §1.2 |
| Live map on mobile | F3 |
| Incentive calculator, legal cases, compliance alerts, revenue/commission, planned-visit queue | No backend model — mockup fiction (§1.4) |

## 10. Open questions

Answer before the phase that depends on each.

O1 and O2 were answered on 2026-09-04 and are now S4 and S6 in §2.6. O3 was answered
2026-09-04 and implemented in Phase 0 (migration `1789200000000_inability-to-pay-oc-fv.sql`).
O4 was answered 2026-09-04 and implemented in Phase 1 (§4.7). O5 and O6 were answered
2026-09-04; both still block their respective phase since neither has been implemented yet.

| # | Question | Answer | Blocks |
|---|---|---|---|
| O4 | §4.7 DECIDE — should an admin password reset revoke *nothing*, or only web (NULL-device) tokens? | Only web (NULL-device) tokens — **implemented**, Phase 1. | Phase 1 (done) |
| O5 | When a customer is contacted by phone *and* visited on the same day, is that one interaction record or two? | **One** interaction record; when both a call and a visit happen the same day, the **latest one takes precedence** (overwrites/supersedes the earlier record for same-day dedup purposes, per "customers contacted" not double-counting). | Phase 11 |
| O6 | Will commissions ever be computed from collection numbers? | **No**, not as of 2026-09-04. N4's "whoever recorded it" attribution stands as-is; revisit if this changes. | Phase 12 |
