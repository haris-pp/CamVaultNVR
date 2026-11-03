@echo off
rem CamVault NVR - DEMO: simulated cameras and a separate database (nothing of your real setup is touched).
rem The first run downloads MediaMTX and go2rtc and makes four sample videos. Stop with Ctrl+C.
cd /d "%~dp0"
title CamVault NVR (demo)
if exist ".venv\Scripts\python.exe" (set "PY=.venv\Scripts\python.exe") else (set "PY=python")
"%PY%" dev\setup_demo.py
if errorlevel 1 (
  echo.
  echo Demo setup did not finish - see the messages above.
  pause
  exit /b 1
)
"%PY%" app.py --demo
echo.
echo The demo has stopped.
pause
