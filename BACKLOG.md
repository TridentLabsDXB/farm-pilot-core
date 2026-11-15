# Backlog

## Milestone 2 (security hardening, raised 2026-11-15)
- **Login rate limiting, persistent and per account/IP.** Today: in-memory only, 5 failures per username+IP lock that pair for 5 minutes, and the counters reset on restart. Add a DB-backed counter, a global per-IP limit, and an audit row on lockout.
- **Forced password change on first login.** The bootstrap `admin` password (file `initial-admin-password`, or `CORE_ADMIN_PASSWORD`) and any password an Admin sets for another user must be marked `must_change`; the API refuses everything except change-password until it is changed, and the bootstrap file is deleted after the change.
- Admin UI action to delete a user (today only disable; test users had to be removed by hand in SQLite).
- Optional: password minimum/complexity rule beyond 8 characters, session list and revoke.

## Before the real industrial PC (raised 2026-11-16, Milestone 2)
- **Tested install procedure for the industrial PC.** `deploy.sh` now uses `npm ci --ignore-scripts` because `better-sqlite3` ships prebuilt binaries (`prebuilds/<platform>-<arch>.node`) and the implicit `node-gyp rebuild` fails on a box without `make`/`g++`. That only works if a prebuilt binary exists for the TARGET CPU architecture and Node version (bench: linux-x64, Node 22.23.5). Write and test the procedure on the real hardware: pin the Node version, verify the prebuilt loads (`node -e "new (require('better-sqlite3'))(':memory:')"`), have a fallback (build tools or a vendored binary), and make `deploy.sh` check this BEFORE `npm ci` empties `node_modules` (keep the old tree until the new one passes). Also test `serialport` (optional dependency, needed for `GW_TRANSPORT=rtu-serial`) on that target, plus serial-port permissions for the service user (`dialout` group, `SupplementaryGroups=` and `DeviceAllow` in the unit).
- **Forced password change on first login** (carried over from the Milestone 2 security items): the bootstrap `admin` password and any password an Admin sets for another user are marked `must_change`; the API refuses everything except change-password until it is changed; the bootstrap file `initial-admin-password` is deleted after the change. The bench admin still uses the bootstrap password.
- Hardware validation checklist (README, "Milestone 2") must be completed before `milestone-2-c1` is merged to `main`.
