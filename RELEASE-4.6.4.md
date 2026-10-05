# Attendance 4.6.4 — GPS exception requests and admin approvals

A GPS accuracy rejection previously ended in a generic error dialog. Employees had no request path for breaks, and the desktop admin interface did not expose existing attendance correction requests.

## Changes

- GPS rejection now offers retry, Safari and an explicit request for human review. No branch radius or GPS accuracy threshold is increased.
- GPS requests support all existing event modes, record server receipt time, employee-selected office, reason and optional fresh coordinates. A request is not a completed attendance event. Only one pending request per employee is allowed.
- Admins and the employee's current supervisor can approve/reject. Approval locks the employee, validates the entire resulting chronological sequence, inserts one event and commits the request decision and audit together. Changed/invalid history fails without overwriting records. Repeated approvals are idempotent.
- Desktop admin has a searchable attendance request queue, pending/approved/rejected filters, reasons and review actions for both legacy correction requests and GPS requests.
- Existing start/end correction review now has an explicit service-only administrator route. Supervisor ownership checks and date boundaries remain intact.
- GPS fallback rejects stale or future fixes and invalid coordinate ranges. LINE and Safari preserve structured GPS errors, and Safari can submit/check GPS requests.

## Validation and deployment

Run `npm install` and `npm test` using Node 24+. If npm blocks the pinned embedded-postgres postinstall, run its platform package's `scripts/hydrate-symlinks.js` before testing. PostgreSQL tests use a disposable local cluster, never production records.

27 PostgreSQL groups and 8 frontend groups cover previous behavior, GPS queue and replay, changed histories, supervisor scope, service-only permissions, administrator correction and concurrent approvals. Backend transpilation and frontend script syntax are also checked.

Apply `202610050001_admin_correction_review.sql` then `202610050002_gps_attendance_requests.sql` and `202610050003_legacy_break_request_guard.sql`, deploy both Edge Functions preserving existing auth configuration, then publish frontend files. These migrations do not approve requests or alter employee histories. New table RLS is enabled with no public/employee direct access; backend endpoints enforce identity.

## Audit findings and remaining work

1. **Fixed:** GPS errors had no usable review path, desktop admins could not review attendance requests, and some fallback branches accepted stale locations.
2. **Operational limit:** GPS is not physical presence proof. A reviewer must confirm presence and the requested event; approval uses the time the server received the request, not an inferred shift time. Pending requests need prompt human review before the next event. Legacy start/end correction requests still use shift boundaries and expire after three days.
3. **High priority:** Admin access uses one shared API key persisted in browser localStorage. Move to individual authenticated admin accounts and scoped roles in a separate auth migration; this release retains the existing access model.
4. **High priority:** Existing direct admin edit/delete operations and some legacy workflows write their audit separately from the mutation. Extend the atomic transaction pattern beyond the new request paths.
5. **Medium priority:** GPS failure frequency and device/browser accuracy distributions are not collected centrally before a request. Add retention-limited diagnostics and review location quality per office. Do not infer that rain alone caused a failure from one screenshot.
6. **Medium priority:** The live work timer uses elapsed start time before final calculation and can include breaks. Unify live and finalized work-minute calculation with explicit break-policy tests.
7. **Medium priority:** Large bootstrap/history queries have fixed row limits; add pagination and explicit truncation indicators beyond the request queue.

This is a source, schema and attendance-workflow review with targeted regression tests, not a full penetration test or payroll audit. No real employee requests are approved for testing.

Live queue review also found legacy start/end requests whose reasons explicitly refer to breaks. Their approval is now blocked in the shared database correction function and admin UI; reviewers must correct the intended break event through audited Attendance management and close the mismatched request. The guard uses explicit Thai/English break keywords and cannot infer every ambiguous free-text reason.
