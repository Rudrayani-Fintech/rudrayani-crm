# Handoff — Rudrayani CRM Revamp

Read this first in a new session. It's the "how do I pick this up" briefing —
`docs/REVAMP-SPEC.md` is the *what to build*, `docs/mobile-revamp-decisions.md` is the *why*
behind decisions already made, `docs/KNOWN-ISSUES.md` is the *what's already broken and known
about* checklist. This file exists because a fresh session has none of the prior conversation
context that produced those three documents.

**Last updated:** 2026-09-05, immediately after Phase 9.

---

## 1. Where things actually stand

- **Phases 0-9 of 18 are done**, verified, and live on the `revamp-integration` branch (pushed to
  `origin`). Phase-by-phase summary: §5 below.
- **`main` is NOT the integration branch for this work.** `origin/main` auto-deploys to production
  (Railway). Phase 7 deleted backend routes the current web frontend still calls (see
  `KNOWN-ISSUES.md` §2) — deploying anything from this revamp before Phase 15 ships would break
  the live web dashboard. Every phase from Phase 8 onward lands on `revamp-integration`, not
  `main`. (Phases 0-7 *are* also present on local `main` in the primary checkout, from before this
  branch existed — that's a historical artifact of how those phases were merged, not something to
  repeat or worry about; just don't push local `main` anywhere.)
- **Nobody has `revamp-integration` checked out** in any worktree as of this writing — pushing
  directly to it (`git push origin HEAD:revamp-integration`) after merging your phase's branch
  into it locally is the simplest path. If a future session finds someone already has it checked
  out, see §4's git-workflow notes for the workaround used once already this session.
- **The mobile app (`mobile/`) is the current focus** — Phases 8-13 are all mobile, Phases 14-16
  are web, Phase 17 is final verification. Phases 0-7 were 100% backend and are done.

## 2. Standing instructions from the user (do not relitigate these)

1. **Never push to `origin/main`** unless explicitly told to, and only once the *entire* revamp
   is complete and verified — "no half measures." Push phase work to `revamp-integration` freely.
2. **One worktree per phase** (or a bundled phase-pair, e.g. "8 and 9", "2 and 3" — the user has
   asked for pairs before when moving fast). Implement, verify, commit, merge `--no-ff` into a
   local tracking branch of `revamp-integration`, push that to `origin/revamp-integration`, delete
   the worktree/branch. Don't leave stray worktrees lying around.
3. **Testing approach (decided 2026-09-05, mid-Phase-8/9)**: write and run each phase's own
   spec-named acceptance tests only. Do **not** do the Phase-0-7-style deep regression triage
   (full-suite-vs-baseline file-by-file comparison, forking to explain every unrelated
   pre-existing failure) every phase — that's what burned most of Phase 7's budget for
   comparatively low value. Full-suite/full-regression verification is Phase 17's explicit job;
   don't repeat it early. If something *looks* like a genuine new regression (not just "this
   unrelated file already failed"), it's still worth a quick look — use judgement.
4. **Document every deviation and every deferral.** If a phase's literal instruction can't be
   fully completed in scope (like Phase 9's seven-screens migration), do the clearly-specified,
   bounded, high-value part in full, and write down precisely what was skipped and why in both
   the relevant commit message and `docs/mobile-revamp-decisions.md` — never silently drop scope.
   `docs/KNOWN-ISSUES.md` is where *bugs/defects* discovered along the way go (whether or not
   caused by this revamp); `mobile-revamp-decisions.md` is where *decisions and deviations* go.
5. **Read `docs/KNOWN-ISSUES.md` before assuming something is a new bug.** Several categories of
   pre-existing test failures are already catalogued there with root causes.

## 3. Git workflow mechanics (gotchas hit this session)

- `EnterWorktree` defaults to branching from `origin/<default-branch>` (i.e. `origin/main`), which
  is **stale** relative to `revamp-integration`. Immediately after creating a worktree for the next
  phase: `git fetch origin revamp-integration && git merge --no-ff --no-edit origin/revamp-integration`
  before doing anything else, or the new work won't build on the prior phases.
- A worktree-isolated session's shell is guarded against git commands that "name git in a form too
  complex to verify it stays inside the worktree" — multi-step chained commands (`git add X &&
  git commit -m "..."` in one call, or anything piping through `sed -i` with unusual flags) get
  refused. Split git operations into separate, simple, single-purpose Bash calls. Write long
  commit messages to a temp file and use `git commit -F <file>` rather than a giant inline `-m`.
- If `main` (or whatever you need to merge into) is checked out in another worktree you can't
  touch, you can still fast-forward its ref without checking it out, entirely from your own
  worktree, via plumbing — this was needed once (Phase 7, merging into local `main` while the
  primary checkout held it):
  ```
  git rev-parse <target-branch>          # old tip
  git rev-parse HEAD                     # your new tip
  git commit-tree HEAD^{tree} -p <old-tip> -p HEAD -m "Merge ..."   # new merge commit
  git update-ref refs/heads/<target-branch> <new-commit> <old-tip>  # fast-forward with a safety check
  ```
  This shouldn't be necessary for `revamp-integration` specifically (nobody has it checked out),
  but keep it in your back pocket.
- The `Write`/`Edit` tools sometimes render invisible control characters (e.g. `` used as a
  cache-key separator in `worklist_provider.dart`/`account_repository.dart`) as literally invisible
  in `Read` output, which makes an `Edit` `old_string` match fail even though the file content is
  actually correct. If an edit mysteriously won't match around a "separator" or similar low-level
  string constant, `cat -A` (or hexdump) the actual bytes before assuming something's broken — it
  may already be fine.
- Git commands touching CRLF-normalized files print `warning: ... LF will be replaced by CRLF ...`
  constantly in this repo/OS combination. Harmless noise, not an error.

## 4. Technical patterns and gotchas worth knowing before touching either codebase

### Backend (`backend/`, Node/Express/TypeScript/pg, still relevant for Phases 14-16)
- `AT TIME ZONE 'Asia/Kolkata'` binds to the *bare* right-hand expression, not `timestamp +
  interval`. Always parenthesize: `((col + interval '1 day') AT TIME ZONE 'Asia/Kolkata')`. Hit
  this bug independently at least three times across the session.
- The whole backend test suite shares **one real Postgres DB**, not per-file fixtures.
  `users.phone` is globally unique — grep the existing phone-prefix ranges across `test/*.ts`
  before picking a new one for a new test file's fixtures.
- Tests that compute "today" via `new Date().toISOString().slice(0, 10)` (JS, UTC-based) while the
  server compares against real `now()` via IST-aware SQL will flake whenever UTC wall-clock time is
  between ~18:30-23:59 (IST has already rolled to the next calendar day). Use the equivalent of
  `istToday()` (`backend/src/utils/ist.ts`) in tests instead, or expect intermittent failures at
  certain times of day. See `KNOWN-ISSUES.md` §1e.
- `customerWriteScopeClamp()` requires a customer fixture to have `assigned_agent_id` and/or
  `assigned_field_agent_id` set, or any customer-scoped write 404s — several test files still don't
  do this (`KNOWN-ISSUES.md` §1b).

### Mobile (`mobile/`, Flutter/Riverpod/GoRouter, the current focus)
- **Design tokens already existed** before Phase 8 (`AppColors`/`AppSpacing`/`AppRadius`/
  `AppDimens`/`AppTextStyles.tabularNums`, all in `core/theme/app_theme.dart`) — Phase 8 built the
  *component library* on top of them, it did not invent the tokens.
- **The typedef-alias bridging pattern**, used twice this session to avoid touching untouched
  feature screens while still doing a "real" architectural rename:
  ```dart
  typedef OldName = NewImplementation;
  ```
  Works for classes with matching constructor signatures (all named params compatible) — every
  existing `OldName(...)`/`.fromJson(...)`/field access keeps compiling, because the alias *is*
  the new type, not a wrapper. Used for `Customer = Account` (`core/models/customer.dart`) and
  `LoadingState/EmptyState/ErrorState/InlineErrorNote = AppLoadingState/AppEmptyState/AppErrorState/
  AppInlineErrorNote` (`core/widgets/state_views.dart`). Reach for this again whenever a phase asks
  for "one X model/pattern" but explicitly says not to touch existing screens yet.
- **Hive/`connectivity_plus`/`path_provider` platform channels are not mockable anywhere in this
  test suite.** Established pattern (see `test/offline_queue_test.dart`,
  `test/home_shell_dashboard_role_test.dart`, and now `test/account_repository_test.dart`): don't
  try to test code that touches `ReadCache`/`OfflineQueueNotifier`/Hive boxes end-to-end. Extract
  the *pure* logic pieces (a classifier function, a cache-key builder, a decision function) as
  standalone top-level functions and test those in isolation instead.
- **`AccountRepository`** (`core/data/account_repository.dart`) is now the one place `Account`
  reads happen (`fetchWorklist`, `fetchById`) and writes are queued (`enqueueWrite` — delegates to
  the existing `OfflineQueueNotifier`, doesn't reimplement queueing). `worklistProvider`/
  `customerByIdProvider` (`features/worklist/worklist_provider.dart`) are thin wrappers over it —
  route any *new* account-related fetch through the repository, not a fresh hand-rolled provider.
- **`HomeTab` enum** (`features/home/home_shell.dart`) is the named-tab-identity pattern — a
  `_HomeTabEntry` list pairs each tab's identity, its `NavigationDestination`, and a lazy
  `WidgetBuilder`; the active tab is found by identity (`indexWhere`), not by a stored position.
  Reuse this shape if another conditionally-sized tab/section list needs the same treatment.
- **Router redirects**: prefer per-route `redirect:` callbacks over one big top-level function for
  concerns that only apply to specific routes, and `ref.watch(provider.select(...))` over
  watching a whole provider's state when only one field actually matters for a decision — avoids
  rebuilding the whole `GoRouter` (a new instance!) on unrelated state changes.
- **`flutter analyze`/`flutter test` both work fine in this environment** and are fast enough to
  run after every meaningful change (they took 15s-30s once pub's initial fetch was warm). Prefer
  running them liberally over guessing whether something compiles.

## 5. Phase-by-phase status

| Phase | What | Status |
|---|---|---|
| 0 | Production triage (disposition-channel NULL, GPS ping reliability) | Done |
| 1 | Backend: session/auth fixes | Done |
| 2 | Backend: password-reset requests | Done |
| 3 | Backend: worklist pagination/worked-state/server filtering | Done |
| 4 | Backend: disposition cadence | Done |
| 5 | Backend: `customers.address` column | Done |
| 6 | Backend: embedded payments + idempotency | Done |
| 7 | Backend: permissions, delete KPI/targets surface | Done |
| **8** | **Mobile: design system** | **Done** |
| **9** | **Mobile: state/navigation foundation** | **Done, with documented deferrals (§4 in KNOWN-ISSUES.md)** |
| 10 | Mobile: Today (day plan) + duty bar wiring | **Not started — next up** |
| 11 | Mobile: Customer detail + Log Visit rebuild, delete call-log/payment screens | Not started |
| 12 | Mobile: My Day + Branch views, delete dashboard/performance screens | Not started |
| 13 | Mobile: the cut list (delete Account admin lists, notifications, etc.) | Not started |
| 14 | Web: worklist day-plan restructure | Not started (can run parallel to mobile phases) |
| 15 | Web: delete KPI surface, rework navigation | Not started (**this is what fixes §2 of KNOWN-ISSUES.md**) |
| 16 | Web: admin surfaces for password-reset/address-correction | Not started |
| 17 | Verification and regression (full suite, physical device E2E) | Not started (**this is where deferred full-regression testing happens**) |

## 6. Starting Phase 10

Read `docs/REVAMP-SPEC.md` §5.1 (mobile IA — the exact layout of the Today/Customer/Log
Visit/My Day/Branch/Account screens) and the Phase 10 section in full before starting. Quick
orientation:

- **Builds on Phase 8's `DutyBar`** (`core/ui/duty_bar.dart`) — currently a pure presentational
  shell taking `onDuty`/`shiftDuration`/`pendingSyncCount`/`offline`/`onPunchPressed` as explicit
  params, with sample data only in the Phase 8 gallery. Phase 10 wires it to
  `attendanceProvider`/`offlineQueueProvider` and mounts it (probably above `HomeShell`'s tab
  content, alongside or replacing `SyncBanner` — check whether both are still wanted).
- **New `features/today/*`** — the actual home screen: PTP section (collapsible, highlighted),
  progress line ("12 of 40 worked · ₹8,400 collected"), lazy paginated worklist with server-side
  search + branch filter, worked rows greyed/sunk to the bottom.
- This is a **feature screen** phase — unlike Phase 8, this is exactly where `core/ui/*`
  components (built but unused so far) get their first real consumer. Use `AppListRow`,
  `AppStatTile`, `AppChipGroup`, `AppMoney`, `AppSectionHeader` etc. rather than hand-rolling.
- The backend groundwork for worked-state/pagination/server-side filtering already shipped in
  Phase 3 (`GET /worklist`) — check `worked_today`/`collected_today` are already on the `Account`
  model (they are, added in Phase 9) before assuming backend work is needed here.
- Acceptance criteria are concrete and testable (400-account scroll performance, PTP-first
  ordering, worked-row greying without full reload, offline alert on connectivity loss, punch-out
  reachable in one tap from every tab) — read them closely, they're not vague.

## 7. If you get stuck or something looks wrong

- Check `docs/KNOWN-ISSUES.md` first — it may already be catalogued.
- If a test fails and you're not sure if it's pre-existing: check whether the failure is in a file/
  area you actually touched this phase. If not, it's very likely pre-existing (per §2 point 3
  above, don't rabbit-hole proving this exhaustively — a quick sanity check is enough).
- If a spec instruction conflicts with something already shipped and unrelated to the revamp
  (discovered several times in Phases 0-7 — see `mobile-revamp-decisions.md` for the pattern),
  investigate, make the defensible call, and document the deviation clearly rather than either
  blindly following the letter of the spec or silently doing something else.
