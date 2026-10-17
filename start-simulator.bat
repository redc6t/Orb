@echo off
title Orb - Agile + Sentinel simulator
cd /d "%~dp0"
node tools\simulate.js %*
pause
