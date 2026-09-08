/**
 * Smart Waste Dumping Detection & Alert System - Express server.
 *
 * To switch from "browser as camera" to a real RTSP CCTV feed later:
 *   - Keep this ingestion API unchanged.
 *   - Write a small RTSP connector that decodes frames (e.g. ffmpeg) and
 *     POSTs the same JSON payload with the matching camera_id + snapshot.
 */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const { seedIfEmpty } = require('./db/database');

const app = express();
app.use(cors());
app.use(express.json({ limit: '25mb' })); // browser frames are base64 images

// Simple request log (nice for watching the mock feed live).
app.use((req, _res, next) => {
  if (req.method === 'POST') console.log(`[req] ${req.method} ${req.originalUrl}`);
  next();
});

// Saved camera snapshots / zone reference images.
app.use('/api/uploads', express.static(path.join(__dirname, 'uploads')));

// API routes.
app.use('/api/frames', require('./routes/frames'));
app.use('/api/live', require('./routes/live'));
app.use('/api/zones', require('./routes/zones'));
app.use('/api/residents', require('./routes/residents'));
app.use('/api/admins', require('./routes/admins'));
app.use('/api/events', require('./routes/events'));
app.use('/api/stats', require('./routes/stats'));

app.get('/api/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// Serve the built React app when present (frontend/dist) so a single
// `npm start` can run the whole prototype in production-like mode.
const distDir = path.join(__dirname, '..', 'frontend', 'dist');
if (require('fs').existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(distDir, 'index.html')));
  console.log('[server] Serving built frontend from frontend/dist');
}

// Central error handler - keeps the REST contract predictable in the prototype.
app.use((err, _req, res, _next) => {
  console.error('[error]', err.message);
  res.status(500).json({ error: err.message });
});

const PORT = Number(process.env.PORT || 5000);
seedIfEmpty(); // demo data on first boot
app.listen(PORT, () => {
  console.log(`\nSmart Waste Dumping Detection - backend on http://localhost:${PORT}`);
  console.log(`  Health : http://localhost:${PORT}/api/health`);
  console.log(`  Zones  : http://localhost:${PORT}/api/zones`);
  const rf = require('./services/roboflow');
  console.log(`  Detection mode : ${rf.detectionMode()}`);
  if (rf.detectionMode() === 'python') {
    console.log(`  Python detector: ${process.env.PYTHON_DETECTOR_URL || 'http://127.0.0.1:8001/detect'}`);
  }
  console.log('  Mock detection is', rf.mockEnabled() ? 'ENABLED' : 'DISABLED');
});