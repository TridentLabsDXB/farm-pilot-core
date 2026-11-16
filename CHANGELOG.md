# FARM-PILOT CORE release notes

Shown on the About page (RELEASE NOTES). Plain text, newest first. No network is needed to read it.

## 0.1.0 (in preparation)

### Added
- About page for every role: product identity, version and build, licence summary with usage, and (Admin) details of this computer.
- Licensing: a built-in FREE licence (1 gateway, 10 sensors in total). A licence file bound to the box's Device ID lifts the limits. Limits only block ADDING sensors or gateways; monitoring, alarms and pump commands never stop because of a licence.
- Support tools for Admin: copy diagnostics and a support bundle.
- CONTROL page for pumps and other control devices.
- RS-485 Ports: Port 1 and Port 2 settings, device-to-port assignment, one request queue per port, TEST and KEEP/REVERT.
- Farm Profile, alarm history with acknowledgement, calibration, farm structure, backup and restore.
- Sidebar navigation (drawer on tablet, bottom navigation on phone) and a new login page.

### Changed
- Slots are numbered from 1. Serials are the plain decimal number printed on the sensor. Temperature and humidity intervals are in minutes (5 to 240).

### Known limits
- A licence is bound to one box. Cloning a virtual machine or disk image copies the Device ID; replacing the board changes it.
