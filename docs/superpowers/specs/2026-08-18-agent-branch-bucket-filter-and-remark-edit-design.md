# Design: Agent Branch/Bucket Filter + Same-Day Remark Edit

Date: 2026-08-18
Status: Approved, pending implementation plan

## Problem

Two gaps reported against the live product:

1. Field agents and telecallers have no consistent way to narrow their working set of customers by **branch** and **bucket** (DPD/severity band) across both web and mobile. The web worklist has partial, agency-wide-sourced, single-select dropdowns for this; the mobile app has only a client-side bucket filter and no branch filter at all.
2. Agents cannot correct a remark they just logged. The only existing path (`correction-requests`) requires manager approval and has no time limit, which is too heavy for fixing a same-day typo or omission.

## Current state (as found)

- `customers.bucket` (free text) + `buckets` master table (per-agency canonical list, admin-managed).
- `customers.branch_id` (nullable FK) with a free-text fallback in `customers.custom_fields->>'branch'` for companies that haven't enabled the `customer_branch` field — every branch-matching query already does `COALESCE(branch_id match, custom_fields text match)` (`backend/src/services/scope.ts`, `worklist.ts`).
- `telecaller_branches` junction table already supports multi-branch assignment for telecallers; field agents rely only on a scalar `users.branch_id`.
- `GET /worklist` already accepts optional `bucket` and `customer_branch` query params (single-value, exact match).
- Web `MyWorklistPage.tsx` has single-select Branch/Bucket dropdowns wired to `/worklist`, sourced from agency-wide `GET /customers/branches` and `GET /buckets`.
- Mobile `worklist_screen.dart` has a client-side-only Bucket dropdown (filters the already-fetched list in memory) and no Branch filter.
- No direct edit endpoint exists for `call_logs.remark` or `field_visits.remark`. `call_logs.remark` is server-composed from a disposition code's `remark_template` + structured `details` fields + optional free-text `extra_remark`, via `composeRemark()` (`backend/src/services/disposition-service.ts`). `field_visits.remark` is plain free text.
- `correction-requests.ts` lets an agent flag their own `payment`/`call_log`/`ptp` record for a TL/manager to approve, with `ALLOWED_FIELDS.call_log = ["remark"]` and no time limit. It does **not** support `field_visit` records today.
- `backend/src/utils/ist.ts` is the single source of truth for "today" in IST; not needed for this feature since the remark edit window is a rolling 24h duration, not a calendar-day boundary.

## Feature 1: Branch/Bucket filter

### Behavior
- Not a hard gate. Worklist shows all of an agent's allocated customers by default. Selecting branch(es) and/or bucket(s) narrows the list; clearing the selection returns to "show all."
- Multi-select on both branch and bucket, independently.
- Selection persists per agent across sessions (client-side storage — `localStorage` on web, `SharedPreferences` on mobile — keyed by user id). No server-side preference storage; this is a personal working filter, not shared state.
- Dropdown options are scoped to the requesting agent's own allocated customers (which branches/buckets their actual customers fall into), not the full agency list. Reuses the existing `agentBranchClamp`/`customerWriteScopeClamp` scoping logic already applied to worklist reads.

### Backend
- `GET /worklist`: extend `bucket` and `customer_branch` params to accept multiple values (comma-separated or repeated query keys), building `IN (...)` against the existing `COALESCE(branch_id-match, custom_fields-match)` expression instead of today's equality check.
- New or extended options endpoints (building on `GET /customers/branches`, `GET /buckets`) to return only branch/bucket values present among the requesting agent's currently allocated customers, applying the same clamp used for worklist reads.

### Web (`frontend/src/pages/MyWorklistPage.tsx`)
- Convert Branch and Bucket `Select` components to multi-select (`mode="multiple"`).
- On change, persist to `localStorage` and re-query with the combined param list.
- On mount, restore the persisted selection if present, else default to no filter.

### Mobile (`mobile/lib/features/worklist/`)
- Add a Branch multi-select filter UI mirroring the existing Bucket filter's placement.
- Convert Bucket filtering from in-memory/client-side to a real server-side query param passed to `/worklist`, matching web behavior.
- Persist selections in `SharedPreferences` per user id; restore on load.

## Feature 2: Same-day (rolling 24h) remark edit

### Behavior
- Applies to both `call_logs.remark` (telecallers) and `field_visits.remark` (field agents).
- Owner-only: only the agent who created the record may edit it. No manager/TL override on this path (managers already have the correction-request path for that).
- Editable window: `created_at + 24 hours > now()`, evaluated server-side at request time (not IST calendar-day — a straight rolling duration).
- Scope of edit for call logs: only the free-text note portion (`extra_remark`). The disposition code and structured `details` fields are not editable through this path, so a record that already triggered a PTP or similar side effect can't be silently invalidated — this mirrors the existing `correction-requests` restriction (`ALLOWED_FIELDS.call_log = ["remark"]`, and even that flow disallows editing `disposition_code_id`).
- Scope of edit for field visits: the `remark` column directly (it is already plain free text with no composition step).
- No edit-history table. The record is overwritten in place; an `edited_at` timestamp column is set on successful edit and surfaced in the UI (web + mobile history timeline) as an "(edited hh:mm)" indicator.
- After the 24-hour window closes, the only remaining path is the existing `correction-requests` approval flow. Since that flow does not currently support `field_visit` as a record type, it will be extended to do so (`ALLOWED_FIELDS.field_visit = ["remark"]`), matching the existing `call_log` pattern — otherwise field agents would have zero recourse for a field visit remark after 24 hours.

### Backend
- New endpoints: `PATCH /call-logs/:id/remark` (body: `{ extra_remark }`) and `PATCH /field-visits/:id/remark` (body: `{ remark }`).
- Auth: requester must equal the record's `agent_id`. Reject with 403 if not the owner, 409 (or similar) if the 24h window has closed — response should point the client to the correction-request flow in that case.
- Implementation note to confirm during planning: check whether `extra_remark` is already persisted as its own column on `call_logs` or only merged into the final composed `remark` string at write time. If it isn't persisted separately, add an `extra_remark` column so the edit path can recompose `remark = template + fields + new extra_remark` without touching the disposition-driven portion. This needs a direct read of `disposition-service.ts` and the `call_logs` migration history before finalizing the migration.
- Add `edited_at TIMESTAMPTZ NULL` to both `call_logs` and `field_visits`.
- Extend `correction-requests.ts`'s `ALLOWED_FIELDS` map to include `field_visit: ["remark"]`, and extend `loadOwnedRecord()`/decision logic to handle that record type alongside the existing three.

### Web / Mobile
- Add an edit affordance (pencil icon) next to remarks in the history/timeline views, visible only when the viewing agent owns the record and it's within the 24h window.
- Outside the window, keep only the existing "flag for correction" affordance.
- Show the "(edited)" badge with timestamp when `edited_at` is set.

## Testing / edge cases

- Edit attempt exactly at the 24h boundary: treat as exclusive — must succeed strictly before `created_at + 24h`.
- A call log linked to a PTP: confirm editing `extra_remark` does not touch PTP status/amount/fields.
- Non-owner (including branch_manager/TL) attempting the direct-edit endpoint: must be rejected — they still have the correction-request path.
- Agent with no allocated customers in a branch/bucket they previously had selected (e.g., reallocated overnight): filter options should regenerate from current allocation on next load; stale persisted selections that no longer match any customer should just yield an empty (not erroring) filtered list.
- Multi-select filter combined with existing `product`/`q`/`company_id` worklist params: all should AND together as today.
- Field visit correction-request extension: verify existing decide/bulk-decide logic in `correction-requests.ts` generalizes cleanly to a fourth record type rather than needing per-type special-casing beyond the `ALLOWED_FIELDS` map.

## Out of scope

- Server-side/cross-device persistence of filter selections (client-local storage only).
- Full edit-history/audit trail for remark edits (overwrite + `edited_at` flag only, per decision).
- Any change to the disposition code / structured fields / PTP-triggering portion of a call log via the new same-day edit path.
- Offline queuing behavior for mobile edits beyond whatever pattern already exists for call/visit creation.
