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
  echo Finished. If the bridge is running, keep its window open while you trade.
  echo Your URL and token are saved in connect.txt next to run.cmd.
) else (
  echo The bridge could not start or stopped unexpectedly ^(exit code %RC%^).
  echo Read the message above. Most common causes:
  echo   - Python 3.11 or newer is not installed ^(install from python.org,
  echo     tick "Add python.exe to PATH"^)
  echo   - the first-run dependency install failed ^(check your internet
  echo     connection, run run.cmd again^)
  echo Port conflicts are handled automatically: if the bridge is already
  echo running you get its URL and token in connect.txt; if another program
  echo owns the port the bridge starts on the next free one.
)
echo.
echo Press any key to close this window...
pause >nul
endlocal
