# Mobile Revamp — Decision Log

Living record of decisions made during the mobile UI revamp discovery.
Append-only: supersede an entry with a new dated one rather than editing history.

---

## Phase 1 — Auth & Architecture Setup

### D1 — Session model: one mobile device + one web session (2026-09-03)
**Decision.** A user may hold a mobile session and a web session at the same time.
Logging in from either place must not disturb the other; state changes reflect in both.

**Current behaviour (defect).** `auth-service.login()` runs the device-binding revoke
whenever a `device_id` is supplied. Mobile always supplies one (`android.id`); web never
does. Because SQL `NULL IS DISTINCT FROM 'abc'` is **true**, a mobile login revokes the
user's web refresh token. The web tab's next refresh then hits the revoked-token branch,
which logs `"Revoked refresh token reused"` and revokes *every* remaining session for that
user — i.e. an ordinary mobile login is processed as a token-replay compromise.

**Required change.** Confine the revoke to other *mobile* devices, e.g.
`AND device_id IS NOT NULL AND device_id IS DISTINCT FROM $2`, so web (NULL) sessions
survive. Add regression coverage for "mobile login leaves the web session alive".

### D2 — OTP deferred; auth is phone + password (2026-09-03)
**Decision.** No SMS gateway is procured. Ship phone + password only. **Drop OTP from the
mobile design.** Keep the existing OTP implementation in place, commented / dormant, to be
revived when a provider is bought.

**Consequence.** `getSmsProvider()` returns `ConsoleSmsProvider` unconditionally — in
production it logs and sends nothing. So today `POST /auth/otp/request` and the
new-employee credential SMS both silently deliver nothing. The web `ForgotPasswordPage`
OTP flow therefore only works with `ALLOW_OTP_ECHO=true` (dev). Leave the code, do not
surface it on mobile, and revisit when a gateway (MSG91/Twilio + India DLT template
registration) is in place.

### D3 — Mobile password recovery is an admin-mediated request (2026-09-03)
**Decision.** Mobile gets a "request password reset" screen: a free-text box where the user
explains the problem and asks an admin to reset it. The admin resets the password from the
Employees tab. **An alert/notification must reach the admin when a request is raised.**

**Consequence.** This is the project's first *new* backend object — a request table, create
+ list + resolve endpoints, and two UI surfaces (mobile request screen, web admin alert).
Open spec questions: who is notified, whether the agent sees status, abuse limits, and
whether an admin reset should log the agent out everywhere (`POST /employees/:id/reset-password`
currently revokes all that user's refresh tokens).

### D4 — Security/compliance hardening deferred (2026-09-03)
**Decision.** Not in scope at this stage. Revisit later.

**Deferred, knowingly:** web stores access + refresh tokens in `localStorage` (XSS-readable);
mobile has no biometric/PIN re-auth (`local_auth` is not a dependency) against an 8h access
token and a 30-day refresh; no idle timeout; no screenshot blocking. Mobile does correctly
use `flutter_secure_storage` with `encryptedSharedPreferences`.

### D5 — Foundation first, visuals later (2026-09-03)
**Decision.** Build the architectural foundation (component library, unified account model +
repository, navigation/state cleanup) before any visual restyle. Expand the foundation only
after *all* screen decisions are finalised, then re-evaluate, then start visual changes.
The foundation itself is to be discussed in detail before being built.

---

## Product & org model

### D6 — Mobile is a field-agent app for now (2026-09-03)
**Decision.** Telecallers work on the **web**; field agents work on the **mobile app**.
Support for telecallers on mobile and field agents on web is planned but explicitly **not now**.

### D7 — Org model confirmed: branch, no team leader (2026-09-03)
**Decision.** Rudrayani operates across multiple branches. Each branch has telecallers and
field agents, whose work is **not confined to their branch**. Each branch has a branch
manager who is themselves also a telecaller or a field agent, can view their whole branch,
and is accountable for branch performance. **There is no Team Leader tier.**

**Consequence.** The current backend model (`designation = branch_manager` + `agent_type`,
`branches.branch_manager_id`, `telecaller_branches` for cross-branch work) already matches
this. The **mockup is stale** — it is built around a Team Leader role removed by migration
`1788000000000_remove-team-leader.sql`. Treat every Team Leader screen in the mockup as
branch-manager material or discard it.

### D8 — GPS is mandatory for every mobile user (2026-09-03)
**Decision.** The punch-in gate stays. GPS is mandatory for all mobile users — including
telecallers when they eventually arrive on mobile.

**Consequence.** The `_exemptFromGps` carve-out in `attendance_provider.dart` (telecaller
without field_agent skips permissions and tracking) contradicts this and must be removed.
Open: whether a punch-in with **no fix obtained** is still permitted (today it is, deliberately).

### D9 — Allocation shape: a month of accounts, delivered at once (2026-09-03)
**Decision.** The admin assigns roughly a full month of customers in a single allocation.
Agents see that whole list.

**Consequence.** The worklist is large and `GET /worklist` has **no pagination** — it returns
every assigned row and reports `total: rows.length`. Mobile then filters, searches and sorts
in Dart over the entire loaded list. Pagination (or an explicit day-plan slice) is a
prerequisite, not an optimisation.

### D10 — The day starts with PTP follow-ups (2026-09-03)
**Decision.** PTP follow-ups due today are the agent's top priority, above everything else.
The list must be interactive and must capture, per customer: whether contacted, how much was
paid, whether it was a partial payment, the trail (disposition) code, the PTP date if any,
and a remark. Interaction history must be stored and visible.

**Consequence.** `GET /ptps/due` already serves the PTP list. But the `/worklist` payload
carries **no payment information at all** (no collected-this-month, no last-payment), and the
payments model has no "partial" concept — only `type = emi | settlement`. Surfacing paid /
partial state on the row is a backend contract change.

### D11 — The stated problem is organisation, not decoration (2026-09-03)
**Decision.** The driving complaint is that the UI is "all over the place", uncategorised and
disorganised — an information-architecture problem, not a palette problem. Judge the revamp
on whether the day is legible and ordered, not on how it looks in isolation.

---

## Phase 1 close-out / Phase 2 opening (2026-09-03)

### D12 — No device binding; remove the security copy
**Decision.** No device protection at this stage. Keep today's "last device wins" behaviour
(`login()` simply overwrites `users.active_device_id` with whatever device authenticates).

**Consequence.** The mockup's login copy — *"This device will be bound to your account for
security"* — asserts a control that does not exist. **Remove that line from the design.**
Do not ship copy that overstates the protection in place.

### D13 — Punch-in: allow without a fix, verify in the background
**Decision.** The middle path. A punch-in with no GPS fix is permitted (agents must not be
trapped indoors / on a cold GPS start), the record is marked location-unverified, and the
location is verified in the background whenever a fix becomes available.

**Implementation note.** The foreground tracking service already captures a fix on start and
every ping interval (default 120s). The first successful ping after punch-in can backfill the
punch-in location and flip the verified flag — no new polling, no extra battery cost. Needs a
schema addition (e.g. `attendance.punch_in_location_verified`) and the same treatment for
punch-out. Branch managers should be able to see which shifts are unverified.

### D14 — Mobile home is the full assigned list with PTPs pinned on top
**Decision.** Option A. The agent sees their full assigned list; PTP follow-ups due today are
pinned above it as the first thing in the day. *(Read from an ambiguous answer — confirm.)*

**Consequence.** Because the list stays month-sized (D9), **pagination on `GET /worklist`
becomes mandatory rather than merely advisable** — Option B would have softened this by making
the long list a secondary screen. Still open: whether the agent can re-order/pin, or whether
ordering is the app's alone.

### D15 — Payment state is fully transparent, and part payment becomes first-class
**Decision.** "As transparent as possible — make it part of the system." Payment state is shown
on the worklist row, not hidden behind the customer screen. Part payment is modelled explicitly
rather than inferred from `amount < due_amount`.

**Open modeling problem.** `payments.type` is currently `emi | settlement`. Adding
`part_payment` as a third value conflates two independent axes — *what obligation* (EMI vs
settlement) and *how complete* (full vs partial) — and would silently break the existing
"Settlement vs EMI Collections" KPI, since a partial EMI would stop counting as EMI. Prefer a
separate completeness flag over a third enum value. To be decided.

### D16 — An admin password reset must not boot the agent's other sessions
**Decision.** `POST /employees/:id/reset-password` currently revokes **every** refresh token for
that user. Under D1/D3 that means an admin helping a locked-out agent silently kills that
agent's other live session. A reset must invalidate the old password without destroying
unrelated sessions.

### D17 — Password-reset request defaults (assumed, pending correction)
Unanswered sub-questions from Q1, proceeding on these defaults:
- **Alert routes to the agent's branch manager first, with agency admin as fallback** when the
  branch has no manager — this reuses the branch scope that already exists everywhere else
  rather than inventing agency-wide fan-out.
- **The agent sees status on the login screen** ("Request sent — waiting on your manager"), so
  they don't re-submit or phone the office.
- **One open request per user at a time**; a second submission updates the existing one instead
  of creating a duplicate. This is the cheapest abuse control and needs no rate-limit config.

---

## Phase 2 — The Day (2026-09-03)

### D14 — SUPERSEDED by D14a
### D14a — Mobile home is a day plan; the app owns the order (2026-09-03)
**Decision.** Reverses D14. **Option B:** the home screen is a genuine day plan, with the full
assigned list one tap away. **The app decides the order** — the agent does not get sort
controls. The agent does get **search and filters** on the full list, and the **most important
filter is customer branch**, with the others (company, product, bucket) supporting it.
Allocation remains admin-driven.

**Consequence.** Ordering and sorting move server-side, which is what makes pagination
workable. `next_action_date` becomes the primary ordering signal instead of being discarded
in Dart. Note that **customer branch — the filter that matters most — is the one that was
observed returning "No Data"** in production; `GET /worklist/filter-options` must be verified
end-to-end on both clients before this ships.

### D18 — Remove the KPI apparatus; build a work-done ledger instead (2026-09-03)
**Decision.** Reconciles two answers that read as contradictory: *"remove all the KPIs"* and
*"as a business owner I need this visibility."* What gets cut is the **finance-metric
apparatus**; what replaces it is an **activity ledger**.

**Cut:** the four-metric model (Resolution / Rollback / Normalization / Recovery), monthly
targets, run-rate current/required, achievement %, the gauge, bucket-movement and DPD-mismatch
cards, and target-vs-achievement framing everywhere. On mobile that removes
`telecaller_dashboard_screen`, `field_executive_dashboard_screen`, `performance_screen` and
`dashboard_widgets` as currently conceived; on web it removes most of the widget registry.

**Keep / build — the ledger.** Per agent, per day, per company, the owner must be able to read
a sentence like: *"field_agent_1 contacted 20 Hero customers at home today — 5 PTP, 10 part
paid, 10 paid in full."* Required dimensions: agent, day, company, contact channel (visited in
person vs called), outcome, amount collected, and — for field agents — the movement trail from
punch-in to punch-out.

**Most of this data already exists.** `GET /reports/agent-activity` is exactly this event
stream (kind, agent, customer, company, amount, ptp_status, disposition).
`/tracking/team-day` already aggregates per-agent-per-day calls / payments / visits /
cash / online. `/tracking/route` gives movement. The work is deleting the KPI layer and
re-presenting these — not new aggregation.

### D19 — Worked rows grey out and sink; recontact is driven by trail code (2026-09-03)
**Decision.** A worked customer **greys out and moves to the bottom of the list** — it never
disappears. The pinned PTP section is a **collapsible dropdown**. A customer contacted
yesterday can be contacted again, and **the trail (disposition) code decides when**. Framing:
think like a collections business — a non-paying customer should be contacted repeatedly.

**Gap this exposes.** `disposition_codes` has **no recontact cadence field** — only
`needs_*` flags and `channel`. Nothing derives a follow-up date from a disposition, so
`next_action_date` is fed *only* by PTP promised dates and manual reminders. Without a cadence
per code, "greys out and sinks" is permanent: nothing ever lifts a customer back to the top.
This is the engine the day plan needs.

### D20 — Customer address is mandatory, and must be editable (2026-09-03)
**Decision.** Lenders do supply addresses; address is a **mandatory** field for the business.
Where it is missing it must be correctable from **both web and mobile**.

**Reality today.** Address is *not* mandatory in the system. It is a `system_field_definitions`
entry with `storage_column = NULL`, so it lands in the `custom_fields` JSON blob; it is
`is_core = false`, i.e. enabled-but-optional per company. Mobile's Navigate finds it by
**scanning every custom field for a key whose name contains "address" or "addr"** and hands the
raw string to `geo:0,0?q=<text>` — no geocoding, no lat/lng, no validation. It works only when
the lender's column happens to be named accordingly, and fails silently otherwise. And there is
**no API to edit a customer's address at all** — `customers.ts` exposes exactly one mutation,
`PATCH /customers/:id/branch`. The correction-request flow covers payments, call logs, PTPs and
field visits, but **not customer fields**.

### D21 — Offline writes the server refuses stay dropped (2026-09-03)
**Decision.** Keep current behaviour: a queued write rejected with a 4xx is classified
`permanent`, removed from the queue, and surfaced to the agent as a one-line rejection.

**Registered concern (owner's call, accepted).** The dropped record can be a PTP or a cash
collection. Dead-lettering already exists in `offline_queue.dart` and could park these for
re-filing instead of discarding them. Revisit if agents report lost work.

---

## Phase 2 close-out / Phase 3 opening (2026-09-03)

### D22 — App purpose restated: operations visibility (2026-09-03)
**Decision.** The app's job in its current phase is operational, not analytical: **how much has
been collected, how many customers were contacted, and where the staff are.** Everything else
is secondary. This is the yardstick for keep/cut decisions from here on.

### D23 — Recontact cadence lives on the trail code (proposed; awaiting sign-off)
**Decision.** Cadence design delegated to me. Proposal: add to `disposition_codes` an
admin-editable `followup_after_hours`, plus `exits_agent_queue` and `routes_to` for codes that
should leave the dialling queue entirely. `next_action_date` is then fed by three sources
instead of one: pending PTP dates, manual reminders, **and disposition cadence**.

Proposed defaults by category (all admin-overridable on the Dispositions page):

| Trail-code category | Cadence | Rationale |
|---|---|---|
| Promise to Pay | on the promised date | already modelled via `ptps` |
| Call Back | at the time the customer gave | needs date+time capture on the code |
| Pick Up / Left Message | +1 day | reached someone, no commitment |
| Not connected (RNR / NC / switched off) | +4h, max 3 attempts/day, then +1 day | never burn a day on one number |
| Out of Station | +7 days | genuinely unavailable |
| Refuse to Pay | +3 days, escalate after 2 | deliberate pressure cadence |
| Inability to Pay | +15 days | weekly calls are wasted effort |
| Re Visit | +1 day | field |
| Wrong Number / New Mobile Number | leaves dialling queue → data-correction queue | calling again is pure waste |
| Field Referral | leaves telecaller queue → field queue | |
| Escalated Case / Legal Proceedings | leaves agent queue → manager | |
| Cleared From Bank | closed | |

Plus a per-customer daily attempt cap (default 3) so the queue cannot loop.

### D24 — Trail codes are the only taxonomy; part payment is a trail code (2026-09-03)
**Decision.** Supersedes the completeness-flag half of D15. **We do not introduce a second
outcome taxonomy.** Partial vs full payment is expressed as a trail code, not as a column on
`payments`. Where a code implies a future commitment (PTP, or a part payment with a promise for
the balance), the agent **must capture a date from the customer**; that creates a PTP, puts the
customer in the PTP list, and **must remind the agent on that day**.

**Gap this exposes.** The PTP half already works — `createsPtp()` opens a `ptps` row when a
promise-flavoured code carries amount + date, and `refreshNextActionDate()` feeds
`next_action_date`. **The reminder half does not exist.** Mobile schedules local notifications
only for manually-created `reminders`; a PTP fires no notification at all. It merely appears in
the Today section if the agent opens the app.

**Load-bearing assumption to verify:** this model only renders the D18 ledger if the live trail
code list actually distinguishes part payment from full payment. If it doesn't, "10 part paid,
10 paid in full" cannot be computed.

### D25 — Address becomes a real, import-required column (2026-09-03)
**Decision.** Promote address out of the `custom_fields` JSON blob into a first-class
`customers.address` column, and make it **required at import**.

**Consequences to handle:** (1) a lender file with no address column will now be **rejected** —
confirm that's acceptable before onboarding a new client; (2) existing rows need a backfill from
`custom_fields` (the same fuzzy "contains address/addr" scan mobile uses today); (3) mobile's
Navigate can then read a real column instead of scanning JSON keys. **Still open:** who may edit
an address (agent directly vs. agent-proposes/manager-approves), and whether we geocode to
lat/lng or keep handing text to Google Maps.

### D26 — Ledger audience: everyone sees their own scope (2026-09-03)
**Decision.** The work-done ledger is for **all** roles: telecallers and field agents see their
own; branch managers see their whole branch's; the agency owner/admin sees everybody. The full
cross-agent, per-company view is a **web** surface for the owner and admin.

**Attribution — proposed default, not yet confirmed:** money credits whoever recorded it
(`payments.collected_by_user_id`), i.e. the simplest rule, matching "operations visibility"
rather than payout accounting. Flag if commissions will ever be calculated from this.

---

## STANDING RULES

### R1 — Mobile and web move together (2026-09-03)
Every decision in this log applies to **both clients**. Where a decision changes behaviour,
`mobile/` and `frontend/` are both updated. Neither client is allowed to drift; the shared
backend is the contract that keeps them honest. Web is not "the old one" — it is the telecaller
product (D6) and gets equal weight.

---

## Business insights captured from the Q&A

- **BI1 — Field agents call before they visit.** Visiting agents phone the customer first, so
  the trail codes they need are largely the same as a telecaller's. Channel is a property of
  *this interaction*, not of the agent's job title.
- **BI2 — The telecaller→field handoff already exists in the code master.** `PICK UP` ("Customer
  asked to send the field agent to collect") and `FIELD REFERRAL` ("Case is referred to field")
  are live trail codes. The schema also already has `customers.assigned_field_agent_id` and
  `POST /allocations/assign-field-agent`. Nothing currently connects the two — logging FIELD
  REFERRAL does not route the case anywhere.
- **BI3 — A non-paying customer must be worked repeatedly.** Contact is not one-and-done;
  the queue must keep resurfacing unresolved accounts (drives D19/D23).
- **BI4 — Allocation is monthly, delivered in one drop** (D9), so the worklist is inherently
  large and the day plan must impose the order.
- **BI5 — Frequency ordering has a data source.** `Trail Codes.xlsx` column 1 is literally
  headed *"Majorly used result code"* — the grouping the business already thinks in. Use it to
  seed the most-used ordering in D30 rather than inventing one.
- **BI6 — The master sheet is merged-cell/sparse.** Category appears only on the first row of
  each group; the seeder must forward-fill or codes lose their category.

---

## Phase 3 — Interaction Capture (2026-09-03)

### D27 — No push notifications; highlight instead (2026-09-03)
**Decision.** No alarms or push notifications for PTPs. Instead, **PTP items due are highlighted
prominently on the homepage of both the app and the web.** Supersedes the alarm half of D24.

**Consequence.** `flutter_local_notifications`, `timezone` and `flutter_timezone` exist solely
to serve manual reminders. With no notification requirement, that whole dependency stack and
`NotificationService` become candidates for removal — a real simplification.

### D28 — Address is mandatory at the column-mapping step (2026-09-03)
**Decision.** Refines D25. The admin maps the lender's spreadsheet columns to internal field
names at import; **address must be a required mapping there**, i.e.
`company_field_settings.is_required = true` for `address`, enforced the same way
`loan_number`/`customer_name` already are.

### D29 — VERIFIED: part payment is a trail code (2026-09-03)
`PP · Part Payment Received` exists in `Trail Codes.xlsx` under category `RESOLVED`, channel
`OC/FV`, alongside `PAID`. The D18 ledger is therefore computable from trail codes alone.

### D30 — Disposition capture in under 10 seconds (2026-09-03)
**Decision.** Logging one interaction must take **≤10s**. The agent's most-used codes float to
the top. Seed that ordering from the master sheet's own *"Majorly used result code"* grouping
(BI5), then adapt per agent by actual usage.

### D31 — Money is recorded inside the interaction log (2026-09-03)
**Decision.** Payment capture merges into the interaction record — **call log** for telecallers,
**field visit** for field agents. Both the interaction and the money are logged in one act, not
two. No separate "Record Payment" screen.

**Consequence.** `payments` has no `call_log_id` or `field_visit_id` (only `ptps` links back to
a call log), so the money and the outcome currently live in unconnected tables and "which
disposition was this collected under" is unanswerable. Merging the capture flow requires linking
them. This also collapses two offline queue item types into one atomic unit — an improvement,
but the queue's per-type handling in `offline_queue.dart` must be reworked accordingly.

### D32 — Channel belongs to the interaction, not the agent (2026-09-03)
**Decision.** Follows from BI1. A field agent who phones a customer must be able to log an
**OC** code; a telecaller referring a case must reach the relevant codes too.

**Defect this exposes.** `call_log_screen.dart` pre-selects the channel from the agent's role —
`isFieldAgent && !isTelecaller → 'FV'` — and `codesForChannel()` filters strictly on
`c.channel == channel`. **So a field agent today cannot see or log a single OC code**, even
though BI1 says calling is the first thing they do. The channel must be chosen per interaction.

### D33 — Calls are self-reported; no verification (2026-09-03)
**Decision.** The app will not read the device call log or route calls through a telephony
provider. Contact counts are self-reported, and that is accepted.

**Known limitation:** "how many customers did my agent call" is "how many they logged". The
`call_logs.call_duration_seconds` column exists and is never populated by mobile. Avoided
trade-off: the Android `CALL_LOG` permission group is a common Play Store rejection cause.

---

## OPEN DEFECTS

### X1 — SUSPECTED PRODUCTION BLOCKER: disposition codes may all have `channel = NULL`
`src/migrations/seed_disposition_codes.ts` **never writes the `channel` column** — it is absent
from the INSERT entirely. Channel values were assigned once, by migration
`1785600000000_add-disposition-channel.sql`, which also duplicated each `OC/FV` code into an FV
row and an OC row.

Production was re-seeded with the 70-code master list on 2026-09-02, i.e. **after** that
migration had already run. If so, every production disposition code has `channel = NULL`.

Both clients filter strictly on channel — mobile `codes.where((c) => c.channel == channel)`,
web `dispositionCodes.filter(c => c.channel === channel)` — so a NULL channel makes a code
invisible in **both**. The consequence is that **the Result Code picker is empty and no call can
be logged on either client**, showing only "No FV codes configured yet". The Dispositions admin
page has a warning banner built for exactly this state.

**Confirm with one query:**
```sql
SELECT channel, COUNT(*) FROM disposition_codes
 WHERE agency_id = '<agency>' AND is_active GROUP BY channel;
```
**Fix:** teach the seeder to derive `channel` from the sheet's Action Code column
(`OC`, `FV`, `LG`, `PIOC`, `PIFV`, `OC/FV`) and to expand `OC/FV` into both channels, so seeding
is idempotent and no longer depends on a one-shot migration.

### X2 — Location pings are unreliable; battery optimisation is never requested
`AndroidManifest.xml` does not declare `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`, and
`FlutterForegroundTask.requestIgnoreBatteryOptimization()` is never called. On the OEM skins that
dominate the Indian budget-Android market (MIUI, ColorOS, FuntouchOS, One UI) the tracking
foreground service will be throttled or killed. Two secondary causes: `_capturePing()` requests
`LocationAccuracy.high` with a 30s limit and, on failure, records **nothing** rather than a
degraded fix; and `recorded_at` is taken from the GPS fix's own timestamp while
`location_pings` has a unique `(user_id, recorded_at)` index with `ON CONFLICT DO NOTHING`,
so a repeated cached fix is silently discarded.

---

## Phase 4 — Field Work, Attendance & Offline (2026-09-03)

### D34 — Field agents record visits only (2026-09-03)
**Decision.** Revises D32. A field agent logs every interaction as a **visit** (`field_visits`),
using the field agent's trail codes. There is **no channel picker** for them. The pre-visit phone
call described in BI1 is not separately recorded.

**Correction to D32.** The earlier claim that a field agent "cannot see a single OC code" was
overstated: migration `1785600000000` duplicated every shared `OC/FV` code into an FV row, so an
FV filter already yields the FV codes *plus* the shared ones. What a field agent genuinely cannot
reach are the **pure-OC** codes (NC, RNR, Wrong Number, Broken Promise, Inability to Pay, Pick Up,
Field Referral, Cleared from Bank, the REDEP and LG sets). Under this decision that is acceptable,
with one exception to confirm: **Inability to Pay** is a plausible doorstep outcome and is
currently OC-only.

### D35 — Field-referral auto-routing deferred (2026-09-03)
**Decision.** Not now. `PICK UP` / `FIELD REFERRAL` remain remarks; no automatic assignment to a
field agent. Plan retained for when it is picked up (see BI2).

### D36 — Photo proof is not mandatory (2026-09-03)
**Decision.** No photo is required in any case for now, including cash collection. Revisit later.

**Consequence.** `field-visits.ts` currently rejects a visit with no photo *and* no explanatory
remark; mobile requires a photo when the outcome is "Met customer". Both constraints relax.
Registered once: the photo is the only evidence behind a cash collection.

### D37 — Offline stays light, and says so out loud (2026-09-03)
**Decision.** Connectivity in India is broadly good, so do not over-invest. Keep the existing
durable write queue (already built, cheap to retain). **Add an explicit alert telling the user
they have entered offline mode and how the app behaves there.** No day-ahead pre-download, no
delta-sync endpoint for now.

### D38 — Live tracking is web-only, and must actually be accurate (2026-09-03)
**Decision.** The live map stays on **web only**; mobile gets no map. A branch manager sees their
own team; the agency admin sees everybody. The 2-minute ping interval is acceptable — but pings
are **not arriving reliably** and that must be fixed (see X2).

---

## Phase 5–7 confirmations (2026-09-04)

### D39 — No targets, anywhere (2026-09-04)
**Decision.** Agents have no target and no percentage. A field agent's homepage shows their
**customer visits and PTP list**, nothing more. The `targets` table, the Targets admin page and
the Excel target import are **deleted outright**, not left dormant.

### D40 — Branch managers get a branch view on mobile (2026-09-04)
**Decision.** A branch manager on mobile gets a **Branch** tab showing their own team. It is a
*ledger* view (per agent: on duty, contacted, collected, PTPs) — not a revived KPI dashboard.

### D41 — Agents work multiple lenders every day (2026-09-04)
**Decision.** Working several companies in one day is routine, not exceptional. Company must be
visible on every worklist row and available as a filter on both clients.

### D42 — Mobile Account is stripped to profile only (2026-09-04)
**Decision.** All six read-only admin lists on the mobile Account tab (All Customers, Employees,
Teams, Branches, Companies, Catalog) are **cut**, together with `generic_list_screen.dart`,
`employee_detail_screen.dart` and their routes. Account keeps name, phone, branch and Log out.
Reallocation and correction requests are **removed from mobile** and stay web-only.

### D43 — Punch-out lives in a persistent duty bar (2026-09-04)
**Decision.** Placement delegated and decided: punch-out moves out of Account into a **persistent
duty bar** across the top of every mobile tab, showing duty state and elapsed shift time. The same
bar carries the pending-sync count and the offline-mode alert. Rationale: punch-out ends the shift
*and* stops GPS tracking, so it must never be more than one tap away.

### D44 — The server-URL override is removed from production (2026-09-04)
**Decision.** The gear icon on the mobile login screen that repoints the app at an arbitrary
backend is a development tool and is **removed**. Builds keep `--dart-define=API_URL`.

### D45 — Web telecallers get the same day-plan restructure (2026-09-04)
**Decision.** Rule R1 applied in full. `MyWorklistPage` keeps its dense table — a desk tool with a
keyboard is legitimately different from a phone — but is reorganised the same way: PTPs due pinned
and highlighted above the list, worked rows greyed and sunk, search and filtering server-side.

### D46 — Tracking is split by permission (2026-09-04, CONFIRMED)
**Decision.** Agents must not see Tracking, but revoking `tracking.view` outright would break their
own attendance screen (`scopeFilter()` clamps them to self). So the permission is **split**:
`tracking.view` stays with telecaller and field_agent for their **own** data; a new
`tracking.view_team` gates the Tracking nav item, the live map and route replay. Branch managers
see their own branch; ops and admin see everyone; agents see nobody.

### D47 — The web KPI Dashboard is deleted; Agent Daily Activity becomes the landing page (2026-09-04, CONFIRMED)
**Decision.** Nothing new is built to replace the dashboard. `/` redirects to `/agent-activity`,
which already *is* the ledger described in D18 — the "field_agent_1 contacted 20 Hero customers
today, 5 PTP, 10 part paid, 10 paid in full" view. Reports and Targets pages are deleted with it.

### D48 — English only (2026-09-04)
**Decision.** No localisation. Marathi/Hindi are not required.

### D49 — No deadline; correctness over speed (2026-09-04)
**Decision.** There is no demo date. The foundation is built properly first (D5) — no flagship
screen is sequenced early to buy a demo.

### D50 — Address is read-only and correction-requested (2026-09-04)
**Decision.** Supersedes the "editable in web and app" part of D20. Address comes from the lender
and **nobody edits it directly**. An agent may **request a correction, which a manager approves**,
reusing the correction-request pattern extended to customer fields. Address remains a real column
and remains required at the import column-mapping step (D25, D28).

### D51 — Worklist paging (2026-09-04)
**Decision.** Recommendation accepted: page size 50, infinite scroll, no page numbers. The agent
never needs "account 340 of 500". Search must work across the whole assigned set, not just the
loaded page.

---

## Implementation handover (2026-09-04)

Discovery is closed. The implementable specification is **`docs/REVAMP-SPEC.md`** — 18 phases,
each with acceptance criteria and named tests, written to be executed without further
interpretation. This log remains the history and the *why*; the spec is the *what* and the *how*.
Where the two disagree, the spec wins.

**Phase 0 is a suspected production incident** (defect X1) and blocks every other phase.

Four questions remain open (O3–O6 in the spec); each blocks a specific later phase, and none
blocks Phase 0.

---

## Phase 0 execution (2026-09-04)

A fresh implementation session read the spec and executed Phase 0 only, per §0.2. Both X1
(disposition channel) and X2 (GPS ping reliability) fixes were made, verified against the local
dev DB and the real login → `GET /dispositions` API, and committed to
`worktree-phase0-production-triage` (`27bb7e9`, `028af80`). Full detail is in the commit messages
and PR; the acceptance-criteria walkthrough was reported to the owner directly rather than
duplicated here.

One deviation from the spec's literal wording, made for correctness: §8 Phase 0 step 2 specifies
the seeder's idempotency key as `(agency_id, action_code, result_code, description)`. That key
would have collapsed the 9 legitimate "Call Back" remark-template variants into 1 row, and
wouldn't have let the two OC/FV channel clones coexist (they differ only by `channel`). The
natural key actually used is `(agency_id, action_code, result_code, description, remark_template,
channel)`, all four nullable text columns wrapped in `COALESCE(..., '')` since a plain unique
index never treats two NULLs as equal.

### D52 — O3 answered: Inability to Pay becomes OC/FV (2026-09-04)
**Decision.** `Inability to Pay` (result_code `IP`) is relabelled `OC/FV` and given an `FV` twin,
same pattern as every other dual-channel code. Field agents can now log it from a doorstep visit,
not just telecallers on a call. Implemented in migration
`1789200000000_inability-to-pay-oc-fv.sql`, verified against the local dev DB and via a real field
agent login. **Not yet done:** `Trail_Codes.xlsx` (the seed source for brand-new agencies) still
lists `Inability to Pay` as OC-only, so a fresh agency onboarded later would silently regress this
decision unless the sheet is also updated — flagged, not fixed, since editing the binary sheet
programmatically carries real corruption risk for a single-cell change.

Phase 0 was merged to local `main` (`5b1768a`), not pushed to `origin` — new project policy
(2026-09-04): work merges to local `main` and its worktree is deleted per phase; nothing pushes to
`origin` until a complete, verified feature is ready to go live (pushing `main` deploys to
production via Railway).

### D53 — O4 answered: admin password reset revokes only web sessions (2026-09-04)
**Decision.** §4.7's DECIDE is resolved: an admin password reset revokes only the target's web
sessions (`device_id IS NULL`); a live mobile session is untouched. Implemented in Phase 1
(migration `1789300000000_refresh-token-revoked-reason.sql`, `auth-service.ts`,
`employees.ts`). Verification surfaced a second bug not in the original defect list: `refresh()`'s
replay-abuse defense revoked every session for a user whenever *any* revoked token was presented
again, regardless of why it was revoked — so the web client's ordinary next refresh after this
reset would have cascaded into revoking the mobile session the reset was meant to protect,
silently undoing D53 in practice. Fixed by tagging every revoke site with why
(`refresh_tokens.revoked_reason`) and scoping the cascade to `'rotated'` (single-use-token replay)
only. See [[rudrayani-crm-project-state]] for the general lesson about token-replay defenses
conflating unrelated revoke sources.

### D54 — O5 answered: call + visit same day is one record, latest wins (2026-09-04)
**Decision.** When a customer is contacted by phone *and* visited on the same day, that's **one**
interaction record for "customers contacted" purposes, not two — the latest of the two
(call-then-visit or visit-then-call) takes precedence. Affects Phase 11 (interaction/ledger
counting); not yet implemented.

### D55 — O6 answered: no commission-based attribution, for now (2026-09-04)
**Decision.** Commissions will not be computed from collection numbers as of 2026-09-04. N4's
"whoever recorded it" payment attribution rule stands unchanged. Revisit if this changes — flagged
against Phase 12.

Phase 1 was merged to local `main` (`22bcb27`), not pushed to `origin`, same policy as Phase 0.
All four originally-open questions (O3–O6) are now answered; O5 and O6 still block their
respective phases (11, 12) until those phases are implemented.

## Phase 2 and 3 execution (2026-09-04)

Both implemented in one worktree (`worktree-phase2-3-password-reset-worklist`) for turnaround,
committed separately, merged to local `main` as one merge (`47e691d`) — not pushed to `origin`,
same policy as Phase 0/1.

**Phase 2** (password-reset request queue, `a77dc8f`): implements §4.6. One deviation from the
spec's literal text: §4.6 gates `GET /password-reset-requests` and its resolve endpoint on
`employees.update`, but `branch_manager` doesn't hold that permission by design (it gets
`employees.view`/`create`, deliberately not `update`/`deactivate`) — so a branch manager would
403 before ever reaching the branch-scoping logic, directly contradicting Phase 2's own
acceptance criterion. Used `employees.view` instead: the queue itself is read/triage-only, and
the actually-sensitive action (changing a password) stays on the unchanged,
`employees.update`-gated `POST /employees/:id/reset-password` (Phase 1). Verified: 6 new test
cases, all pass.

**Phase 3** (worklist pagination/worked-state, `debae2b`): implements §4.1 exactly. Found and
fixed the same "$1 unreferenced, Postgres can't infer its type" bug the file's own existing
regression test already documents for `filter-options` — it reappeared in the new `COUNT(*)`
query (no `is_primary_for_me` column to anchor `$1` the way the main SELECT does), fixed with a
harmless `$1::uuid IS NOT NULL` clause. Verified: 5 new test cases (pagination boundaries,
worked_today toggling + bottom-sort, collected_today scoping, server-side branch filtering), all
pass; the 6 pre-existing tests in the same file still pass (no regression).

Also renumbered `password-reset-requests.test.ts`'s phone-number fixtures after discovering they
collided with three other already-existing test files (`users.phone` is globally unique across
the whole suite, which runs against one real shared Postgres DB, not a per-file fixture) —
picked an unused `798xxxxxxx` prefix. Worth remembering when writing any new test file with
phone-number fixtures: grep the existing range first.

Full backend suite after both phases: same 23 of 34 files failing on the pre-existing, unrelated
`users.designation` NOT NULL fixture gap as every prior phase's baseline (one more file than
before — Phase 2 added its own test file — no new failures), 111 passed (up from 100 after
Phase 1), 1 pre-existing unrelated failure (the dormant OTP flow, `ALLOW_OTP_ECHO` off by
design). `tsc --noEmit`: back to the same 2 pre-existing unrelated errors after fixing 3 new
ones in the new test file's own assertions.
