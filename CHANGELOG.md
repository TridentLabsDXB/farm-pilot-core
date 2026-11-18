# FARM-PILOT CORE release notes

Shown on the About page (RELEASE NOTES). Plain text, newest first. No network is needed to read it.

## 0.1.0 (in preparation)

### Added
- Server Connection (SYSTEM, Admin, all builds, every licence incl. FREE): the box can report a small status message (Device ID, version, licence state, usage counts, uptime, time of last data, number of open alarms; never readings, users, contacts or the logo) over HTTPS to the main CORE server. Off until enabled and enrolled; outbound only; retries 1, 2, 5, then every 15 minutes; a server problem never affects monitoring, alarms or control. About shows a MAIN CORE SERVER card for Admins.
- Connected Boxes (Online build, SYSTEM, Admin): the boxes that report to this server, with status, licence, usage, 30-day availability history, enrolment codes, approval, revoke and CSV export.
- Sensors Gateway (Admin): READ GATEWAY T/H SECTION and READ GATEWAY SOIL SECTION (read-only) compare the slots in the gateway with CORE; IMPORT INTO CORE adds the sensors only the gateway holds. Audited as gateway.read_section. Soil import comes with Milestone 2b.
- Lab bundle: serial-probe.cmd COM11 [address] [baud], a standalone COM port and gateway check that needs no database (README-LAB step 4a).
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
- RS-485 serial reader: a reply is read until its full length is known (a 120-register read is 245 bytes), never ended by a pause between bytes, so a USB-RS485 adapter that delivers it in 8 bursts works. Stray bytes are skipped, a frame with a bad CRC is never accepted and is retried at once, and the reason is shown ("bad CRC", "timeout: no reply", "short reply: got N of M bytes"). The gateway goes OFFLINE only after 3 failed poll cycles in a row. The default response timeout is 1500 ms. LOG_MODBUS=1 also logs the decision for every frame.
- Sensors Gateway: the GATEWAY card shows the configured Modbus address instead of "--" while the gateway has not answered yet.
- upgrade.cmd: the database copy is made by a separate process (a loaded native module kept the program folder locked on Windows), a folder that cannot be renamed gives a plain explanation, and a zip path starting with / is no longer mistaken for an option.
- RS-485 Ports on Windows: a serial port shows OPEN only while Windows really holds the handle (it is opened when the port is saved or CORE starts, not on the first request). A failed open shows ACCESS DENIED, NOT FOUND or ERROR with the Windows error text and is logged. An open port with a device assigned but no request for 60 s shows OPEN, NOT POLLED.
- A fresh database no longer starts with the gateway device switched off while its port is on (the cause of "(switched off)", NO GATEWAY and counters 0 / 0). The Devices table has an Enabled switch, the Gateway page says which of the two is off, and databases made by the earlier build are repaired once.
- TEST PORT tests the settings in the form even when they are not saved, and always answers: OK with the response time, NO ANSWER, CRC ERROR, CANNOT OPEN with the Windows error, SWITCHED OFF, or why the settings are invalid. SAVE no longer claims "reopened and tested" unless the test passed.
- Serial logging (open, close, errors) on the console and in core.log; LOG_MODBUS=1 adds hex request and answer frames.

### Changed
- The database file now defaults to core.db inside the data folder (DATA_DIR); DB_PATH still overrides it. The server prints the database path it opened as the first log line.
- Main menu grouped (Admin): SETTINGS (Farm Profile, Farm Structure), DATA SOURCES (RS-485 Ports, Sensors Gateway, MQTT Payload, Sensors), SYSTEM (Users, Backup); ABOUT stays at the bottom. Operators see no groups. On the phone the fourth bottom-nav item is MORE for everyone and lists the same groups. Addresses of the pages do not change.
- Slots are numbered from 1. Serials are the plain decimal number printed on the sensor. Temperature and humidity intervals are in minutes (5 to 240).

### Known limits
- A licence is bound to one box. Cloning a virtual machine or disk image copies the Device ID; replacing the board changes it.
