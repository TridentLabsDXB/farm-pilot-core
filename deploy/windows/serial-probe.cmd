@echo off
rem Farm-Pilot CORE serial probe: standalone check of a COM port and the gateway behind it. Needs no CORE, no database. Changes nothing.
rem   serial-probe.cmd COM11 [address=7] [baud=9600]
rem Close every other program that uses the COM port first (the vendor tool, a serial monitor, CORE itself).
setlocal
set "APP=%~dp0"
set "NODE=%APP%node\node.exe"
if not exist "%NODE%" set "NODE=node.exe"
cd /d "%APP%"
"%NODE%" "%APP%serial-probe.mjs" %*
set "RC=%ERRORLEVEL%"
echo %cmdcmdline% | find /i "%~nx0" >nul && pause
exit /b %RC%
