/**
 * Admin / corporation contact management.
 * Admins can be zone-specific (zone_id set) or global fallback (zone_id NULL).
 *   GET    /api/admins            -> all admins
 *   POST   /api/admins            -> create (zoneId optional; null = global)
 *   DELETE /api/admins/:id        -> remove
 */
const express = require('express');
const { db } = require('../db/database');

const router = express.Router();

router.get('/', (req, res) => {
  const rows = db.prepare(`
    SELECT a.*, z.name AS zone_name FROM admins a
    LEFT JOIN zones z ON z.id = a.zone_id
    ORDER BY a.zone_id NULLS FIRST, a.id DESC
  `).all();
  res.json(rows);
});

router.post('/', (req, res, next) => {
  try {
    const { zoneId, name, email, phone } = req.body || {};
    if (!name || !email) return res.status(400).json({ error: 'name and email are required.' });

    const info = db.prepare(
      'INSERT INTO admins (zone_id, name, email, phone) VALUES (?, ?, ?, ?)'
    ).run(zoneId || null, name, email, phone || null);

    const created = db.prepare(`SELECT a.*, z.name AS zone_name FROM admins a
      LEFT JOIN zones z ON z.id = a.zone_id WHERE a.id = ?`).get(info.lastInsertRowid);
    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', (req, res) => {
  const info = db.prepare('DELETE FROM admins WHERE id = ?').run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'Admin not found.' });
  res.json({ ok: true });
});

module.exports = router;