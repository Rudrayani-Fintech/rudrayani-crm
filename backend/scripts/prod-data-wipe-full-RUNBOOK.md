# Production FULL RESET — Runbook

**Who runs this**: The agency owner (not an automated process).
**Irreversible**: Once `COMMIT` is typed, the data is gone.

This is a **more drastic** wipe than `prod-data-wipe.sql` / its runbook.
That one keeps all employees, branches, teams, and companies and only
clears transactional data. **This one** resets the database back to
just: the agency row, the agency-admin login (phone `9999999999`),
`disposition_codes`, and static app config (`permissions`,
`capability_permissions`, `system_field_definitions`). Every branch,
team, company, customer, other employee, and all transactional data is
deleted.

---

## Pre-flight checklist

1. **Take a pg_dump backup first (mandatory, no exceptions)**:
   ```bash
   pg_dump "$DATABASE_URL" -Fc -f prod-backup-$(date +%Y%m%d-%H%M).dump
   ```
   Store it somewhere safe (local disk, S3, Dropbox) before doing anything else.
   This is the only way back if anything about this script is wrong.

2. **Confirm the admin login still works** before wiping — log in to the
   web portal with phone `9999999999` first, so you know that account is
   real and active on this database.

3. **Check the connection string host** before connecting — Railway's
   `DATABASE_URL` is on the Railway dashboard under the Postgres service →
   Variables → `DATABASE_URL`. Make absolutely sure it points at
   **production**, not a local or test DB.

4. **Notify anyone using the system** — this deletes every other login,
   so every other employee will be signed out and unable to log back in
   until re-created.

---

## Steps

### 1. Connect to production Postgres
```bash
psql "$DATABASE_URL"
```

### 2. Verify you are on the right database
```sql
SELECT current_database(), current_user, inet_server_addr();
```
If this points at `localhost` or anything other than the Railway host, **STOP**.

### 3. Run the script
```bash
psql "$DATABASE_URL" -f backend/scripts/prod-data-wipe-full.sql
```
Or from inside `psql`:
```sql
\i backend/scripts/prod-data-wipe-full.sql
```

This opens a transaction, aborts immediately if it can't find exactly one
user with phone `9999999999` (so it never silently deletes everyone),
prints before-counts, runs the wipe, and prints after-counts. **It does
NOT commit** — the last line is commented out.

### 4. Review the output

- `agencies` → 1
- `users` → 1
- `branches`, `teams`, `companies`, `customers`, `call_logs`, `payments` → 0
- `disposition_codes`, `permissions`, `capability_permissions`,
  `system_field_definitions` → unchanged from the before-counts

If anything looks wrong, type `ROLLBACK;` and investigate — do not commit.

### 5. Confirm and commit
```sql
COMMIT;
```
This is the point of no return.

### 6. Post-wipe smoke test

1. Log in to the web portal with phone `9999999999` — should still work.
2. Dashboard should load empty (no companies/customers), not crash.
3. Employees page should show only the one admin account.
4. Companies/Branches/Teams pages should all be empty.
5. Disposition code master (Settings → Dispositions or similar) should
   still show all 70 codes.
6. Try creating one branch/team/company/employee — confirms the app
   still functions from this reset baseline.

---

## What is preserved

| Table | Preserved |
|-------|-----------|
| `agencies` (the one agency row) | ✅ |
| `users` (only phone `9999999999`) | ✅ |
| `disposition_codes` | ✅ |
| `permissions`, `capability_permissions` | ✅ (static RBAC config) |
| `system_field_definitions` | ✅ (import field catalog, kept so the app doesn't need re-seeding) |

## What is wiped

Everything else: `branches`, `teams`, `companies`, `company_field_settings`,
`import_templates`, `import_runs`, `products`, `customers`,
`customer_month_snapshots`, `call_logs`, `payments`, `ptps`,
`import_review_items`, `allocation_logs`, `bucket_movements`, `buckets`,
`targets`, `reminders`, `attachments`, `field_visits`,
`reallocation_requests`, `correction_requests`, `dashboard_preferences`,
`attendance`, `location_pings`, `refresh_tokens`, `otp_requests`,
`audit_logs`, and every user other than phone `9999999999`.
