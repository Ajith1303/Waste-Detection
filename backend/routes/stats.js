/**
 * Dashboard aggregates: counts by type, zones, residents, admins.
 *   GET /api/stats
 */
const express = require('express');
const { db } = require('../db/database');

const router = express.Router();

router.get('/', (_req, res) => {
  const byType = db.prepare(
    'SELECT classification, COUNT(*) AS n FROM events GROUP BY classification'
  ).all();

  const lastEvent = db.prepare(`
    SELECT e.*, z.name AS zone_name, z.area AS zone_area
    FROM events e LEFT JOIN zones z ON z.id = e.zone_id
    ORDER BY e.id DESC LIMIT 1`).get();

  res.json({
    events: db.prepare('SELECT COUNT(*) AS n FROM events').get().n,
    eventsToday: db.prepare(
      "SELECT COUNT(*) AS n FROM events WHERE created_at >= datetime('now','start of day')"
    ).get().n,
    illegal: db.prepare("SELECT COUNT(*) AS n FROM events WHERE classification = 'illegal'").get().n,
    full: db.prepare("SELECT COUNT(*) AS n FROM events WHERE classification = 'full'").get().n,
    correct: db.prepare("SELECT COUNT(*) AS n FROM events WHERE classification = 'correct'").get().n,
    zones: db.prepare('SELECT COUNT(*) AS n FROM zones').get().n,
    residents: db.prepare('SELECT COUNT(*) AS n FROM residents').get().n,
    admins: db.prepare('SELECT COUNT(*) AS n FROM admins').get().n,
    byType,
    lastEvent,
  });
});

module.exports = router;