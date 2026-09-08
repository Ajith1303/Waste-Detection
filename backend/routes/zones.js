/**
 * Zone configuration endpoints (Admin). Zones map a camera_id to a
 * normalized dustbin bounding box plus its area/admin contact.
 *   GET    /api/zones        -> list all zones (+ counts)
 *   POST   /api/zones        -> create a zone (optionally with its admin)
 *   PATCH  /api/zones/:id    -> update name/area/zone box
 *   DELETE /api/zones/:id    -> remove a zone (events are detached, not deleted)
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const { db } = require('../db/database');

const router = express.Router();
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');

/**
 * Validate a normalized zone box: { x1,y1,x2,y2 } all 0..1, width/height > 0.
 */
function isValidZoneBox(box) {
  if (!box) return false;
  const nums = [box.x1, box.y1, box.x2, box.y2];
  if (nums.some((v) => typeof v !== 'number' || Number.isNaN(v))) return false;
  if (nums.some((v) => v < 0 || v > 1)) return false;
  return box.x2 > box.x1 && box.y2 > box.y1;
}

const zoneSelect = `
  SELECT z.*,
    (SELECT COUNT(*) FROM residents r WHERE r.zone_id = z.id) AS resident_count,
    (SELECT COUNT(*) FROM admins a WHERE a.zone_id = z.id) AS admin_count
  FROM zones z
`;

// List all zones with parsed box + counts.
router.get('/', (req, res) => {
  const zones = db.prepare(`${zoneSelect} ORDER BY z.name`).all()
    .map((z) => ({ ...z, zone_box: JSON.parse(z.zone_box) }));
  res.json(zones);
});

// Create a zone (with optional reference snapshot + default admin).
router.post('/', (req, res, next) => {
  try {
    const {
      name, area, cameraId, zoneBox,
      referenceImageBase64, admin,
    } = req.body || {};

    if (!name || !area || !cameraId || !isValidZoneBox(zoneBox)) {
      return res.status(400).json({
        error: 'name, area, cameraId and a valid normalized zoneBox {x1,y1,x2,y2} are required.',
      });
    }
    const duplicate = db.prepare('SELECT id FROM zones WHERE camera_id = ?').get(cameraId);
    if (duplicate) {
      return res.status(409).json({ error: `camera_id "${cameraId}" is already mapped to a zone.` });
    }

    // Optionally store the reference snapshot used to draw the box.
    let referenceImage = null;
    if (referenceImageBase64) {
      const m = /^data:image\/(\w+);base64,(.+)$/.exec(referenceImageBase64);
      if (m) {
        const safeCam = cameraId.replace(/[^A-Za-z0-9._-]/g, '_');
        const fname = `zone-ref-${safeCam}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
        fs.mkdirSync(UPLOAD_DIR, { recursive: true });
        fs.writeFileSync(path.join(UPLOAD_DIR, fname), Buffer.from(m[2], 'base64'));
        referenceImage = path.join('uploads', fname);
      }
    }

    const info = db.prepare(
      `INSERT INTO zones (name, area, camera_id, zone_box, reference_image)
       VALUES (@name, @area, @cameraId, @zoneBox, @referenceImage)`
    ).run({ name, area, cameraId, zoneBox: JSON.stringify(zoneBox), referenceImage });

    // Optional: bind a corporation contact to the zone right away.
    if (admin && admin.email) {
      db.prepare('INSERT INTO admins (zone_id, name, email, phone) VALUES (?, ?, ?, ?)')
        .run(info.lastInsertRowid, admin.name || 'Corporation', admin.email, admin.phone || null);
    }

    const created = db.prepare(`${zoneSelect} WHERE z.id = ?`).get(info.lastInsertRowid);
    res.status(201).json({ ...created, zone_box: JSON.parse(created.zone_box) });
  } catch (err) {
    next(err);
  }
});

// Update zone box / labels (e.g. after the admin re-draws the zone).
router.patch('/:id', (req, res, next) => {
  try {
    const { name, area, zoneBox } = req.body || {};
    const existing = db.prepare('SELECT * FROM zones WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Zone not found.' });
    if (zoneBox !== undefined && !isValidZoneBox(zoneBox)) {
      return res.status(400).json({ error: 'Invalid normalized zoneBox.' });
    }
    db.prepare(`UPDATE zones SET name=?, area=?, zone_box=? WHERE id=?`).run(
      name ?? existing.name,
      area ?? existing.area,
      zoneBox ? JSON.stringify(zoneBox) : existing.zone_box,
      existing.id
    );
    const updated = db.prepare(`${zoneSelect} WHERE z.id = ?`).get(existing.id);
    res.json({ ...updated, zone_box: JSON.parse(updated.zone_box) });
  } catch (err) {
    next(err);
  }
});

// Delete a zone (events keep their history via ON DELETE SET NULL).
router.delete('/:id', (req, res, next) => {
  try {
    const info = db.prepare('DELETE FROM zones WHERE id = ?').run(req.params.id);
    if (!info.changes) return res.status(404).json({ error: 'Zone not found.' });
    res.json({ ok: true, deleted: req.params.id });
  } catch (err) {
    next(err);
  }
});

module.exports = router;