"""
YOLOv8 + ByteTrack + Movement + Temporal Dumping Engine backend.

Wraps the `ultralytics` YOLOv8 model and runs:
  1. Object detection (distinguishing person and waste classes)
  2. ByteTrack tracking (with track_id, Kalman filter, movement analysis)
  3. TemporalDumpingEngine (state machine tracking person-waste proximity,
     person departure, waste stationarity, and incident generation).
"""

import os
import time
from typing import List, Dict, Optional, Tuple, Set

import numpy as np

# Plain imports for direct execution
import tracker
import movement
import temporal_engine

# Absolute path of this folder (backend/python_detector). Used so LOCAL_MODEL_PATH
# resolves correctly no matter where the service is launched from.
BASE_DIR = os.path.dirname(os.path.abspath(__file__))


def _resolve_model_path(model_path: str) -> str:
    """Resolve a (possibly relative) model path against BASE_DIR.

    The .env sets LOCAL_MODEL_PATH as a bare filename (e.g. waste_model.pt);
    ultralytics resolves it against the process working directory, which breaks
    when the service is started from anywhere else (e.g. `cd ibm && python
    backend/python_detector/detector.py`). Absolute paths pass through.
    """
    model_path = (model_path or "").strip()
    if not model_path or os.path.isabs(model_path):
        return model_path
    candidate = os.path.join(BASE_DIR, model_path)
    if os.path.exists(candidate):
        return candidate
    return model_path


def _load_dotenv():
    env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    if not os.path.exists(env_path):
        return
    with open(env_path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            key, val = key.strip(), val.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = val


_load_dotenv()


def _clamp01(v: float) -> float:
    return min(1.0, max(0.0, v))


# Standard COCO & comprehensive waste classes mapping
DEFAULT_PERSON_CLASSES = {"person"}
DEFAULT_WASTE_CLASSES = {
    "garbage", "trash", "waste", "trash_bag", "plastic_bag", "garbage_bag",
    "trash bag", "garbage bag", "black plastic bag", "plastic shopping bag",
    "litter", "rubbish", "cardboard box", "cardboard", "box", "carton",
    "food container", "tin can", "can", "bottle", "plastic bottle",
    "crumpled paper", "debris", "backpack", "handbag", "suitcase"
}


class YoloV8Detector:
    """
    YOLOv8 & YOLO-World model wrapper with ByteTrack + Movement + Temporal Dumping Engine.
    Supports standard YOLO models as well as open-vocabulary YOLO-World models.
    """

    def __init__(self):
        self._model = None
        self._names = None
        self._is_world = False
        self._tracker = None
        self._movement = None
        self._temporal = None

        self._person_classes: Set[str] = set(DEFAULT_PERSON_CLASSES)
        self._waste_classes: Set[str] = self._load_waste_classes()

        self._load_enabled()

    def _load_waste_classes(self) -> Set[str]:
        env_classes = os.environ.get("WASTE_CLASSES", "").strip()
        if env_classes:
            custom = {c.strip().lower() for c in env_classes.split(",") if c.strip()}
            return custom.union(DEFAULT_WASTE_CLASSES)
        return set(DEFAULT_WASTE_CLASSES)

    def _load_enabled(self):
        track_on = (os.environ.get("ENABLE_TRACKING", "1") or "").lower() in ("1", "true", "yes", "on")
        if track_on:
            try:
                track_history = int(os.environ.get("TRACK_HISTORY", "30"))
                self._tracker = tracker.ByteTrackTracker(track_history=track_history)
                self._movement = movement.MovementTracker(history_len=track_history)

                # Initialize Temporal State Machine
                stationary_sec = float(os.environ.get("STATIONARY_DURATION_SEC", "5.0"))
                prox_dist = float(os.environ.get("PROXIMITY_THRESHOLD", "0.22"))
                leave_dist = float(os.environ.get("LEAVE_DISTANCE_THRESHOLD", "0.35"))
                cooldown_min = float(os.environ.get("COOLDOWN_MINUTES", "15.0"))
                disappear_to = float(os.environ.get("WASTE_DISAPPEAR_TIMEOUT", "5.0"))

                self._temporal = temporal_engine.TemporalDumpingEngine(
                    proximity_threshold=prox_dist,
                    leave_distance_threshold=leave_dist,
                    stationary_duration_sec=stationary_sec,
                    cooldown_minutes=cooldown_min,
                )
                self._temporal.waste_disappear_timeout = disappear_to
            except Exception as e:
                print(f"[yolo] tracking/temporal initialization warning ({e})")
                self._tracker = None
                self._movement = None
                self._temporal = None

    def _load_model(self):
        """Lazily load the ultralytics YOLO model (standard YOLOv8 or open-vocabulary YOLO-World)."""
        if self._model is not None:
            return self._model

        try:
            from ultralytics import YOLO
        except ImportError:
            raise RuntimeError("ultralytics not installed - run: pip install ultralytics")

        model_path = (os.environ.get("LOCAL_MODEL_PATH", "yolov8n.pt") or "yolov8n.pt").strip()
        model_path = _resolve_model_path(model_path)
        self._model = YOLO(model_path)

        names_raw = os.environ.get("LOCAL_NAMES", "").strip()
        self._names = [n.strip() for n in names_raw.split(",") if n.strip()] if names_raw else None

        # Detect open-vocabulary YOLO-World capability
        self._is_world = "world" in model_path.lower() or (os.environ.get("OPEN_VOCABULARY", "0").lower() in ("1", "true", "yes"))
        if self._is_world and hasattr(self._model, "set_classes"):
            try:
                vocab = ["person"] + sorted(list(self._waste_classes))
                self._model.set_classes(vocab)
                print(f"[yolo] YOLO-World open-vocabulary enabled with {len(vocab)} classes.")
            except Exception as e:
                print(f"[yolo] Warning setting YOLO-World classes: {e}")

        return self._model

    def detect_image_np(self, img: np.ndarray) -> List[Dict]:
        """
        Run YOLO detection on an OpenCV BGR numpy image array.
        Returns normalized detections: [{class, confidence, x, y, w, h, is_person, is_waste}].
        """
        model = self._load_model()
        default_conf = "0.25" if self._is_world else "0.35"
        conf_thr = float(os.environ.get("ROBOFLOW_CONFIDENCE", default_conf))

        results = model.predict(img, conf=conf_thr, verbose=False)
        detections = []

        if results:
            r = results[0]
            boxes = r.boxes
            if boxes is not None:
                h, w = img.shape[:2]
                for i in range(len(boxes)):
                    cls_id = int(boxes.cls[i])
                    conf = float(boxes.conf[i])
                    x1, y1, x2, y2 = boxes.xyxy[i].tolist()

                    cx = (x1 + x2) / 2 / w
                    cy = (y1 + y2) / 2 / h
                    bw = (x2 - x1) / w
                    bh = (y2 - y1) / h
                    name = model.names[cls_id] if cls_id in model.names else f"class{cls_id}"
                    name_lower = name.lower()

                    # Check class filtering
                    if self._names and name not in self._names and name_lower not in self._names:
                        continue

                    is_person = name_lower in self._person_classes or "person" in name_lower
                    is_waste = (
                        name_lower in self._waste_classes
                        or any(k in name_lower for k in (
                            "trash", "garbage", "waste", "bag", "litter", "rubbish",
                            "box", "carton", "bottle", "debris", "can", "container"
                        ))
                    ) and not is_person

                    detections.append({
                        "class": name,
                        "confidence": round(conf, 4),
                        "x": round(_clamp01(cx), 4),
                        "y": round(_clamp01(cy), 4),
                        "w": round(_clamp01(max(0.0, bw)), 4),
                        "h": round(_clamp01(max(0.0, bh)), 4),
                        "is_person": is_person,
                        "is_waste": is_waste,
                    })

        return detections

    def detect(self, image_bytes: bytes) -> Tuple[List[Dict], Optional[np.ndarray]]:
        """
        Run YOLOv8 detection on raw image bytes.
        Returns (detections, decoded_image_np).
        """
        try:
            import cv2
            nparr = np.frombuffer(image_bytes, np.uint8)
            img = cv2.imdecode(nparr, cv2.COLOR_BGR2RGB if False else cv2.IMREAD_COLOR)
            if img is None:
                raise RuntimeError("could not decode image bytes")
        except ImportError:
            raise RuntimeError("opencv-python not installed - run: pip install opencv-python")

        detections = self.detect_image_np(img)
        return detections, img

    def track(self, detections: List[Dict]) -> List[Dict]:
        """
        Run ByteTrack + Movement tracking on raw detections.
        Returns tracked objects enriched with track_id + movement metadata.
        """
        if self._tracker is None or self._movement is None:
            return []
        tracked = self._tracker.update(detections)
        tracked = self._movement.update(tracked)
        return tracked

    def update_temporal(
        self,
        tracks: List[Dict],
        frame_img: Optional[np.ndarray] = None,
        timestamp: Optional[float] = None,
        zone_box: Optional[Dict] = None,
    ) -> Dict:
        """
        Advance temporal state machine on current frame tracks.
        """
        if self._temporal is None:
            return {
                "state": "IDLE",
                "candidates_count": 0,
                "candidates": [],
                "confirmed_incidents": [],
            }
        return self._temporal.update(tracks, frame_img=frame_img, timestamp=timestamp, zone_box=zone_box)

    def reset(self):
        """Reset tracker, movement history, and temporal state engine."""
        if self._tracker is not None:
            self._tracker.reset()
        if self._temporal is not None:
            self._temporal.reset()


# Singleton instance
_detector = None


def get_detector() -> YoloV8Detector:
    global _detector
    if _detector is None:
        _detector = YoloV8Detector()
    return _detector
