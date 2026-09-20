# Smart Waste Dumping Detection & Alert System

A prototype that watches a dustbin through a camera, uses AI **object detection**
(Roboflow) to find waste wherever it is, and then applies **custom geometry** to
decide whether the disposal was *correct*, the bin is *full*, or someone is
*illegally dumping* — alerting residents and the corporation via **email and SMS**.

```
browser camera (simulated CCTV)     Roboflow hosted inference        custom zone-check geometry
┌───────────────────────────┐       ┌────────────────────────┐      ┌─────────────────────────────┐
│ Monitor page (mobile)     │ 0..1  │ detects waste + coords │      │ dustbin zone box (0..1)     │
│ 720p frame every 1-2s     │──────▶│ normalized 0..1        │─────▶│ inside/outside/near tests   │
│ + GPS + camera/session id │       └────────────────────────┘      │ illegal · full · correct    │
└───────────────────────────┘                                       └──────────────┬──────────────┘
       Express + SQLite (events, snapshots, residents, zones) ◀──────────────────────┘
                    │
                    ▼
        Nodemailer email + SMS (Fast2SMS stub / DLT note)   ->  residents + admin alerts
```

## What ships in this prototype

- **React + Vite frontend (mobile-friendly)** served by Express in one running server
  - **Monitor page** — asks for camera + GPS, samples frames at your chosen cadence,
    draws the dustbin zone and live AI boxes (green inside / amber near / red outside),
    streams the "last 40 frames" classification + notification feed, holds a
    **screen wake-lock** while streaming, and auto-starts on a PC remote-start signal
  - **Admin dashboard** — global stats, filterable event table with thumbnails,
    GPS→Google Maps, per-event notification status
  - **Zone config** — upload a snapshot, drag a box around the dustbin (normalized
    0..1 → resolution-independent), create/edit/delete zones + admin contact
  - **Register page** — residents sign up with their mobile to get alerts
  - **Live View page** — watch the phone camera as a CCTV-style grid on any
    screen: LIVE badge, 📍 GPS, AI overlay (zone + detection boxes), classification
    label; fed by the rolling backend frame cache; includes a **▶ Start camera**
    button that remotely wakes an idle phone into streaming (~3s, one-shot signal)
- **Express + SQLite backend**
  - `POST /api/frames` ingestion pipeline: snapshot → Roboflow → **custom
    classification** → event row (only when waste found) → alert dispatch with a
    per-classification **30-minute cooldown**
  - Zones, residents, admins, events, stats REST endpoints; seeds 2 zones,
    6 residents, 3 admin contacts
  - **Mock detector** (`MOCK_DETECTION=1`) — full demo with **zero API keys**;
    `MOCK_SCENARIO=random|correct|full|illegal|near|none` forces outcomes
  - **Roboflow integration**: serverless endpoint (Bearer + multipart) with
    automatic fallback to the legacy `detect.roboflow.com` model URL
  - **Notifications**: console email/SMS out of the box; SMTP + Fast2SMS ready
  - **Live feed bridge**: `POST /api/frames` caches every frame (waste or not) →
    `uploads/live/<cameraId>-latest.jpg`; `GET /api/live` + `GET /api/live/:cameraId.jpg`
    serve the current feeds to the Live View page (60s TTL)
- **Unit-tested classification core** — `npm test` in `backend/`

## Classification rules (the core custom logic)

Every coordinate is **normalized 0..1** relative to the camera frame, so one zone
box works for a phone, an HD camera, or a 4K RTSP feed without code changes.

1. Any waste object whose center is **outside** the zone (+ no near band) → **`illegal`** → alert residents + admin
2. A **near** drop (inside the 12% padded band around the bin) **and** the bin looks full
   (`fillEstimate ≥ 50%` **or** `≥ 2 objects` already inside) → **`full`** → alert admin only
3. Zone coverage ≥ 85% (overflowing) → **`full`** → alert admin only
4. Objects only **inside** the zone → **`correct`** → logged, no alert
5. Only **near** objects, bin not full → **`near`** → logged, no alert
6. No detections → **`no_waste`** → not persisted

Fill estimate = clipped area of in-zone detection boxes / zone area (double-counting
is deliberate and fail-safe).

## Repository layout

```
backend/
  server.js            Express app; serves /api + built frontend/dist
  .env.example         copy to .env
  db/                  schema.sql, database.js (open + seed)
  routes/              frames, zones, residents, admins, events, stats, live
  services/
    roboflow.js        serverless + legacy API, normalize 0..1, MOCK detector
    classification.js  CORE custom zone-check logic (unit-tested)
    notifications.js   Nodemailer email + SMS dispatch
    liveFeed.js        rolling live-frame cache (uploads/live, 60s TTL)
  tests/classification.test.js   npm test
  uploads/             saved snapshots + zone reference images + live/
frontend/
  vite.config.js       proxies /api -> :5000 (dev)
  src/                 React app (Monitor, Live View, Dashboard, Zone Config, Register)
  dist/                production build (served by the backend)
```
## Quick start

Requires **Node 18+** (backend uses built-in `fetch`). On Windows, install with the
**x64 toolchain** for `better-sqlite3` (Visual Studio Build Tools) if needed.

```bash
# 1) Backend
cd backend
copy .env.example .env      # Windows; on Linux/macOS: cp .env.example .env
npm install
npm test                    # classification logic tests (illegal/full/correct/near/no_waste)

# 2) Frontend (build once; the backend then serves it)
cd ../frontend
npm install
npm run build

# 3) Run the whole system from ONE server
cd ../backend
npm start                   # http://localhost:5000  (backend + frontend + API)
```

For frontend hot-reload during development instead of rebuilding each time:

```bash
cd frontend
npm run dev                 # http://localhost:5173 (proxies /api -> :5000)
```

Reset the demo database (fresh zones/residents/admins, no events) any time with:

```bash
cd backend
npm run seed
```

## Demo flow (no keys needed)

1. `npm start` in `backend/` (mock detection is on by default).
2. Open **http://localhost:5000** — ideally from a phone (localhost won't give
   camera access on a real phone, so on mobile use `https` via a tunnel such as
   `cloudflared tunnel --url http://localhost:5000`).
3. **Monitor** → pick a zone → pick a demo scenario (`illegal`, `full`, `correct`,
   `near`, or leave `random`) → **Start Monitoring** and allow camera + location.
4. Watch the live overlay and the classification feed. The first `illegal` / `full`
   frame prints email + SMS alerts to the backend console (cooldown suppresses
   repeats for 30 min).
5. **Admin Dashboard** → see stats, event thumbnails, GPS→Maps, notification status.
6. **Zone Config** → upload a picture of a bin, drag the zone box, save a new zone.
7. **Register** → add a resident; they'll appear in the alert dispatch on the next
   `illegal` event.
8. **Live View** → the phone feed appears here too (same browser or the PC);
   frames keep flowing even when there is no waste object.

## Live View (phone camera → PC CCTV)

Turn the phone into a remote CCTV: whatever the **Monitor** page's camera sees is
cached by the backend and shown on the **Live View** page — so a PC (or anyone
with the URL) watches the phone's feed live.

```
phone (Monitor, 1-1.5s/frame)           backend                          PC / other screen
┌─────────────────────────────────┐     ┌────────────────────────────┐    ┌──────────────────┐
│ POST /api/frames (every frame,  │────▶│ liveFeed → uploads/live/   │───▶│ GET /api/live +  │
│ waste or no-waste) + GPS        │     │ <cameraId>-latest.jpg +    │    │ .jpg → Live View │
└─────────────────────────────────┘     │ in-memory meta (60s TTL)   │    │ grid (1s poll)   │
                                        └────────────────────────────┘    └──────────────────┘
```

### How to try it (phone + PC)

1. Start the backend + open the tunnel URL (see Demo flow).
2. **Phone**: Monitor → zone → ▶ Start Monitoring → **Allow** camera + location.
   Frames flow automatically after that — no further phone input needed.
3. **PC**: open the same URL → **Live View**. The feed appears in ~1–2 s:
   LIVE badge, last-frame age, 📍 GPS → Maps, AI overlay (zone + detection
   boxes), and the classification label.
4. **Remote start (optional)**: phone Monitor page open but idle? Click
   **▶ Start camera** on the camera card — the phone auto-starts in ~3s
   (no tap needed, as long as camera permission was granted at least once).

### Why the phone must tap "Start Monitoring" once

Browsers forbid a remote page (your PC) from switching on another device's
camera without the device's own user gesture — camera access is granted
per-site, per-user. So the phone has to start monitoring at least once per
session. After that it needs **no further input**; frames are sent and cached
automatically. If the Monitor page is left **open but idle**, the PC's
**▶ Start camera** button wakes it remotely (~3s later) — a one-time grant
already covers later starts.

### Known limitations (web platform)

- The phone page must stay **open + foreground**: background tabs are throttled
  by the browser. Screen lock is handled by the **Wake Lock API** (Monitor page
  holds one while streaming → the screen stays on; browsers without Wake Lock
  still lock and show **OFFLINE** after 60s).
- Cadence is **~1–1.5s per frame** (sampling-based capture, not sub-second video).
- A camera is considered offline 60s after its last frame.
- The tunnel URL is temporary — restarting `cloudflared` changes it.

## Configuration (backend/.env)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `5000` | Backend + frontend port |
| `ROBOFLOW_API_KEY` | *(empty)* | Empty ⇒ mock mode. Set with `MOCK_DETECTION=0` for real inference |
| `ROBOFLOW_MODEL_ID` | *(empty)* | e.g. `myproject/12` (serverless) or `workspace/project/version` (legacy) |
| `ROBOFLOW_ENDPOINT` | `serverless` | `serverless` or `legacy` |
| `MOCK_DETECTION` | `1` | `1` to fabricate detections, `0` to call Roboflow |
| `MOCK_SCENARIO` | `random` | `random\|correct\|full\|illegal\|near\|none` |
| `ROBOFLOW_CONFIDENCE` | `0.45` | Detection confidence filter applied to predictions |
| `MAIL_MODE` | `console` | `console` prints emails; `smtp` really sends |
| `SMTP_HOST/_PORT/_USER/_PASS` | – | Gmail app password works well |
| `SMS_MODE` | `console` | `console` logs SMS; `fast2sms` sends (see DLT note) |
| `FAST2SMS_API_KEY` | – | Fast2SMS key for real SMS |
| `NOTIFY_COOLDOWN_MINUTES` | `30` | Minutes before an identical alert is re-sent |

### SMS / DLT note (India)

Transactional SMS in India requires **DLT registration** of the sender + approved
templates. The prototype logs SMS to the console by default and ships a Fast2SMS
integration for when you have the registration.

## API reference (summary)

| Route | Method | Purpose |
|---|---|---|
| `/api/health` | GET | Liveness |
| `/api/frames` | POST | Ingestion: `{ cameraId\|zoneId, imageBase64, gps, mockScenario? }` → classification, event id, snapshot URL, notification status |
| `/api/zones` | GET/POST | List / create zones (`zoneBox` = normalized box, optional `referenceImageBase64`, `admin`) |
| `/api/zones/:id` | PATCH/DELETE | Update box/name/area, delete zone |
| `/api/residents` | GET/POST/DELETE | Resident registration for alerts |
| `/api/admins` | GET/POST/DELETE | Zone admin / global fallback contacts |
| `/api/events` | GET | `?zoneId=&type=&from=&to=&limit=` filtered history + snapshot URLs |
| `/api/stats` | GET | Today's totals + counts by type |
| `/api/live` | GET | All configured zones as camera cards (cameraId, zone, GPS, classification, detections, snapshot URL) — `connected: true/false` |
| `/api/live/:cameraId.jpg` | GET | Current JPEG frame for a camera (no-store) |
| `/api/live/:cameraId/start` | POST | PC asks a phone camera to start (one-shot signal, 60s TTL) |
| `/api/live/remote-start` | GET | Phone polls `?cameraId=`; consumes the signal → `{start:true/false}` |
| `/api/uploads/*` | GET | Saved snapshots / reference images |

## Going to production (todos)

- **Real cameras**: keep `POST /api/frames`; add an RTSP connector (ffmpeg → same payload)
- **Auth**: protect admin routes; keep the resident register page public
- **DB**: swap SQLite for Postgres (the REST contract is already DB-agnostic)
- **HTTPS** for camera + GPS access anywhere except localhost
- **DLT** SMS registration, email domain + DKIM/SPF
- Capacity: fewer samples, queue ingestion, cache the last detection per zone

---

## Built with IBM Bob

This entire project — backend services, frontend pages, database schema, and documentation — was designed and implemented with **IBM Bob**, IBM's AI SDLC partner.

See **[IBM_BOB_USAGE.md](IBM_BOB_USAGE.md)** for a detailed breakdown of what IBM Bob did at each stage: codebase investigation, architecture planning, code implementation, task tracking, and documentation generation.