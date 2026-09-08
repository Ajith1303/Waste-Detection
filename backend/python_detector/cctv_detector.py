"""
CCTV & Video Stream Illegal Waste Dumping Detection System.

Processes video streams (CCTV RTSP feeds, USB webcams, or video files),
tracks persons and waste items using YOLOv8 + ByteTrack, and applies
the TemporalDumpingEngine state machine to detect illegal waste dumping:

Event Sequence:
  1. Person enters the frame
  2. Person interacts with / drops waste
  3. Person leaves the scene (moves away)
  4. Waste remains stationary for >= stationary_duration (e.g. 5-10s)
  5. Incident confirmed -> Evidence snapshot/clip saved -> Sent to Backend API

Usage:
  # Webcam:
  python cctv_detector.py --source 0 --display

  # Video file:
  python cctv_detector.py --source path/to/video.mp4 --display

  # CCTV RTSP Stream:
  python cctv_detector.py --source rtsp://admin:pass@192.168.1.100:554/stream --display

  # Headless (No GUI, background CCTV monitor):
  python cctv_detector.py --source rtsp://... --api-url http://127.0.0.1:5000/api/frames
"""

import sys
if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

import os
import time
import argparse
import base64
import json
import urllib.request
import urllib.error
from typing import Optional

import cv2
import numpy as np

# Detector & temporal state machine imports
import yolo_backend
import temporal_engine


def send_incident_to_backend(
    api_url: str,
    camera_id: str,
    zone_id: Optional[int],
    incident: dict,
    evidence_b64: str,
    width: int,
    height: int,
):
    """
    Dispatches a confirmed illegal dumping incident to the Node.js Express backend.
    """
    payload = {
        "cameraId": camera_id,
        "zoneId": zone_id,
        "imageBase64": f"data:image/jpeg;base64,{evidence_b64}",
        "width": width,
        "height": height,
        "sessionId": f"cctv-{camera_id}",
        "classificationOverride": "illegal",
        "reasonOverride": incident.get("reason", "Temporal event: Illegal waste dumping confirmed."),
        "temporalEvent": {
            "incidentId": incident.get("incident_id"),
            "personId": incident.get("person_id"),
            "wasteId": incident.get("waste_id"),
            "dropPosition": incident.get("drop_position"),
            "stationaryDuration": incident.get("stationary_duration"),
            "leaveDistance": incident.get("leave_distance"),
            "drift": incident.get("drift"),
        },
    }

    try:
        req = urllib.request.Request(
            api_url,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            print(f"[API DISPATCH] Successfully posted incident {incident['incident_id']} -> Backend Event ID: {data.get('eventId')}")
            return data
    except Exception as e:
        print(f"[API DISPATCH WARNING] Could not reach backend API at {api_url}: {e}")
        return None


def run_cctv_detector(args):
    source = args.source
    # Convert integer source for webcam
    if str(source).isdigit():
        source = int(source)

    print("=" * 70)
    print("  AI Illegal Waste Dumping Detection System (CCTV / Video Stream)")
    print("=" * 70)
    print(f"Source:              {source}")
    print(f"Backend API URL:     {args.api_url}")
    print(f"Camera ID:           {args.camera_id}  |  Zone ID: {args.zone_id}")
    print(f"Stationary Duration: {args.stationary_sec} seconds")
    print(f"Proximity Threshold: {args.proximity_dist} (normalized)")
    print(f"Leave Distance:      {args.leave_dist} (normalized)")
    print(f"Save Directory:      {args.save_dir}")
    print(f"Display GUI:         {args.display}")
    print("=" * 70)

    # Prepare evidence directory
    os.makedirs(args.save_dir, exist_ok=True)

    # Initialize YOLOv8 and ByteTrack
    os.environ["ROBOFLOW_CONFIDENCE"] = str(args.conf)
    os.environ["STATIONARY_DURATION_SEC"] = str(args.stationary_sec)
    os.environ["PROXIMITY_THRESHOLD"] = str(args.proximity_dist)
    os.environ["LEAVE_DISTANCE_THRESHOLD"] = str(args.leave_dist)
    os.environ["COOLDOWN_MINUTES"] = str(args.cooldown_min)

    det = yolo_backend.get_detector()

    # Open video capture
    cap = cv2.VideoCapture(source)
    if not cap.isOpened():
        print(f"[ERROR] Could not open video source: {source}")
        return 1

    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    print(f"[INFO] Video opened. FPS: {fps:.2f}, Total frames: {total_frames if total_frames > 0 else 'Live Stream'}")

    frame_idx = 0
    start_wall_time = time.time()

    # Fetch zone box if available from backend, or None
    zone_box = None

    try:
        while True:
            ret, frame = cap.read()
            if not ret:
                print("[INFO] End of video stream reached.")
                break

            frame_idx += 1
            if args.skip_frames > 1 and (frame_idx % args.skip_frames != 0):
                continue

            if args.max_frames and frame_idx > args.max_frames:
                print(f"[INFO] Reached max frames limit ({args.max_frames}).")
                break

            h, w = frame.shape[:2]
            simulated_timestamp = start_wall_time + (frame_idx / fps)

            # 1. Run YOLOv8 Object Detection
            detections = det.detect_image_np(frame)

            # 2. Run ByteTrack Multi-Object Tracking
            tracks = det.track(detections)

            # 3. Advance Temporal State Machine
            temporal_res = det.update_temporal(
                tracks,
                frame_img=frame,
                timestamp=simulated_timestamp,
                zone_box=zone_box,
            )

            state = temporal_res.get("state", "IDLE")
            confirmed_incidents = temporal_res.get("confirmed_incidents", [])

            # 4. Handle any confirmed dumping incidents
            for inc in confirmed_incidents:
                inc_id = inc["incident_id"]
                print("\n" + "!" * 70)
                print(f" [INCIDENT CONFIRMED] {inc['reason']}")
                print(f" Person #{inc['person_id']} -> Waste #{inc['waste_id']} | Stationary: {inc['stationary_duration']}s")
                print("!" * 70 + "\n")

                # Save annotated evidence image
                evidence_img_bytes = inc.get("evidence_image_bytes")
                snapshot_path = os.path.join(args.save_dir, f"{inc_id}.jpg")
                if evidence_img_bytes:
                    with open(snapshot_path, "wb") as fh:
                        fh.write(evidence_img_bytes)
                    print(f"[SAVED EVIDENCE] Snapshot written to: {snapshot_path}")

                    # Optionally export pre/post video clip
                    if args.save_video and det._temporal:
                        video_clip_path = os.path.join(args.save_dir, f"{inc_id}.mp4")
                        det._temporal.export_evidence_video(video_clip_path, fps=int(fps))

                    # Dispatch to backend API
                    b64 = base64.b64encode(evidence_img_bytes).decode("ascii")
                    send_incident_to_backend(
                        api_url=args.api_url,
                        camera_id=args.camera_id,
                        zone_id=args.zone_id,
                        incident=inc,
                        evidence_b64=b64,
                        width=w,
                        height=h,
                    )

            # 5. Optional GUI Preview Display
            if args.display:
                display_frame = frame.copy()

                # Draw track boxes & trails
                for t in tracks:
                    cls_name = t.get("class", "object")
                    is_p = t.get("is_person", False)
                    is_w = t.get("is_waste", False)
                    tid = t.get("track_id", 0)

                    color = (255, 140, 0) if is_p else ((0, 0, 230) if is_w else (180, 180, 180))
                    bx1 = int((t["x"] - t["w"] / 2) * w)
                    by1 = int((t["y"] - t["h"] / 2) * h)
                    bx2 = int((t["x"] + t["w"] / 2) * w)
                    by2 = int((t["y"] + t["h"] / 2) * h)

                    cv2.rectangle(display_frame, (bx1, by1), (bx2, by2), color, 2)
                    label = f"#{tid} {cls_name} {int(t.get('confidence', 0)*100)}%"
                    cv2.putText(display_frame, label, (bx1, max(18, by1 - 6)),
                                cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 2, cv2.LINE_AA)

                    # Draw movement trail
                    hist = t.get("history", [])
                    if len(hist) > 1:
                        pts = [np.array([int(pt[0] * w), int(pt[1] * h)]) for pt in hist]
                        for i in range(1, len(pts)):
                            cv2.line(display_frame, tuple(pts[i - 1]), tuple(pts[i]), color, 1, cv2.LINE_AA)

                # Draw Top Status Banner
                cv2.rectangle(display_frame, (0, 0), (w, 40), (20, 20, 20), -1)
                state_colors = {
                    "IDLE": (160, 160, 160),
                    "PERSON_DETECTED": (255, 180, 0),
                    "PERSON_NEAR_WASTE": (0, 200, 255),
                    "WASTE_PLACED": (0, 140, 255),
                    "PERSON_LEFT": (0, 100, 255),
                    "WASTE_STATIONARY": (0, 60, 255),
                    "DUMPING_CONFIRMED": (0, 0, 255),
                }
                st_color = state_colors.get(state, (255, 255, 255))
                status_text = f"STATE: {state} | Tracks: {len(tracks)} | Active Candidates: {temporal_res.get('candidates_count', 0)}"
                cv2.putText(display_frame, status_text, (15, 26), cv2.FONT_HERSHEY_SIMPLEX, 0.65, st_color, 2, cv2.LINE_AA)

                # Draw candidate interaction details
                cand_y = 65
                for c in temporal_res.get("candidates", []):
                    c_text = f"Candidate P#{c['person_id']} -> W#{c['waste_id']} [{c['state']}] Stationary: {c['stationary_elapsed']}s Dist: {c['max_dist']:.2f}"
                    cv2.putText(display_frame, c_text, (15, cand_y), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 255), 1, cv2.LINE_AA)
                    cand_y += 20

                cv2.imshow("CCTV Illegal Waste Dumping Detector", display_frame)
                key = cv2.waitKey(1) & 0xFF
                if key == 27 or key == ord("q"):
                    print("[INFO] User stopped monitoring (ESC/Q pressed).")
                    break

            if frame_idx % 60 == 0:
                print(f"[MONITOR] Frame {frame_idx} | State: {state} | Tracks: {len(tracks)} | Candidates: {temporal_res.get('candidates_count', 0)}")

    except KeyboardInterrupt:
        print("\n[INFO] Stopped by user (KeyboardInterrupt).")
    finally:
        cap.release()
        if args.display:
            cv2.destroyAllWindows()

    print(f"[INFO] CCTV monitoring finished. Processed {frame_idx} frames.")
    return 0


def main():
    parser = argparse.ArgumentParser(description="AI CCTV Illegal Waste Dumping Detection")
    parser.add_argument("--source", type=str, default="0", help="Video source: webcam index ('0'), video file path, or RTSP URL")
    parser.add_argument("--api-url", type=str, default="http://127.0.0.1:5000/api/frames", help="Node backend frames ingestion API URL")
    parser.add_argument("--camera-id", type=str, default="cctv-cam-01", help="Identifier for this CCTV camera feed")
    parser.add_argument("--zone-id", type=int, default=1, help="Associated dustbin zone ID in the backend database")
    parser.add_argument("--conf", type=float, default=0.40, help="YOLO detection confidence threshold (0.0 - 1.0)")
    parser.add_argument("--stationary-sec", type=float, default=5.0, help="Seconds waste must remain stationary to confirm dumping")
    parser.add_argument("--proximity-dist", type=float, default=0.22, help="Max normalized distance for person-waste proximity")
    parser.add_argument("--leave-dist", type=float, default=0.35, help="Min normalized distance for person departure")
    parser.add_argument("--cooldown-min", type=float, default=15.0, help="Cooldown minutes to suppress repeated alerts for same spot")
    parser.add_argument("--save-dir", type=str, default=os.path.join(os.path.dirname(__file__), "..", "uploads", "evidence"), help="Evidence directory")
    parser.add_argument("--save-video", action="store_true", help="Save evidence video clip in addition to snapshot image")
    parser.add_argument("--display", action="store_true", help="Display OpenCV live video preview window with annotations")
    parser.add_argument("--max-frames", type=int, default=None, help="Stop after processing N frames")
    parser.add_argument("--skip-frames", type=int, default=1, help="Process every N-th frame (e.g. 2 to reduce compute load)")

    args = parser.parse_args()
    return run_cctv_detector(args)


if __name__ == "__main__":
    sys.exit(main())
