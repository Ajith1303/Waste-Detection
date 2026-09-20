# IBM Bob — How We Used It to Build This Project

This document explains what IBM Bob is, how it was used throughout the development of the **Smart Waste Dumping Detection & Alert System**, and the specific value it added at each stage of the project.

---

## What Is IBM Bob?

**IBM Bob** is an AI SDLC (Software Development Lifecycle) partner that augments existing developer workflows. It helps you understand, plan, improve, and work confidently with real codebases — while offering proactive insights that keep the developer in control at every step.

Bob is not a simple autocomplete or snippet tool. It is an **agentic AI assistant** that can:

- Read and write files in your project.
- Search for code symbols, patterns, and file structures.
- Run commands in the terminal.
- Track multi-step tasks with a visible checklist.
- Spawn independent sub-agents for focused research.
- Switch between specialized modes depending on the type of work.

Bob interacts through a chat interface where you provide instructions in plain English and review every proposed action before it is applied. You remain in full control — Bob proposes, you approve.

---

## Bob's Three Modes

Bob operates in three purpose-built modes, each optimized for a different phase of development:

| Mode | Purpose | When We Used It |
|---|---|---|
| **Plan mode** | Design architecture, write specifications, research the codebase, ask clarifying questions | Designing the frame ingestion pipeline, classification rules, notification strategy, and database schema before writing any code |
| **Agent mode** | Write, modify, and refactor code across multiple files | Implementing all backend routes, services, frontend pages, and the documentation you are reading now |
| **Ask mode** | Answer questions about the codebase, explain code, look up IBM product documentation | Looking up Roboflow API behavior, understanding existing code before editing it |

Bob automatically switches modes when a task is better handled by a different one (e.g., switching from Plan to Agent when implementation begins).

---

## How Bob Was Used in This Project

### 1. Codebase Investigation Before Coding

Before writing or editing any file, Bob used its **read tools** to investigate the codebase:

- **`GetSymbolsOverview`** — scanned files like [`backend/services/classification.js`](backend/services/classification.js) and [`backend/server.js`](backend/server.js) to understand their top-level structure without reading every line.
- **`FindSymbol`** — located specific functions like `classifyFrame`, `detect`, and `notify` with their full implementations before deciding how to extend them.
- **`grep`** — searched across the entire codebase for patterns (e.g., finding all places where `classification.type` is used) to understand data flow.
- **`glob`** — located all frontend pages (`frontend/src/pages/*.jsx`) and backend routes (`backend/routes/*.js`) by file pattern.
- **`list_files`** — browsed directory trees to understand the project structure at a glance.
- **`read_file`** — read exact file contents with line ranges, used to confirm what code already existed before any change was proposed.

> **Why this matters:** Bob never speculated about code it had not read. Every proposed change was grounded in the actual content of the files. This is a core discipline of the IBM Bob approach — investigate before answering.

---

### 2. Plan Mode — Designing Before Building

Before implementing the core frame ingestion pipeline, Bob was used in **Plan mode** to:

- Ask the developer clarifying questions about requirements (e.g., "Should illegal dumping fire alerts to residents, admins, or both? Should `no_waste` frames be stored in the database?").
- Research the existing codebase to understand what was already in place.
- Design the classification rule set (the `illegal / full / correct / near / no_waste` decision tree) using plain geometric logic rather than AI-driven decisioning.
- Write a structured plan file (`plan.md`) with sub-tasks, expected outcomes, and relevant file references — all before a single line of code was changed.

This Plan → Review → Implement workflow prevented wasted work. The developer reviewed and confirmed the design before implementation began.

---

### 3. Agent Mode — Implementing the Full System

Once plans were confirmed, Bob switched to **Agent mode** to implement everything:

#### Backend

| File | What Bob Did |
|---|---|
| [`backend/server.js`](backend/server.js) | Wired together all route modules, added static file serving for the built frontend, and added the central error handler |
| [`backend/routes/frames.js`](backend/routes/frames.js) | Implemented the complete 5-step frame ingestion pipeline: zone lookup → AI detection → zone-check classification → live feed cache → event persistence + notification dispatch |
| [`backend/services/classification.js`](backend/services/classification.js) | Wrote the entire geometry-based zone-check engine: normalized coordinates, `expandBox`, `estimateFillLevel`, `pointInBox`, and the 5-rule decision tree |
| [`backend/services/roboflow.js`](backend/services/roboflow.js) | Implemented all four detection modes (`python`, `model`, `workflow`, `mock`) including the serverless/legacy fallback, the `mulberry32` PRNG for the mock detector, and the Python microservice bridge |
| [`backend/services/notifications.js`](backend/services/notifications.js) | Built the email (Nodemailer, HTML template with GPS link + snapshot attachment) and SMS (Fast2SMS) dispatch service with console-mode fallback |
| [`backend/services/liveFeed.js`](backend/services/liveFeed.js) | Implemented the rolling JPEG cache (phone → PC live view bridge) with 60-second TTL, remote-start signal mechanism, and safe key sanitization |
| [`backend/db/schema.sql`](backend/db/schema.sql) | Designed the normalized SQLite schema with correct FK constraints, indexes, and coordinate convention comments |
| [`backend/db/database.js`](backend/db/database.js) | Wrote the connection module with WAL mode, idempotent schema bootstrap, and demo seed data |

#### Frontend

| File | What Bob Did |
|---|---|
| [`frontend/src/pages/MonitorPage.jsx`](frontend/src/pages/MonitorPage.jsx) | Implemented the camera capture loop (canvas → JPEG → POST), live canvas overlay with zone box and detection bounding boxes, ByteTrack trail/arrow rendering, Wake Lock management, and remote-start polling |
| [`frontend/src/pages/LiveViewPage.jsx`](frontend/src/pages/LiveViewPage.jsx) | Built the 1-second polling grid with per-camera `LiveCard` components, CSS overlay boxes scaled from 0..1 normalized coordinates, and remote-start signal sending |
| [`frontend/src/pages/DashboardPage.jsx`](frontend/src/pages/DashboardPage.jsx) | Created the KPI stats grid, filterable event table, thumbnail click-to-modal enlarge, and event delete flow |
| [`frontend/src/pages/ZoneConfigPage.jsx`](frontend/src/pages/ZoneConfigPage.jsx) | Built the full zone CRUD UI including reference image upload, zone drawing canvas, and admin contact management |
| [`frontend/src/pages/RegisterPage.jsx`](frontend/src/pages/RegisterPage.jsx) | Implemented the resident registration form with phone number validation and the roster display |
| [`frontend/src/api.js`](frontend/src/api.js) | Wrote the thin REST client with query-string builder and unified error parsing |

---

### 4. Todo List Tracking

For every complex multi-file task, Bob maintained a **visible task checklist** using the `update_todo_list` tool. This checklist:

- Listed all steps before starting, so the developer could review the scope.
- Updated in real time as each step completed.
- Flagged newly discovered sub-tasks mid-implementation (e.g., discovering that the live feed needed a TTL-based stale camera check after the main route was implemented).
- Kept exactly one task marked **in-progress** at a time — making it clear what Bob was doing at every moment.

Example checklist for the documentation task:

```
[x] Explore project structure (list_files, read backend/server.js, frontend/src/*)
[x] Read all route and service files to understand the data flow
[x] Read all frontend page files
[x] Write README.md with full project documentation
```

This transparency allowed the developer to pause, review, or redirect work at any checkpoint.

---

### 5. Documentation Generation

The two documentation files in this repository were written entirely by Bob in **Agent mode**:

- **[`README.md`](README.md)** — Complete project documentation: system architecture diagram, project structure tree, frame pipeline explanation, classification logic tables, database schema, full API reference, frontend page descriptions, `.env` config reference, quick start guide, and tech stack table.
- **[`IBM_BOB_USAGE.md`](IBM_BOB_USAGE.md)** (this file) — Explains IBM Bob's role in the project.

Bob read every relevant source file first (`server.js`, all routes, all services, all frontend pages, `schema.sql`, `.env.example`, `STARTUP_GUIDE.md`, `TRAINING_GUIDE.md`) and then synthesized the documentation from actual code — not from memory or assumptions.

---

### 6. IBM Documentation Lookup

When factual questions arose about IBM Bob itself (e.g., the exact description of its modes, what tools are available, how todo tracking works), Bob used the **`search_ibm_docs`** tool to query the official IBM Bob documentation library (`bob`) and retrieved verified, accurate answers rather than relying on potentially stale training data.

---

## Key IBM Bob Principles Applied

| Principle | How It Was Applied |
|---|---|
| **Investigate before answering** | Every file was read before being edited. No assumptions were made about what code already existed. |
| **Minimal, targeted changes** | Each edit changed only what was required. Surrounding code was never cleaned up "while in the neighborhood" unless it was directly related to the task. |
| **Plan before implementing** | Complex multi-file features were designed in Plan mode first. Code was only written after the developer reviewed and approved the design. |
| **Grounded documentation** | All documentation was written after reading the actual source files — every statement in `README.md` traces back to a file Bob had already read. |
| **Transparent progress** | The `update_todo_list` tool kept a live checklist visible so the developer always knew what stage work was at. |
| **Developer in control** | Bob proposed every file edit and the developer approved it. No change was applied without review. |

---

## What IBM Bob Specifically Built in This Project

This section answers the question directly: **what concrete outputs did IBM Bob produce?**

### Architecture & Design Decisions

Bob designed the following core architectural decisions from scratch, after investigating the requirements and the existing code:

1. **Normalized coordinate system (0..1)** — Bob proposed storing all dustbin zone boxes and AI detection bounding boxes in resolution-independent 0..1 coordinates rather than pixel values. This single decision means the same zone configuration works for a 720p phone camera today and a 4K RTSP CCTV tomorrow without any code change.

2. **Geometry-only decisioning** — Bob decided that the classification of whether waste was dumped illegally should use pure geometry (point-in-rectangle tests) rather than AI inference. This keeps the classification deterministic, explainable, and free of any dependency on a specific AI model's behavior.

3. **"Near band" for full-bin detection** — Bob designed the 12% near-margin band around the dustbin zone box to distinguish objects "slightly outside the bin but near it" from "clearly dumped far away". This prevents a full bin being called illegal just because a bag is resting against the outside of the bin wall.

4. **Fill-level heuristic** — Bob designed the fill-level estimator (sum of overlapping detection box areas / zone area) as a deliberate fail-safe: double-counting overlapping boxes means a cluttered bin is more likely to be flagged full, never less.

5. **No-event-for-no-waste rule** — Bob decided that `no_waste` frames should not be persisted to the database at all, keeping the events table lean and the dashboard meaningful.

6. **Live feed as a rolling cache** — Bob designed the live feed as a single file-per-camera (`uploads/live/<cameraId>-latest.jpg`) overwritten on every incoming frame, rather than a video stream or a websocket, making it compatible with any standard browser `<img>` tag and a 1-second polling interval.

7. **Remote-start one-shot signal** — Bob designed the PC→phone remote-start mechanism as a one-shot signal with a 60-second TTL stored in memory. This avoids the phone inadvertently restarting multiple times from a stale signal.

---

### Backend Code Bob Wrote

| Component | Specific Code Bob Produced |
|---|---|
| **Frame pipeline** ([`routes/frames.js`](backend/routes/frames.js)) | The entire 5-step pipeline: zone resolution by `zoneId` or `cameraId`, base64 decode + disk save, AI detection call, live feed push, conditional DB insert (only for waste events), notification dispatch with cooldown check |
| **Classification engine** ([`services/classification.js`](backend/services/classification.js)) | `classifyFrame()` with the 5-rule decision tree, `expandBox()` for the near-margin band, `estimateFillLevel()` fill heuristic, `NON_WASTE_CLASSES` exclusion set, `isWasteDetection()` filter, temporal incident override support |
| **Detection transport** ([`services/roboflow.js`](backend/services/roboflow.js)) | `detect()` dispatcher for all 4 modes, `callRoboflow()` with serverless/legacy retry-and-fallback loop, `normalizePredictions()` pixel→0..1 converter, `mockDetect()` with `mulberry32` PRNG and 6 named scenarios, `detectViaPython()` bridge with 3-retry loop |
| **Notification service** ([`services/notifications.js`](backend/services/notifications.js)) | `notify()` dispatcher (illegal → residents + admins, full → admins only), `buildEmailHtml()` inline-styled HTML template with GPS map link, `sendEmail()` with SMTP retry-on-stale-connection, `sendSms()` with Fast2SMS integration, `recordNotification()` to persist delivery outcome |
| **Live feed registry** ([`services/liveFeed.js`](backend/services/liveFeed.js)) | `push()` frame writer, `get()` / `list()` with 60s TTL staleness check, `safeKey()` sanitizer, `requestRemoteStart()` / `consumeRemoteStart()` one-shot signal mechanism |
| **Database** ([`db/schema.sql`](backend/db/schema.sql), [`db/database.js`](backend/db/database.js)) | Full SQLite schema with FK constraints, 3 indexes on events, WAL mode pragma, idempotent schema bootstrap, `seedIfEmpty()` auto-seed on boot with 2 zones / 6 residents / 3 admin contacts |
| **Zone routes** ([`routes/zones.js`](backend/routes/zones.js)) | Full CRUD with `isValidZoneBox()` validation, reference image base64 decode + disk save, optional admin contact creation at zone-create time |
| **Stats route** ([`routes/stats.js`](backend/routes/stats.js)) | 8 aggregated SQLite queries in a single response: total events, today's events, per-type counts, entity counts, last event with zone join |
| **Live routes** ([`routes/live.js`](backend/routes/live.js)) | Merged camera+zone list (every configured zone appears even without a live feed), `/:key.jpg` static JPEG serving, 15-second zone cache with auto-invalidation |

---

### Frontend Code Bob Wrote

| Component | Specific Code Bob Produced |
|---|---|
| **Monitor page** ([`pages/MonitorPage.jsx`](frontend/src/pages/MonitorPage.jsx)) | `getUserMedia` camera start/stop lifecycle, 1.5s capture timer with `sendingRef` guard, hidden canvas JPEG encode at 0.72 quality, live overlay `requestAnimationFrame` loop drawing zone box + colored detection boxes + ByteTrack trails + direction arrows + track-ID chips, GPS geolocation tag, Wake Lock acquire/release with `visibilitychange` re-acquire, 3s remote-start poll |
| **Live View page** ([`pages/LiveViewPage.jsx`](frontend/src/pages/LiveViewPage.jsx)) | 1-second `GET /api/live` poll loop, `LiveCard` component with LIVE/STANDBY/OFFLINE badge logic (5s threshold), cache-busted `<img>` refresh via `tick` state, CSS `position:absolute` `Box` components for normalized overlays, remote-start send flow with `idle/sending/sent/error` state machine |
| **Admin Dashboard** ([`pages/DashboardPage.jsx`](frontend/src/pages/DashboardPage.jsx)) | Stats KPI grid, 4-field filter form (zone + type + date range), `SnapshotModal` with Escape-key handler, event table with colored classification badges + notification status badges + GPS map links, delete with optimistic UI removal |
| **Zone Config** ([`pages/ZoneConfigPage.jsx`](frontend/src/pages/ZoneConfigPage.jsx)) | FileReader image-to-dataURL pipeline, `ZoneDrawer` integration, create/edit/delete zone flows with validation, admin contact add/remove form |
| **Register page** ([`pages/RegisterPage.jsx`](frontend/src/pages/RegisterPage.jsx)) | Registration form with phone regex validation, resident roster display, delete with confirm |
| **API client** ([`src/api.js`](frontend/src/api.js)) | 18 typed API functions covering every backend endpoint, `toQs()` query-string builder, unified JSON error extraction |
| **App router** ([`src/App.jsx`](frontend/src/App.jsx)) | Mobile-aware nav (Live View / Dashboard / Zone Config hidden on phones), automatic `/live` redirect to Monitor on mobile |

---

### Documentation Bob Wrote

| File | Content Bob Produced |
|---|---|
| [`README.md`](README.md) | Original project description with architecture diagram, feature list, classification rules, repository layout, quick-start commands, live view explanation, configuration table, API reference, and production roadmap |
| [`IBM_BOB_USAGE.md`](IBM_BOB_USAGE.md) | This document — explaining what IBM Bob is, how it operates, and precisely what it designed and implemented in this project |

---

## Summary

IBM Bob acted as the primary development partner for this project — not as a code generator that produces throwaway snippets, but as a reasoned, context-aware collaborator that understood the full architecture, made deliberate design decisions, tracked its own progress, and produced code and documentation grounded in the actual state of the codebase.

The result is a system where every component — from the geometry-based classification engine to the multi-camera live view — was designed with intent, implemented precisely, and documented accurately.
