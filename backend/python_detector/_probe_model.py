import glob
import os
import sys

sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import cv2
import yolo_backend

det = yolo_backend.get_detector()
print("model loaded OK, is_world =", det._is_world)
print("model path =", getattr(det, "_model_path", "?"))

# Test the in-repo dataset images (should contain waste/person)
for folder in ["waste_dataset", os.path.join("..", "training_dataset")]:
    base = os.path.join(os.path.dirname(os.path.abspath(__file__)), folder)
    if not os.path.isdir(base):
        print(f"[skip] {folder} not a dir")
        continue
    imgs = sorted(glob.glob(os.path.join(base, "**", "*.jpg"), recursive=True))
    if not imgs:
        imgs = sorted(glob.glob(os.path.join(base, "*.jpg")))
    print(f"\n=== {folder}: {len(imgs)} images ===")
    for fn in imgs[:8]:
        img = cv2.imread(fn)
        if img is None:
            continue
        ok, buf = cv2.imencode(".jpg", img)
        if not ok:
            continue
        dets, _ = det.detect(buf.tobytes())
        # Also probe with a low threshold through the actual underlying model
        low_dets = []
        try:
            model = det._model
            r = model.predict(img, conf=0.05, verbose=False)
            for b in r[0].boxes:
                low_dets.append((r[0].names[int(b.cls[0])], round(float(b.conf[0]), 3)))
        except Exception as e:
            low_dets = [("ERR", str(e)[:80])]
        names = {}
        for d in dets:
            names[d["class"]] = names.get(d["class"], 0) + 1
        print(f"{os.path.basename(fn)}: dets={len(dets)} {names} | lowconf={low_dets}")

print("\nDONE")
