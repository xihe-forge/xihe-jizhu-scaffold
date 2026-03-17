@echo off
setlocal
cd /d "%~dp0"
call pnpm autopilot:stop
echo.
pause
