"""Multi-frame tracking test against the LIVE Python detector service.
Sends a 6-frame sequence (bus moving via shifted crops) and prints how
ByteTrack assigns track_ids and how movement metadata evolves.
Run:  python multi_frame_test.py   (service must be running on :8001)
"""
import json
import time
import requests

URL = "http://127.0.0.1:8001/detect"
SEQUENCE = ["f1.jpg", "f2.jpg", "f3.jpg", "f1.jpg", "f2.jpg", "f3.jpg"]


def main():
    print("=== Live multi-frame ByteTrack test ===")
    print("Sending 6 frames of a moving bus...\n")
    last = None
    for i, fn in enumerate(SEQUENCE, 1):
        with open(fn, "rb") as fh:
            files = {"file": (fn, fh, "image/jpeg")}
            r = requests.post(URL, files=files, data={"width": "810", "height": "1080"}, timeout=120)
        d = r.json()
        last = d
        line = f"frame {i} ({fn:>8}): dets={len(d['detections'])} tracks={len(d['tracks'])}"
        for t in d.get("tracks", []):
            m = t.get("movement", {})
            line += (f"  -> #{t['track_id']} {t['class']} "
                     f"dir={m.get('direction')} speed={m.get('speed')} x={t['x']}")
        print(line)
        time.sleep(0.05)

    print("\n--- final frame: first tracked object (full JSON) ---")
    if last and last.get("tracks"):
        print(json.dumps(last["tracks"][0], indent=2, default=str))
        ok = True
    else:
        print("No tracks on final frame. Checking seeds with a longer run...")
        ok = False
    print("\nRESULT:", "PASS - track IDs + movement flowing through HTTP" if ok else "FAIL")


if __name__ == "__main__":
    main()