/**
 * SQLite connection + schema bootstrap + seed data.
 *
 * We use better-sqlite3 (synchronous, zero-config, file based) so the
 * prototype runs on any machine with zero database setup. Swap this one
 * module for a Postgres `pg` pool later - none of the route/service code
 * needs to change.
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_DIR = __dirname;
const DATA_DIR = path.join(DB_DIR, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'waste-detect.sqlite');

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Apply schema (idempotent).
db.exec(fs.readFileSync(path.join(DB_DIR, 'schema.sql'), 'utf8'));

/**
 * Seed zones / residents / admins if the zones table is empty.
 * Called automatically on server boot so the demo works out of the box.
 */
function seedIfEmpty() {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM zones').get();
  if (n === 0) seed();
}

/**
 * Insert demo data. `force` wipes existing demo tables first (used by `npm run seed`).
 */
function seed(force = false) {
  if (force) {
    db.exec('DELETE FROM events; DELETE FROM residents; DELETE FROM admins; DELETE FROM zones;');
  }
  const zoneCount = db.prepare('SELECT COUNT(*) AS n FROM zones').get().n;
  if (zoneCount > 0) {
    console.log('[db] zones already seeded, skipping.');
    return;
  }

  const insZone = db.prepare(
    `INSERT INTO zones (name, area, camera_id, zone_box, reference_image) VALUES (?, ?, ?, ?, ?)`
  );

  const zoneA = insZone.run(
    'Main Gate Dustbin',
    'Ward 12 - MG Road',
    'cam-main-gate',
    JSON.stringify({ x1: 0.38, y1: 0.25, x2: 0.62, y2: 0.55 }),
    null
  ).lastInsertRowid;

  const zoneB = insZone.run(
    'Park Side Dustbin',
    'Ward 12 - Central Park',
    'cam-park-side',
    JSON.stringify({ x1: 0.67, y1: 0.30, x2: 0.90, y2: 0.62 }),
    null
  ).lastInsertRowid;

  const insResident = db.prepare(
    `INSERT INTO residents (zone_id, name, email, phone) VALUES (?, ?, ?, ?)`
  );
  insResident.run(zoneA, 'Ravi Kumar',    'ravi.kumar@example.com',    '+91 90000 00001');
  insResident.run(zoneA, 'Sita Sharma',   'sita.sharma@example.com',   '+91 90000 00002');
  insResident.run(zoneA, 'Anil Verma',    'anil.verma@example.com',    '+91 90000 00003');
  insResident.run(zoneB, 'Meera Nair',    'meera.nair@example.com',    '+91 90000 00004');
  insResident.run(zoneB, 'Joseph Mathew', 'joseph.mathew@example.com', '+91 90000 00005');
  insResident.run(zoneB, 'Pooja Singh',   'pooja.singh@example.com',   '+91 90000 00006');

  const insAdmin = db.prepare(
    `INSERT INTO admins (zone_id, name, email, phone) VALUES (?, ?, ?, ?)`
  );
  insAdmin.run(zoneA, 'Corporation - Ward 12',     'corporation.ward12@example.com',    '+91 90000 01001');
  insAdmin.run(zoneB, 'Corporation - Ward 12',     'corporation.ward12@example.com',    '+91 90000 01001');
  insAdmin.run(null,  'City Control Room (fallback)', 'controlroom@example.com',        '+91 90000 01000');

  console.log('[db] Seeded 2 zones, 6 residents and 3 admin contacts.');
}

module.exports = { db, seedIfEmpty, seed };