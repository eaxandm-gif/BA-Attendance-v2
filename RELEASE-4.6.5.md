# 4.6.5 — Editable attendance requests

Employees can request a forgotten break start, break return, or both, with actual times. Administrators and supervisors review the original request beside that day's history and may correct event type, time, and office before approving. Existing incorrectly categorized requests use this same editor. A replacement requires an explicit existing-event selection; approval never silently replaces shift start/end.

The service-only RPC locks the request and employee, rejects stale history, validates the projected complete day under the existing attendance policy, and writes events, decision, and audit together. Identical approval retries replay the prior result. Original request details remain unchanged. Supervisor access remains restricted to their current team. Existing three-day request expiry remains in effect. Times in this editor are within the request's Bangkok calendar date; cross-midnight corrections still require the existing privileged Attendance workflow.

Changed: index.html, admin.html, attendance-review.js, config.js, ba-api, admin-api, SQL migration 202610050004, package metadata and tests. Old direct-approval API actions ask clients to reload into the editor.

Validation: 8 existing frontend groups, 3 shared-editor/form groups and 36 PostgreSQL groups pass. Coverage includes both break times, mistaken legacy request types, original record preservation, explicit replacements, supervisor scope, stale history, concurrent approvals, retry conflicts, audit rollback, GPS review, and MULTI_BRANCH/STOCK_REFILL regressions. API TypeScript stripping and JavaScript syntax checks pass. Database tests use the production enum for audit roles in the new workflow.

Deployment order: SQL migration, both Edge Functions, then frontend files including attendance-review.js. No historical employee records are changed by the migration or release.
