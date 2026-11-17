# FARM-PILOT CORE release notes

Shown on the About page (RELEASE NOTES). Plain text, newest first. No network is needed to read it.

## 0.1.0 (in preparation)

### Added
- Sensors Gateway (Admin): READ GATEWAY T/H SECTION and READ GATEWAY SOIL SECTION (read-only) compare the slots in the gateway with CORE; IMPORT INTO CORE adds the sensors only the gateway holds. Audited as gateway.read_section. Soil import comes with Milestone 2b.
- About page for every role: product identity, version and build, licence summary with usage, and (Admin) details of this computer.
- Licensing: a built-in FREE licence (1 gateway, 10 sensors in total). A licence file bound to the box's Device ID lifts the limits. Limits only block ADDING sensors or gateways; monitoring, alarms and pump commands never stop because of a licence.
- Support tools for Admin: copy diagnostics and a support bundle.
- CONTROL page for pumps and other control devices.
- MONITORING (the old SCADA page) has a CARDS | CHARTS switch: one chart per zone with a line per sensor and the zone average, ranges 1H, 24H, 1W, 1M, and CSV export (temperature and humidity) for one zone or all zones. Charts and exports follow the licence: FREE reaches back 7 days (1M is locked), a licence lifts it.
- RS-485 Ports: Port 1 and Port 2 settings, device-to-port assignment, one request queue per port, TEST and KEEP/REVERT.
- Farm Profile, alarm history with acknowledgement, calibration, farm structure, backup and restore.
- Sidebar navigation (drawer on tablet, bottom navigation on phone) and a new login page.

- MQTT Payload page (Data sources): connect CORE to an external MQTT broker as a client, subscribe to topics, map JSON fields to measurements, review new devices and the last 20 messages. Admin edits, Operators can read it. Starts disabled. The payload format is a placeholder until the real one is decided.

### Fixed
- Sensors Gateway: the gateway's system registers (address, PID, version) are read one at a time (count 1); the real gateway answers one register per read, so the old 3-register read gave "short reply: got 7 of 11 bytes" and OFFLINE. The version is optional, the system registers only fill the GATEWAY card, and the gateway is ONLINE when the sensor poll works. A failed read names the request (function, address, count).

### Changed
- The database file now defaults to core.db inside the data folder (DATA_DIR); DB_PATH still overrides it. The server prints the database path it opened as the first log line.
- Main menu grouped (Admin): SETTINGS (Farm Profile, Farm Structure), DATA SOURCES (RS-485 Ports, Sensors Gateway, MQTT Payload, Sensors), SYSTEM (Users, Backup); ABOUT stays at the bottom. Operators see no groups. On the phone the fourth bottom-nav item is MORE for everyone and lists the same groups. Addresses of the pages do not change.
- Slots are numbered from 1. Serials are the plain decimal number printed on the sensor. Temperature and humidity intervals are in minutes (5 to 240).

### Known limits
- A licence is bound to one box. Cloning a virtual machine or disk image copies the Device ID; replacing the board changes it.
