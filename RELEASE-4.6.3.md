# Attendance 4.6.3

A previous-day attendance correction searched a 48-hour window and could soft-delete the following day's start event. The old presence-based policy then offered a new start even with an orphaned break. The insert RPC locked requests but only rejected same-type events within ten seconds; it did not validate transitions.

## Changes

- FIXED_BRANCH accepts exactly a prefix of IN → BREAK_OUT → BREAK_IN → OUT. Invalid existing histories are blocked pending privileged correction.
- STOCK_REFILL preserves refill visits before/after the single work cycle, including legacy IN/OUT aliases; orphaned/duplicate/reversed work histories cannot restart. Legitimate MULTI_BRANCH transitions remain unchanged.
- All attendance mutations, including Admin and Supervisor corrections, share an employee transaction lock. The employee RPC rechecks state inside that lock, assigns time after locking, preserves the ten-second duplicate guard, and scopes idempotency to employee/type/source/actor.
- Only the backend service role can call these RPCs. ADMIN and SUPERVISOR events count toward state. The employee RPC cannot request an admin override.
- Supervisor approval now replaces only the intended date/shift window. Replacement, audit and review status commit together, with rollback on failure. Overnight checkout windows stop at the following shift's start.
- Admin additions use a separate privileged RPC with required reason and atomic audit. Existing authenticated admin edit/delete paths participate in locking.
- Frontend retries retain the request key across a tab reload; Safari refresh uses the external session; a refresh error after successful submission never offers a resubmission. Invalid histories show a supervisor-review message.
- Production source for both Edge Functions is now versioned in this repository; it was previously absent.

## Validation

`npm install` then `npm test` on Node 24+. Embedded PostgreSQL needs permission for local shared memory and a loopback listener on port 55439. It creates a temporary disposable cluster, never connects to Supabase, and stops it after testing. Set `BA_TEST_RUNTIME` to an existing node_modules directory if needed. Install the embedded-postgres platform package's approved postinstall script for binary symlinks.

20 PostgreSQL test groups plus 6 frontend groups cover exhaustive fixed prefixes, SQL/JS agreement, production-policy regression fixtures, valid multi/refill paths, malformed histories, identity collisions, eight simultaneous requests, same-key replay, admin locking, rollback, previous-day correction and overnight boundaries. Inline frontend and backend syntax is checked separately.

## Deployment

Apply the three migrations in filename order once, then deploy `admin-api` and `ba-api` using the project's existing authentication configuration, then publish the root frontend files. Do not expose the service role or Admin API key in frontend files. The SQL and both Edge Functions were applied on 2026-09-25 after local tests and a rollback-only production-schema dry-run. Deployed sources were downloaded and compared byte-for-byte with the tested files.

Existing employee histories are not rewritten by these migrations. Review anomalous histories through the privileged, audited correction workflow. The migrations intentionally fail closed on malformed fixed/refill histories.

A live unauthenticated bootstrap probe verifies the BA version header and authentication rejection; the existing unauthenticated path returns HTTP 500 with the LINE-token-required message. No real employee submission is generated for smoke testing.
