# Live view with go2rtc — what changed

Copy these files over your project (same folder structure). Nothing else changes; recording,
schedules and playback logic are untouched.

## New files
| File | Purpose |
|------|---------|
| `go2rtc_client.py` | Registers/removes cameras in go2rtc, re-syncs every 30 s, fails quietly if go2rtc is not running |
| `go2rtc/go2rtc.yaml` | go2rtc configuration (ports, CORS for the app) |
| `go2rtc/README.md` | Install and security notes |
| `run_windows.bat` | Starts go2rtc (if `go2rtc\go2rtc.exe` exists) and `python app.py` |

## Modified files
| File | Change |
|------|--------|
| `app.py` | (1) `import go2rtc_client`; (2) `POST /api/sources` accepts optional `sub_url`, stores it and registers the camera with go2rtc; (3) `DELETE /api/sources` also removes it from go2rtc; (4) new `GET /api/live/config` and `POST /api/live/sync`; (5) `migrate_db()` adds the `sub_url` column to existing databases automatically; (6) starts the go2rtc sync thread in the `__main__` block |
| `init_db.py` | `sub_url` column for new databases |
| `static/js/home.js` | Snapshot image on each tile, click a tile to open the live pop-up (Low/Full switch), Esc to close |
| `static/js/sources.js` | Optional "Substream URL" field and display |
| `static/css/home.css` | Snapshot and live pop-up styles |
| `static/css/sources.css` | Add-source form now has three fields |
| `.gitignore`, `README.md` | go2rtc binary ignored; short live-view notes |

## Upgrade steps
1. Copy the files above into your project.
2. Download `go2rtc_win64.zip` from the go2rtc releases page and put `go2rtc.exe` into the `go2rtc` folder.
3. Run `run_windows.bat`. Existing cameras are registered automatically; your database is upgraded in place.
4. Allow go2rtc through the Windows firewall (private networks) when asked.
