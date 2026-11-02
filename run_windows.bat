@echo off
rem Starts CamVault NVR. The app itself starts go2rtc and the test cameras (see tools\dev_stack.py).
cd /d "%~dp0"
python app.py
