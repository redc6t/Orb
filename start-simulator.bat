@echo off
title MME Pit Wall - Agile + Sentinel simulator
cd /d "%~dp0"
node tools\simulate.js %*
pause
