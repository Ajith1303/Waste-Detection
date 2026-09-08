/**
 * Live feed registry - the bridge that lets a phone (browser camera) show its
 * live feed on the PC / admin screen.
 *
 * Every frame that POST /api/frames receives (waste or not) is:
 *   1. written to uploads/live/<cameraId>-latest.jpg  (rolling cache, overwritten)
 *   2. recorded in-memory with its classification + GPS + timestamp
 *
 * routes/live.js serves this cache back to the "Live View" frontend page, so
 * whatever browser is capturing (e.g. the phone) becomes a CCTV that any other
 * screen can watch in ~1s cadence.
 */
const fs = require('fs');
const path = require('path');

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
const LIVE_DIR = path.join(UPLOAD_DIR, 'live');
fs.mkdirSync(LIVE_DIR, { recursive: true });

/** A camera stops being "live" if we haven't heard from it for this long. */
const STALE_MS = 60 * 1000;

/** Map: sanitizedCameraId -> { cameraId, sessionId, ts, gps, width, height,
 *                              classification, detections, framePath } */
const cameras = new Map();

/** Keep only URL-safe characters so a cameraId can be used in a route param. */
function safeKey(id) {
  return String(id || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * Record one incoming frame as the newest view of a camera.
 * Cheap: one image write (~100-300KB) + a map entry; safe to call on every frame.
 */
function push({ cameraId, sessionId, buffer, classification, detections, gps, width, height }) {
  const key = safeKey(cameraId);
  if (!key) return;

  const framePath = path.join(LIVE_DIR, `${key}-latest.jpg`);
  try {
    fs.writeFileSync(framePath, buffer);
  } catch (err) {
    // A failure here must never break the frame pipeline.
    console.error('[liveFeed] write failed:', err.message);
    return;
  }

  cameras.set(key, {
    cameraId: key, // already sanitized, mirrors the original camera_id from the zone
    sessionId,
    ts: Date.now(),
    gps: gps && typeof gps === 'object' ? gps : {},
    width: Number(width) || 0,
    height: Number(height) || 0,
    classification: classification ? { type: classification.type, reason: classification.reason } : null,
    detections: Array.isArray(detections) ? detections : [],
    framePath,
    snapshotUrl: `/api/uploads/live/${key}-latest.jpg`,
  });
}

/** Snapshot of one camera (without exposing filesystem paths). */
function get(id) {
  const meta = cameras.get(safeKey(id));
  if (!meta) return null;
  if (Date.now() - meta.ts > STALE_MS) return null;
  return {
    cameraId: meta.cameraId,
    sessionId: meta.sessionId,
    lastFrameAt: meta.ts,
    ageMs: Date.now() - meta.ts,
    gps: meta.gps,
    width: meta.width,
    height: meta.height,
    classification: meta.classification,
    detections: meta.detections,
    snapshotUrl: meta.snapshotUrl,
  };
}

/** All cameras that reported a frame recently, newest first. */
function list() {
  const now = Date.now();
  const live = [];
  for (const meta of cameras.values()) {
    if (now - meta.ts <= STALE_MS) {
      live.push({
        cameraId: meta.cameraId,
        sessionId: meta.sessionId,
        lastFrameAt: meta.ts,
        ageMs: now - meta.ts,
        gps: meta.gps,
        width: meta.width,
        height: meta.height,
        classification: meta.classification,
        detections: meta.detections,
        snapshotUrl: meta.snapshotUrl,
      });
    }
  }
  live.sort((a, b) => b.lastFrameAt - a.lastFrameAt);
  return live;
}

/**
 * Pending "remote start" signals sent by the PC Live View page.
 * Map: cameraId -> timestamp (ms). The phone's Monitor page POLLs this and,
 * if its camera permission was already granted, auto-starts — no tap needed.
 * A signal is consumed on first read and expires after REMOTE_START_TTL_MS.
 */
const remoteStart = new Map();
const REMOTE_START_TTL_MS = 60 * 1000;

function requestRemoteStart(cameraId) {
  const key = safeKey(cameraId);
  if (!key) return false;
  remoteStart.set(key, Date.now());
  return true;
}

function consumeRemoteStart(cameraId) {
  const key = safeKey(cameraId);
  const ts = remoteStart.get(key);
  remoteStart.delete(key); // one-shot: a signal is consumed no matter what
  if (!ts) return false;
  return Date.now() - ts <= REMOTE_START_TTL_MS;
}

module.exports = { push, get, list, safeKey, LIVE_DIR, requestRemoteStart, consumeRemoteStart, REMOTE_START_TTL_MS };