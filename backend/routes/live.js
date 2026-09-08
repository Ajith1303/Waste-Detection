/**
 * Live View API - serves the rolling camera cache created by services/liveFeed.
 *
 *   GET /api/live            -> JSON list of active cameras (enriched with zone info)
 *   GET /api/live/:key.jpg   -> latest JPEG frame for that camera (no-store)
 *
 * The "Live View" React page polls /api/live every ~1s and refreshes each
 * camera <img> with a cache-busted URL, turning any browser that runs the
 * Monitor page (typically the phone) into a CCTV watchable from any screen.
 */
const express = require('express');
const path = require('path');
const liveFeed = require('../services/liveFeed');
const { db } = require('../db/database');

const router = express.Router();

// Zone lookup cache so we don't hit SQLite on every poll.
let zonesByCamera = null;
function zoneFor(cameraId) {
  if (!zonesByCamera) {
    const rows = db.prepare('SELECT * FROM zones').all();
    zonesByCamera = new Map(rows.map((z) => [String(z.camera_id), z]));
  }
  return zonesByCamera.get(cameraId) || null;
}
// Refresh the cache after zone edits (cheap to rebuild).
setInterval(() => { zonesByCamera = null; }, 15000);

router.get('/', (_req, res) => {
  const live = liveFeed.list();
  const liveByCam = new Map(live.map((c) => [c.cameraId, c]));
  const zoneRows = db.prepare('SELECT * FROM zones ORDER BY id').all();

  // Every configured zone is a "camera" in the Live View grid — connected only
  // when frames have arrived recently. This lets the PC remote-start a camera
  // from a completely cold state: the card (and its "Start camera" button)
  // exists even when nothing has streamed yet.
  const merged = zoneRows.map((z) => {
    const cam = liveByCam.get(String(z.camera_id));
    return cam
      ? { ...cam, connected: true, zoneId: z.id, zoneName: z.name, area: z.area }
      : {
          cameraId: String(z.camera_id), zoneId: z.id, zoneName: z.name, area: z.area,
          connected: false, ageMs: null, lastFrameAt: null, gps: {},
          width: 0, height: 0, classification: null, detections: [], snapshotUrl: null,
        };
  });
  // Live cameras whose zone row was deleted still show up (no zone info).
  for (const cam of live) {
    if (zoneRows.some((z) => String(z.camera_id) === cam.cameraId)) continue;
    merged.push({ ...cam, connected: true, zoneId: null, zoneName: null, area: null });
  }
  res.json(merged);
});

router.get('/:key.jpg', (req, res) => {
  const key = liveFeed.safeKey(req.params.key);
  const meta = liveFeed.get(key);
  if (!meta) {
    return res.status(404).json({ error: 'No live frame cached for this camera yet.' });
  }
  res.set('Content-Type', 'image/jpeg');
  res.set('Cache-Control', 'no-store, max-age=0');
  // key is sanitized to [A-Za-z0-9._-], so the path is ours, not user input.
  res.sendFile(path.join(liveFeed.LIVE_DIR, `${key}-latest.jpg`));
});

router.get('/remote-start', (req, res) => {
  const cameraId = String(req.query.cameraId || '');
  if (!cameraId) return res.json({ start: false });
  // One-shot: consumed here so the same signal only starts the camera once.
  res.json({ start: liveFeed.consumeRemoteStart(cameraId) });
});

router.post('/:key/start', (req, res) => {
  const key = liveFeed.safeKey(req.params.key);
  if (!key) return res.status(400).json({ error: 'cameraId required' });
  const ok = liveFeed.requestRemoteStart(key);
  res.json({ ok, cameraId: key, hint: `Signal lasts ${liveFeed.REMOTE_START_TTL_MS / 1000}s; phone app open+foreground with camera permission already granted will auto-start in ~3s.` });
});

module.exports = router;