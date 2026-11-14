# FARM-PILOT CORE

Single-customer, fully offline appliance edition of Farm-Pilot. One Node process: embedded MQTT broker (Aedes, loopback only), SQLite (WAL), REST + WebSocket API and the SCADA View SPA. No Docker, Node-RED, InfluxDB, MinIO or Postgres. **Control never depends on this PC: the PLC keeps its own logic.** This repo is Milestone 0 + 1 (test bench).

## Run
Bench (core.farm-pilot.com host, as root):
```bash
./deploy.sh            # git pull, npm ci, build, restart, health check
systemctl status farmpilot-core
journalctl -u farmpilot-core -f
```
Layout on the bench: code + `node/` (Node 22 tarball, SHA256-verified, gitignored) in `/opt/farmpilot-core`; data in `/var/lib/farmpilot-core/core.db`; settings in `/etc/farmpilot-core.env` (see `deploy/farmpilot-core.env.example`); unit `deploy/farmpilot-core.service` (User `fpcore`, `MemoryHigh=1500M`, `MemoryMax=2G`, `CPUQuota=200%`, `CPUWeight=20`, `IOWeight=20`). First boot creates user `admin`; the random password is in `/var/lib/farmpilot-core/initial-admin-password` (mode 600; or set `CORE_ADMIN_PASSWORD`). Delete the file after the first login.

Local dev: `npm i && npm --prefix web i && npm run build && HOST_BIND_IP=127.0.0.1 DB_PATH=./dev.db DATA_DIR=. npm start`.

Environment: `HOST_BIND_IP` (default 127.0.0.1), `PORT` (4100), `MQTT_PORT` (1884, loopback only), `DB_PATH`, `COOKIE_SECURE` (`auto` | `true` | `false`), `RETENTION_DAYS` (30), `COMMAND_TIMEOUT_SEC` (10, Admin can change), `COMMAND_DEDUPE_MS` (3000).
`COOKIE_SECURE=auto` marks the session cookie Secure only when the request came over HTTPS (X-Forwarded-Proto from NPM). On the real box the hotspot serves plain HTTP, so use `auto` or `false` there.

## Simulator (dev / bench only, never on the box image)
`deploy/install-sim.sh` installs `farmpilot-core-sim.service`; `deploy.sh` never does. It publishes Unified payloads every 5 s and echoes pump commands. `SIM_NO_ACK=1` makes it stay silent (tests the timeout state); it ignores commands older than 15 s.

## MQTT topics (farm slug `demo-farm`)
| Topic | Direction | Payload |
|---|---|---|
| `farmpilot/demo-farm/air` `/soil` `/water` | device -> runtime | Unified: `{"ts":iso,"sensors":[{"key":"AIR1","type":"temp_humidity","readings":{"temp":24.1,"humidity":55}}]}`; the pump status is sensor `WPump1`, reading `status` 1/0, in `water` |
| `farmpilot/demo-farm/cmd/pump1` | runtime -> device | `{"cmd_id","action":"on"\|"off","ts","by"}` QoS 1, **not retained** |
| `farmpilot/demo-farm/ack/pump1` | device -> runtime | `{"cmd_id","ok":true,"state":"on"}` |

Command states: `sent` -> `confirmed` (ack) or `timeout`. On start-up any `sent` command is closed as `timeout` and **never re-published**. A repeated same-pump same-action command within 3 s is ignored (double tap). The broker sits behind the `MqttBroker` interface (`src/broker.ts`); the runtime talks to it as a normal MQTT client, so Mosquitto can replace Aedes.

## Schema (SQLite, `auto_vacuum=INCREMENTAL`, WAL)
`series(id,topic,sensor_key,metric)` · `latest(series_id,value,ts)` · `history_raw(series_id,ts,value)` WITHOUT ROWID, 30 days · `rollup_hourly(series_id,hour_ts,avg,min,max,n)` kept · `users(role operator|admin)` · `sessions(token_hash,...)` · `settings` · `commands(id,pump,action,status,username,role,created_at,resolved_at,note)` · `audit_log(ts,username,role,action,detail)` append-only (triggers refuse UPDATE/DELETE).
Jobs: rollup every 10 min (idempotent); retention at start + every 6 h in 5000-row batches with WAL checkpoints and `incremental_vacuum`; command sweeper every 1 s.

## API
`POST /api/login|logout`, `GET /api/me|state|health`, `POST /api/commands`, Admin: `GET/POST /api/users`, `POST /api/users/:id`, `PUT /api/settings`. WebSocket `/ws` pushes `telemetry` and `command` events. Roles: Operator = view + commands; Admin = also Settings.

## Firewall (test bench)
No public port is opened. The runtime binds the private cluster address (`10.0.0.3:4100`) and the broker binds `127.0.0.1:1884` only. ufw's default INPUT policy is DROP.
Rule added 2026-11-15: `ufw allow from 172.16.0.0/12 to any port 4100 proto tcp comment 'NPM container -> farmpilot-core'`.
Reason: the shared Nginx Proxy Manager runs as a Docker container on this host and reaches the runtime from a Docker network (observed source `172.19.0.3`). Without the rule ufw dropped those packets (`[UFW BLOCK] ... DPT=4100`) and NPM answered 504. The existing rules already allow that range to ports 3000, 10000 and 8086 the same way. Access is restricted for users by the NPM Access List (VPN address range), not by this rule.

## Provenance
`web/src/cabinet/SOURCE.md` records the main-repo commit the Control Cabinet CSS was copied from.

## Measured on the bench (2 vCPU / 7.8 GB shared host, 2026-11-15)
Idle runtime: ~98 MB RSS, ~0.1 % CPU. History: 100 sensors x 2 readings x 1/min = 288 000 rows/day, ~42 bytes/row, **~11.6 MB/day -> ~350 MB per 30 days per 100 sensors**. Retention test: 35 days seeded, 30 kept, rollup rows kept.

## Out of scope
Modbus, Wi-Fi hotspot, licence flag, EDGE uplink, fleet menu, USB backups, Arabic UI.
