# BA Attendance 4.7.0

## Changes
- Explicit rejection action in the shared Admin/Supervisor editor. Rejecting a legacy request without time requires an audit reason but does not require a time or the approval-only confirmation. Approval still requires actual event times. Both decisions retain existing server authorization, locking and auditing.
- Shared color, spacing, typography, button, table, responsive navigation and modal styles. Locally hosted Noto Sans Thai with upstream OFL license. Screen-reader labels, focus trapping/restoration, visible keyboard focus, minimum button height and safe-area padding.
- Employee clock/actions first, compact summary, separate request/calendar/leave navigation. Actions remain solely those returned by the server. Existing history, location recovery, profile, schedule and special-mode operations remain accessible.
- Admin navigation grouped by task; employee status filters default to active and allow all/inactive. Tables retain horizontal scrolling inside their frame. Report computation is unchanged.
- Requests show Thai status labels, preserve original reasons, and separate pending requests from history. Read markers are separate from approval status and stored per browser/profile; they do not synchronize across devices.
- Calendar dates open their own attendance details. Future dates remain schedule views. Short calendar labels avoid narrow-screen overflow.
- Admin employee row offers “ตั้งเป็นหัวหน้างาน”. This opens a prefilled Supervisor form using the existing LINE account; no rights change until the administrator saves. If that account already has a Supervisor record, the existing record opens. Assign team members via their Supervisor field afterward. Existing authentication prioritizes an active Supervisor record over BA login; this release does not add dual-role switching.

## Preserved boundaries
No database migration, Edge Function deployment, historical attendance rewrite, OT formula, geofence, WFH capability or authorization expansion is part of this release. Existing request-history retention windows remain unchanged. Features conditional on backend support, including WFH, time-credit requests and dual-role switching, are not invented in the presentation layer.

## Validation
- Automated UI tests cover Thai option labels without modifying submitted enum values, request read markers, all three attendance modes, unknown summaries, and text contrast >=4.5:1.
- Shared reviewer tests cover missing times, rejection with no time, required reason, two-break corrections, replacement selection, escaping and network retry.
- Existing frontend, report and 36 database regression groups pass, including concurrent requests, locking, idempotency, administrator corrections and ownership checks.
- Browser fixture checks cover employee home, admin tables, Supervisor rejection, promotion form (not saved), calendar, long Thai names and reasons. Home/rejection checked at 360/390/430/768/1024/1440 CSS pixels. Table/zoom checks also covered intermediate widths; horizontal overflow stays inside tables. Calendar overflow corrected after visual inspection.
- Physical iPhone/Android/Windows and LINE WebView checks still require those devices. Browser viewport checks are not equivalent to real-device certification.

## Reproduce
Run `npm test`. For isolated browser fixtures, run `node tests/preview-server.mjs`, then open http://127.0.0.1:4177/index.html, /index.html?view=supervisor or /admin.html. Fixtures contain fabricated people and never call production.
