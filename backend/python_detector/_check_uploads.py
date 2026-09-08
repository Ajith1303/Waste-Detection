import glob
import os
import sys

sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import yolo_backend

det = yolo_backend.get_detector()
print("model loaded OK, is_world =", det._is_world)

uploads = glob.glob(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "uploads", "*.jpg"))
for fn in sorted(uploads):
    with open(fn, "rb") as fh:
        dets, img_np = det.detect(fh.read())
    names = {}
    for d in dets:
        names[d["class"]] = names.get(d["class"], 0) + 1
    print(f"{os.path.basename(fn)}: dets={len(dets)} {names}")
print("DONE")