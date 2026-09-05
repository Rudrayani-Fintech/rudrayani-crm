# Known Issues — Revamp in Progress

Live checklist, not a chronological log (see `docs/mobile-revamp-decisions.md` for the append-only
decision history behind each of these). Update in place as items are fixed or new ones are found.
Last updated: 2026-09-05, after Phase 7.

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

## 4. Format for adding new entries

When a new phase surfaces a defect that isn't blocking that phase's own verification, add a dated
subsection under the relevant number above (or a new `## N.` section for a new category) with:
what's broken, which file(s), why it happened, and the minimal fix if known. Remove or mark
`[FIXED]` an entry once actually resolved — don't let this file grow stale in the other direction.
