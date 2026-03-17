@echo off
setlocal
cd /d "%~dp0"
echo.
echo ==========================================
echo   Robust AI Scaffold - Start Here
echo ==========================================
echo.
call pnpm install
if errorlevel 1 goto :fail
call pnpm start-here
if errorlevel 1 goto :fail
goto :end

:fail
echo.
echo Setup did not finish successfully.

:end
echo.
pause
