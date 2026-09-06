# Known Issues — Revamp in Progress

Live checklist, not a chronological log (see `docs/mobile-revamp-decisions.md` for the append-only
decision history behind each of these). Update in place as items are fixed or new ones are found.
Last updated: 2026-09-06, after a full role-by-role product audit (§9). §2 — the last defect
blocking a merge to `main` — is now fixed.

## Why this file exists

The 18-phase backend/mobile/web revamp (`docs/REVAMP-SPEC.md`) is being built on a dedicated
`revamp-integration` branch, merged to `main`/deployed only once the whole revamp is done — not
phase by phase. That means bugs found mid-revamp don't need to be fixed immediately unless they
block verifying the *current* phase; they can sit here until a dedicated cleanup session. This
file is that holding pen.

## 1. Backend test failures, not yet fixed

All confirmed pre-existing (not caused by any phase 0–7 change) via direct comparison against
`main` before each phase's own changes, or via a forked investigation (Phase 7). None block any
phase's own acceptance criteria so far.

### 1a. Phase 5 fallout — `customers.address` now required, 4 test files never updated
`allocation-import.test.ts`, `bucket-movements.test.ts`, `import-review.test.ts`,
`e2e-allocation-lifecycle.test.ts` all use hardcoded import-column-mapping fixtures with no
`address` column. Since Phase 5 made `address` a required core field at import, every
upload/commit call in these files now 400s. ~31 failing tests across the four files (confirmed
against main at the time). Same category of fix as the two files already patched in the Phase 5
commit (`field-config.test.ts`, `import.test.ts`) — add an `Address` column to each file's mapping
constant/fixture and a value to every fixture row. `e2e-allocation-lifecycle.test.ts` has no
shared mapping constant to patch once; will need per-fixture edits.

### 1b. `customerWriteScopeClamp()` fixture gap, spread across several files
Test customers created via raw SQL with no `assigned_agent_id`/`assigned_field_agent_id` never
match `customerWriteScopeClamp()`, so any customer-scoped write 404s even for that file's own
pre-existing (not new) tests. Confirmed in: `attachments.test.ts`, `reminders.test.ts`,
`customer-detail.test.ts`; very likely also `collection-workflow.test.ts` and
`field-workflow.test.ts` (same symptom shape, not yet root-caused as thoroughly). Already fixed
narrowly, once, inside `offline-idempotency.test.ts` during Phase 6 — that fix (give the fixture
customer both `assigned_agent_id` and `assigned_field_agent_id`) is the template; it was never
swept across the rest of the suite. Worth a dedicated pass since it's one mechanical fix repeated
per file.

### 1c. `org.test.ts` — `POST /api/employees` payload missing `designation`
An earlier phase made `designation` a required enum field on employee creation. This test's
"assigns a manager (Reports to)" flow sends only `capabilities: { is_operations_manager: true }`
with no `designation`, so the create call 400s before the test's own assertions run — cascades
into 5 more tests in the same file that depend on the employee IDs the first call was supposed to
create. Fix: add `designation: "operations_manager"` (etc., matching each test's intent) to the
request bodies.

### 1d. `auth.test.ts` — OTP echo test needs an env var that isn't set anywhere
`otpRes.body.devOtp` is `undefined` because `ALLOW_OTP_ECHO` isn't in `.env`/`.env.example`. Not a
code bug — either set it for the test DB/environment, or gate the assertion behind a check for
whether the env var is configured.

### 1e. [FIXED, 2026-09-06] UTC/IST day-boundary test flake (test bug, not a product bug)
Any test that computes "today" client-side via `new Date().toISOString().slice(0, 10)` while the
server records real `now()` and a route compares it via `... AT TIME ZONE 'Asia/Kolkata'` will
intermittently fail whenever the wall-clock UTC time is between ~18:30 and 23:59 — IST has already
rolled into the next calendar day but the JS-computed "today" string hasn't. Affected:
`reports.test.ts`'s Phase-12-KPI `/reports/trend` tests, `tracking.test.ts`'s "route replay >
returns the day's ordered points" test, and (newly identified during Phase 17's live run)
`day-plan.test.ts`'s whole suite. Fixed in all three files by switching to `istToday()` from
`backend/src/utils/ist.ts` instead of a raw JS `Date`/`toISOString()` call — confirmed via two real
runs during Phase 17: one taken squarely inside the flake window (18 files... 85/313 failing, with
the extra 5 beyond baseline exactly matching these three files) and one taken after the window
closed (80/318 failing, exactly the pre-existing baseline, see §8). A closely related but distinct
timing edge also surfaced in `day-plan.test.ts`: its attendance fixture used
`now() - interval '2 hours'`, which crosses the real IST midnight boundary when the suite runs in
the ~2 hours just after midnight IST (confirmed live: real time 01:22 IST, attendance timestamp
therefore fell on the previous IST calendar day) — this one is inherent to any fixture computing a
"recent" timestamp via a relative interval near midnight and isn't grep-fixable the way the
`istToday()` swap was; it self-resolves a couple of hours into the new IST day and didn't need a
code change once past that window.

### 1f. Pre-existing `Buffer<ArrayBufferLike>` vs `Buffer` type error
`e2e-allocation-lifecycle.test.ts` (line ~441 as of Phase 7) has a supertest `.parse()` callback
whose `Buffer.concat(chunks)` result doesn't satisfy the stricter `Buffer` type ExcelJS expects
under the current `@types/node`. Cosmetic type-checker noise (does not fail at runtime, only
`tsc --noEmit`); been present since at least Phase 2/3 (documented then as "2 pre-existing
errors," this is one of them).

### 1g. [FIXED, 2026-09-06] `GET /reports/agent-activity` 500'd on any date-filtered request
Found via live E2E during Phase 17 (the exact request the "Agent Daily Activity" web page sends by
default), not by any test — this endpoint had zero test coverage before Phase 17 added
`test/agent-activity.test.ts`. Two independent bugs in `agentRecentActivity()`
(`backend/src/services/report-service.ts`), both pre-existing (predate Phase 8, unrelated to any
phase-10-through-17 change):
1. `dateFor()`'s template contains the `{COL}` placeholder twice (`>= {COL} ... < {COL}`) but
   substituted it with `.replace()`, which only replaces the first occurrence — every date-filtered
   call left a literal `{COL}` in the generated SQL and Postgres 500'd with "syntax error at or near
   '{'". Fixed by switching to `.replaceAll()`. Grepped the rest of the codebase for the same
   `.replace("$X"/"{X}", ...)` pattern (the same bug class as the `scopeFilter()` `$SCOPE` bug fixed
   2026-07-18, see `rudrayani-crm-project-state` memory) — no other live instances found.
2. The 4-branch `UNION ALL` (call/payment/ptp/field_visit) only defined column aliases on the
   `call` branch, relying on Postgres inheriting those names for the whole UNION. That inheritance
   only happens when a UNION is actually formed with `call` as a member; filtering to a single
   `action_type` that excludes `call` (e.g. `action_type=ptp` alone) leaves just one un-aliased
   SELECT, so Postgres falls back to each column's own source name (`pt.created_at` → `created_at`,
   not `at`) and `ORDER BY at DESC` 500'd with "column 'at' does not exist". Fixed by giving every
   branch its own full, consistent set of aliases matching `AgentActivityRow`'s field names.

**Current full-suite baseline, confirmed via a real run against the Docker Postgres container on
2026-09-06 (Phase 17, after the 1e flake window closed): 11/34 files failing, 80/318 tests
failing.** This is the exact same 80-test count as the Phase 7 baseline (34 files / 318 tests now,
not 33/310, because Phase 16 added 3 passing `correction-requests.test.ts` cases and Phase 17 added
a new 5-test `agent-activity.test.ts` file, both green) — confirms **zero regressions** across
every phase from 8 through 17. Re-run and update this number after fixing any of §1a-§1d, or after
each further phase if new failures appear.

## 2. Live frontend/backend contract mismatch — fully resolved as of 2026-09-06

**Phase 7 deleted backend routes** (`/reports/dashboard`, `/breakdown`, `/agents`, `/recalls`,
`/bucket-movements`, `/bucket-mismatches`, `/export`, all of `/api/targets`) **that the web
frontend called.** Phase 15 ("Web: delete the KPI surface, rework navigation") shipped
2026-09-05 and closed most of this gap — but not all of it. Two different situations now:

### 2a. RESOLVED by Phase 15
`frontend/src/pages/DashboardPage.tsx`, `pages/ReportsPage.tsx`, `pages/TargetsPage.tsx`, and
`scrapped-features/management-dashboard/ManagementDashboardPage.tsx` (plus the KPI-only
`components/dashboard/*` widgets nothing else imported: `widgetRegistry.tsx`,
`DashboardCustomizer.tsx`, `Gauge.tsx`, `MetricPanel.tsx`, `MetricTabsCard.tsx`,
`RecalledStatTile.tsx`, `BucketMovementCard.tsx`, `BucketMismatchCard.tsx`, `SummaryStat.tsx`,
`PendingApprovalsAlert.tsx`, `SetupChecklist.tsx`, `OverviewChart.tsx`, `DepositsRangeCard.tsx`,
`ExceptionPaymentsCard.tsx`, `TrailAnalyticsCard.tsx`) are all **deleted outright.** `/` now
redirects to `/agent-activity` (managers/owners) or `/my-worklist` (individual contributors) —
see `mobile-revamp-decisions.md`'s Phase 15 section for why the redirect is role-conditional, not
a single static target.

### 2b. [FIXED, 2026-09-06] The org-chart drill-through drawers
`components/dashboard/BreakdownTable.tsx` called the deleted `GET /reports/breakdown` and
`components/AgentDetailDrawer.tsx` the deleted `GET /reports/dashboard?agent_id=`. Neither file was
in Phase 7's or Phase 15's file list, so both had been calling dead endpoints since Phase 7.
Reproduced live during the post-Phase-17 audit: on `OrgChartPage`, clicking an agent gave a
completely blank drawer plus a red "Not found" toast, and clicking a team or branch gave an empty
Breakdown table; `BranchesPage`'s drawer hit the same thing. Network capture showed
`/api/reports/dashboard` → 404 and `/api/reports/breakdown` → 404.

Fixed by restoring `GET /reports/breakdown`. The important detail for anyone re-reading the Phase 7
diff: **only the HTTP route was ever deleted** — `dimensionBreakdown()` in `report-service.ts`
stayed live the whole time and is already reused by `GET /employees/org-hierarchy
?with_performance=true`. So this is a thin re-exposure of a proven, already-scope-clamped
aggregate, not a reimplementation, and it needed no change to `BreakdownTable` at all.
`AgentDetailDrawer` now reads the single agent-dimension row from the same endpoint, so all three
drawers share one endpoint and one clamp.

Worth recording why the row-level alternative was rejected: `BreakdownTable`'s columns (allocated,
resolution/rollback/normalization/recovery %, target, achievement) are **not derivable** from
`/reports/agent-activity` or `/reports/trail`, which are event feeds. "Repoint at a surviving
endpoint" was only possible because the surviving thing was the aggregate service, not those feeds.

Verified live after the fix: agent drawer shows Allocated 9.36L (6) / Collected 0.03L plus its
activity timeline, team drawer shows a per-agent breakdown, branch drawer shows team details plus
the agent-wise breakdown — all calls 200, no error toast.

**This was the last item blocking a merge of `revamp-integration` into `main`.** That merge is now
a product decision rather than a known-defect blocker; per the user's standing instruction it still
happens only when they explicitly ask for it.

## 3. Housekeeping (not urgent, not part of the revamp)

Many stale local/remote branches exist from an older, unrelated phase-numbering scheme (e.g.
`worktree-phase0-stop-the-bleeding`, `worktree-phase6-owner-reports`, `worktree-rbac-branch-
scoping-batch3`, ~20 more). Unrelated to `docs/REVAMP-SPEC.md`'s phases. Safe to leave alone;
worth a separate cleanup pass (confirm each is actually merged/abandoned before deleting).

`backend/src/migrations/seed_demo.ts` fails on its own customer-import step with `HttpError: The
template must map a column to "mobile_number"` (found while seeding fixtures for Phase 17's live
web E2E, 2026-09-06). It successfully creates the demo users (Priya/Rahul/Sneha/Amit) first, so the
failure is isolated to the import-column-mapping constant used for its demo customers, which has
gone stale relative to `import-service.ts`'s current required-field validation — the same general
class of drift as §1a (a hardcoded column-mapping fixture not updated when a required field
changed), just in dev tooling rather than a test file. Not chased further since it wasn't blocking;
worth a one-line fix (add a `mobile_number` mapping to the constant) whenever someone next needs
`seed:demo`'s full output including its sample customers.

## 4. Mobile: Phase 9 deferrals

### 4a. The "seven raw-setState screens" were not migrated onto AccountRepository/a provider
Phase 9 (§7) built the core architecture in full -- `Account` model, `AccountRepository`,
IndexedStack removal, named `HomeTab` identity, the router redirect split, the X4 pull-to-refresh
fix, and the `riverpod_generator` cleanup -- but deliberately did not migrate
`generic_list_screen.dart`, `employee_detail_screen.dart`, `login_screen.dart`,
`call_log_screen.dart`, `field_visit_screen.dart`, `payment_screen.dart`, `ptps_screen.dart`'s
hand-rolled `_loading`/`_error`/`_data` fields onto a proper provider. These are money-critical
write flows (payments, field visits, PTPs) with real side effects (GPS, camera, the offline
queue) that are genuinely risky to rewrite without a physical device to verify against -- not
something to rush through on faith. `generic_list_screen.dart`/`employee_detail_screen.dart` are
the lowest-risk pair to start with (read-only, no offline-queue interaction) if this is picked up
later.

### 4b. Deep links to `/account/*`/`/customer/*` no longer enforce the punch-in guard
The router redirect split (§7.6) put the punch-in check on `/login`, `/punch-in`, and `/home`
individually rather than as one function evaluated for every route. In normal use this is
equivalent (those routes are only reached by navigating from `/home`, which itself guards
punch-in), but a *deep link* straight to e.g. `/customer/:id` (there is no push-notification
deep-linking implemented yet, so this is currently theoretical) would no longer redirect an
un-punched-in user to `/punch-in` first. Add the same `redirect` to those routes (or wrap them in
a shared parent route) if/when deep-linking is built.

## 5. Mobile: Phase 10-11 scope cuts and follow-ups

### 5a. Today screen's company filter is loaded-page-only, not server-side
§4.1 lists `company_id` among the filters "both clients must use ... instead of filtering
client-side," but the Today screen dropped the company filter dropdown entirely rather than half-
implement it: it doesn't compose with server-side pagination without a `company_id` on the
`Account` model (currently only `companyName`, a display string). Company is still visible on
every row (P10). Worth adding properly (model field + filter param) in a later mobile pass if a
company filter is wanted back.

### 5b. "Most-used" trail-code ordering is local-device-only
`DispositionUsageStore` (Hive) tallies usage per device, not per agent account -- an agent who
switches phones, reinstalls, or clears app data starts the most-used ordering over from zero. This
was a deliberate **DECIDE** resolution (§0.1: simplest option), not an oversight; revisit only if
agents report the reset as actually disruptive in practice.

### 5c. Log Visit no longer captures a photo or GPS point
Per §5.1's literal component list, the merged Log Visit screen (Phase 11) doesn't offer photo/GPS
capture at all -- previously `field_visit_screen.dart`'s "Met customer" outcome required one.
Continuous background tracking (X2) still records agent location roughly every 2 minutes while
punched in, and I6 already held photo proof non-mandatory. If per-interaction photo evidence turns
out to still be wanted (e.g. for dispute resolution), it would need `field_visits` to gain a
`disposition_code_id` (or an equivalent link) since that table isn't the write path any more --
Log Visit now submits to `POST /call-logs` (see `mobile-revamp-decisions.md`'s Phase 11 section
for why).

### 5d. "Mark customer as Closed" has no mobile UI any more
`payment_screen.dart`'s close-customer toggle was deleted with the rest of that screen. This
mirrors an existing Phase 6 product decision (`embedded-payment-service.ts`'s own doc comment:
closing a customer from inside a call/visit form was ruled out of scope then too), not a new gap.
The standalone `POST /payments` `close_customer` path is unchanged and still used by web/offline
replay -- there's simply no mobile screen driving it directly. Revisit only if closing a customer
from the field turns out to be a real workflow need.

## 6. Mobile: Phase 12-13 scope notes

### 7a. My Day's "this month" figures are a composition of two endpoints, not one
`/tracking/team-day` only accepts a single `date`; `/reports/agent-activity` has no date-range
filter. My Day's month view therefore calls `/reports/trail` (contacted, PTPs set) and
`/reports/overview` (collected) separately and shows them together. Functionally correct, but two
requests instead of one, and there's no "Visits this month" figure at all (no kept endpoint gives
a month-range field-visit count, and it's a shrinking metric now that Phase 11 routes field-agent
interactions through `/call-logs` instead of `/field-visits` anyway). A dedicated aggregate
endpoint would be cleaner if a future phase revisits reporting.

### 7b. Branch's "tap through to an agent's day" is a bottom sheet, not a separate screen
§5.1 says "tapping through to that agent's day" without specifying the UI shape. The row already
carries everything (`GET /tracking/team-day` returns the full day's numbers per agent), so a
bottom sheet was the simplest option consistent with the rest of the spec (§0.1) rather than
building a new route/screen and a second request for data already in hand. Revisit only if a
branch manager wants something more persistent (e.g. comparing two agents side by side).

### 7c. `rawFields` on history-timeline entries is now write-only
`history_timeline.dart`'s `_HistoryEntry.rawFields` was populated for the correction-request
dialog (Phase 13 deleted the dialog and its call site, mobile-only per P1 — web keeps its own
correction-request UI). The field itself was left in place rather than threading its removal
through every construction site for zero behavioural gain; it's simply unread now. Harmless, but
worth deleting outright if `history_timeline.dart` gets touched again for another reason.

## 7. Web: Phase 14-15 scope notes

### 7a. My Worklist's company filter is dropped, matching mobile's Phase 10 decision
`WorklistCustomer` (the `/worklist` response shape) carries `company_name` but no `company_id` --
the backend's `/worklist` filter accepts `company_id`, not a name string, so a company filter here
was always client-side-only (derived names, `.filter()`'d in the browser). That doesn't compose
with real server-side pagination (Phase 14): filtering a company on only the current 50-row page
would silently hide matches sitting on other pages. Dropped outright rather than half-fixed, same
call as mobile's Today screen (Phase 10) for consistency across clients. Company is still a visible
table column. Revisit only alongside adding a real `company_id` to the worklist response.

### 7b. Bug found and fixed during Phase 14: "Due Today" never auto-opened
`MyWorklistPage.tsx`'s PTP/reminder Collapse used `defaultActiveKey={dueCount > 0 ? ["due"] : []}`
-- a *default* prop, read only once at mount. `reminders`/`ptpsDue` are both empty until the async
`load()` resolves, so `dueCount` was always `0` at that first render; the section silently never
auto-opened even when PTPs were genuinely due, directly contradicting this phase's own "PTPs due
are visible without scrolling" acceptance criterion. Not a new regression from this phase's other
changes -- pre-existing, just never triggered a visible failure because nobody was checking this
specific accept criterion before. Fixed: `Collapse` is now controlled (`activeKey`/`onChange`), and
an effect opens it the first time `dueCount` transitions above zero.

## 8. Phase 17 verification status -- all six items ran, with real output

Phase 17 ("prove the whole thing works") asks for six things. As of 2026-09-06, all six have
actually run, against a live Docker Postgres and a real dev server, with genuine output -- not
assertion. One item (physical-device mobile E2E) has a partial substitute noted below since no
physical Android device exists in any session's environment; every other item is fully done.

### 8a. Backend/frontend/mobile checks (real output)
1. **Full backend suite** (`cd backend && npm run migrate:up && npm test`, against
   `rudrayani_postgres` in Docker): **11/34 files failing, 80/318 tests failing** -- exactly the
   Phase 7 pre-existing baseline (see §1's closing paragraph). Two genuine, previously-undiscovered
   bugs were found and fixed along the way (§1g), plus the §1e UTC/IST flake was fixed outright
   rather than merely documented. Zero regressions from any of Phases 8 through 17.
2. **`flutter analyze` / `flutter test`** in `mobile/`: clean / 94/94 passing (same 4 pre-existing
   `ptps_screen.dart` info-level lints present since before Phase 10 -- unrelated to this work).
3. **`npm run typecheck && npm run build`** in `frontend/`: both clean.
4. **`npm run typecheck` and `npm run build`** in `backend/`: both clean.

### 8b. Manual web E2E for telecaller, branch manager, owner (real, live)
Ran against the actual dev stack (Vite dev server + `npm run dev` backend + Docker Postgres), not
simulated:
- **Telecaller** (Priya Sharma): logged in, landed on `/my-worklist` correctly, logged a call
  (auto-composed remark from the disposition code's description persisted correctly to
  `call_logs`), recorded a ₹2,000 UPI part-payment (persisted to `payments`), and watched the
  worklist re-sort in real time -- the logged-call customer's row sank to the bottom and picked up
  a disposition-code tag and "a few seconds ago" timestamp, confirming Phase 14's worked-state sort
  live, not just in tests.
- **Branch manager** (a temporary `branch_manager` demo user): logged in, landed on
  `/agent-activity` (branch_manager has `reports.view`), correctly saw the telecaller's activity
  scoped to her own branch.
- **Owner/agency_admin**: logged in, landed on `/agent-activity`, saw both actions with correct
  customer/company/product/branch/bucket/amount/disposition columns and no errors.
- **One real bug found and fixed as a direct result of this pass**: the Agent Daily Activity page
  showed three "Internal server error" toasts on load, from `GET /reports/agent-activity` 500ing --
  see §1g for the two root causes and fixes. Confirmed clean (zero errors, real data rendering
  correctly) after the fix, via the same live page.
- Browser-automation note: AntD's multi-select "Result Code" dropdown resisted the standard
  click/find/type tool calls (a recurring category of issue with this component per prior-session
  memory) -- worked around by dispatching a full synthetic pointerdown/mousedown/pointerup/
  mouseup/click event sequence via `javascript_tool` rather than the single-event click the
  automation tools issue by default. Not a product defect; noted here only so a future automated
  E2E pass doesn't waste time rediscovering the same tooling quirk.

### 8c. The owner's ledger question (item 6) -- confirmed both ways
Confirmed twice: once at the code level (new `test/agent-activity.test.ts`, 5 passing tests
covering single-agent, `browse=all` multi-agent rollup, product filtering, and per-`action_type`
narrowing -- including the exact "5 PTP, 10 part paid" shape via an `action_type=ptp`-only
request, which is what originally surfaced the §1g bug #2), and once live: the telecaller's real
call + payment from 8b showed up correctly, with correct amounts and disposition, on the
admin/owner's Agent Daily Activity page filtered to that day. The mechanism the owner's question
depends on -- per-agent, per-day, filterable by product/action-type, with correct totals -- is
proven to work end-to-end, not just that the endpoint returns *a* number.

### 8d. Physical-device mobile E2E (item 4) -- still needs a real device
No physical Android device or emulator exists in this or the prior session's environment. This
remains the one item that genuinely needs a person with real hardware to walk through: punch in →
day plan loads → PTP section populated → open a customer → navigate → log a visit with a payment
in under 10 seconds → row greys and sinks → go offline → log another → alert appears → come back
online → it syncs → punch out → tracking stops. Everything *around* this flow (the same logic
paths, exercised via the web equivalent and the backend test suite) is now verified; only the
physical-device-specific concerns (GPS accuracy, foreground-service reliability, real airplane-mode
behavior, battery/permission prompts) remain unconfirmed.

### 8e. What this means for merging to `main`
Phases 0-16 are implemented and verified (see each phase's own commits and
`mobile-revamp-decisions.md` sections). Phase 17 is now done for every item except the
physical-device pass in 8d. §2 of this file separately documents that the
`BreakdownTable.tsx`/`AgentDetailDrawer.tsx` gap is still open (unrelated to Phase 17's own gate).
A physical-device pass is still worth doing before a real production rollout to real field agents,
but it is no longer a *blocker* discovered by this session -- everything automatable, plus a real
live web QA pass across all three roles, is done and green.

## 9. Full-product audit, 2026-09-06 — what it found

A role-by-role pass through the live product (Docker Postgres + both dev servers), acting as owner,
branch manager, telecaller and field agent, plus a static audit of all 118 backend endpoints and
every source file in the three codebases. Everything below is either already fixed or recorded
here deliberately.

### 9a. [FIXED] Branch managers saw ZERO customers after an import
The highest-severity find, and silent: the import reported "12 inserted, 0 errors" while leaving
every branch manager blind to their whole book.

`customer_branch` was seeded (migration `1787400000000`) with `is_core = false` **and** an explicit
`is_enabled = false` `company_field_settings` row per company. `resolveFieldCatalog()` resolves
enablement as `COALESCE(settings.is_enabled, definition.is_core)`, so the field was off for every
company, never appeared in the import mapping dropdown, and `customers.branch_id` stayed NULL on
every imported row. `customerBranchClamp()` matches on `c.branch_id` with a
`custom_fields->>'branch'/'Branch'` fallback — and an Excel header of "Customer Branch" lands under
the key `"Customer Branch"`, which that fallback never hits. So the clamp matched nothing.

What made it hard to spot from the outside: the same branch manager still correctly saw their own
*staff* (`GET /employees`, `/day-plan`, `/tracking/live` all scope via the agent, not the customer),
so it looked like missing data rather than broken scoping. Reproduced: Pune BM saw 0 of 12; after
enabling that one field and re-importing, exactly their own 6.

Fixed in migration `1790000000000` + `CORE_FIELD_DEFINITIONS_SQL`: `customer_branch` is now core and
enabled by default, and existing explicit-`false` rows are flipped. Deliberately **not** made
required — a file with no branch column must still import, leaving `branch_id` NULL for those rows.

**Residual gap, by the owner's explicit choice** (they picked "make it core by default" over
"derive branch_id from the resolved agent"): rows imported *before* this fix still have
`branch_id = NULL`, and a file with no branch column still produces NULL. If a production branch
manager reports an empty list, the backfill is:
```sql
UPDATE customers c SET branch_id = u.branch_id
  FROM users u
 WHERE c.branch_id IS NULL
   AND u.branch_id IS NOT NULL
   AND (c.assigned_agent_id = u.id OR c.assigned_field_agent_id = u.id);
```

### 9b. [FIXED] Imports put field agents in the telecalling column
`resolveAgents()` ignored the resolved user's type and always wrote `assigned_agent_id`, never
`assigned_field_agent_id`, even though the two are parallel tracks with their own allocation
endpoints (`/allocations/assign` vs `/allocations/assign-field-agent`). Worklist reads both columns
so agents still saw their customers, which is why nothing looked broken. Now routed by
`is_field_agent`, with the `allocation_logs` comparison, the `FOR UPDATE` select, the
`import_row_backups` payload and the rollback allow-list all updated to match.

### 9c. [FIXED] Dead code removed
- `report-service.ts`: `collectedToday()`, `collectionByType()`, `collectionByChannel()`,
  `filterOptions()` and their types — all written for the Management Dashboard that Phases 7/15
  deleted, zero references anywhere (-141 lines). Also `isCurrentMonth()` and `liveConditions()`,
  which lint had already been flagging as unreachable.
- Four orphaned API surfaces with no caller in either client: `/api/dashboard-preferences`
  (+ its route, test and the `dashboard_preferences` table, migration `1790100000000`),
  `/api/setup-status`, `GET /reports/trend` (+ `collectionTrend()`), `POST /products/normalize`.
- Frontend: `MetricBlock`/`MetricKey`/`DashboardData`/`METRIC_TITLES` from `dashboard/types.ts`
  and `compactCount()`/`metricValue()` from `dashboard/format.ts`.

**Deliberately KEPT despite having no caller today**, by the owner's decision:
`GET /reports/deposits-range` and `GET /reports/exceptions`. Cash-deposit reconciliation by date
range and anomalous-payment review are plausible near-term needs for a collections business; they
are dormant, not dead. Don't "clean these up" without asking.

There is **no dead code left in `frontend/src` or `mobile/lib`** — every file and every public
widget class is reachable. (A naive scan flags eight mobile classes such as `AuthNotifier` and
`TodayWorklistNotifier`; those are Riverpod notifiers referenced by their provider in the same
file, i.e. false positives.)

### 9d. Verified working (no action needed)
Exercised against the live stack, not asserted: all **62 OC and 41 FV trail codes** log
successfully; PTP auto-creation fires on exactly the promise codes and correctly skips
broken-promise ones; `exits_agent_queue` returns the customer to the unallocated pool (7 codes);
per-disposition required-field validation; remark composition with placeholder substitution plus
free-text notes, and remark editing restricted to the author; idempotent replay via `client_key` on
both call logs and payments; cross-branch writes blocked; punch in/out; GPS ping ingestion, live
tracking, and route replay (self allowed, other agents 403, team map manager-only); field visits
with embedded payments; correction requests end to end including allowed-field enforcement;
reallocation requests; attachments; the customer-360 payload; employee CRUD with the
"telecaller must report to a manager" rule and branch managers blocked from creating staff in
another branch; the password-reset queue; deposit reconciliation; and the agent-activity report
across 17 filter combinations plus xlsx export (admin and branch-manager-scoped).

### 9e. Open observations — not bugs, but worth a decision
1. **Login rate limit may be too tight for a real office.** `loginRateLimiter` allows 20 attempts
   per 15 minutes **per IP**. A collection agency where 30+ agents log in from one NAT'd office
   connection each morning would lock itself out; the comment claims the window is "generous enough
   not to lock out a shared-NAT office network", which this audit's own usage disproved (hit it
   just by testing). Consider keying on phone+IP, or raising the cap.
2. **`attendance-records` has zero test coverage** despite being used by the web Attendance page.
3. **`seed_demo.ts`'s customer import is broken** (stale column mapping, missing `mobile_number`) —
   see §3. Dev tooling only.
4. **Naming convention in `backend/src/jobs/` is undocumented**: kebab-case files hold the logic
   (`purge-pings.ts`), snake_case files are thin CLI runners for the npm scripts
   (`purge_old_location_pings.ts`). Consistent once you know, confusing until then.

### 9f. Code quality assessment
Genuinely good discipline for a codebase this size (~13.7k backend, ~12.9k frontend, ~7.6k mobile
lines): **one** `TODO` in the entire tree, **zero** stray `console.log` in production paths, and
only ~10 uses of `any` across both TypeScript codebases. Comments consistently explain *why* rather
than restating the code, and several carry the history of a past bug — which is what made this
audit's root-causing fast. Backend lint sits at 12 pre-existing errors (mostly `prefer-const` and
unused test variables), down from 14.

Complexity hotspots worth watching, none urgent: `report-service.ts` (~1.2k lines after the
deletions), `routes/employees.ts` (1144), `pages/ImportPage.tsx` (1174), `pages/AllocationPage.tsx`
(922).

## 10. Format for adding new entries

When a new phase surfaces a defect that isn't blocking that phase's own verification, add a dated
subsection under the relevant number above (or a new `## N.` section for a new category) with:
what's broken, which file(s), why it happened, and the minimal fix if known. Remove or mark
`[FIXED]` an entry once actually resolved — don't let this file grow stale in the other direction.
