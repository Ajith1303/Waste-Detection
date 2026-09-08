/**
 * Frame ingestion pipeline (POST /api/frames).
 *
 * Flow per received frame:
 *   1. Resolve the dustbin zone for the given zoneId / cameraId.
 *   2. Decode the base64 snapshot and save it to disk (uploaded by the
 *      browser camera page every 1-2s - see README on sampling to keep API
 *      cost low).
 *   3. Pass bytes to the Roboflow object-detection service (or mock).
 *   4. Run the CORE CUSTOM zone-check geometry (services/classification.js).
 *   5. Persist an event row ONLY if waste was found (avoids DB spam).
 *   6. For 'illegal' / 'full' -> dispatch notifications (email/SMS) with a
 *      per-classification cooldown so a persistent situation doesn't spam.
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db } = require('../db/database');
const roboflow = require('../services/roboflow');
const liveFeed = require('../services/liveFeed');
const { classifyFrame } = require('../services/classification');
const notifications = require('../services/notifications');

const router = express.Router();
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/** Decode an image sent either as `data:image/jpeg;base64,...` or raw base64. */
function b64ToBuffer(dataUrl) {
  const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  return Buffer.from(m ? m[2] : dataUrl, 'base64');
}

router.post('/', async (req, res, next) => {
  try {
    const {
      cameraId,
      zoneId,
      imageBase64,
      gps = {},
      width = 1280,
      height = 720,
      sessionId = 'browser-session',
      mockScenario, // only used in mock mode - handy for demos/tests
      classificationOverride,
      reasonOverride,
      temporalEvent,
    } = req.body || {};

    if (!imageBase64) {
      return res.status(400).json({ error: 'imageBase64 (data URL) is required.' });
    }

    // ---- 1) resolve zone ----------------------------------------------
    let zone = null;
    if (zoneId) zone = db.prepare('SELECT * FROM zones WHERE id = ?').get(zoneId);
    else if (cameraId) zone = db.prepare('SELECT * FROM zones WHERE camera_id = ?').get(cameraId);
    if (!zone) {
      return res.status(404).json({
        error: `No dustbin zone mapped for zoneId=${zoneId} cameraId=${cameraId}. Configure one in Admin > Zone Config first.`,
      });
    }

    const zoneBox = JSON.parse(zone.zone_box); // normalized 0..1 box
    const buffer = b64ToBuffer(imageBase64);

    // ---- 2) AI object detection (normalized coords) --------------------
    const detections = await roboflow.detect(buffer, { width, height }, zoneBox, mockScenario);
    // Optional ByteTrack + movement data + temporal state machine
    const tracks = (detections && detections.tracks) || [];
    const temporalState = (detections && detections.temporalState) || 'IDLE';
    const candidates = (detections && detections.candidates) || [];
    const confirmedIncidents = (detections && detections.confirmedIncidents) || [];

    // ---- 3) CORE custom logic: zone check + classification -------------
    const classification = classifyFrame(detections, zoneBox, {
      temporalState,
      candidates,
      confirmedIncidents,
      classificationOverride,
      reasonOverride,
    });

    // ---- 3b) LIVE FEED: cache this frame (waste or not) so the "Live View"
    // page on the PC can watch the phone camera in near-real-time. ----------
    liveFeed.push({
      cameraId: cameraId || zone.camera_id,
      sessionId,
      buffer,
      classification,
      detections,
      gps,
      width,
      height,
    });

    // ---- 4) only persist frames where waste was actually found ----------
    if (classification.type === 'no_waste') {
      return res.json({
        ok: true,
        classification,
        detections,
        tracks,
        temporalState,
        candidates,
        confirmedIncidents,
        eventId: null,
        notification: { status: 'not_triggered', detail: 'no waste in frame' },
      });
    }

    const safeSession = String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_');
    const filename = `${safeSession}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.jpg`;
    fs.writeFileSync(path.join(UPLOAD_DIR, filename), buffer);
    const snapshotPath = path.join('uploads', filename); // relative to backend root

    const info = db.prepare(`
      INSERT INTO events
        (zone_id, camera_id, classification, reason, fill_estimate, object_count,
         detections_json, gps_lat, gps_lng, snapshot_path, notification_status)
      VALUES
        (@zone_id, @camera_id, @classification, @reason, @fill_estimate, @object_count,
         @detections_json, @gps_lat, @gps_lng, @snapshot_path, 'not_triggered')
    `).run({
      zone_id: zone.id,
      camera_id: cameraId || zone.camera_id,
      classification: classification.type,
      reason: classification.reason,
      fill_estimate: classification.fillEstimate,
      object_count: classification.objectCount,
      detections_json: JSON.stringify(detections),
      gps_lat: gps.lat ?? null,
      gps_lng: gps.lng ?? null,
      snapshot_path: snapshotPath,
    });
    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(info.lastInsertRowid);

    // ---- 5) notifications for 'illegal' / 'full' -------------------------
    let notification = { status: 'not_triggered', detail: 'no alert needed for this classification' };
    if (classification.type === 'illegal' || classification.type === 'full') {
      const cooldownMin = Number(process.env.NOTIFY_COOLDOWN_MINUTES || 30);
      // Exclude the event we just inserted (id != event.id) so the FIRST alert
      // for a new situation always fires; only repeats within the window skip.
      // Only count successfully sent alerts — failed deliveries don't start the cooldown.
      const { n } = db.prepare(
        `SELECT COUNT(*) AS n FROM events
          WHERE zone_id = ? AND classification = ? AND id != ?
            AND notification_status = 'sent'
            AND created_at >= datetime('now', ?)`
      ).get(zone.id, classification.type, event.id, `-${cooldownMin} minutes`);

      if (n > 0) {
        notification = {
          status: 'cooldown',
          detail: `identical alert already sent within the last ${cooldownMin} min - skipped to prevent spam.`,
        };
        notifications.recordNotification(event.id, notification); // persist so the dashboard shows it
      } else {
        try {
          const sent = await notifications.notify(zone, event);
          notification = notifications.recordNotification(event.id, sent);
        } catch (err) {
          // A delivery failure (e.g. SMTP down / bad credentials) must NOT
          // break the frame pipeline - the detection result is already saved.
          console.error('[notify] delivery failed:', err.message);
          notification = { status: 'failed', detail: `notification error: ${err.message}` };
          notifications.recordNotification(event.id, notification);
        }
      }
    }

    res.json({
      ok: true,
      classification,
      detections,
      tracks,
      temporalState,
      candidates,
      confirmedIncidents,
      eventId: event.id,
      notification,
      snapshotUrl: `/api/${snapshotPath.replace(/\\/g, '/')}`,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;