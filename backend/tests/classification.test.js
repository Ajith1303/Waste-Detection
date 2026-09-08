/**
 * Unit tests for the CORE custom zone-check / classification logic.
 * Run with: npm test  (backend/)
 */
const assert = require('assert');
const { classifyFrame } = require('../services/classification');

// Shared fixture: a normalized dustbin zone roughly in the centre of a frame.
const ZONE = { x1: 0.4, y1: 0.3, x2: 0.6, y2: 0.5 };

const obj = (x, y, w = 0.08, h = 0.08) => ({ class: 'Trash', confidence: 0.9, x, y, w, h });
const rIn = () => obj(0.45 + Math.random() * 0.1, 0.35 + Math.random() * 0.1);

// ---- Rule A: anything outside the bin = illegal dumping ---------------------
{
  const res = classifyFrame([obj(0.05, 0.05), rIn()], ZONE);
  assert.strictEqual(res.type, 'illegal', 'a far object must be classified illegal');
  assert.strictEqual(res.placements.outside >= 1, true);
}

// ---- Rule B: near-drop + bin looks full = full (admin only) ----------------
{
  // 3 objects crammed into the zone (fill high) + 1 just outside the box edge
  // but INSIDE the 12% near band (zone x2=0.6 -> padded edge is 0.624).
  const res = classifyFrame(
    [obj(0.44, 0.34), obj(0.55, 0.45), obj(0.48, 0.32), obj(0.61, 0.4)],
    ZONE
  );
  assert.strictEqual(res.type, 'full', 'near drop onto an almost-full bin must be "full"');
  assert.ok(res.fillEstimate > 0.3, 'fill estimate should be non-trivial');
}

// ---- Rule B2: bin overflowing even without a fresh near drop ----------------
{
  const res = classifyFrame(
    [obj(0.42, 0.31, 0.35, 0.4), obj(0.58, 0.48, 0.32, 0.35)],
    ZONE
  );
  assert.strictEqual(res.type, 'full', 'very high zone coverage without near drop = "full"');
}

// ---- Rule C: objects inside zone only = correct -----------------------------
{
  const res = classifyFrame([rIn()], ZONE);
  assert.strictEqual(res.type, 'correct', 'single in-zone object must be "correct"');
}

// ---- Rule D: near only, bin not full = informational "near" -----------------
{
  const res = classifyFrame([obj(0.615, 0.42)], ZONE); // in the 12% near band, bin empty
  assert.strictEqual(res.type, 'near', 'near-only with low fill must be "near", no alert');
}

// ---- Rule E: no detections = no_waste ---------------------------------------
{
  const res = classifyFrame([], ZONE);
  assert.strictEqual(res.type, 'no_waste');
}

// ---- placements are attached to objects for the UI overlay ------------------
{
  const res = classifyFrame([obj(0.05, 0.05)], ZONE);
  assert.strictEqual(res.placements.outside, 1);
}

// ---- Rule F: a person outside the bin is NOT a waste object (no false illegal alert) --
{
  const res = classifyFrame([
    { class: 'person', confidence: 0.95, x: 0.05, y: 0.05, w: 0.1, h: 0.3, is_person: true }
  ], ZONE);
  assert.strictEqual(res.type, 'no_waste', 'a person walking outside the bin must not trigger illegal dumping');
}

// ---- Rule G: temporal dumping incident confirmed across frames -> illegal ----
{
  const res = classifyFrame([], ZONE, {
    confirmedIncidents: [{
      incident_id: 'INC-TEST-001',
      person_id: 1,
      waste_id: 2,
      reason: 'Temporal dumping confirmed: Person #1 dropped waste #2 and moved away.',
    }],
  });
  assert.strictEqual(res.type, 'illegal', 'confirmed temporal incident must classify as illegal');
  assert.strictEqual(res.temporalState, 'DUMPING_CONFIRMED');
}

console.log('All classification tests passed ✔  (illegal / full x2 / correct / near / no_waste / person_filter / temporal)');
process.exit(0);