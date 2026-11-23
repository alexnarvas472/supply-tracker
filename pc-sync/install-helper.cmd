@echo off
cd /d "%~dp0"
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
> "%STARTUP%\AppsScript sync helper.vbs" echo CreateObject("WScript.Shell").Run "pyw ""%~dp0pc_sync.py"" --watch", 0, False
wscript "%STARTUP%\AppsScript sync helper.vbs"
echo The sync helper is installed and running in the background.
echo It starts by itself whenever Windows starts, and checks for
echo "Back up to PC" requests from My App Register every minute.
echo.
echo To remove it, run uninstall-helper.cmd.
pause
