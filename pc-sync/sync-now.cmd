@echo off
title Apps Script sync
cd /d "%~dp0"
echo Syncing every Apps Script project to C:\Users\alexn\AppsScript ...
echo.
py pc_sync.py
echo.
echo Full report: %~dp0sync-report.txt
pause
