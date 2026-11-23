@echo off
title Download old versions of an Apps Script project
cd /d "%~dp0"
set "FOLDER=%~1"
if "%FOLDER%"=="" set /p "FOLDER=Drag a project folder into this window (or type its path) and press Enter: "
set FOLDER=%FOLDER:"=%
py pc_sync.py --versions "%FOLDER%"
echo.
pause
