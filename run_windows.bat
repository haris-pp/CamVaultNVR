@echo off
rem RecoraCam NVR - normal start (your real cameras).
rem go2rtc (live view) is started by the app itself when it is installed: python scripts\get_binaries.py
cd /d "%~dp0"
title RecoraCam NVR
if exist ".venv\Scripts\python.exe" (set "PY=.venv\Scripts\python.exe") else (set "PY=python")
"%PY%" app.py
echo.
echo RecoraCam has stopped.
pause
