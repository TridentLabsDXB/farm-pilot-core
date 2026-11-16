@echo off
rem Farm-Pilot CORE upgrade / rollback. Run it from the program folder (C:\FarmPilot-Core\app).
rem   upgrade.cmd C:\path\farmpilot-core-lab-<version>-<build>-win-x64.zip     install a newer bundle (CORE must be stopped)
rem   upgrade.cmd /rollback                                                    go back to the previous program (and the database copy taken before the upgrade)
rem   upgrade.cmd /rollback /keep-data                                         go back to the previous program but keep the current database
rem The program folder is renamed during the upgrade, so this script first copies node.exe and upgrade.mjs to %TEMP%\fp-upgrade and runs from there.
setlocal
set "APP=%~dp0"
if "%APP:~-1%"=="\" set "APP=%APP:~0,-1%"
set "RUN=%TEMP%\fp-upgrade"
if not exist "%APP%\node\node.exe" ( echo node.exe not found next to this script: run upgrade.cmd from the program folder. & exit /b 1 )
rmdir /s /q "%RUN%" >nul 2>&1
mkdir "%RUN%" || exit /b 1
copy /y "%APP%\node\node.exe" "%RUN%\node.exe" >nul || exit /b 1
copy /y "%APP%\upgrade.mjs" "%RUN%\upgrade.mjs" >nul || exit /b 1
cd /d "%RUN%"
rem one line on purpose: cmd reads the whole line before it runs, so renaming the folder that holds this file cannot break the rest of the script
"%RUN%\node.exe" "%RUN%\upgrade.mjs" "%APP%" %* && exit /b 0 || exit /b 1
