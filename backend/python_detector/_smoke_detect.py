"""Smoke test: POST a real frame to the running detector service and print result."""
import glob
import os
import sys
import urllib.request
import urllib.parse
import uuid

sys.stdout.reconfigure(encoding="utf-8")

BASE = os.path.dirname(os.path.abspath(__file__))
imgs = sorted(glob.glob(os.path.join(BASE, "..", "training_dataset", "*.jpg")))
if not imgs:
    print("no training images found")
    sys.exit(1)

url = "http://127.0.0.1:8001/detect"

def post_detect(fn):
    with open(fn, "rb") as f:
        data = f.read()
    boundary = uuid.uuid4().hex
    parts = []
    # file field
    parts.append(
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{os.path.basename(fn)}"\r\n'
        f"Content-Type: image/jpeg\r\n\r\n".encode()
        + data
        + b"\r\n"
    )
    for name, val in (("width", "1280"), ("height", "720")):
        parts.append(
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="{name}"\r\n\r\n'
            f"{val}\r\n".encode()
        )
    parts.append(f"--{boundary}--\r\n".encode())
    body = b"".join(parts)
    req = urllib.request.Request(
        url, data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    with urllib.request.urlopen(req, timeout=45) as r:
        return r.status, r.read().decode("utf-8", "replace")

# try a few frames
for fn in imgs[:3]:
    s, text = post_detect(fn)
    print(f"=== {os.path.basename(fn)} ({s}) ===")
    print(text[:900])
    print()
