import os
import sys

sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import cv2
import yolo_backend

cap = cv2.VideoCapture(os.path.join(os.path.dirname(os.path.abspath(__file__)), "dummy.mp4"))
det = yolo_backend.get_detector()
print("model loaded OK, is_world =", det._is_world)

for fr in range(6):
    ok, img = cap.read()
    if not ok:
        break
    ok2, buf = cv2.imencode(".jpg", img)
    if not ok2:
        continue
    dets, img_np = det.detect(buf.tobytes())
    tracks = det.track(dets)
    temporal = det.update_temporal(tracks, frame_img=img_np)
    print(f"frame {fr}: dets={len(dets)} tracks={len(tracks)} state={temporal.get('state')}")
    for t in tracks[:3]:
        m = t.get("movement", {})
        print(f'   track #{t["track_id"]} {t["class"]} conf={t["confidence"]} x={t["x"]} dir={m.get("direction")}')

cap.release()
print("DONE")