@echo off
del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\AppsScript sync helper.vbs" 2>nul
for /f "tokens=5" %%p in ('netstat -ano ^| findstr "127.0.0.1:47613" ^| findstr LISTENING') do taskkill /PID %%p /F >nul 2>&1
echo The sync helper was stopped and won't start with Windows any more.
pause
