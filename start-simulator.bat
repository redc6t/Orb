@echo off
title MME Pit Wall - PLTD + BTTM simulator
cd /d "%~dp0"
node tools\simulate.js %*
pause
