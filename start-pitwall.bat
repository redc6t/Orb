@echo off
title MME Pitwall Strategy Manager server
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js 18 or newer is required: https://nodejs.org & pause & exit /b 1)
echo Starting Pitwall Strategy Manager. Leave this window open during the event.
start "" http://localhost:8080
node server.js
pause
