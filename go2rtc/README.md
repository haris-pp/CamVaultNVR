# go2rtc - live view (optional)

CamVault uses [go2rtc](https://github.com/AlexxIT/go2rtc) to show cameras live in the browser
(WebRTC for the lowest delay, with automatic fallback). **Recording does not depend on it**: without go2rtc,
recording, schedules, playback and downloads work the same and the Home page simply shows no live picture.

| | |
|---|---|
| Install | `python scripts/get_binaries.py` (downloads `go2rtc` / `go2rtc.exe` into this folder) |
| Start | automatic - the app starts go2rtc when it starts and stops it when it exits |
| Switch off | set `CAMVAULT_GO2RTC=0` before starting the app, or delete the program from this folder |
| Settings | `go2rtc.yaml` in this folder |
| Log | `Logs/go2rtc.log` |

You never list cameras in `go2rtc.yaml`: the app registers every camera of the Cameras page by itself
(`cam_<id>` for the main stream, `cam_<id>_sub` for the optional lower-quality stream) and registers them again
every 30 seconds in case go2rtc was restarted.

## Ports

| Port | Use | Open it to |
|------|-----|------------|
| 5000 | CamVault web app | your network |
| 1984 | go2rtc web API and player | your network (the browser fetches live pictures from here) |
| 8555 | WebRTC media (TCP + UDP) | your network (allow it in the firewall for the lowest delay) |
| 8554 | go2rtc RTSP re-stream | this computer only |

## Security

Port 1984 can show the camera addresses, including the passwords inside RTSP URLs, to anyone who can reach it.
Keep it on a trusted network, or set `username` / `password` under `api:` in `go2rtc.yaml`.
Do not forward port 1984 or 5000 to the internet; use a VPN or a reverse proxy with a login and HTTPS.

## Settings (environment variables, optional)

| Variable | Default | Meaning |
|----------|---------|---------|
| `CAMVAULT_GO2RTC` | `1` | `0` = never start go2rtc |
| `GO2RTC_BIN` | - | full path of a go2rtc program installed elsewhere |
| `GO2RTC_API` | `http://127.0.0.1:1984` | where the app finds go2rtc. Point it at another computer to use a go2rtc running there (the app then starts nothing) |
| `GO2RTC_PUBLIC_PORT` | `1984` | the port browsers use to reach go2rtc |
