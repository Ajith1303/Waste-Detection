-- ============================================================================
-- Smart Waste Dumping Detection - SQLite schema (prototype)
-- Note: switch `zones`/`residents`/`admins`/`events` to Postgres tables in
-- production. The rest API is deliberately database-agnostic.
--
-- IMPORTANT coordinate convention:
--   zones.zone_box stores the dustbin bounding box in NORMALIZED 0..1
--   coordinates (x=left->right, y=top->bottom over the full camera frame).
--   This keeps a zone valid for ANY camera resolution (browser 1280x720 or a
--   future 4K RTSP feed) - see services/classification.js for the logic.
-- ============================================================================

CREATE TABLE IF NOT EXISTS zones (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT    NOT NULL,             -- human readable name, e.g. 'Main Gate Dustbin'
  area             TEXT    NOT NULL,             -- ward / locality, e.g. 'Ward 12 - MG Road'
  camera_id        TEXT    NOT NULL UNIQUE,      -- maps one physical camera to this zone
  zone_box         TEXT    NOT NULL,             -- JSON {x1,y1,x2,y2} normalized 0..1
  reference_image  TEXT,                         -- optional stored snapshot that was used to draw the box
  created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS residents (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  zone_id    INTEGER NOT NULL REFERENCES zones(id) ON DELETE CASCADE,
  name       TEXT    NOT NULL,
  email      TEXT    NOT NULL,
  phone      TEXT,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_residents_zone ON residents(zone_id);

-- Admins / corporation contacts. zone_id NULL => global fallback used when a
-- zone has no dedicated admin contact.
CREATE TABLE IF NOT EXISTS admins (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  zone_id    INTEGER REFERENCES zones(id) ON DELETE CASCADE,
  name       TEXT    NOT NULL,
  email      TEXT    NOT NULL,
  phone      TEXT,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_admins_zone ON admins(zone_id);

-- One row per analysed frame that contained waste.
-- classification: 'correct' | 'full' | 'illegal' | 'near'
CREATE TABLE IF NOT EXISTS events (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  zone_id             INTEGER REFERENCES zones(id) ON DELETE SET NULL,
  camera_id           TEXT,
  classification      TEXT    NOT NULL,
  reason              TEXT,
  fill_estimate       REAL,
  object_count        INTEGER NOT NULL DEFAULT 0,
  detections_json     TEXT,                       -- normalized detections (for replay / debugging)
  gps_lat             REAL,
  gps_lng             REAL,
  snapshot_path       TEXT,                       -- relative path under backend/uploads
  notification_status TEXT    NOT NULL DEFAULT 'not_triggered',
  notification_detail TEXT,
  created_at          TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_zone ON events(zone_id);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
CREATE INDEX IF NOT EXISTS idx_events_classification ON events(classification);