# Live view with go2rtc

CamVault NVR uses [go2rtc](https://github.com/AlexxIT/go2rtc) to show cameras in the browser
(WebRTC for low delay, with automatic fallback). It is optional: without it, recording,
schedules and playback work as before and tiles simply show no live image.

## Windows
1. Download `go2rtc_win64.zip` from https://github.com/AlexxIT/go2rtc/releases/latest
2. Extract `go2rtc.exe` into **this folder** (next to `go2rtc.yaml`).
3. Make sure `ffmpeg` is on your PATH (already required by the app).
4. Start everything with `run_windows.bat` from the project folder
   (or run `go2rtc.exe` here in one window and `python app.py` in another).
5. The first time Windows asks, allow go2rtc through the firewall on *private networks*.

## Linux / macOS
Download the matching binary, `chmod +x go2rtc`, run it from this folder, then `python app.py`.

## How it works
- Add a camera on the **Cameras** page. Optionally enter a low-resolution *substream* URL
  (usually H.264) – tiles and the default live view use it, "Full" switches to the main stream.
- The app registers each camera with go2rtc automatically (and re-registers every 30 s if go2rtc was restarted).
- **Home**: tiles show a snapshot that refreshes every 10 s; click a tile for live video.
- Several people can watch the same camera: go2rtc connects to the camera once and shares it.

## Ports
| Port | Use |
|------|-----|
| 5000 | CamVault NVR web app |
| 1984 | go2rtc web API / player |
| 8555 | WebRTC media (TCP + UDP) |

## Security
Port 1984 exposes camera addresses (including passwords inside RTSP URLs) to anyone who can reach it.
Keep it on a trusted network, or enable `username` / `password` in `go2rtc.yaml`.
Before exposing anything to the internet, put the app and go2rtc behind a login and HTTPS (or use a VPN).

## Settings (environment variables, optional)
- `GO2RTC_API` – address the app uses to reach go2rtc (default `http://127.0.0.1:1984`)
- `GO2RTC_PUBLIC_PORT` – port the browser uses (default `1984`)
