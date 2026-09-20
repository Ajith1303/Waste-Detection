/**
 * Detection-event listing for the Admin Dashboard.
 *   GET  /api/events?zoneId=&type=&from=&to=&limit=
 *     type : correct | full | illegal | near
 *     from / to : YYYY-MM-DD dates
 *   DELETE /api/events/:id  – remove an event and its snapshot file
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const { db } = require('../db/database');

const router = express.Router();

router.get('/', (req, res) => {
  const where = [];
  const params = {};

  if (req.query.zoneId) {
    where.push('e.zone_id = @zoneId');
    params.zoneId = Number(req.query.zoneId);
  }
  if (req.query.type) {
    where.push('e.classification = @type');
    params.type = String(req.query.type);
  }
  if (req.query.from) {
    where.push('date(e.created_at) >= date(@from)');
    params.from = String(req.query.from);
  }
  if (req.query.to) {
    where.push('date(e.created_at) <= date(@to)');
    params.to = String(req.query.to);
  }

  const limit = Math.min(Number(req.query.limit) || 50, 500);
  params.limit = limit;

  const sql = `
    SELECT e.*, z.name AS zone_name, z.area AS zone_area
    FROM events e
    LEFT JOIN zones z ON z.id = e.zone_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY e.id DESC
    LIMIT @limit`;
  const rows = db.prepare(sql).all(params);

  res.json(rows.map((r) => ({
    ...r,
    snapshotUrl: r.snapshot_path ? `/api/${r.snapshot_path.replace(/\\/g, '/')}` : null,
    detections: r.detections_json ? JSON.parse(r.detections_json) : [],
  })));
});

router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid event id.' });
  }

  const event = db.prepare('SELECT snapshot_path FROM events WHERE id = ?').get(id);
  if (!event) {
    return res.status(404).json({ error: 'Event not found.' });
  }

  // Delete snapshot file from disk if it exists
  if (event.snapshot_path) {
    const abs = path.join(__dirname, '..', event.snapshot_path);
    try { fs.unlinkSync(abs); } catch (_) { /* ignore if already gone */ }
  }

  db.prepare('DELETE FROM events WHERE id = ?').run(id);
  res.json({ ok: true });
});

module.exports = router;