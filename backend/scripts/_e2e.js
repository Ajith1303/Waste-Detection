/* End-to-end test: start server, POST a real SAM frame through /api/frames. */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');

(async () => {
  // Start the server in-process.
  const { seedIfEmpty } = require('../db/database');
  const express = require('express');
  const cors = require('cors');
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '25mb' }));
  app.use('/api/frames', require('../routes/frames'));
  seedIfEmpty();
  const server = app.listen(0, async () => {
    const port = server.address().port;
    try {
      const f = fs.readdirSync(path.join(__dirname, '..', 'uploads'))
        .filter((n) => /\.(jpg|jpeg|png)$/i.test(n))
        .map((n) => ({ n, t: fs.statSync(path.join(__dirname, '..', 'uploads', n)).mtimeMs }))
        .sort((a, b) => b.t - a.t)
        .find((x) => x.n.includes('1788593213944')); // has 3 detections: person, plastic, paper
      const buf = fs.readFileSync(path.join(__dirname, '..', 'uploads', f.n));
      const dataUrl = `data:image/jpeg;base64,${buf.toString('base64')}`;

      const resp = await fetch(`http://127.0.0.1:${port}/api/frames`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cameraId: 'cam-main-gate',
          zoneId: 3,
          imageBase64: dataUrl,
          width: 1280,
          height: 720,
          sessionId: 'e2e-sam-test',
        }),
      });
      const json = await resp.json();
      console.log('HTTP', resp.status);
      console.log(JSON.stringify({
        ok: json.ok,
        classification: json.classification && { type: json.classification.type, reason: json.classification.reason, fillEstimate: json.classification.fillEstimate, objectCount: json.classification.objectCount },
        detections: (json.detections || []).map((d) => `${d.class}/${(d.confidence || 0).toFixed(2)}`),
        eventId: json.eventId,
        notification: json.notification,
      }, null, 2));
    } finally {
      server.close();
    }
  });
})().catch((e) => { console.error('E2E ERR:', e.message); process.exit(1); });
