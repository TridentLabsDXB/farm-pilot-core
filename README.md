# FARM-PILOT CORE

Single-customer, fully offline appliance edition of Farm-Pilot. One Node process: embedded MQTT broker (Aedes, loopback only), SQLite (WAL), REST + WebSocket API and the SCADA View SPA. No Docker, Node-RED, InfluxDB, MinIO or Postgres. **Control never depends on this PC: the PLC keeps its own logic.** This repo is Milestone 0 + 1 + 2 (test bench; Milestone 2 = C1 LoRa gateway over Modbus, T/H sensors).

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

## Milestone 2: C1 gateway (ThingSend XZ-DS-MUS2, Modbus RTU, T/H sensors)
Source of truth: manual "XZ-DS-MUS2 manual V20". Everything the manual does not say is marked `ASSUMED` in `config/gateway-thingsend.yaml` and must be verified on real hardware.

**Enable polling** (off by default; without `GW_TRANSPORT` the runtime behaves as in Milestone 1) in `/etc/farmpilot-core.env`:
`GW_TRANSPORT=tcp|rtu-tcp|rtu-serial`, `GW_HOST`/`GW_PORT` (tcp, rtu-tcp), `GW_SERIAL_PATH` (default `/dev/ttyUSB0`), `GW_BAUD` (9600), `GW_PARITY` (none), `GW_ADDRESS` (0 = map default), `GW_TIMEOUT_MS` (1500), `GW_RETRIES` (2), `GW_REGMAP` (`config/gateway-thingsend.yaml`). On the real box use `rtu-serial` (RS485 / USB-RS485, 9600 8N1); `serialport` is an optional dependency loaded only then. If the register map is invalid the gateway part is disabled with a clear log line; the rest of the runtime keeps running.

**Code map:** `src/drivers/modbus/` (frames, transports, priority-queue master, register-map loader, driver) · `src/gateway/` (logic = planner, calibration, staleness, health; registry; service = poll loop + Send to Gateway; routes; health view) · `src/tools/gateway-sim/` (simulator; dev only) · `config/gateway-thingsend.yaml` (register map, types as config blocks; gas, light, door_smoke, soil are disabled placeholders for Milestone 2b).

**Gateway simulator** (`farmpilot-gateway-sim.service`, bench only, installed by `deploy/install-gateway-sim.sh`): Modbus TCP on 127.0.0.1:5020, RTU-over-TCP on 5021, control HTTP on 127.0.0.1:5030. Eight physical T/H sensors (serials `4A01B3F2`..`4A01B3F9`) only transmit once a group with their serial is configured. Control: `POST /freeze?serial=`, `/unfreeze`, `/zero?serial=` (registers read zeros), `/voltage?serial=&v=3.0`, `/stop` and `/start` (gateway stops answering), `/reject?on=1[&serial=]` (writes rejected), `/preconfig?type=th&slot=1&serial=&interval=` (a group configured "with the maker's tool"; slots are 1-based like everywhere else), `/replay` (POST JSON `{"loop":false,"frames":[{"t":0,"type":"th","slot":1,"regs":[235,580,360,65456]}]}`), `GET /state`. Optional virtual serial pair with `socat` is described at the top of `src/tools/gateway-sim/main.ts`.

**Behaviour decisions**
- **Slots are numbered 1..N** (T/H 1..30) in the database, the API, the UI, the simulator and the backup file (format version 2; version 1 files, which counted from 0, are converted on import). Only the Modbus address calculation subtracts one: register = `config.base + (slot - 1) * regs_per_group`. A one-time migration (`settings.slots_1based`) converted databases written by the first Milestone 2 build. Old `audit_log` rows from before 2026-11-16 still show the 0-based number in their detail text (the log is append-only).
- The gateway is the truth for "sent": `sent_slot`/`sent_interval` mirror the last config read-back (FC04). IN GATEWAY / CHANGED / NOT SENT derive from them.
- Send to Gateway (per type): pause polling, read back groups, plan (changed groups only, zeros for removed), ask for confirmation if anything is removed, moved or replaced, write with FC16, read back and verify every group, retry once, resume polling in `finally`. Groups in the gateway that CORE does not know are never touched and never auto-added: they show as NEW SENSOR FOUND (ADD / IGNORE) and their slots are reserved.
- A sensor deleted in CORE (or replaced) is cleared in the gateway only by the next confirmed Send; its slot is not reused before that.
- History: topic `gateway/<type>`, key = serial, metrics `temperature`/`humidity` (calibrated) and `temperature_raw`/`humidity_raw`, `voltage`, `rssi`; written only when the channel frame changed. Rollups, alarms and the SCADA View use the calibrated series.
- Staleness: fingerprint of the whole channel frame; identical for 3 intervals of that sensor = NO UPDATE (all zeros = NO DATA). Heuristic until validated on hardware.
- Poll period: the configured default (30 s) but never longer than half the shortest sensor interval in use, floor 10 s; backoff while failing; gateway OFFLINE after 3 failed cycles (a Modbus exception reply does not count: the gateway answered).
- `serialport` and `yaml` were added as dependencies. The UI follows `core-ui-spec-direction-a.md` (light default, dark toggle, `web/src/tokens.css`); the old demo AIR/SOIL/WATER MQTT cards were replaced by structure-built zone cards, the pump card is unchanged in behaviour.

**ASSUMED (verify on hardware, then edit the YAML):** default gateway address 1; group register order `[serial_hi, serial_lo, interval, control]`; serial as 8 hex digits, high word first; interval unit seconds, range 10..86400 (soil 60..86400); control value 0 on add; version register value; low-voltage 3.20 V; battery icon bounds (empty = low-voltage threshold minus 0.4 V, full = 3.60 V; the icon is only a hint, the voltage is always printed, and both bounds depend on the battery type, which is not confirmed); RSSI good above -90 / poor below -105; FC03 for data and FC04 for config (the simulator is strict about this split; set `lenientFc` in `sim.ts` to see the other behaviour).
**How to swap in real values:** edit `config/gateway-thingsend.yaml` (bump `map_version`) and restart `farmpilot-core`; no code change. A new sensor type = a config block with `enabled: true`.

**Hardware validation checklist (industrial PC, real gateway over RS485):** address / group address / version registers; FC03 vs FC04 behaviour; group register order and serial word order (compare with the printed label); interval unit and range, and whether the gateway pushes it to the sensor; control register meaning; registers of a never-received and of a silent sensor (switch a sensor off and record whether they freeze, zero or change; adjust the detector and the simulator's freeze mode to match); RSSI/voltage behaviour of a healthy sensor; group persistence after a gateway power cycle; polling time at 9600 baud; soil data start (0x4001 vs 0x5001) before Milestone 2b; **battery:** confirm the battery type, record voltage against remaining life (fresh, mid-life, at the point the sensor stops reporting) and settle the low-voltage warning threshold plus the icon's empty and full points (`web/src/ui.tsx`, `Battery`; today empty = threshold - 0.4 V, full = 3.60 V).

**Slot mapping:** slots are 1..N; `test/slot-address.test.ts` proves slot 1 = first group (T/H config 0x0100, data 0x0001), slot 30 = config 0x0174 / data 0x0075, every type's last slot, the bytes on the wire, and that slot 0 / 31 are refused before any request is sent.

**Tests:** `npm test` (unit: register map, decoding, planner, calibration, staleness, rate limit; integration against the simulator over TCP and RTU framing). `scripts/acceptance.mjs` runs the bench acceptance against a running core + simulator.

## Out of scope
Wi-Fi hotspot, licence flag, EDGE uplink, fleet menu, USB backups, Arabic UI; soil, light, gas/CO2, door/smoke types (Milestone 2b), LoRa actuator control, rules engine.
