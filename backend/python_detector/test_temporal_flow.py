"""
End-to-End Synthetic Video Verification Test for Temporal Dumping Detection.

Generates synthetic CCTV frames:
  - Background street/ground
  - Person walking into frame
  - Dropping a trash bag
  - Moving away and exiting the scene
  - Bag staying stationary for 5+ seconds
  - Engine confirming dumping and exporting annotated evidence snapshot
"""

import sys
if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

import os
import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tracker
import movement
import temporal_engine


def create_synthetic_frame(w=1280, h=720, person_box=None, waste_box=None):
    """Draw a synthetic CCTV street scene."""
    frame = np.full((h, w, 3), (210, 215, 220), dtype=np.uint8)

    # Draw sidewalk / road
    cv2.rectangle(frame, (0, int(h * 0.45)), (w, h), (140, 140, 140), -1)
    cv2.line(frame, (0, int(h * 0.45)), (w, int(h * 0.45)), (90, 90, 90), 3)

    # Draw dustbin zone (green outline on far left)
    cv2.rectangle(frame, (40, int(h * 0.35)), (180, int(h * 0.65)), (50, 180, 50), 2)
    cv2.putText(frame, "Designated Bin", (45, int(h * 0.33)), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (40, 140, 40), 1)

    # Draw waste if present
    if waste_box:
        wx, wy, ww, wh = waste_box
        bx1 = int((wx - ww / 2) * w)
        by1 = int((wy - wh / 2) * h)
        bx2 = int((wx + ww / 2) * w)
        by2 = int((wy + wh / 2) * h)
        cv2.rectangle(frame, (bx1, by1), (bx2, by2), (30, 30, 30), -1)
        cv2.putText(frame, "BAG", (bx1 + 5, by1 + 15), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (255, 255, 255), 1)

    # Draw person if present
    if person_box:
        px, py, pw, ph = person_box
        bx1 = int((px - pw / 2) * w)
        by1 = int((py - ph / 2) * h)
        bx2 = int((px + pw / 2) * w)
        by2 = int((py + ph / 2) * h)
        cv2.rectangle(frame, (bx1, by1), (bx2, by2), (180, 80, 40), -1)
        # Head
        cv2.circle(frame, (int(px * w), int((py - ph * 0.35) * h)), int(pw * w * 0.3), (220, 180, 140), -1)

    return frame


def main():
    print("=" * 65)
    print("  SYNTHETIC CCTV VIDEO - TEMPORAL DUMPING VERIFICATION")
    print("=" * 65)

    evidence_dir = os.path.join(os.path.dirname(__file__), "..", "uploads", "evidence")
    os.makedirs(evidence_dir, exist_ok=True)

    t = tracker.ByteTrackTracker(track_history=30, min_hits=2)
    mv = movement.MovementTracker()
    engine = temporal_engine.TemporalDumpingEngine(
        proximity_threshold=0.22,
        leave_distance_threshold=0.35,
        stationary_duration_sec=3.0,
        stationary_drift_tol=0.04,
        debug=True,
    )

    confirmed_incidents = []
    fps = 5.0  # 5 frames per second
    total_frames = 50

    print(f"Generating and processing {total_frames} synthetic CCTV video frames...")

    for frame_idx in range(total_frames):
        sim_time = frame_idx / fps

        # Person enters at x=0.30, moves to drop location (0.55), drops bag, then walks away to x=0.95
        person_present = frame_idx < 22
        if person_present:
            if frame_idx < 8:
                px = 0.30 + frame_idx * 0.03
            elif frame_idx < 12:
                px = 0.54  # Standing / dropping
            else:
                px = 0.54 + (frame_idx - 12) * 0.04  # Walking away
            person_box = (px, 0.60, 0.08, 0.28)
        else:
            person_box = None

        # Waste appears at frame 10 at (0.55, 0.68) and stays stationary
        waste_present = frame_idx >= 10
        waste_box = (0.55, 0.68, 0.07, 0.07) if waste_present else None

        img = create_synthetic_frame(person_box=person_box, waste_box=waste_box)

        # Build detections list
        dets = []
        if person_present:
            dets.append({
                "class": "person",
                "confidence": 0.93,
                "x": round(person_box[0], 4),
                "y": round(person_box[1], 4),
                "w": round(person_box[2], 4),
                "h": round(person_box[3], 4),
                "is_person": True,
                "is_waste": False,
            })
        if waste_present:
            dets.append({
                "class": "trash",
                "confidence": 0.89,
                "x": round(waste_box[0], 4),
                "y": round(waste_box[1], 4),
                "w": round(waste_box[2], 4),
                "h": round(waste_box[3], 4),
                "is_person": False,
                "is_waste": True,
            })

        tracked = mv.update(t.update(dets))
        res = engine.update(tracked, frame_img=img, timestamp=sim_time)

        if res.get("confirmed_incidents"):
            for inc in res["confirmed_incidents"]:
                confirmed_incidents.append(inc)
                # Save evidence image to disk
                evidence_bytes = inc.get("evidence_image_bytes")
                if evidence_bytes:
                    evidence_file = os.path.join(evidence_dir, f"synthetic_test_{inc['incident_id']}.jpg")
                    with open(evidence_file, "wb") as fh:
                        fh.write(evidence_bytes)
                    print(f"\n[VERIFIED] Evidence snapshot saved to: {evidence_file}")

    print("\n--- Summary ---")
    print(f"Total Confirmed Incidents: {len(confirmed_incidents)}")
    if confirmed_incidents:
        inc = confirmed_incidents[0]
        print(f"Incident ID:           {inc['incident_id']}")
        print(f"Person Track ID:       #{inc['person_id']}")
        print(f"Waste Track ID:        #{inc['waste_id']}")
        print(f"Drop Position:         {inc['drop_position']}")
        print(f"Stationary Duration:   {inc['stationary_duration']} seconds")
        print(f"Departure Distance:    {inc['leave_distance']:.2f}")
        print(f"Reason:                {inc['reason']}")
        print("\n[SUCCESS] End-to-end temporal dumping detection verified successfully!")
        return 0
    else:
        print("[FAIL] No incident confirmed.")
        return 1


if __name__ == "__main__":
    sys.exit(main())
