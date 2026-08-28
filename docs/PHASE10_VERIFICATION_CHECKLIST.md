# Phase 10 — End-to-End Verification Checklist

Agent Daily Activity feature completion verification. Test as admin, branch_manager, and agent roles.

## Pre-Testing Setup

- [ ] Backend and frontend both build successfully
- [ ] Database migrations current (if any)
- [ ] Dev server running with both backend and frontend
- [ ] Test user accounts available for each role (admin, branch_manager, telecaller, field_agent)

---

## 1. Routing & Navigation

### 1.1 Navigation Item Visibility
- [ ] **Admin login**: "Agent Daily Activity" appears in nav under Reports
- [ ] **Branch Manager login**: "Agent Daily Activity" appears in nav
- [ ] **Telecaller login**: "Agent Daily Activity" does NOT appear in nav
- [ ] **Field Agent login**: "Agent Daily Activity" does NOT appear in nav
- [ ] **Ops Manager login**: "Agent Daily Activity" appears in nav

### 1.2 Route Access
- [ ] Navigate to `/agent-activity` as admin → page loads
- [ ] Navigate to `/agent-activity` as branch_manager → page loads (scoped to their branch)
- [ ] Navigate to `/agent-activity` as telecaller → redirects to 403 or home
- [ ] `/management-dashboard` route no longer exists (404 or redirects)

---

## 2. Primary Filters

### 2.1 Date Picker
- [ ] Default date is today (in IST)
- [ ] Can change to any past date
- [ ] Changing date resets page to 1 and fetches new data
- [ ] URL updates with `date=YYYY-MM-DD` param

### 2.2 Search Input
- [ ] Typing in search box debounces (waits ~400ms before fetching)
- [ ] Search matches customer name, loan number, or mobile number
- [ ] Clearing search refetches all rows for current date/filters
- [ ] URL updates with `search=` param (with special chars URL-encoded)

### 2.3 Branch Multi-Select
- [ ] Dropdown shows all available branches
- [ ] Can select multiple branches
- [ ] Selecting/clearing branches refetches immediately
- [ ] URL updates with `branch_id=X&branch_id=Y` repeatable params
- [ ] Branch Manager: only sees and can select their own branch (RBAC enforced)

### 2.4 Bucket Multi-Select
- [ ] Dropdown shows bucket labels
- [ ] Can select multiple buckets
- [ ] Selecting/clearing buckets refetches immediately
- [ ] URL updates with `bucket=X&bucket=Y` repeatable params

### 2.5 Agent Multi-Select
- [ ] Dropdown shows all active telecallers and field agents (names searchable)
- [ ] Can select multiple agents
- [ ] Selecting/clearing agents refetches immediately
- [ ] URL updates with `agent_id=X&agent_id=Y` repeatable params
- [ ] Branch Manager: only sees agents from their own branch

### 2.6 Agent Type Segmented
- [ ] Shows "All / Telecaller / Field Agent" toggle
- [ ] Defaults to "All" (no filter)
- [ ] Selecting Telecaller shows only call/ptp/payment rows from telecallers
- [ ] Selecting Field Agent shows only field_visit rows
- [ ] URL updates with `agent_type=telecaller` or `agent_type=field_agent` (no param if "All")

### 2.7 Clear Filters Button
- [ ] Resets all primary filters to defaults (date=today, search="", all others empty)
- [ ] Resets secondary filters too (actionTypes back to all 4, others to empty)
- [ ] Refetches with defaults

---

## 3. Secondary Filters (Behind "More Filters" Collapse)

### 3.1 Collapse Panel
- [ ] "More Filters" toggle is collapsed by default
- [ ] When collapsed, shows "More Filters (0)" if no secondary filters active
- [ ] When collapsed, shows "More Filters (3)" if 3 secondary filter categories have values
- [ ] Clicking expands to show the 5 secondary filter controls
- [ ] Collapse panel styling consistent with page theme

### 3.2 Company Multi-Select
- [ ] When expanded, dropdown shows all companies
- [ ] Can select multiple companies
- [ ] Selecting/clearing refetches
- [ ] URL updates with `company_id=` repeatable params

### 3.3 Product Multi-Select
- [ ] Shows distinct product labels
- [ ] Can select multiple products
- [ ] Selecting/clearing refetches
- [ ] URL updates with `product=` repeatable params

### 3.4 Action Type Checkboxes
- [ ] Shows 4 checkboxes: Call, Payment, PTP, Field Visit
- [ ] All 4 are checked by default
- [ ] Unchecking an action type immediately refetches (only rows of selected types shown)
- [ ] Unchecking all 4 shows no rows (valid edge case)
- [ ] URL updates with `action_type=call&action_type=payment` etc.
- [ ] "More Filters (1)" shows if not all 4 are selected

### 3.5 Disposition Code Multi-Select
- [ ] Shows disposition codes with action_code + description
- [ ] Can select multiple codes
- [ ] Only affects `call` action rows (others show "—" in Disposition column)
- [ ] Selecting/clearing refetches
- [ ] URL updates with `disposition_code_id=` repeatable params

### 3.6 PTP Status Checkboxes
- [ ] Shows 3 checkboxes: Pending, Kept, Broken
- [ ] Defaults to empty (no filter = all PTP statuses shown)
- [ ] Selecting/clearing refetches
- [ ] Only affects `ptp` action rows (others show "—" in PTP Status column)
- [ ] URL updates with `ptp_status=pending&ptp_status=kept` etc.

---

## 4. Data Table & Pagination

### 4.1 Table Display
- [ ] 11 columns render correctly: Time, Agent, Action, Customer, Company, Product, Branch, Bucket, Amount, Disposition, PTP Status, Remark
- [ ] Rows display correct data (spot-check 3-5 rows against database values)
- [ ] Table is horizontally scrollable within its container (no page-level horizontal scroll)
- [ ] Row height and spacing is comfortable

### 4.2 Column Rendering
- [ ] **Time**: Shows `HH:mm` (e.g., "14:35"), monospace font
- [ ] **Agent**: Shows name + small colored tag (blue=Telecaller, cyan=Field Agent)
- [ ] **Action**: Colored tag (blue=Call, green=Payment, orange=PTP, red=Field Visit)
- [ ] **Customer**: Clickable (cursor pointer, primary color), opens drawer on click
- [ ] **Branch/Bucket/Company/Product**: Text, "—" if null
- [ ] **Amount**: Right-aligned, `₹1,234.56` format (tabular-nums), "—" if null
- [ ] **Disposition**: Call rows show code, others show "—"
- [ ] **PTP Status**: `ptp` rows show colored tag (default=gray, success=green, error=red), others "—"
- [ ] **Remark**: Truncated with ellipsis, full text in tooltip on hover

### 4.3 Pagination
- [ ] Shows "Showing 1 to 50 of X actions on [date]" text
- [ ] Default page size is 50
- [ ] Pagination controls at bottom: current page, next/prev buttons, total pages
- [ ] Clicking page number fetches that page
- [ ] Page state synced to URL (`page=2`)
- [ ] Changing filters resets to page 1

### 4.4 Empty State
- [ ] When no rows match filters, shows empty state with message "No agent activity matches these filters"
- [ ] No error/crash when switching to empty results

### 4.5 Loading State
- [ ] Page shows loading spinner (Ant Spin) while fetching
- [ ] Filters are disabled during load
- [ ] Export button is disabled during load

---

## 5. Customer Detail Drawer Integration

### 5.1 Row Click
- [ ] Click on customer name opens drawer
- [ ] Drawer shows customer full detail (ID, name, loan, phone, EMI, POS, etc.)
- [ ] Drawer remains open across filter changes (independent state)
- [ ] Click close/X in drawer closes it

### 5.2 Multiple Clicks
- [ ] Click customer A → drawer opens with A's data
- [ ] Click customer B (in same table) → drawer updates to B's data (not a second drawer)
- [ ] Close drawer, click again → opens cleanly

---

## 6. Export Button & Excel Download

### 6.1 Export Mechanics
- [ ] Export button shows "Export to Excel" text + download icon
- [ ] Click starts export, button shows spinner
- [ ] Button is disabled while export in progress (no double-click)
- [ ] After ~1-2 seconds, file downloads as `agent-activity-YYYY-MM-DD.xlsx`
- [ ] Success toast: "Export downloaded successfully"

### 6.2 Export with Filters
**Test scenario: Admin selects Branch=Mumbai, Agent=Raj, Date=2026-08-28**
- [ ] Export includes only rows matching those filters
- [ ] Row count in Excel ≤ row count on screen (if pagination at page 1, should match approximately)
- [ ] Open file: 18 columns + data

### 6.3 Excel File Contents
- [ ] Header row (bold): Date, Time, Agent Name, Agent Type, Action Type, Customer Name, Mobile Number, Loan Number, Company, Product, Branch, Bucket, Outstanding (POS), EMI, Due Amount, Amount, Disposition Code, Disposition Description, PTP Status, Remark
- [ ] Data rows match table display (spot-check 3-5 rows)
- [ ] Numbers formatted as text (no auto-conversion to scientific notation)
- [ ] Currency shows with ₹ symbol and 2 decimals
- [ ] Column widths are readable (not too narrow)

### 6.4 Export Row-Count Cap
**Test scenario: Filter to a combination that would return 30,000+ rows**
- [ ] Export button click shows error: "Too many rows (30,456) for one export — narrow your filters..."
- [ ] Error includes actual count (so user knows how much to narrow)
- [ ] No file downloaded

### 6.5 Export RBAC
**Test scenario: Branch Manager from Mumbai tries to export but adds Branch filter for Delhi (another branch)**
- [ ] Export honors scope clamp: only returns Mumbai rows (filter for Delhi is ignored)
- [ ] Or: return only rows the branch_manager can see (RBAC applied)

---

## 7. URL Sync & Bookmarking

### 7.1 State Persistence
- [ ] Set filters: Branch=Mumbai, Search="Loan123", Agent=Raj, Company=HeroFin
- [ ] URL shows: `?date=2026-08-28&branch_id=...&search=Loan123&agent_id=...&company_id=...`
- [ ] Copy URL, paste in new browser tab → page loads with exact same filters applied

### 7.2 Back Button
- [ ] Apply filters A → URL changes
- [ ] Apply filters B → URL changes
- [ ] Click browser back button → returns to filters A view
- [ ] Click forward → returns to filters B view

---

## 8. Dark Mode Consistency

### 8.1 Light Mode
- [ ] All text readable (sufficient contrast)
- [ ] Table rows alternate background (if design calls for it)
- [ ] Buttons, tags, inputs styled correctly

### 8.2 Dark Mode
- [ ] Toggle app to dark theme
- [ ] Colors adapt (all component colors use theme tokens, no hardcoded hex)
- [ ] Table still readable
- [ ] Tags still readable (colors meaningful, not washed out)
- [ ] No white-on-white or black-on-black text

---

## 9. Role-Based Access Control (RBAC)

### 9.1 Admin
- [ ] Can see all branches, all agents, all data
- [ ] No filters are pre-applied
- [ ] Can export full result set

### 9.2 Branch Manager
- [ ] Can only see their own branch (Branch filter only shows own branch)
- [ ] Attempting to manually pass another branch_id in URL is ignored (server-side clamp)
- [ ] Can see only their own branch's agents in Agent dropdown
- [ ] Export includes only their branch's data

### 9.3 Telecaller / Field Agent
- [ ] Nav item "Agent Daily Activity" is hidden
- [ ] Direct access to `/agent-activity` results in 403 or redirect to home
- [ ] Cannot access page at all

### 9.4 Ops Manager
- [ ] Can see all branches and all agents (like Admin)
- [ ] Same permissions as Admin for this page

---

## 10. Error Handling

### 10.1 Network Errors
- [ ] Disconnect backend, try to fetch data → error toast shown, table remains at previous state
- [ ] Reconnect backend, filters still apply → can refetch successfully

### 10.2 Invalid Filter Values
- [ ] Try to manually add invalid `agent_id=invalid-uuid` to URL → API returns 400 or gracefully ignores
- [ ] Page still loads (doesn't crash)

### 10.3 Export Errors
- [ ] Trigger an export, then disconnect backend mid-export → error toast appears, button re-enables
- [ ] Can retry export

---

## 11. Performance

### 11.1 Initial Load
- [ ] Page loads with ~500 rows on initial date (today) in < 3 seconds

### 11.2 Filter Application
- [ ] Applying a new filter (e.g., agent select) refetches in < 1 second

### 11.3 Pagination
- [ ] Clicking page 10 fetches and renders in < 1 second

### 11.4 Export
- [ ] Exporting 10,000 rows completes in < 5 seconds

---

## 12. Documentation

- [ ] `docs/USAGE_GUIDE_EN.md` updated: "Agent Daily Activity" section describes feature, filters, use cases
- [ ] No references to "Management Dashboard" remain in user-facing docs (archived references OK in design docs)

---

## Sign-Off

- [ ] All 12 sections above tested and passing
- [ ] No regressions in other pages (Dashboard, Reports, OrgChart, etc. still work)
- [ ] No TypeScript errors in build
- [ ] All Phases 1-9 commits present in git history
- [ ] Ready for production release

**Tested by:** ________________  
**Date:** ________________  
**Notes:** ________________

---

## Deferred Issues (if any)

Document any issues found that are deferred to a future release:

1. _________________
2. _________________
3. _________________

