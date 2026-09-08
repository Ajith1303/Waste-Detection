/* Smoke test with retries: runs SAM workflow detection on a real uploaded image. */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const roboflow = require('../services/roboflow');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const files = fs.readdirSync(path.join(__dirname, '..', 'uploads'))
    .filter((n) => /\.(jpg|jpeg|png)$/i.test(n))
    .map((n) => ({ n, t: fs.statSync(path.join(__dirname, '..', 'uploads', n)).mtimeMs }))
    .sort((a, b) => b.t - a.t)
    .slice(0, 3);

  console.log('mode =', roboflow.detectionMode(), '| mockEnabled =', roboflow.mockEnabled());

  for (const f of files) {
    const buf = fs.readFileSync(path.join(__dirname, '..', 'uploads', f.n));
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const dets = await roboflow.detect(buf, { width: 1280, height: 720 }, { x1: 0.3, y1: 0.3, x2: 0.7, y2: 0.7 });
        console.log(`[${f.n}] attempt ${attempt}: ${dets.length} detections`, dets.slice(0, 3).map((d) => `${d.class}/${d.confidence.toFixed(2)}@(${d.x.toFixed(2)},${d.y.toFixed(2)})`).join(' '));
        if (dets.length) break;
      } catch (e) {
        console.log(`[${f.n}] attempt ${attempt} ERR: ${e.message}`);
      }
      await sleep(2500);
    }
  }
})().catch((e) => { console.error('SMOKE ERR:', e.message); process.exit(1); });
