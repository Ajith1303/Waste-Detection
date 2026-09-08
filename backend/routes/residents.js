/**
 * Resident registration (public form) + management.
 *   GET    /api/residents          -> all residents (optionally ?zoneId=)
 *   POST   /api/residents          -> register a resident to a zone
 *   DELETE /api/residents/:id      -> remove a resident
 */
const express = require('express');
const { db } = require('../db/database');

const router = express.Router();

router.get('/', (req, res) => {
  const rows = req.query.zoneId
    ? db.prepare(`
        SELECT r.*, z.name AS zone_name FROM residents r
        JOIN zones z ON z.id = r.zone_id WHERE r.zone_id = ?
        ORDER BY r.id DESC`).all(Number(req.query.zoneId))
    : db.prepare(`
        SELECT r.*, z.name AS zone_name FROM residents r
        JOIN zones z ON z.id = r.zone_id ORDER BY r.id DESC`).all();
  res.json(rows);
});

router.post('/', (req, res, next) => {
  try {
    const { zoneId, name, email, phone } = req.body || {};
    if (!name || !email) {
      return res.status(400).json({ error: 'Name and email are required.' });
    }
    let targetZoneId = zoneId;
    if (!targetZoneId) {
      const firstZone = db.prepare('SELECT id FROM zones ORDER BY id ASC LIMIT 1').get();
      if (!firstZone) {
        return res.status(400).json({ error: 'No zones exist yet. Please create a zone first.' });
      }
      targetZoneId = firstZone.id;
    }
    const zone = db.prepare('SELECT id FROM zones WHERE id = ?').get(targetZoneId);
    if (!zone) return res.status(404).json({ error: 'Zone not found.' });

    const info = db.prepare(
      'INSERT INTO residents (zone_id, name, email, phone) VALUES (?, ?, ?, ?)'
    ).run(targetZoneId, name.trim(), email.trim(), phone ? phone.trim() : null);

    const created = db.prepare(`SELECT r.*, z.name AS zone_name FROM residents r
      JOIN zones z ON z.id = r.zone_id WHERE r.id = ?`).get(info.lastInsertRowid);
    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', (req, res) => {
  const info = db.prepare('DELETE FROM residents WHERE id = ?').run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'Resident not found.' });
  res.json({ ok: true });
});

module.exports = router;