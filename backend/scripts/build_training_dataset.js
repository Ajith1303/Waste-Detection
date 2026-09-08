/**
 * Build a de-duplicated starter training dataset from captured frames in uploads/.
 *
 * The system captures a frame every 1-2s, so consecutive frames are near-identical
 * (same scene). Feeding all of them to Roboflow just inflates the dataset without
 * adding variety. This copies ONE representative frame per near-duplicate group
 * (via a content hash) into ./training_dataset, ready to zip + upload.
 *
 * Usage:  node scripts/build_training_dataset.js [sourceDir] [outDir]
 *
 * Output: flat folder of chosen frames (filename only).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const srcDir = process.argv[2] || 'uploads';
const outDir = process.argv[3] || 'training_dataset';

/** Content hash: sample evenly across the whole file + record length. Near-duplicate
 *  camera frames (same scene) collapse to one entry; genuinely different scenes don't. */
function contentHash(buf) {
  const h = crypto.createHash('sha256');
  const step = Math.max(1, Math.floor(buf.length / 1024));
  for (let i = 0; i < buf.length; i += step) h.update(buf.subarray(i, i + 2));
  h.update(String(buf.length));
  return h.digest('hex');
}

if (!fs.existsSync(srcDir)) {
  console.error(`Source dir not found: ${srcDir}`);
  process.exit(1);
}

const files = fs.readdirSync(srcDir).filter((f) => /\.(jpe?g|png)$/i.test(f));
console.log(`Source: ${srcDir}  (${files.length} image files)`);

const seen = new Map(); // hash -> first filename
const chosen = [];
for (const f of files) {
  const buf = fs.readFileSync(path.join(srcDir, f));
  const h = contentHash(buf);
  if (!seen.has(h)) {
    seen.set(h, f);
    chosen.push(f);
  }
}

console.log(`After de-duplication: ${chosen.length} representative frames (${files.length - chosen.length} near-dupes skipped)`);

fs.mkdirSync(outDir, { recursive: true });
for (const e of fs.readdirSync(outDir)) {
  if (/\.(jpe?g|png)$/i.test(e)) fs.unlinkSync(path.join(outDir, e));
}
let bytes = 0;
for (const f of chosen) {
  fs.copyFileSync(path.join(srcDir, f), path.join(outDir, f));
  bytes += fs.statSync(path.join(outDir, f)).size;
}
console.log(`Wrote ${chosen.length} frames to ${outDir} (${(bytes / 1048576).toFixed(1)} MB)`);
console.log('\nNext: zip this folder and drag it into Roboflow -> Add images.');
