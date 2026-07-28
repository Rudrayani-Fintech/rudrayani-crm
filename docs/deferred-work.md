# Deferred work

This file exists so decisions to explicitly scope work *out* of the Adoption
Recovery Plan (Phases 0-8) aren't lost. It has sections for: the Phase 9
strict re-verification pass (a line-by-line audit of every phase against
what actually shipped, done because "the PR merged" isn't the same claim as
"the plan item is done"), things the plan itself deferred by decision before
implementation started, and things individual phases scoped down or skipped
during implementation.

## Phase 9 — strict verification audit findings (2026-07-28)

Every numbered item in Phases 0 through 7 was re-checked against the actual
code on `main` (not the PR descriptions that claimed completion), phase by
phase, with file:line evidence. This surfaced real gaps that earlier PRs
missed or silently left unfinished. **Fixed in this pass:**

- **1B.4 — team filter still collapsed to zero on the live-customers path.**
  `baseConditions()` (the snapshot path) was fixed for this in an earlier
  phase, but `liveConditions()` (used for the current, not-yet-snapshotted
  month) still did a bare `c.assigned_team_id = $N`, reintroducing the exact
  team-less-agent collapse-to-zero bug for that one code path. Generalized
  `reportTeamClause()` to take a customer-alias + agent-columns (mirroring
  how `reportBranchClause()` already works) and applied it in both places.
- **1.3 — punch-in had no offline fallback**, unlike every other
  money-critical mobile action. An agent starting a shift in airplane mode
  with no prior cached punch state was permanently locked on the punch-in
  screen — directly contradicting Phase 1's own "Done when" criterion.
  Added a `'punch_in'` queued-action type (`offline_queue.dart`), wired
  `attendance_provider.dart`'s `punchIn()` to enqueue and optimistically
  mark the shift open locally when offline, and special-cased a 409 on
  sync (shift already open some other way) as a silent success rather than
  a surfaced rejection.
- **2.4 — `dpd` not set at import time**, only by the nightly refresh job —
  a freshly imported customer showed `dpd = NULL` for up to ~24h. Now
  computed inline on both insert and update in `import-service.ts`, using
  the same formula the nightly job uses.
- **7.1 — three formatter stragglers** bypassing the shared `rupees()`/
  `lakh()` formatters: `ImportPage.tsx`'s Due Amount/POS/EMI preview columns
  (bare `toLocaleString`, no ₹ symbol) and `OverviewChart.tsx`'s dashboard
  hero total (a third, ad hoc `Intl.NumberFormat` instance). Fixed.
- **7.3 — `today_section.dart`'s reminder/PTP rows** were still `dense: true`
  with no tap-target floor, undercutting `AppDimens.listRow` (56px) despite
  the plan naming this file specifically; the "Today's Actions" header text
  was also still 13px in non-hero mode despite the "14px floor" claim.
  Both fixed.
- **4.3 — redundant pending-count refetch** on `ImportReviewPage.tsx`,
  `CorrectionRequestsPage.tsx`, `ReallocationRequestsPage.tsx`: each fired a
  second, duplicate request for the pending count on every `load()`, even
  while already viewing the pending list (which gets that count for free
  from the same response). Now skipped in that case.
- **`docs/deferred-work.md` itself** — Phase 0 explicitly required writing
  this file "so the list survives this plan." It was never created across
  any of Phases 0-8 until this pass.
- Two items investigated and found to be **non-issues on closer inspection**
  (not fixed, because there was nothing to fix): 0.2's `filterOptions()` —
  flagged as "not branch-clamped," but it queries the `products`/`buckets`
  catalog tables, which have no branch dimension at all (company-wide master
  data, not customer rows) — nothing to clamp. 3.14's `hasTokens()` — flagged
  as "doesn't check expiry," but it's only used to decide whether to attempt
  the optimistic-login-then-verify flow at app-init; the real freshness check
  already happens server-side via `/auth/me`, and making it expiry-aware
  would actually break the deliberate "stay optimistically logged in
  offline" design.
- **1B.9 — `branches.ts`/`teams.ts` GET routes** were flagged as unscoped
  (any authenticated user in the agency can list every branch/team name).
  Reviewed and left open — same reasoning already applied to
  `buckets.ts`/`dispositions.ts`: this is org-structure metadata (names
  only, no financial/customer data), already agency-scoped, and every role
  legitimately needs the full list for pickers. Converted from a silent gap
  to an explicit, documented decision (added the reasoning as an in-code
  comment on both routes) rather than risk breaking legitimate admin/ops
  pickers with an unverified scoping change.

**Found but NOT fixed in this pass — genuinely open, needs a real decision
or a scoped follow-up:**

- **0.6 — password reset is still non-functional in production.**
  `getSmsProvider()` unconditionally returns `ConsoleSmsProvider` — no real
  SMS vendor was ever integrated, so an OTP-based reset never reaches
  anyone, and the "admin types an initial password, SMS invite + first-login
  set-password flow" replacement described in the plan was never built. This
  is the single most severe open item in the whole plan (it's a Phase 0
  "stop the bleeding" item), and it cannot be closed without the user
  choosing a real SMS vendor (Twilio, MSG91, etc.) and providing credentials
  — genuinely blocked on information only the user has, not a code gap that
  can be guessed at.
- **3.9 — worklist search doesn't do what the plan asked.** The backend
  `/worklist?q=` param only searches within the agent's own already-allocated
  result set; it does not let an agent find a customer outside today's
  allocation (the plan's explicit scenario: "precisely what they need when a
  customer calls *them* back"). The mobile client doesn't even call the `q`
  param — it still filters the in-memory loaded list client-side. Widening
  the search scope safely (without reintroducing a Phase-0-style cross-branch
  leak) needs the same `agentBranchClamp()` scoping discipline used
  elsewhere, which is a real but contained fix — deferred here for time, not
  because it's risky to design.
- **3.11 — battery-drain fixes are almost entirely missing.** Only the
  "re-POST the entire ping backlog every tick" bug was fixed. Still absent:
  motion gating, distance filter, accuracy downgrade when stationary,
  punch-out reminder, auto punch-out, and the 300-ping cap still silently
  drops the oldest pings (dropping the morning route) instead of handling
  overflow properly. This was the specific item flagged in this same
  session as "field staff uninstall the app over this" — a real, unresolved
  adoption risk, but building proper adaptive/motion-gated tracking is a
  substantial feature, not a quick fix.
- **6.5 — dashboard chart types never built.** Only the 2-column grid
  landed; no target-vs-actual trend line, bucket-distribution chart, or
  agent-comparison chart exists (still just `OverviewChart`,
  `TrailAnalyticsCard`, and `Gauge` — the exact three the plan named as
  insufficient).
- **6.3 — contactability report and agent-productivity-beyond-raw-counts
  are both fully missing** (no backend, no UI, for either). Raw exports
  (payment register, call-log/trail register, PTP register) also don't
  exist — only customer list has CSV export, from an earlier phase.
- **6.4 — report export has no background job, no timeout guard.** Still
  runs 7 sequential heavy report functions synchronously inside one
  request.
- **4.4/4.8 — URL-synced filters and CSV export were only wired onto
  Customers**, not Allocation/Employees/Worklist (filters) or
  Allocation/Employees/Deposits/Import Review/Worklist/request-queues
  (export), despite the plan naming all of them.
- **5.3 — login routing is still not role-aware**; every role lands on `/`
  regardless of capability, and no distinct branch-manager or agent home
  page exists (a `PendingApprovalsAlert` widget was added as a smaller,
  explicitly-scoped substitute).
- **7.5 — design token sweep never happened.** `space`/`radius` tokens in
  `tokens.ts` still have zero usages anywhere; hardcoded hex colors and
  duplicate title/placeholder Selects remain at roughly the scale the plan
  originally described.
- **1.5 — no responsive table fixes.** The nav-drawer-reopen bug itself was
  fixed, but none of the compounding wide-table issues (`scroll={{x:1500+}}`
  on Customers/Worklist/Allocation, no `responsive:` column hiding, no card
  fallback below `md`) were addressed.
- Smaller residuals, each low-effort but not yet done: **3.3** no inline
  PTP-due quick action on worklist rows (call + log-call only); **3.5** no
  live Indian-grouping input formatter on the payment amount field (only
  comma-strip-before-parse); **3.13** the `LoadingState` primitive exists
  but was only applied to 2 of the 6+ screens named in the plan (worklist,
  customer detail, PTPs, performance, and all three dashboards still use a
  bare spinner); **1B.9** no regression test explicitly exercises "a
  branch_manager with no branch assigned sees zero rows" (the fail-shut
  sentinel logic looks structurally sound on inspection, but is unverified
  by a test).

## Deferred by decision before the plan started

- **Localization (Marathi / Hindi).** The mobile app has zero i18n
  infrastructure and ~400 hard-coded English strings; `main.dart` declares
  no `localizationsDelegates` or `supportedLocales`, so date/time pickers
  are English-only regardless. Revisit if adoption in Sangli/Kolhapur/Latur
  stays low after Phases 1-3 — this remains the largest single untouched
  adoption lever.
- **Contactability data:** multiple phone numbers per customer (there is
  exactly one, `customers.mobile_number`), co-borrower/guarantor records (no
  table), structured address with verification status (`address` currently
  has no dedicated column and lands in `custom_fields` JSON), customer
  language preference.
- **Commercial layer:** agency commission rate card per company/product/
  bucket, invoicing, agent incentive slabs and payouts. A `billing.view`
  permission is seeded with no backing schema at all.
- **Legal and settlement:** settlement offers/waivers/approvals, legal
  notice and Sec-138 tracking, repossession, cheque-bounce/NACH return
  history (`payments.mode` is free text with no instrument table).
- **Field features:** route optimization, in-app maps/turn-by-turn
  navigation, attendance selfie, call recording reference, leaderboard,
  end-of-day summary.
- **Reporting:** cost-per-collection (no cost data in the schema at all),
  aging/roll-rate matrix (raw material exists in `customer_month_snapshots`
  + `buckets.sort_order` but is reduced to a binary resolved/rolled-back
  flag), company-wise settlement split, daily target series (`targets.month`
  is always the 1st).
- **Notifications:** no SMS/notification log table, no delivery receipts, no
  customer-facing messages (no payment-received SMS, no PTP reminder, no
  receipt delivery) despite `reminders` being a first-class table. No email
  channel anywhere.
- **Schema cleanup:** dead `team_leaders_archive` table; `assigned_team_id`
  is only ever the agent's own team at allocation time rather than an
  independent team book (`report-service.ts` explicitly works around this).

## Scoped down during implementation (Phase 8)

- **8.4 — bulk-write rewrite of `commitImport()`'s per-row loop.** The
  per-row INSERT/UPDATE/snapshot-upsert loop in `import-service.ts` was
  identified as the root cause of large imports timing out, but rewriting
  it into `unnest()`/`COPY`-based bulk statements was explicitly raised to
  the user (`AskUserQuestion`) rather than attempted unilaterally, because
  no live Postgres was available in the sandbox to verify `ON CONFLICT`
  semantics for within-batch duplicate loan numbers. The user chose to skip
  the core batching and ship only the safer win (caching the parsed sheet
  across upload/preview/commit so the file isn't re-parsed three times).
  **Still open**: the per-row write loop itself is unchanged and will still
  time out on a large (~20k row) file.
- **8.6 — hard-delete of customers is still hard-delete.** Import rollback
  and run-deletion still `DELETE FROM customers` (and cascade-delete
  `allocation_logs`/`customer_month_snapshots`) rather than soft-deleting.
  Converting this to soft-delete requires a new `deleted_at` column and
  auditing/rewiring every query across the app that reads `customers` to
  filter it out — assessed as a wide-blast-radius, hard-to-verify-without-
  a-live-database change on the same order as the 8.4 decision above, but
  touching far more files, so it was left as-is pending an explicit
  decision on that specific tradeoff. **Still open.**
- **8.6 — TOCTOU narrowing, not full closure.** The "has this customer been
  worked since" checks in `imports.ts`'s rollback/delete handlers were
  moved inside their transactions with `FOR UPDATE` row locks, which closes
  the race against any writer that itself locks the customer row
  (`payments.ts` does). It does **not** close the race against
  `call_logs`/`field_visits`/`ptps` inserts, since those write paths don't
  take a row lock on `customers` at all — closing that fully would mean
  adding `FOR UPDATE` locking to those three insert paths too, which was
  judged out of scope for that pass. **Still open** if a fully airtight
  guarantee is required.
- **8.6 — audit log covers a subset of actions, not the full list.** The
  plan named: employee capability/designation/branch changes, password
  resets, target edits, disposition/bucket master edits, deposit marking,
  customer re-branching, import rollback, and login/logout. The
  `audit_logs` table and `recordAuditLog()` helper now exist and are wired
  into employee designation/branch/team/`is_active` changes, password
  resets, deposit marking, and import rollback/delete — the highest-value
  subset. Target edits, disposition/bucket master edits, customer
  re-branching, and login/logout are **not yet wired up**; extending
  coverage to them is now a small, low-risk follow-up (the pattern and
  table already exist) rather than a new design.

## Standing sandbox limitation (all phases)

No live Postgres database has been available in this development sandbox
across any of the 9 phases. All backend verification has been `tsc --noEmit`
/ `npm run build` plus careful manual review of every query and transaction
boundary touched — never an actual run of the test suite (`vitest run`)
against a real database, and never a manual QA pass through the running
app. This is the single largest gap in confidence across the whole plan and
should be closed before/during a production rollout: run the full
`backend/test/*.test.ts` suite (it already has substantial coverage,
including branch/team scope regression tests and a Phase 1B team-less-agent
test) against a real database, and walk through Phase 9.2/9.3/9.4's manual
role and device checklists by hand.
