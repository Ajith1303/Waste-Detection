/**
 * Roboflow hosted inference wrapper.
 *
 * Two transport modes (env ROBOFLOW_ENDPOINT):
 *   - 'serverless' (default) -> POST https://serverless.roboflow.com/<project>/<version>
 *                               multipart file upload + `Authorization: Bearer <key>`
 *                               (auto-falls-back to legacy on failure)
 *   - 'legacy'               -> POST https://detect.roboflow.com/<model>?api_key=...
 *                               raw image bytes in the body
 *
 * MOCK MODE (MOCK_DETECTION=1 or missing ROBOFLOW_API_KEY):
 *   Fabricates detections so the whole prototype can be demoed without any
 *   external API key or cost. Use MOCK_SCENARIO to force a behaviour.
 */
const clamp01 = (v) => Math.min(1, Math.max(0, v));

/** SAM 3 workflow transport (zero-shot segmentation via Workflows HTTP API). */
const workflow = require('./roboflowWorkflow');

/**
 * Detection mode, from env.ROBOFLOW_MODE:
 *   - 'workflow' -> SAM 3 zero-shot workflow (serverless.roboflow.com/infer/workflows/...)
 *   - 'python'   -> Python Detector microservice (backend/python_detector) - does the
 *                   real ML locally (ONNX YOLO) or via Roboflow, and returns normalized
 *                   detections over HTTP. Point PYTHON_DETECTOR_URL at it.
 *   - 'model'    -> classic hosted model endpoint (ROBOFLOW_MODEL_ID)
 *   - 'mock'     -> fabricated detections (demo, no API cost)
 * Default: 'model' but if the legacy MOCK_DETECTION flag is set, mock wins.
 */
function detectionMode() {
  const mode = (process.env.ROBOFLOW_MODE || '').toLowerCase();
  if (mode === 'workflow') return 'workflow';
  if (mode === 'python') return 'python';
  if (mode === 'mock') return 'mock';
  // Explicit "model" or default.
  return 'model';
}

function mockEnabled() {
  return (
    detectionMode() === 'mock' ||
    (detectionMode() === 'model' &&
      (!process.env.ROBOFLOW_API_KEY ||
        process.env.MOCK_DETECTION === '1' ||
        process.env.MOCK_DETECTION === 'true'))
  );
}


/**
 * Translate raw Roboflow predictions into a canonical NORMALIZED (0..1)
 * format. Roboflow returns pixel coordinates relative to the input image, so
 * we divide by the image size. If the API already returned normalized values
 * (some endpoints/models do), we leave them alone.
 */
function normalizePredictions(payload, fallbackSize) {
  if (!payload || !Array.isArray(payload.predictions)) return [];
  const img = payload.image || {};
  const size = {
    width: img.width || (fallbackSize && fallbackSize.width),
    height: img.height || (fallbackSize && fallbackSize.height),
  };
  const dimsKnown = size.width > 1 && size.height > 1;

  return payload.predictions
    .filter((p) => typeof p.x === 'number' && typeof p.y === 'number')
    .map((p) => {
      let x = p.x;
      let y = p.y;
      let w = p.width || 0;
      let h = p.height || 0;
      if (dimsKnown) {
        const alreadyNormalized = x <= 1 && y <= 1 && w <= 1 && h <= 1;
        if (!alreadyNormalized) {
          x /= size.width;
          w /= size.width;
          y /= size.height;
          h /= size.height;
        }
      }
      return {
        class: p.class,
        confidence: p.confidence,
        x: clamp01(x),
        y: clamp01(y),
        w: clamp01(Math.max(0, w)),
        h: clamp01(Math.max(0, h)),
      };
    });
}
async function callRoboflow(imageBuffer, { retries = 2, backoffMs = 2000 } = {}) {
  const key = process.env.ROBOFLOW_API_KEY;
  const model = (process.env.ROBOFLOW_MODEL_ID || '').trim();
  if (!model) throw new Error('ROBOFLOW_MODEL_ID is not set (see backend/.env)');
  // Host inference requires the fully-qualified model string:
  //   workspace/project/version  (e.g. ajith-m-jqkia/illegal-dumping-detection-a5otx/1)
  // ROBOFLOW_MODEL_ID may be given as just "project/version"; if a workspace is
  // set, prepend it so the URL resolves for project-owned models.
  const ws = (process.env.ROBOFLOW_WORKSPACE || '').trim();
  const qualified =
    model.split('/').filter(Boolean).length > 2 || !ws ? model : `${ws}/${model}`;

  const tryLegacy = async () => {
    const resp = await fetch(
      `https://detect.roboflow.com/${encodeURIComponent(qualified)}?api_key=${encodeURIComponent(key)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: imageBuffer,
      }
    );
    if (!resp.ok) {
      throw new Error(`Roboflow legacy endpoint ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
    }
    return resp.json();
  };

  const mode = (process.env.ROBOFLOW_ENDPOINT || 'serverless').toLowerCase();
  const runner =
    mode === 'legacy'
      ? tryLegacy
      : async () => {
          // Serverless cloud API: multipart upload with Bearer auth.
          const fd = new FormData();
          fd.append('file', new Blob([imageBuffer], { type: 'image/jpeg' }), 'frame.jpg');
          const resp = await fetch(`https://serverless.roboflow.com/${encodeURIComponent(qualified)}`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${key}` },
            body: fd,
          });
          if (!resp.ok) {
            throw new Error(`Roboflow serverless ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
          }
          return resp.json();
        };

  // ---- retry loop (mirrors services/roboflowWorkflow.callWorkflow) ----------
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      console.log(`[roboflow] model endpoint transient failure, retrying (${attempt}/${retries})...`);
      await new Promise((r) => setTimeout(r, backoffMs * attempt));
    }
    try {
      return await runner();
    } catch (err) {
      lastErr = err;
      // If serverless fails and fallback is enabled, try the legacy endpoint
      // once before giving up on this attempt.
      if (
        mode !== 'legacy' &&
        process.env.ROBOFLOW_ENDPOINT_FALLBACK !== 'off' &&
        !(typeof err.message === 'string' && err.message.includes('legacy'))
      ) {
        try {
          console.warn(`[roboflow] serverless failed (${err.message}); retrying via legacy detect endpoint.`);
          return await tryLegacy();
        } catch (fallbackErr) {
          lastErr = fallbackErr;
        }
      }
      continue;
    }
  }
  throw lastErr || new Error('Roboflow model request failed');
}
/* ----------------------------- MOCK DETECTOR ------------------------------ */

/** Small deterministic-ish PRNG so mock feeds look slightly organic. */
function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pointInBox(px, py, box) {
  return px >= box.x1 && px <= box.x2 && py >= box.y1 && py <= box.y2;
}

/** Random point uniformly distributed inside a normalized box. */
function sampleInBox(rand, box) {
  return {
    x: box.x1 + rand() * (box.x2 - box.x1),
    y: box.y1 + rand() * (box.y2 - box.y1),
  };
}

/** Build a fake waste detection centred at (x,y). */
function mockObject(x, y, rand) {
  return {
    class: 'Trash',
    confidence: Math.round((0.72 + rand() * 0.26) * 1000) / 1000,
    x: clamp01(x),
    y: clamp01(y),
    w: clamp01(0.04 + rand() * 0.07),
    h: clamp01(0.03 + rand() * 0.06),
  };
}

/**
 * Fabricate detections without calling Roboflow (demo mode).
 * `scenario` (optional) forces a demo outcome:
 *   random(default) | correct | full | illegal | near | none
 * The generated objects are placed relative to the actual zone box so the
 * real zone-check logic in classification.js produces the desired outcome.
 */
function mockDetect(zoneBox, scenario) {
  const rand = mulberry32(Date.now() & 0xffffffff);
  const want = (scenario || process.env.MOCK_SCENARIO || 'random').toLowerCase();

  const inZone = () => { const p = sampleInBox(rand, zoneBox); return mockObject(p.x, p.y, rand); };
  // Place an object deterministically INSIDE the exact near band used by
  // classification.js (zone expanded by 12%): pick a zone point, then step one
  // of its edges outward by 20-90% of that margin. This always yields a
  // genuine "near" placement (never "outside"), so scenarios stay reliable.
  const inBand = () => {
    const p = sampleInBox(rand, zoneBox);
    const dx = (zoneBox.x2 - zoneBox.x1) * 0.12;
    const dy = (zoneBox.y2 - zoneBox.y1) * 0.12;
    const edge = Math.floor(rand() * 4);
    const o = 0.2 + rand() * 0.7; // fraction of the margin, keeps us inside the band
    let x = p.x;
    let y = p.y;
    if (edge === 0) x = zoneBox.x2 + dx * o;      // right of the bin
    else if (edge === 1) x = zoneBox.x1 - dx * o; // left
    else if (edge === 2) y = zoneBox.y2 + dy * o; // below
    else y = zoneBox.y1 - dy * o;                 // above
    return mockObject(clamp01(x), clamp01(y), rand);
  };
  // Pick a far corner where the bin (typically central) cannot be.
  const far = () => {
    const corner = rand() < 0.5;
    const p = corner
      ? { x: 0.03 + rand() * 0.2, y: 0.05 + rand() * 0.2 }
      : { x: 0.72 + rand() * 0.25, y: 0.04 + rand() * 0.3 };
    return mockObject(p.x, p.y, rand);
  };

  const scenarios = {
    correct: () => [inZone()],
    full: () => [inZone(), inZone(), inZone(), inBand()],
    illegal: () => [far(), rand() > 0.5 ? far() : far()],
    near: () => [inBand()],
    none: () => [],
    random: () => {
      const roll = rand();
      if (roll < 0.3) return [inZone()];                          // correct disposal
      if (roll < 0.45) return [inZone(), inZone(), inBand()];     // bin full + near drop
      if (roll < 0.65) return [far(), far()];                     // active illegal dumping
      if (roll < 0.75) return [inBand()];                         // pile-up beside bin
      if (roll < 0.85) return [inZone(), inZone(), inZone(), far()]; // messy scene
      return [];                                                  // empty frame
    },
  };
  return (scenarios[want] || scenarios.random)();
}

/**
 * Call the Python Detector microservice (backend/python_detector).
 * It returns the canonical normalized detections directly, so no re-normalization.
 *
 * With the YOLOv8 backend, the payload also includes a `tracks` array
 * (ByteTrack + movement metadata). We return { detections, tracks } so the
 * caller can use the tracking data without breaking the list-shaped contract
 * used by the classification logic.
 */
async function detectViaPython(imageBuffer, frameSize, zoneBox) {
  const url = (process.env.PYTHON_DETECTOR_URL || 'http://127.0.0.1:8001/detect').trim();
  const fd = new FormData();
  fd.append('file', new Blob([imageBuffer], { type: 'image/jpeg' }), 'frame.jpg');
  fd.append('width', String((frameSize && frameSize.width) || 1280));
  fd.append('height', String((frameSize && frameSize.height) || 720));
  if (zoneBox) {
    fd.append('zone_box_json', JSON.stringify(zoneBox));
  }

  let lastErr;
  for (let attempt = 0; attempt <= 2; attempt++) {
    if (attempt > 0) {
      console.log(`[roboflow] python detector retrying (${attempt}/2)...`);
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
    try {
      const resp = await fetch(url, { method: 'POST', body: fd });
      if (!resp.ok) {
        lastErr = new Error(`Python detector HTTP ${resp.status}`);
        continue;
      }
      const json = await resp.json();
      if (json.error) {
        lastErr = new Error(`Python detector error: ${json.error}`);
        continue;
      }
      const detections = Array.isArray(json.detections) ? json.detections : [];
      const tracks = Array.isArray(json.tracks) ? json.tracks : [];
      const temporalState = json.temporal_state || 'IDLE';
      const candidates = Array.isArray(json.candidates) ? json.candidates : [];
      const confirmedIncidents = Array.isArray(json.confirmed_incidents) ? json.confirmed_incidents : [];
      return { detections, tracks, temporalState, candidates, confirmedIncidents };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('Python detector request failed');
}

/**
 * Run object detection on an image buffer.
 *
 * @param {Buffer}   imageBuffer  JPEG/PNG bytes
 * @param {Object}   frameSize    { width, height } of the source frame (for normalization)
 * @param {Object}   zoneBox      normalized zone box (mock generator placement)
 * @param {string?}  scenario     optional mock scenario override (mock mode only)
 */
async function detect(imageBuffer, frameSize, zoneBox, scenario) {
  const mode = detectionMode();
  if (mode === 'python') {
    console.log('[roboflow] PYTHON mode: detection via Python microservice (backend/python_detector).');
    const result = await detectViaPython(imageBuffer, frameSize, zoneBox);
    // Python service returns { detections, tracks, temporalState, candidates, confirmedIncidents }
    if (Array.isArray(result)) return result;
    if (result && Array.isArray(result.detections)) {
      // Attach metadata as non-enumerable properties so array-shaped contract stays identical
      const dets = result.detections;
      Object.defineProperty(dets, 'tracks', {
        value: Array.isArray(result.tracks) ? result.tracks : [],
        enumerable: false,
        configurable: true,
      });
      Object.defineProperty(dets, 'temporalState', {
        value: result.temporalState || 'IDLE',
        enumerable: false,
        configurable: true,
      });
      Object.defineProperty(dets, 'candidates', {
        value: Array.isArray(result.candidates) ? result.candidates : [],
        enumerable: false,
        configurable: true,
      });
      Object.defineProperty(dets, 'confirmedIncidents', {
        value: Array.isArray(result.confirmedIncidents) ? result.confirmedIncidents : [],
        enumerable: false,
        configurable: true,
      });
      return dets;
    }
    return [];
  }
  if (mode === 'workflow') {
    console.log('[roboflow] WORKFLOW mode: SAM 3 zero-shot segmentation (serverless workflows API).');
    return workflow.detect(imageBuffer, frameSize);
  }
  if (mockEnabled()) {
    console.log('[roboflow] MOCK mode: fabricated detections (set ROBOFLOW_MODE=workflow/model for real inference).');
    return mockDetect(zoneBox, scenario);
  }
  const payload = await callRoboflow(imageBuffer);
  return normalizePredictions(payload, frameSize);
}

module.exports = { detect, normalizePredictions, mockEnabled, detectionMode };