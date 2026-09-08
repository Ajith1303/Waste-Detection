/**
 * ============================================================================
 * CORE CUSTOM LOGIC - Dustbin zone check & waste-disposal classification
 * ============================================================================
 *
 * This is the heart of the project. Roboflow (or the mock detector) tells us
 * WHERE objects are - the DECISION of whether that position is a violation is
 * made here with plain geometry against the manually configured dustbin zone.
 * No AI is involved in the decisioning, which keeps it deterministic,
 * explainable and dependency-free.
 *
 * ----------------------------------------------------------------------------
 * COORDINATE CONVENTION
 * ----------------------------------------------------------------------------
 * Every coordinate in this module is NORMALIZED 0..1 relative to the camera
 * frame (x: left -> right, y: top -> bottom, 0 = top-left corner).
 *
 * Why normalized? A camera_id may stream from a phone browser at 1280x720
 * today and from a 4K RTSP CCTV tomorrow. By storing zone boxes and
 * detections in 0..1 space, we never have to change geometry code when the
 * input resolution changes - see services/roboflow.js which normalizes raw
 * predictions on the way in.
 *
 * A zone box looks like:
 *   zoneBox = { x1, y1, x2, y2 }   // normalized bounding box of the dustbin
 *
 * ----------------------------------------------------------------------------
 * PER-OBJECT PLACEMENT (a "near" band surrounds the zone)
 * ----------------------------------------------------------------------------
 *   zoneBox expanded outward by NEAR_MARGIN (fraction of box width/height)
 *   gives a padded box. For every detected waste object we compute its CENTER
 *   point and classify it as:
 *
 *     1. center inside zoneBox      -> "inside"  (dropped into the bin)
 *     2. center inside padded box   -> "near"    (dropped beside the bin)
 *     3. anything else              -> "outside" (clearly away from the bin)
 *
 * ----------------------------------------------------------------------------
 * FRAME-LEVEL DECISION (aggregate of all detections in the frame)
 * ----------------------------------------------------------------------------
 *   A) ANY object "outside"                    -> 'illegal'
 *        Someone dropped waste clearly outside the bin.
 *        ALERT: nearby residents + admin/corporation.
 *
 *   B) a "near" drop happens AND the bin looks full -> 'full'
 *        "Bin looks full" is ESTIMATED (never trusted from a single box) via:
 *          fillEstimate = area of in-zone detection boxes overlapping the zone
 *                         / total zone area   (see estimateFillLevel)
 *        full  <=>  fillEstimate >= FULL_FILL_THRESHOLD
 *                OR in-zone object count >= FULL_MIN_INSIDE_OBJECTS
 *        We only raise 'full' when a NEW object is arriving NEAR the bin;
 *        otherwise a simply-full bin would page the admin on every frame.
 *        ALERT: admin/corporation ONLY.
 *
 *   C) in-zone objects, no near drop, not overflowing -> 'correct'
 *        Waste went into the bin. No alert. (logged)
 *
 *   D) only near objects, bin not full -> 'near' (informational only)
 *        Someone is piling waste beside the bin. Logged, NO alert yet.
 *
 *   E) no detections at all -> 'no_waste' (not persisted as an event)
 *
 * ----------------------------------------------------------------------------
 * WHY THE OUTCOMES MATCH THE SPEC:
 *   Inside                -> 'correct'  : no alert
 *   Near + bin appears full -> 'full'   : alert to admin only
 *   Outside                -> 'illegal' : alert to residents AND admin
 * ============================================================================
 */
const CONFIG = {
  // The "near" band = the zone box expanded by 12% of its own width/height.
  NEAR_MARGIN: 0.12,

  // A near-drop while the zone fill is >= 50% -> treat the bin as full.
  FULL_FILL_THRESHOLD: 0.5,

  // A near-drop while >= 2 objects are already inside -> treat the bin as full.
  FULL_MIN_INSIDE_OBJECTS: 2,

  // Bin visibly overflowing even without a fresh near drop -> page admin.
  OVERFLOW_FILL_THRESHOLD: 0.85,
};

function clamp01(v) {
  return Math.min(1, Math.max(0, v));
}

/** Point-in-rectangle test (normalized coords). */
function pointInBox(px, py, box) {
  return px >= box.x1 && px <= box.x2 && py >= box.y1 && py <= box.y2;
}

function boxArea(box) {
  return Math.max(0, box.x2 - box.x1) * Math.max(0, box.y2 - box.y1);
}

/** Expand a box by `margin` (fraction of the box's own width/height). */
function expandBox(box, margin) {
  const w = box.x2 - box.x1;
  const h = box.y2 - box.y1;
  const dx = w * margin;
  const dy = h * margin;
  return {
    x1: clamp01(box.x1 - dx),
    y1: clamp01(box.y1 - dy),
    x2: clamp01(box.x2 + dx),
    y2: clamp01(box.y2 + dy),
  };
}

/**
 * HEURISTIC fill-level estimate (the "dustbin appears full" check).
 *
 * We do NOT try to count garbage bags (unreliable per frame). Instead we
 * measure how much of the zone area is COVERED by the detection boxes that
 * sit inside it, expressed as a 0..1 "fill ratio". Multiple overlapping
 * objects are handled via per-box clamped overlaps, so stacked/bulky waste
 * pushes the meter up (double counting is deliberate = fail-safe).
 */
function estimateFillLevel(inZoneDetections, zoneBox) {
  const zoneArea = boxArea(zoneBox);
  if (zoneArea <= 0) return 0;
  let covered = 0;
  for (const d of inZoneDetections) {
    const left = Math.max(d.x - d.w / 2, zoneBox.x1);
    const right = Math.min(d.x + d.w / 2, zoneBox.x2);
    const top = Math.max(d.y - d.h / 2, zoneBox.y1);
    const bottom = Math.min(d.y + d.h / 2, zoneBox.y2);
    const iw = Math.max(0, right - left);
    const ih = Math.max(0, bottom - top);
    covered += iw * ih; // overlapping boxes double-count -> conservative = fail-safe
  }
  return clamp01(covered / zoneArea);
}
const NON_WASTE_CLASSES = new Set([
  'person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck',
  'boat', 'traffic light', 'fire hydrant', 'stop sign', 'parking meter', 'bench',
  'bird', 'cat', 'dog', 'horse', 'sheep', 'cow', 'chair', 'couch', 'potted plant',
  'bed', 'dining table', 'toilet', 'tv', 'laptop', 'mouse', 'remote', 'keyboard',
  'cell phone', 'microwave', 'oven', 'toaster', 'sink', 'refrigerator', 'clock',
]);

/** Determine if a detection represents a waste/trash object. */
function isWasteDetection(d) {
  if (d.is_waste === true) return true;
  if (d.is_person === true) return false;
  const cls = String(d.class || '').toLowerCase().trim();
  if (cls === 'person') return false;
  if (NON_WASTE_CLASSES.has(cls)) return false;
  return true;
}

/**
 * Classify one analysed frame.
 *
 * @param {Array}  detections normalized detections: { x, y, w, h, confidence, class }
 *                 (x,y = box CENTER). Each object gets a `placement` field added.
 * @param {Object} zoneBox     normalized { x1, y1, x2, y2 } dustbin zone for this camera.
 * @param {Object} options     optional { temporalState, confirmedIncidents, classificationOverride, reasonOverride }
 * @returns {{ type: 'correct'|'full'|'illegal'|'near'|'no_waste', reason,
 *             fillEstimate, objectCount, placements, temporalState }}
 */
function classifyFrame(detections, zoneBox, options = {}) {
  // Direct classification override (e.g. from standalone CCTV pipeline)
  if (options.classificationOverride) {
    return {
      type: options.classificationOverride,
      reason: options.reasonOverride || 'Classification determined by temporal event detection.',
      fillEstimate: 0,
      objectCount: (detections || []).length,
      placements: { inside: 0, near: 0, outside: (detections || []).length },
      temporalState: options.temporalState || 'DUMPING_CONFIRMED',
    };
  }

  // Temporal dumping incident confirmed across multi-frame state machine
  if (options.confirmedIncidents && options.confirmedIncidents.length > 0) {
    const inc = options.confirmedIncidents[0];
    return {
      type: 'illegal',
      reason: inc.reason || `Temporal dumping confirmed: Person #${inc.person_id} dropped waste #${inc.waste_id}.`,
      fillEstimate: 0,
      objectCount: (detections || []).length,
      placements: { inside: 0, near: 0, outside: 1 },
      temporalState: 'DUMPING_CONFIRMED',
      incident: inc,
    };
  }

  const padded = expandBox(zoneBox, CONFIG.NEAR_MARGIN);
  const inside = [];
  const near = [];
  const outside = [];
  const wasteDetections = [];

  // ---- per-object placement & class filtering -----------------------------
  for (const det of (detections || [])) {
    const px = det.x; // box center
    const py = det.y;
    let placement = 'outside';
    if (pointInBox(px, py, zoneBox)) placement = 'inside';
    else if (pointInBox(px, py, padded)) placement = 'near';
    det.placement = placement; // surfaced to the frontend overlay for color coding

    // Only actual waste items count towards waste-disposal logic
    if (isWasteDetection(det)) {
      wasteDetections.push(det);
      (placement === 'inside' ? inside : placement === 'near' ? near : outside).push(det);
    }
  }

  const objectCount = wasteDetections.length;
  const fillEstimate = estimateFillLevel(inside, zoneBox);
  const finish = (res) => {
    res.fillEstimate = fillEstimate;
    res.objectCount = objectCount;
    res.placements = { inside: inside.length, near: near.length, outside: outside.length };
    res.temporalState = options.temporalState || 'IDLE';
    return res;
  };

  if (objectCount === 0) {
    return finish({ type: 'no_waste', reason: 'No waste objects detected in this frame.' });
  }


  // ---- rule A: any object clearly outside the bin = illegal dumping --------
  if (outside.length > 0) {
    return finish({
      type: 'illegal',
      reason: `${outside.length} waste object(s) detected OUTSIDE the dustbin zone (illegal dumping).`,
    });
  }

  const nearDropHappening = near.length > 0;
  const binLooksFull =
    fillEstimate >= CONFIG.FULL_FILL_THRESHOLD ||
    inside.length >= CONFIG.FULL_MIN_INSIDE_OBJECTS;
  const overflowing = fillEstimate >= CONFIG.OVERFLOW_FILL_THRESHOLD;

  // ---- rule B: fresh near-drop while the bin looks full = 'full' -----------
  if (nearDropHappening && binLooksFull) {
    return finish({
      type: 'full',
      reason: `Waste placed NEAR the bin while it appears full (fill ~${Math.round(fillEstimate * 100)}%, ${inside.length} object(s) inside). Alert admin to empty the bin.`,
    });
  }

  // Bin is visibly overflowing even without a fresh near-drop (e.g. it has
  // been full for a while) - notify admin. Cooldown in routes/frames.js
  // prevents alert spam.
  if (overflowing) {
    return finish({
      type: 'full',
      reason: `Bin appears full/overflowing (fill ~${Math.round(fillEstimate * 100)}%, ${inside.length} object(s) inside).`,
    });
  }

  // ---- rule C: objects inside the bin, no near-drop = correct --------------
  if (inside.length > 0) {
    return finish({
      type: 'correct',
      reason: `${inside.length} waste object(s) disposed correctly inside the dustbin zone.`,
    });
  }

  // ---- rule D: only near objects, bin not full = informational ------------
  return finish({
    type: 'near',
    reason: `Waste detected NEAR the bin (${near.length} object(s)) but the bin is not full yet - logged, no alert.`,
  });
}

module.exports = { classifyFrame, estimateFillLevel, pointInBox, expandBox, CONFIG };