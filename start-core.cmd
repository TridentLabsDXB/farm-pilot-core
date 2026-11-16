@echo off
rem Farm-Pilot CORE on Windows: run in the foreground. No administrator rights needed. Ctrl+C stops it cleanly (database is checkpointed and closed).
rem   start-core.cmd          console output only
rem   start-core.cmd log      also append to %FARMPILOT_CORE_HOME%\logs\core.log (use this form from Task Scheduler)
rem The program folder is wherever this file is (normally C:\FarmPilot-Core\app). Data, logs and core.env live next to it on the local disk (C:\FarmPilot-Core)
rem (set FARMPILOT_CORE_HOME first to use another base folder).
rem Lab behaviour: listens on ALL network interfaces (HOST_BIND_IP=0.0.0.0) so a phone on the tablet's hotspot can open it, unless core.env sets HOST_BIND_IP itself.
rem First start: the program creates the admin user and writes data\initial-admin-password readable by the current Windows user only (icacls); see README-LAB.txt.
setlocal
set "APP=%~dp0"
if not defined FARMPILOT_CORE_HOME set "FARMPILOT_CORE_HOME=C:\FarmPilot-Core"
set "NODE=%APP%node\node.exe"
if not exist "%NODE%" set "NODE=node.exe"
"%NODE%" --version >nul 2>&1 || ( echo Node.js 22 not found: expected %APP%node\node.exe or node.exe on PATH. & exit /b 1 )
if not exist "%FARMPILOT_CORE_HOME%\data" mkdir "%FARMPILOT_CORE_HOME%\data"
if not exist "%FARMPILOT_CORE_HOME%\logs" mkdir "%FARMPILOT_CORE_HOME%\logs"
if not defined HOST_BIND_IP ( findstr /b /i /c:"HOST_BIND_IP" "%FARMPILOT_CORE_HOME%\core.env" >nul 2>&1 || set "HOST_BIND_IP=0.0.0.0" )
cd /d "%APP%"
"%NODE%" "%APP%urls.mjs"
echo Data: %FARMPILOT_CORE_HOME%\data   Logs: %FARMPILOT_CORE_HOME%\logs   Settings file (optional): %FARMPILOT_CORE_HOME%\core.env
if /i "%~1"=="log" (
  "%NODE%" --max-old-space-size=512 --env-file-if-exists="%FARMPILOT_CORE_HOME%\core.env" dist\index.js >> "%FARMPILOT_CORE_HOME%\logs\core.log" 2>&1
) else (
  "%NODE%" --max-old-space-size=512 --env-file-if-exists="%FARMPILOT_CORE_HOME%\core.env" dist\index.js
)
exit /b %ERRORLEVEL%
