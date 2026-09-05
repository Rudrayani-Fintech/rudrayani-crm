# Known Issues — Revamp in Progress

Live checklist, not a chronological log (see `docs/mobile-revamp-decisions.md` for the append-only
decision history behind each of these). Update in place as items are fixed or new ones are found.
Last updated: 2026-09-05, after Phase 13.

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

### 1e. UTC/IST day-boundary test flake (test bug, not a product bug)
Any test that computes "today" client-side via `new Date().toISOString().slice(0, 10)` while the
server records real `now()` and a route compares it via `... AT TIME ZONE 'Asia/Kolkata'` will
intermittently fail whenever the wall-clock UTC time is between ~18:30 and 23:59 — IST has already
rolled into the next calendar day but the JS-computed "today" string hasn't. Confirmed to
self-resolve (tests pass again) once the UTC clock moves past that window; not a race, purely
time-of-day. Affected so far: `reports.test.ts`'s Phase-12-KPI `/reports/trend` tests,
`tracking.test.ts`'s "route replay > returns the day's ordered points" test. The correct fix is
for the *test* to compute "today" the same way the product code does — `istToday()` in
`backend/src/utils/ist.ts` — instead of a raw JS `Date`/`toISOString()` call. Worth grepping the
whole test suite for this pattern once, rather than fixing file by file as each one is noticed.

### 1f. Pre-existing `Buffer<ArrayBufferLike>` vs `Buffer` type error
`e2e-allocation-lifecycle.test.ts` (line ~441 as of Phase 7) has a supertest `.parse()` callback
whose `Buffer.concat(chunks)` result doesn't satisfy the stricter `Buffer` type ExcelJS expects
under the current `@types/node`. Cosmetic type-checker noise (does not fail at runtime, only
`tsc --noEmit`); been present since at least Phase 2/3 (documented then as "2 pre-existing
errors," this is one of them).

**Current full-suite baseline as of Phase 7 (2026-09-05, wall-clock-independent items only, i.e.
excluding 1e which self-resolves): 11/33 files failing, 80/310 tests failing.** Of those, 4 files
are §1a, and the rest are §1b/1c/1d. Re-run and update this number after fixing any of the above,
or after each further phase if new failures appear.

## 2. Live frontend/backend contract mismatch — expected, sequenced, DO NOT deploy backend-only

**Phase 7 deleted backend routes (`/reports/dashboard`, `/breakdown`, `/agents`, `/recalls`,
`/bucket-movements`, `/bucket-mismatches`, `/export`, all of `/api/targets`) that the CURRENT web
frontend still actively calls**, in: `frontend/src/pages/DashboardPage.tsx`,
`components/AgentDetailDrawer.tsx`, `components/BranchDetailDrawer.tsx`,
`components/dashboard/BreakdownTable.tsx`, `components/dashboard/BucketMismatchCard.tsx`,
`components/dashboard/BucketMovementCard.tsx`, `components/dashboard/RecalledStatTile.tsx`,
`scrapped-features/management-dashboard/ManagementDashboardPage.tsx`.

This is **expected and already accounted for in the spec's own phase ordering** — Phase 15 ("Web:
delete the KPI surface, rework navigation") is what deletes these frontend pages/components to
match. The backend is intentionally ahead of the frontend for 8 phases. This is exactly why the
user directed all phases to land on the `revamp-integration` branch instead of `main`: deploying
`main`/production between Phase 7 and Phase 15 would break the live web dashboard with 404s.
**Do not merge `revamp-integration` into `main` (and do not deploy) until at least Phase 15 has
shipped** — ideally not until the whole revamp is done, per the user's explicit instruction.

## 3. Housekeeping (not urgent, not part of the revamp)

Many stale local/remote branches exist from an older, unrelated phase-numbering scheme (e.g.
`worktree-phase0-stop-the-bleeding`, `worktree-phase6-owner-reports`, `worktree-rbac-branch-
scoping-batch3`, ~20 more). Unrelated to `docs/REVAMP-SPEC.md`'s phases. Safe to leave alone;
worth a separate cleanup pass (confirm each is actually merged/abandoned before deleting).

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

## 7. Format for adding new entries

When a new phase surfaces a defect that isn't blocking that phase's own verification, add a dated
subsection under the relevant number above (or a new `## N.` section for a new category) with:
what's broken, which file(s), why it happened, and the minimal fix if known. Remove or mark
`[FIXED]` an entry once actually resolved — don't let this file grow stale in the other direction.
