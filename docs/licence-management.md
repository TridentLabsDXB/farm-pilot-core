# Licence Management (Online build only)

Built 2026-11-17 on branch `feature/licence-management` (from `milestone-2-c1`). Spec: `core-licence-management-page.md` (Option B).

## Switching it on
`FP_ONLINE=1` in the service environment (`config.online`). Unset = standalone box: no table, no `/api/licence-deployments` route (404), `/api/me` never says `online`, no menu entry, `#/licences` redirects to MONITORING.
When the flag is set the server creates two tables at start-up (`licence_deployments`, `licence_history`; `CREATE TABLE IF NOT EXISTS`, nothing is altered or dropped). This repo has no numbered migrations: all schema is idempotent SQL run at start-up. Take a database backup before the first start with the flag.

## Rules
- Admin only: Operator gets 403 on every route, no menu entry. Every change is written to `audit_log` (`licence_deployment.create | update | issued | renewed | history`).
- Record only: deployments, usage and last seen are typed in; RENEW / ISSUE record a licence and a history row, nothing is signed; DOWNLOAD .FPLIC is disabled; there is no REVOKE.
- Status is computed from `valid_until` against the server clock (`src/deployments/calc.ts`), never stored. The licence is valid while now < valid_until (a date-only input is stored as 23:59:59Z that day, like a signed file). EXPIRING = 30 calendar days or less (UTC), including 0 (expires today).
- An EXPIRED box is judged against the FREE limits (`src/licence/free.ts`), as the box itself does, so 14 sensors on an expired box is OVER LIMIT against 10.
- Types are the real ones: FREE, PRO, ENGINEERING. Limits are gateways, sensors, reports_days, retention_days (null = unlimited). ENGINEERING = every limit null, no expiry (same rule as `licence/format.ts`).

## Where the code differs from the spec
The mockups and the spec say "FULL", and show gateways and sensors only; the code has FREE / PRO / ENGINEERING and four limits. The code won, and the licence card also shows reports and retention days.

## Open questions
Unchanged from the spec (how boxes report to the VPS, whether this page ever signs, re-issue on a replaced box, REVOKE, paid types).
