# 🚀 Smart Waste Dumping Detection — Quick Start Guide

Full system = **3 services** (all run on the PC). Phones just open the tunnel URL in Chrome.

```
┌────────────────┐   frames    ┌──────────────────┐  /detect  ┌─────────────────┐
│  Phone A/B     │ ──────────▶ │  Node backend    │ ────────▶ │ Python detector │
│  (Monitor page)|   HTTPS     │  :5000  (PC)     │           │  YOLO-World     │
└────────────────┘  tunnel     └────────┬─────────┘           │  :8001          │
                                        │                     └────────┬────────┘
                                        ▼                            │
                              ┌─────────────────┐   classification   │
                              │  PC Live View   │◀───────────────────┘
                              │  /live grid     │
                              └─────────────────┘
```

---

## ⚡ ONE-CLICK START (recommended)

Double-click **`start_all.ps1`** in the project root, or run:

```powershell
cd C:\Users\ASUS\OneDrive\Desktop\ibm
powershell -ExecutionPolicy Bypass -File start_all.ps1
```

It starts all 3 services, waits for health checks, then prints the **tunnel URL** for your phones. Done.

> If OneDrive has synced weird paths, use the manual steps below instead.

---

## ⚙️ MANUAL START (3 PowerShell windows)

### Prerequisites — first time only

```powershell
# Frontend
cd C:\Users\ASUS\OneDrive\Desktop\ibm\frontend
npm install
npm run build          # creates frontend/dist

# Backend
cd C:\Users\ASUS\OneDrive\Desktop\ibm\backend
npm install
```

### Step 1 — Python detector (YOLO-World AI, port 8001)

```powershell
cd C:\Users\ASUS\OneDrive\Desktop\ibm\backend\python_detector
python detector.py
```

Wait until you see:
```
Waste Detector service -> http://127.0.0.1:8001 (DETECTOR_BACKEND=yolov8)
```

Verify: `Invoke-RestMethod http://127.0.0.1:8001/health`
→ `{"ok":true,"service":"waste-detector","backend":"yolov8","temporal_engine":"active"}`

### Step 2 — Node backend (server + React app, port 5000)

```powershell
cd C:\Users\ASUS\OneDrive\Desktop\ibm\backend
node server.js
```

Verify: `Invoke-RestMethod http://localhost:5000/api/health`
→ `{"ok":true,"ts":"..."}`

> Detection mode in startup log must say `python` — not `mock`.

### Step 3 — Cloudflare tunnel

```powershell
cloudflared tunnel --url http://localhost:5000
```

Copy the printed `https://xxxxxxxx.trycloudflare.com` URL.

---

## 📱 PHONE SETUP (2 phones at 2 locations)

1. Open the **tunnel URL** in **Chrome** on each phone
2. **Phone A** → select zone **Main Gate Dustbin** → tap **Start Monitoring** → Allow camera & location
3. **Phone B** → select zone **Park Side Dustbin** → tap **Start Monitoring** → Allow camera & location
4. ⚠️ Keep the tab **open & unlocked** — wake-lock auto-keeps screen on while monitoring
5. On phone, the navbar shows **Monitor** and **Register** only — Live View / Dashboard / Zone Config are hidden and `/live` auto-redirects to Monitor

---

## 🖥️ PC — LIVE VIEW

```
http://localhost:5000/live
```

- Both cameras appear as cards with **LIVE** badge, AI bounding boxes, GPS map link, classification label
- Cards show **STANDBY** ~60s after the phone stops sending frames
- Click **▶ Start camera** button to remotely wake an idle phone (~3s, one-shot signal)

---

## 🧪 Health Checklist

| Check | URL | Expected |
|---|---|---|
| Python AI | `http://127.0.0.1:8001/health` | `{"ok":true}` |
| Backend | `http://localhost:5000/api/health` | `{"ok":true}` |
| Live page | `http://localhost:5000/live` | React app, not blank |
| Live feeds | `http://localhost:5000/api/live` | both zones listed |
| Frontend build | `frontend/dist` folder exists | yes |
| Detection mode | server startup log | `python` (not mock) |

---

## 🐛 BLANK LIVE PAGE — Troubleshooting

**Cause:** Backend or Python detector crashed / was never started. The React HTML shell loads but every API call fails → empty grid.

**Fix:**
1. Check if processes are running: `Get-Process python,node,cloudflared`
2. If missing, run `start_all.ps1` or start services manually
3. **Hard-refresh** the browser: `Ctrl+F5` on `http://localhost:5000/live`
4. Open browser console (`F12` → Console): `net::ERR_CONNECTION_REFUSED 5000` = backend down

**If you changed frontend code:**
```powershell
cd C:\Users\ASUS\OneDrive\Desktop\ibm\frontend
npm run build    # then Ctrl+F5 in browser — no server restart needed
```

---

## 📋 Key Notes

| Topic | Detail |
|---|---|
| **Frontend rebuild** | Only needed after changing `frontend/src/**`. No server restart — Express serves `dist` from disk. Just `Ctrl+F5`. |
| **Tunnel URL** | Changes every time cloudflared restarts. Share the new URL with phones. |
| **Phone cameras** | Must keep Monitor tab open. Screen lock stops frames after ~30s → card goes STANDBY. |
| **Detection** | YOLO-World model runs on CPU — first frame takes ~8-15s (model warmup). Subsequent frames are faster. |
| **Anti-spam** | Same classification type same zone: 30-minute cooldown between alerts. |
| **Zones** | Zone 3 = Main Gate Dustbin (`cam-main-gate`), Zone 4 = Park Side Dustbin (`cam-park-side`) |
| **Email alerts** | SMTP from `210824205003@kingsedu.ac.in` → registered residents + admin. Cooldown: 30 min per zone. |

---

## 🔄 Normal Daily Routine

```powershell
# Start everything:
cd C:\Users\ASUS\OneDrive\Desktop\ibm
powershell -ExecutionPolicy Bypass -File start_all.ps1

# Then share the printed tunnel URL with phone users.
# PC: open http://localhost:5000/live
```
