@echo off
rem Farm-Pilot CORE self-test: node version, better-sqlite3, serialport, COM ports. Run before the first start-core.cmd. Changes nothing.
setlocal
set "APP=%~dp0"
set "NODE=%APP%node\node.exe"
if not exist "%NODE%" set "NODE=node.exe"
cd /d "%APP%"
"%NODE%" "%APP%check.mjs"
set "RC=%ERRORLEVEL%"
echo %cmdcmdline% | find /i "%~nx0" >nul && pause
exit /b %RC%
