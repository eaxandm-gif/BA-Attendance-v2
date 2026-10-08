# 4.6.7 — Complete historical reports and authoritative OT

Historical admin reports previously loaded recent bootstrap summaries only, then loaded older attendance separately. Missing daily summaries activated a different browser formula; an unresolved legacy shift reference could set required time to zero and report the entire day as OT.

- Add authenticated, date-scoped `report_data`, paging all four report tables without the previous row caps.
- Load daily and monthly reports together with schedules, leave and events. Prevent stale month responses and block export while loading or after failure.
- Use stored daily OT/credited/required/net values, preserving explicit zeroes. Missing summaries are marked for recalculation instead of inventing OT.
- Resolve known quoted legacy shift IDs for display without modifying historical records.
- Remove ba-api's alternative calculation fallback. Database calculation remains authoritative and includes actual arrival before shift, as confirmed by the owner. Existing 540-minute gross requirement and separate excess break treatment remain unchanged.

Validation: frontend, report calculations, 12,001-event pagination, overlapping month requests, partial-load failures, missing summaries, zero values, RPC failure without fallback writes, and PostgreSQL attendance/correction/GPS regression checks.

Deployment order: deploy admin-api and ba-api first, then publish frontend. No SQL migration is required for these code changes. Historical database audit and live verification must be completed before claiming production totals are corrected. Do not delete or invent historical events; missing/invalid sequences need evidence-based correction.
