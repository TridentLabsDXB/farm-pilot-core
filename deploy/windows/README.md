# Farm-Pilot CORE on Windows (phase W1: foreground run)

Windows 10/11 x64, Node 22. Linux stays the primary platform; everything here is gated on `win32` and changes nothing on Linux.

## Test bundle (manual test on a tablet or PC)

1. Unzip `FarmPilotCore-windows-*.zip`. Put the `FarmPilotCore` folder anywhere (Desktop, USB stick, or `C:\FarmPilot-Core\app`). Data never goes next to the program.
2. Double-click **`check.cmd`** first. It prints the Node version, loads `better-sqlite3` and `serialport`, lists the COM ports and proves the data folder is writable. Every line must say PASS.
3. Double-click **`start-core.cmd`**, then open http://127.0.0.1:4100 in a browser. The login password is in `C:\FarmPilot-Core\data\initial-admin-password`.
4. Windows Defender SmartScreen or a firewall prompt: allow `node.exe` on private networks only if you need other devices to reach CORE (default is this PC only).

## Folders

```
C:\FarmPilot-Core\app\      program (a portable copy can live anywhere, e.g. a USB stick)
C:\FarmPilot-Core\data\     core.db (+ -wal / -shm), initial-admin-password, backups   <- keep on the local disk, never on USB
C:\FarmPilot-Core\logs\     core.log (only when started with "log")
C:\FarmPilot-Core\core.env  optional settings, KEY=VALUE per line
```
Never `C:\FarmPilot` (that is the main Farm-Pilot app). Change the base with the `FARMPILOT_CORE_HOME` environment variable, or only the data with `DATA_DIR` / `DB_PATH` in `core.env`.

## Run (foreground, no admin rights)

Double-click or run `start-core.cmd` in the program folder. Ctrl+C stops it cleanly. Open http://127.0.0.1:4100. On the first start the admin password is written to
`C:\FarmPilot-Core\data\initial-admin-password`, readable by the current user only (set `CORE_ADMIN_PASSWORD` in `core.env` to choose it instead).
If Windows cannot restrict that file, nothing is written and the password is printed once in the console.

## Serial ports (RS-485)

Settings > RS-485 Ports: pick the COM port from the list (name plus driver description) or type it (`COM3`, `COM10`; `\\.\COM10` is accepted and stored as `COM10`).
The COM number of a USB adapter can change when it is plugged into another USB socket: check Device Manager > Ports (COM & LPT). Close any serial monitor first, only one program can open a COM port.

## Start at boot, stopgap until the service (W2)

Run in an administrator PowerShell, adjusting the path:

```powershell
$a = New-ScheduledTaskAction -Execute 'C:\FarmPilot-Core\app\start-core.cmd' -Argument 'log' -WorkingDirectory 'C:\FarmPilot-Core\app'
$t = New-ScheduledTaskTrigger -AtStartup
$s = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable
Register-ScheduledTask -TaskName 'FarmPilot-Core Start' -Action $a -Trigger $t -Settings $s -User 'SYSTEM' -RunLevel Highest
```
Restart on failure is at best once a minute. The task runs from the local copy: do not point it at a USB stick. Remove with `Unregister-ScheduledTask -TaskName 'FarmPilot-Core Start' -Confirm:$false`.

## Not in W1

Stable port identity across COM renumbering, the `FarmPilotCore` service (W2), installer, release zip.
