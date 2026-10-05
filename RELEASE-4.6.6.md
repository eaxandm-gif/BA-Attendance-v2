# 4.6.6 — Correct work boundaries in admin reports

The admin report replaced a null summary checkout with the latest REFILL_OUT or BRANCH_OUT. Employees who finished a stock refill before beginning work therefore appeared to check out before checking in. A stock refill after work could also replace the actual checkout when no summary was present.

Respect existing summary boundaries, including null values. When no summary exists, use only IN/OUT for fixed branch, WORK_IN/WORK_OUT (plus legacy IN/OUT) for stock refill, and DAY_IN/DAY_OUT for multi-branch. Apply those types to the monthly matrix fallback too, and prevent an inverted fallback interval from becoming a fictitious overnight work span.

Validation: four admin summary groups, eight existing frontend groups, and three request editor groups pass. Scenarios cover refills before and after work, branch exit before day checkout, fixed branch, null summary values, and monthly matrix fallback. Inline script parsing and git diff checks pass. Database records and APIs are unchanged; no SQL deployment or employee data correction is required. Frontend version is 4.6.6; API version remains 4.6.5.
