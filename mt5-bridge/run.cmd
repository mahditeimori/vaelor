@echo off
REM Vaelor MT5 bridge launcher (double-clickable).
REM Delegates to run.ps1 so dependency bootstrap lives in one place.
REM This window never closes by itself: it always pauses at the end so any
REM error message (missing Python, failed install, port already used, a
REM crashed server) stays on screen until you have read it.
setlocal
cd /d "%~dp0"
title Vaelor MT5 bridge
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run.ps1" %*
set "RC=%ERRORLEVEL%"
echo.
if "%RC%"=="0" (
  echo The bridge stopped. Double-click run.cmd to start it again.
) else (
  echo The bridge could not start or stopped unexpectedly ^(exit code %RC%^).
  echo Read the message above. Most common causes:
  echo   - Python 3.11 or newer is not installed ^(install from python.org,
  echo     tick "Add python.exe to PATH"^)
  echo   - the first-run dependency install failed ^(check your internet
  echo     connection, run run.cmd again^)
  echo   - port 8899 is already used - if the bridge is already running, just
  echo     pair the site with it; otherwise start on another port:
  echo     powershell -NoProfile -ExecutionPolicy Bypass -File run.ps1 -Port 8900
)
echo.
echo Press any key to close this window...
pause >nul
endlocal
