FARM-PILOT CORE - WINDOWS LAB BUNDLE
====================================
Test bundle for the lab tablet (Windows 10 64-bit, Intel Atom x5-Z8350). Not a release: it is a non-release build
(the development licence key dev-1 is trusted). The version, build id and build date are on the ABOUT page and at the
end of this file.

ADDRESS: http://127.0.0.1:4100 on the tablet. From a phone on the tablet's hotspot: http://192.168.137.1:4100 (usually; see step 5 to find the real IP).

WHAT IS IN THE ZIP (unpack at C:\ so everything lands under C:\FarmPilot-Core)
    C:\FarmPilot-Core\README-LAB.txt       this file
    C:\FarmPilot-Core\core.env.example     optional settings; copy to core.env to use
    C:\FarmPilot-Core\app\                 the program
        node\node.exe                      Node.js 22 for Windows x64 (nothing else to install)
        dist\  web\dist\  node_modules\    server, web pages, libraries (Windows binaries for SQLite and serial ports)
        start-core.cmd   check.cmd   serial-probe.cmd   upgrade.cmd   upgrade.mjs   check.mjs   serial-probe.mjs   urls.mjs
Created later, never in the zip:
    C:\FarmPilot-Core\data\                core.db (+ -wal -shm), initial-admin-password, licence\, backups   (local disk only)
    C:\FarmPilot-Core\logs\core.log        only when started as: start-core.cmd log
    C:\FarmPilot-Core\core.env             your settings, optional
    C:\FarmPilot-Core\backups\             database copies made by upgrade.cmd

FIRST-RUN CHECKLIST (tick each one; write down what happened where it did not match)
 [ ] 1. Unblock and unzip. Right-click the zip > Properties > tick "Unblock" > OK (otherwise Windows asks about every file).
        Right-click > Extract All, folder C:\   (the folder FarmPilot-Core is inside the zip). Check that C:\FarmPilot-Core\app\start-core.cmd exists.
        Command line alternative:   tar -xf <zip> -C C:\
 [ ] 2. Windows power settings: Settings > System > Power & sleep: Sleep = Never (both "on battery" and "plugged in"), screen can turn off.
        Also: Control Panel > Power Options > the plan > "Turn off hard disk" = Never. A sleeping tablet stops the readings.
        Keep the tablet on its charger. Set date, time and time zone correctly (Settings > Time & language).
 [ ] 3. Double-click C:\FarmPilot-Core\app\check.cmd. Every line must say PASS and the last line must be "All checks passed."
        If "better-sqlite3" or "serialport" FAIL, copy the window text and send it (the Windows binaries need no extra runtime installed).
        If it FAILs for anything else: do not go on, copy the window text and send it.
 [ ] 4. Double-click start-core.cmd. A black window opens and stays open (that is the program). It prints the web addresses and the data folder.
        On the first start Windows Defender Firewall asks to allow node.exe: tick BOTH "Private networks" AND "Public networks", then click "Allow access".
        The tablet's own hotspot network is often classified as Public; if only Private is ticked, a phone on the hotspot cannot reach CORE.
        (If you clicked Cancel by mistake: Control Panel > Windows Defender Firewall > Allow an app > Change settings > node.exe > tick Private and Public.)
 [ ] 4a. Serial check without CORE (do this BEFORE blaming CORE): close every other program using the COM port (the vendor tool, a serial monitor, CORE itself), then in
        C:\FarmPilot-Core\app run   serial-probe.cmd COM11   (your COM number; optional: serial-probe.cmd COM11 7 9600 = port, gateway address, baud rate).
        It lists the COM ports, opens the port, sends the same read as the vendor tool and prints every byte sent (TX) and received (RX) in hex. The last line is either
        "PASS: gateway answered" or "FAIL: no answer after N tries, check wiring A/B". Copy the whole window and send it. It needs no database and does not change anything.
 [ ] 5. Web address: http://127.0.0.1:4100 on the tablet itself (port 4100), and http://<tablet IP>:4100 from a phone.
        To find the tablet's IP: open Command Prompt and type  ipconfig  . Look for "IPv4 Address" under the adapter the phone is connected through.
        With the Mobile Hotspot on, the tablet's own address on the hotspot is usually 192.168.137.1 (start-core.cmd prints all of them under "From a phone").
        Open http://127.0.0.1:4100 in the tablet's browser. For a phone: switch on the tablet's Mobile Hotspot (Settings > Network & Internet > Mobile hotspot),
        join the phone to it and open the "From a phone" address printed by start-core.cmd (normally http://192.168.137.1:4100).
 [ ] 6. First login: user admin, password in C:\FarmPilot-Core\data\initial-admin-password (open it with Notepad; only your Windows user can read it).
 [ ] 7. Settings > DATA POINTS > RS-485 PORTS. Plug the USB-RS485 adapter in first. Choose the COM port from the list (the list shows the driver name).
        Set baud, parity and the gateway address as on the bench, tick Enabled, APPLY.
 [ ] 8. Press TEST PORT with the real gateway connected. Expect OK and the gateway address. Press KEEP within 30 seconds (otherwise it reverts).
        Open SETTINGS > SENSORS GATEWAY and confirm the sensors read.
 [ ] 9. Replug test: unplug the USB adapter. The port must show NOT FOUND within about a minute and the CORE keeps running. Plug it back
        (same USB socket): the port must come back by itself; if Windows gave it another COM number, choose the new one on the RS-485 Ports page and APPLY.
 [ ] 10. COM10+ test: Device Manager > Ports (COM & LPT) > the adapter > Properties > Port Settings > Advanced > COM Port Number = COM10 or higher
        (a free number, for example COM12). Unplug and replug, pick COM12 on the RS-485 Ports page, TEST PORT again. It must work (the page stores bare "COM12").
 [ ] 11. Optional: restore a bench backup (Settings > BACKUP). Serial ports from the Linux bench (/dev/ttyUSB0 ...) come back DISABLED with a warning;
        nothing is mapped to a COM port for you. Choose the COM port, tick Enabled, TEST PORT.
 [ ] 12. Stop with Ctrl+C in the black window (if Windows asks "Terminate batch job (Y/N)?" answer Y). CORE writes its database and exits. Start it again and check nothing was lost.

STOP, DATA, LOGS
    Stop:    Ctrl+C in the start-core.cmd window. Closing the window also stops it (the database is closed cleanly).
    Data:    C:\FarmPilot-Core\data   (keep it on the tablet's internal disk, never on a USB stick or network drive; check.cmd refuses those)
    Logs:    start-core.cmd log   writes C:\FarmPilot-Core\logs\core.log ; normal start prints to the window only. The serial port lines (opening / opened / closing /
             ERROR could not open COM11: <Windows error>) are in the window and in core.log. For the hex request and answer bytes put  LOG_MODBUS=1  in core.env and restart.
    Backup:  Settings > BACKUP in the program, or copy C:\FarmPilot-Core\data while CORE is stopped.
    Sleep:   disable sleep in Windows power settings for the whole lab (step 2). If the tablet sleeps, readings and alarms stop until it wakes.
    Settings file (optional): C:\FarmPilot-Core\core.env  (see core.env.example). Restart CORE after changing it.

UPGRADE AND ROLLBACK
    Upgrade:   stop CORE, copy the new farmpilot-core-lab-...zip to the tablet, then in C:\FarmPilot-Core\app run
                   upgrade.cmd C:\path\to\the-new-zip.zip
               It unpacks the new program next to the old one, runs the new self-test, copies the database to C:\FarmPilot-Core\backups\pre-upgrade-<time>
               (checked), keeps the old program as C:\FarmPilot-Core\app.prev and puts the new one in place. Data, licence and core.env are not touched.
    Rollback:  stop CORE, then in C:\FarmPilot-Core\app run
                   upgrade.cmd /rollback
               Puts app.prev back and restores the database copy taken before the upgrade. Whatever was entered after the upgrade is NOT in that copy; it is
               first saved as C:\FarmPilot-Core\backups\before-rollback-<time>\core.db. To keep the current database instead (only if the older program starts with it):
                   upgrade.cmd /rollback /keep-data
    If an upgrade stops with a message, nothing was changed.

WHAT TO SEND BACK
    The text of check.cmd; screenshots of the RS-485 Ports page after TEST PORT; for any problem the file C:\FarmPilot-Core\logs\core.log (start with: start-core.cmd log)
    and what you did. Never send initial-admin-password.
