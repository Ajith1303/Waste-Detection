"""End-to-end smoke: POST a frame to the Node /api/frames like the camera page does."""
import base64
import glob
import json
import os
import sys
import urllib.request

sys.stdout.reconfigure(encoding="utf-8")

BASE = os.path.dirname(os.path.abspath(__file__))
imgs = sorted(glob.glob(os.path.join(BASE, "..", "training_dataset", "*.jpg")))
if not imgs:
    print("no training frames")
    sys.exit(1)

# pick a frame that contains a person (waste dumping demo)
fn = next((f for f in imgs if "2258554" in f), imgs[0])
with open(fn, "rb") as fh:
    b64 = base64.b64encode(fh.read()).decode("ascii")

payload = {
    "cameraId": "cam-main-gate",
    "imageBase64": f"data:image/jpeg;base64,{b64}",
    "width": 1280,
    "height": 720,
    "gps": {"lat": 12.9716, "lng": 77.5946},
    "sessionId": "smoke-e2e",
}

data = json.dumps(payload).encode("utf-8")
req = urllib.request.Request(
    "http://localhost:5000/api/frames", data=data,
    headers={"Content-Type": "application/json"},
)
with urllib.request.urlopen(req, timeout=60) as r:
    out = json.loads(r.read().decode("utf-8"))

print("status class:", out.get("classification", {}).get("type"))
print("reason     :", out.get("classification", {}).get("reason"))
print("detections :", len(out.get("detections") or []))
for d in (out.get("detections") or [])[:6]:
    print("   -", d.get("class"), d.get("confidence"), "waste=", d.get("is_waste"))
print("temporal   :", out.get("temporalState"))
print("eventId    :", out.get("eventId"))
print("snapshotUrl:", out.get("snapshotUrl"))