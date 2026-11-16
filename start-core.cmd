@echo off
rem Farm-Pilot CORE on Windows: run in the foreground. No administrator rights needed. Ctrl+C stops it cleanly (database is checkpointed and closed).
rem   start-core.cmd          console output only
rem   start-core.cmd log      also append to %FARMPILOT_CORE_HOME%\logs\core.log (use this form from Task Scheduler)
rem The program folder is wherever this file is (a USB stick is fine). Data, logs and core.env live on the local disk, default C:\FarmPilot-Core
rem (set FARMPILOT_CORE_HOME first to use another base folder). See deploy\windows\README.md.
setlocal
set "APP=%~dp0"
if not defined FARMPILOT_CORE_HOME set "FARMPILOT_CORE_HOME=C:\FarmPilot-Core"
set "NODE=%APP%node\node.exe"
if not exist "%NODE%" set "NODE=node.exe"
"%NODE%" --version >nul 2>&1 || ( echo Node.js 22 not found: expected %APP%node\node.exe or node.exe on PATH. & exit /b 1 )
if not exist "%FARMPILOT_CORE_HOME%\data" mkdir "%FARMPILOT_CORE_HOME%\data"
if not exist "%FARMPILOT_CORE_HOME%\logs" mkdir "%FARMPILOT_CORE_HOME%\logs"
cd /d "%APP%"
echo Farm-Pilot CORE starting. Data: %FARMPILOT_CORE_HOME%\data  Settings file (optional): %FARMPILOT_CORE_HOME%\core.env
if /i "%~1"=="log" (
  "%NODE%" --max-old-space-size=512 --env-file-if-exists="%FARMPILOT_CORE_HOME%\core.env" dist\index.js >> "%FARMPILOT_CORE_HOME%\logs\core.log" 2>&1
) else (
  "%NODE%" --max-old-space-size=512 --env-file-if-exists="%FARMPILOT_CORE_HOME%\core.env" dist\index.js
)
exit /b %ERRORLEVEL%
