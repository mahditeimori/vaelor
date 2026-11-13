@echo off
REM Vaelor MT5 bridge launcher (double-clickable).
REM Delegates to run.ps1 so dependency bootstrap lives in one place.
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run.ps1" %*
if errorlevel 1 pause
endlocal
