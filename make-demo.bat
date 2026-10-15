@echo off
cd /d "%~dp0"
echo This replaces the DEMO weekend (your real weekends are not touched).
node tools\demo.js
echo.
echo Now run start-pitwall.bat, then start-simulator.bat
pause
