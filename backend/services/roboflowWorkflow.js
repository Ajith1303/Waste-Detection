/**
 * Roboflow WORKFLOWS transport for the SAM 3 zero-shot segmentation workflow.
 *
 * Unlike a hosted *model* endpoint (ROBOFLOW_ENDPOINT in services/roboflow.js),
 * a Roboflow *workflow* is called through the Workflows HTTP API:
 *
 *   POST https://serverless.roboflow.com/infer/workflows/{workspace}/{workflow_id}
 *   Authorization: Bearer <API key>
 *   Body (JSON): { inputs: { image: { type: "base64", value: "<b64>" },
 *                            classes: ["person", "garbage", ... ] } }
 *
 * Why SAM 3 here:
 *   - It is ZERO-SHOT, so it works out of the box without any trained dataset.
 *     The user's Roboflow workspace (ajith-m-jqkia) only has an untrained
 *     project, so a plain model endpoint returns 404. A SAM workflow needs no
 *     training and can be wired immediately.
 *   - The `general-segmentation-api-6` workflow returns, per prediction, a
 *     box { x, y, width, height } in ABSOLUTE PIXELS (x,y = box CENTER, the
 *     same convention the rest of this backend already uses) plus an
 *     `rle_mask` (run-length-encoded polygon). The box is what flows into the
 *     normalizer and then into classification.js zone geometry unchanged.
 *
 * Note on accuracy: SAM garbage/object detection is a demo/medium-accuracy
 * capability, not production-grade. It only needs to find *something* in the
 * frame so the deterministic zone-check in classification.js can make the
 * legal/illegal decision.
 */

const clamp01 = (v) => Math.min(1, Math.max(0, v));

/** Read workflow params from env with sensible defaults. */
function workflowConfig() {
  const workspace = (process.env.ROBOFLOW_WORKSPACE || '').trim();
  const workflowId = (process.env.ROBOFLOW_WORKFLOW_ID || '').trim();
  const classes = (process.env.ROBOFLOW_WORKFLOW_CLASSES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const confidence = Number(process.env.ROBOFLOW_WORKFLOW_CONFIDENCE ?? process.env.ROBOFLOW_CONFIDENCE ?? 0.3);
  return {
    workspace,
    workflowId,
    classes,
    confidence: Number.isFinite(confidence) ? confidence : 0.3,
  };
}

/**
 * Call the SAM 3 workflow and return the raw Roboflow prediction array
 * (entries of { x, y, width, height, confidence, class, rle_mask, ... }).
 *
 * Includes retry logic for transient failures (HTML error pages, 5xx, network errors)
 * which the SAM serverless endpoint produces intermittently.
 */
async function callWorkflow(imageBuffer, { retries = 2, backoffMs = 2000 } = {}) {
  const key = (process.env.ROBOFLOW_API_KEY || '').trim();
  const { workspace, workflowId, classes } = workflowConfig();
  if (!key) throw new Error('ROBOFLOW_API_KEY is not set (needed for workflow mode)');
  if (!workspace) throw new Error('ROBOFLOW_WORKSPACE is not set (see backend/.env)');
  if (!workflowId) throw new Error('ROBOFLOW_WORKFLOW_ID is not set (see backend/.env)');
  if (classes.length === 0) {
    throw new Error('ROBOFLOW_WORKFLOW_CLASSES is empty - list the SAM classes to detect (e.g. person,garbage,car)');
  }

  const base64 = imageBuffer.toString('base64');
  const url = `https://serverless.roboflow.com/infer/workflows/${encodeURIComponent(workspace)}/${encodeURIComponent(workflowId)}`;

  const body = {
    inputs: {
      image: { type: 'base64', value: base64 },
      classes,
    },
  };

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      console.log(`[roboflow] workflow transient failure, retrying (${attempt}/${retries})...`);
      await new Promise((r) => setTimeout(r, backoffMs * attempt));
    }
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify(body),
      });

      const text = await resp.text();
      if (!resp.ok) {
        lastErr = new Error(`Roboflow workflow ${resp.status}: ${text.slice(0, 300)}`);
        continue; // 4xx/5xx -> retry
      }

      let json;
      try {
        json = JSON.parse(text);
      } catch (err) {
        // SAM intermittently returns an HTML error page for a valid JSON request.
        lastErr = new Error(`Roboflow workflow returned non-JSON: ${text.slice(0, 200)}`);
        continue;
      }

      // Workflow responses come back as { outputs: [ { annotated_image, predictions } ] }.
      // `predictions` may be EITHER a plain array OR an object wrapping
      // { image: {...}, predictions: [...] } (SAM sometimes wraps it).
      const outputs = json && Array.isArray(json.outputs) ? json.outputs : [];
      const payload = outputs[0] || {};
      let preds = payload.predictions;
      if (preds && !Array.isArray(preds) && Array.isArray(preds.predictions)) {
        preds = preds.predictions;
      }
      return Array.isArray(preds) ? preds : [];
    } catch (err) {
      // Network-level failure (fetch failed, DNS, timeout).
      lastErr = err;
      continue;
    }
  }
  throw lastErr || new Error('Roboflow workflow request failed');
}

/**
 * Translate raw SAM workflow predictions into the canonical NORMALIZED (0..1)
 * detection format used by classification.js: { class, confidence, x, y, w, h }
 * where (x,y) is the box CENTER. SAM returns pixel coords relative to the full
 * frame, so we divide by the frame size. Optional confidence threshold.
 */
function normalizeWorkflowPredictions(predictions, frameSize, threshold) {
  const size = {
    width: (frameSize && frameSize.width) || 0,
    height: (frameSize && frameSize.height) || 0,
  };
  const dimsKnown = size.width > 1 && size.height > 1;
  const minConf = threshold != null ? threshold : workflowConfig().confidence;

  return (predictions || [])
    .filter((p) => typeof p.x === 'number' && typeof p.y === 'number' && p.confidence >= minConf)
    .map((p) => {
      let x = p.x;
      let y = p.y;
      let w = p.width || 0;
      let h = p.height || 0;
      if (dimsKnown) {
        // SAM already returns pixel coords; guard anyway in case a workflow
        // is later swapped in that returns normalized values.
        const alreadyNormalized = x <= 1 && y <= 1 && w <= 1 && h <= 1;
        if (!alreadyNormalized) {
          x /= size.width;
          w /= size.width;
          y /= size.height;
          h /= size.height;
        }
      }
      return {
        class: p.class || 'object',
        confidence: p.confidence,
        x: clamp01(x),
        y: clamp01(y),
        w: clamp01(Math.max(0, w)),
        h: clamp01(Math.max(0, h)),
      };
    });
}

/**
 * Convenience wrapper: call the workflow and normalize in one step.
 * Returns the canonical normalized detections array.
 */
async function detect(imageBuffer, frameSize) {
  const predictions = await callWorkflow(imageBuffer);
  return normalizeWorkflowPredictions(predictions, frameSize);
}

module.exports = {
  callWorkflow,
  normalizeWorkflowPredictions,
  detect,
  workflowConfig,
};
