@echo off
setlocal
cd /d "%~dp0"
echo.
echo ==========================================
echo   Robust AI Scaffold - Autopilot
echo ==========================================
echo.
call pnpm install
if errorlevel 1 goto :fail
call pnpm work
if errorlevel 1 goto :fail
goto :end

:fail
echo.
echo Autopilot did not start successfully.

:end
echo.
pause
