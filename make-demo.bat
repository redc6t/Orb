@echo off
cd /d "%~dp0"
call stop-orb.bat nopause
echo.
echo This replaces the DEMO weekend (your real weekends are not touched).
node tools\demo.js
echo.
echo Now run start-orb.bat, then start-simulator.bat
pause
