# Backlog

## Milestone 2 (security hardening, raised 2026-11-15)
- **Login rate limiting, persistent and per account/IP.** Today: in-memory only, 5 failures per username+IP lock that pair for 5 minutes, and the counters reset on restart. Add a DB-backed counter, a global per-IP limit, and an audit row on lockout.
- **Forced password change on first login.** The bootstrap `admin` password (file `initial-admin-password`, or `CORE_ADMIN_PASSWORD`) and any password an Admin sets for another user must be marked `must_change`; the API refuses everything except change-password until it is changed, and the bootstrap file is deleted after the change.
- Admin UI action to delete a user (today only disable; test users had to be removed by hand in SQLite).
- Optional: password minimum/complexity rule beyond 8 characters, session list and revoke.
