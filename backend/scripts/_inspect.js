/* Inspect several recent uploads + two class-list variants. */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');

const LIST_A = ['person', 'car', 'garbage', 'trash', 'waste', 'dog', 'cat'];
const LIST_B = (process.env.ROBOFLOW_WORKFLOW_CLASSES || '').split(',').map((s) => s.trim()).filter(Boolean);

const files = fs.readdirSync(path.join(__dirname, '..', 'uploads'))
  .filter((n) => /\.(jpg|jpeg|png)$/i.test(n))
  .map((n) => ({ n, t: fs.statSync(path.join(__dirname, '..', 'uploads', n)).mtimeMs }))
  .sort((a, b) => b.t - a.t)
  .slice(0, 5);

const bodyFor = (b64, classes) => ({
  inputs: { image: { type: 'base64', value: b64 }, classes },
});
const call = async (url, body) => {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.ROBOFLOW_API_KEY}` },
    body: JSON.stringify(body),
  });
  const json = await resp.json();
  const o = json.outputs && json.outputs[0];
  if (!o) { console.log('   [NO outputs] top keys=', Object.keys(json)); return []; }
  const p = o.predictions;
  console.log('   [predictions type=', Array.isArray(p) ? 'array' : typeof p, ']');
  if (!Array.isArray(p)) console.log('   [predictions keys]=', p && typeof p === 'object' ? Object.keys(p) : String(p));
  return p;
};

(async () => {
  const url = 'https://serverless.roboflow.com/infer/workflows/ajith-m-jqkia/general-segmentation-api-6';
  console.log('ENV classes B:', JSON.stringify(LIST_B));
  for (const f of files) {
    const b64 = fs.readFileSync(path.join(__dirname, '..', 'uploads', f.n)).toString('base64');
    console.log(`\n==== ${f.n}`);
    const rA = await call(url, bodyFor(b64, LIST_A));
    const arrA = Array.isArray(rA) ? rA : [];
    console.log(`   A(${LIST_A.length} cls): ${arrA.length} preds ->`, arrA.slice(0, 4).map((p) => `${p.class}/${Number(p.confidence).toFixed(2)}`).join(', '));
    const rB = await call(url, bodyFor(b64, LIST_B));
    const arrB = Array.isArray(rB) ? rB : [];
    console.log(`   B(${LIST_B.length} cls): ${arrB.length} preds ->`, arrB.slice(0, 4).map((p) => `${p.class}/${Number(p.confidence).toFixed(2)}`).join(', '));
  }
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
