# Licence Management (Online build only)

Built 2026-11-17 on branch `feature/licence-management` (from `milestone-2-c1`). Spec: `core-licence-management-page.md` (Option B).

## Switching it on
`FP_ONLINE=1` in the service environment (`config.online`). Unset = standalone box: no table, no `/api/licence-deployments` route (404), `/api/me` never says `online`, no menu entry, `#/licences` redirects to MONITORING.
When the flag is set the server creates two tables at start-up (`licence_deployments`, `licence_history`; `CREATE TABLE IF NOT EXISTS`, nothing is altered or dropped). This repo has no numbered migrations: all schema is idempotent SQL run at start-up. Take a database backup before the first start with the flag.

## Rules
- Admin only: Operator gets 403 on every route, no menu entry. Every change is written to `audit_log` (`licence_deployment.create | update | issued | renewed | history`).
- Deployments, usage and last seen are typed in; RENEW / ISSUE record a licence and a history row and sign nothing; there is no REVOKE. DOWNLOAD .FPLIC signs (below).
- Status is computed from `valid_until` against the server clock (`src/deployments/calc.ts`), never stored. The licence is valid while now < valid_until (a date-only input is stored as 23:59:59Z that day, like a signed file). EXPIRING = 30 calendar days or less (UTC), including 0 (expires today).
- An EXPIRED box is judged against the FREE limits (`src/licence/free.ts`), as the box itself does, so 14 sensors on an expired box is OVER LIMIT against 10.
- Tiers (owner decision 2026-11-18, `core-licence-tiers.md`; one constant, `src/deployments/tiers.ts`, sent to the page by the list API): FREE 1 data source / 10 sensors, PRO 5 / 50, FULL 25 / 250, ENGINEERING unlimited. DATA SOURCES is the UI word for the existing `gateways` limit; no column or JSON key was renamed. The type fixes the limits: the issue / renew dialog fills them from the table and the API refuses limits that do not match the tier (a limit left out is filled in).
- FREE has no licence ID, issue date or expiry (choosing FREE in the dialog clears them and writes a NOTE row). Issue dialog defaults: issued today, valid until one year later (editable), NO EXPIRY allowed. History text: ISSUED / RENEWED + "PRO, 5 data sources, 50 sensors, until 18 Nov 2027".
- ENGINEERING is a selectable fourth type (owner, 2026-11-18): unlimited data sources and sensors (every limit null), no expiry by default (the dialog starts with NO EXPIRY ticked; an expiry can still be set). Its usage bars read "n of unlimited" and never show AT LIMIT or OVER LIMIT. Note: a signed ENGINEERING .fplic must have no expiry (`licence/format.ts`); this page records, it does not sign.
- **To be confirmed (open question 1):** reports reach and history kept for FULL are not defined. FULL is recorded like PRO (any report date, 365 days of history) and the dialog says so. FREE is 7 / 90.
- **Not done (open question 2):** the box's own licence check (About, `.fplic`) still knows FREE, PRO and ENGINEERING only. FULL there changes enforcement and is a separate task; this page only records.
- Schema: the first Online build had CHECK (type IN FREE, PRO, ENGINEERING). Start-up rebuilds that table once to allow FULL (rows and history kept). That runs on the bench at the next start with the new build, after a backup.

## Where the code differs from the spec
The mockups and the spec say "FULL", and show gateways and sensors only; the code has FREE / PRO / ENGINEERING and four limits. The code won, and the licence card also shows reports and retention days.

## Open questions
Unchanged from the spec (how boxes report to the VPS, whether this page ever signs, re-issue on a replaced box, REVOKE, paid types).

## DOWNLOAD .FPLIC (2026-11-18, `core-licence-file-download.md`)
Signed on the Online server with the **dev-1 key only** (`src/deployments/signing.ts`). The production key is never on this server.
- **Setting:** `FP_LICENCE_SIGNING_KEY_FILE` = path of the dev-1 private key (PEM, Ed25519). Unset or unreadable: the button is off with "No signing key on this server".
- **Placement on the bench:** outside the repo, readable by the service user only. Suggested `/etc/farmpilot-core-signing/dev-1.private.pem` (directory `root:fpcore` 750, file `root:fpcore` 640); the unit runs `ProtectSystem=strict`, which still allows reading under `/etc`. Never under `/opt/farmpilot-core` (the repo) or `/var/lib/farmpilot-core` (backups include it).
- **Only dev-1:** the key id written into the file is the constant `dev-1`, and the key is accepted only when its public half equals the built-in `DEV_KEYS["dev-1"]`; a production key or any other key is refused. A release build never signs.
- **Verified before offered:** every file is checked with the box's own `checkLicence` (dev-1 public key, the deployment's Device ID); a failure offers nothing.
- **When it is off, the reason is shown:** FREE "FREE has no licence file"; FULL "The box does not accept FULL yet"; ENGINEERING with an expiry (the signed format has none) with a CLEAR EXPIRY button; no licensed-to; no key.
- Every download writes an audit row (`licence_deployment.fplic_downloaded`) and a history row (DOWNLOADED). The key is never logged, returned or stored; nothing is stored of the file.
- The `licence_history` table is rebuilt once at the next start to allow DOWNLOADED (rows kept), like REMOVED before it.
- Still open: who signs production licences and where the production key lives.
