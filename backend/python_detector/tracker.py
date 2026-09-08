"""
ByteTrack-inspired Multi-Object Tracker for the Smart Waste Dumping system.

Core algorithm:
  1. Kalman filter per track for state prediction
  2. IoU-based matching (high-confidence + low-confidence two-stage)
  3. Track lifecycle: new -> tracked -> lost -> deleted

Usage:
    tracker = ByteTrackTracker(track_history=30)
    tracked = tracker.update(detections)
"""
import math
from collections import OrderedDict, deque
from typing import List, Dict
import numpy as np


# ── Kalman Filter (constant-velocity model for bbox center + size) ───────────
# State: [cx, cy, w, h, vx, vy, vw, vh]  (8 dims)
# Measurement: [cx, cy, w, h]              (4 dims)

class KalmanBoxFilter:
    """Kalman filter for a single bounding box (center + size)."""

    def __init__(self, bbox: np.ndarray):
        self.dim_x = 8
        self.dim_z = 4
        # State transition (constant velocity)
        self.F = np.eye(self.dim_x, dtype=np.float32)
        for i in range(4):
            self.F[i, i + 4] = 1.0
        # Measurement matrix
        self.H = np.zeros((self.dim_z, self.dim_x), dtype=np.float32)
        self.H[:4, :4] = np.eye(4, dtype=np.float32)
        # Noise covariances
        self.Q = np.eye(self.dim_x, dtype=np.float32) * 0.01
        self.Q[4:, 4:] *= 0.01
        self.R = np.eye(self.dim_z, dtype=np.float32) * 0.1
        self.P = np.eye(self.dim_x, dtype=np.float32) * 10.0
        # State vector
        self.x = np.zeros((self.dim_x, 1), dtype=np.float32)
        self.x[:4, 0] = bbox
        self.time_since_update = 0
        self.hits = 0
        self.hit_streak = 0
        self.age = 0

    def predict(self) -> np.ndarray:
        self.x = self.F @ self.x
        self.P = self.F @ self.P @ self.F.T + self.Q
        self.x[2] = max(self.x[2], 0.001)
        self.x[3] = max(self.x[3], 0.001)
        self.age += 1
        self.time_since_update += 1
        return self.x[:4, 0].copy()

    def update(self, bbox: np.ndarray):
        z = np.array(bbox, dtype=np.float32).reshape(-1, 1)
        y = z - self.H @ self.x
        S = self.H @ self.P @ self.H.T + self.R
        K = self.P @ self.H.T @ np.linalg.inv(S)
        self.x = self.x + K @ y
        I = np.eye(self.dim_x, dtype=np.float32)
        self.P = (I - K @ self.H) @ self.P
        self.x[2] = max(self.x[2], 0.001)
        self.x[3] = max(self.x[3], 0.001)
        self.time_since_update = 0
        self.hits += 1
        self.hit_streak += 1

    @property
    def state_bbox(self) -> np.ndarray:
        return self.x[:4, 0].copy()

    @property
    def is_confirmed(self) -> bool:
        return self.hits >= 3


# ── IoU computation ──────────────────────────────────────────────────────────

def _iou_batch(bb_a: np.ndarray, bb_b: np.ndarray) -> np.ndarray:
    """IoU between two sets of [cx,cy,w,h] boxes. Returns (N, M) matrix."""
    a_x1 = bb_a[:, 0] - bb_a[:, 2] / 2
    a_y1 = bb_a[:, 1] - bb_a[:, 3] / 2
    a_x2 = bb_a[:, 0] + bb_a[:, 2] / 2
    a_y2 = bb_a[:, 1] + bb_a[:, 3] / 2
    b_x1 = bb_b[:, 0] - bb_b[:, 2] / 2
    b_y1 = bb_b[:, 1] - bb_b[:, 3] / 2
    b_x2 = bb_b[:, 0] + bb_b[:, 2] / 2
    b_y2 = bb_b[:, 1] + bb_b[:, 3] / 2
    N, M = len(bb_a), len(bb_b)
    iou = np.zeros((N, M), dtype=np.float32)
    for i in range(N):
        ix1 = np.maximum(a_x1[i], b_x1)
        iy1 = np.maximum(a_y1[i], b_y1)
        ix2 = np.minimum(a_x2[i], b_x2)
        iy2 = np.minimum(a_y2[i], b_y2)
        inter = np.maximum(0, ix2 - ix1) * np.maximum(0, iy2 - iy1)
        area_a = bb_a[i, 2] * bb_a[i, 3]
        area_b = bb_b[:, 2] * bb_b[:, 3]
        iou[i] = inter / np.maximum(area_a + area_b - inter, 1e-6)
    return iou


def _hungarian(cost_matrix: np.ndarray, max_cost: float = 0.95) -> List[tuple]:
    """Greedy assignment (O(N*M), fast enough for <100 objects)."""
    rows, cols = cost_matrix.shape
    assigned_r, assigned_c = set(), set()
    matches = []
    indices = np.argsort(cost_matrix, axis=None)
    for idx in indices:
        r, c = int(idx // cols), int(idx % cols)
        if r in assigned_r or c in assigned_c:
            continue
        if cost_matrix[r, c] > max_cost:
            break
        matches.append((r, c))
        assigned_r.add(r)
        assigned_c.add(c)
    return matches



# ── ByteTrack Tracker ────────────────────────────────────────────────────────

class ByteTrackTracker:
    """
    ByteTrack-inspired multi-object tracker.

    Key idea: match HIGH-confidence detections first, then try to recover
    lost tracks with LOW-confidence detections. This avoids dropping objects
    that temporarily have low confidence (e.g. partial occlusion).
    """

    def __init__(
        self,
        track_history: int = 30,
        high_conf_threshold: float = 0.6,
        low_conf_threshold: float = 0.1,
        iou_threshold: float = 0.3,
        max_age: int = 30,
        min_hits: int = 3,
    ):
        self.track_history = track_history
        self.high_conf_threshold = high_conf_threshold
        self.low_conf_threshold = low_conf_threshold
        self.iou_threshold = iou_threshold
        self.max_age = max_age
        self.min_hits = min_hits
        self._next_id = 1
        self.tracks: OrderedDict = OrderedDict()

    def _new_track(self, detection: dict) -> dict:
        tid = self._next_id
        self._next_id += 1
        bbox = np.array([detection["x"], detection["y"], detection["w"], detection["h"]], dtype=np.float32)
        kf = KalmanBoxFilter(bbox)
        cls_name = str(detection.get("class", "object")).lower()
        is_p = detection.get("is_person", False) or cls_name == "person"
        is_w = detection.get("is_waste", False) or cls_name in (
            "garbage", "trash", "waste", "trash_bag", "plastic_bag", "litter", "rubbish",
            "backpack", "handbag", "suitcase", "bottle"
        )
        return {
            "track_id": tid,
            "class": detection.get("class", "object"),
            "confidence": detection.get("confidence", 0),
            "x": detection["x"],
            "y": detection["y"],
            "w": detection["w"],
            "h": detection["h"],
            "kalman": kf,
            "history": deque(maxlen=self.track_history),
            "age": 0,
            "hits": 0,
            "time_since_update": 0,
            "matched_class": detection.get("class", "object"),
            "is_person": is_p,
            "is_waste": is_w,
        }


    def _match(self, detections, threshold):
        """Match detections to tracks via IoU. Returns (matches, unmatched_dets, unmatched_tracks)."""
        if not self.tracks or not detections:
            return [], list(range(len(detections))), list(self.tracks.keys())
        track_ids = list(self.tracks.keys())
        track_bboxes = np.array([self.tracks[t]["kalman"].state_bbox for t in track_ids], dtype=np.float32)
        det_bboxes = np.array([[d["x"], d["y"], d["w"], d["h"]] for d in detections], dtype=np.float32)
        iou_matrix = _iou_batch(track_bboxes, det_bboxes)
        cost = 1.0 - iou_matrix
        raw = _hungarian(cost)
        matches, det_idx, track_idx_set = [], set(), set()
        for r, c in raw:
            if iou_matrix[r, c] >= threshold:
                matches.append((r, c))
                det_idx.add(c)
                track_idx_set.add(r)
        unmatched_dets = [i for i in range(len(detections)) if i not in det_idx]
        unmatched_tracks = [track_ids[i] for i in range(len(track_ids)) if i not in track_idx_set]
        return matches, unmatched_dets, unmatched_tracks

    def update(self, detections: List[dict]) -> List[dict]:
        """Process one frame; return tracked results with track_id + history."""
        # predict all tracks
        for t in self.tracks.values():
            t["kalman"].predict()
            t["age"] += 1
            t["time_since_update"] += 1

        high = [d for d in detections if d.get("confidence", 0) >= self.high_conf_threshold]
        low = [d for d in detections if self.low_conf_threshold <= d.get("confidence", 0) < self.high_conf_threshold]
        track_ids = list(self.tracks.keys())

        # Stage A: match high-confidence detections
        matches, unmatched_high, unmatched_tracks = self._match(high, self.iou_threshold)
        for r, c in matches:
            det = high[c]
            track = self.tracks[track_ids[r]]
            bbox = np.array([det["x"], det["y"], det["w"], det["h"]], dtype=np.float32)
            track["kalman"].update(bbox)
            track["x"], track["y"], track["w"], track["h"] = det["x"], det["y"], det["w"], det["h"]
            track["confidence"] = det["confidence"]
            track["matched_class"] = det.get("class", track["matched_class"])
            track["time_since_update"] = 0
            track["hits"] += 1
            track["history"].append([det["x"], det["y"]])

        # Stage B: recover lost tracks with low-confidence detections
        if unmatched_tracks and low:
            rem_ids = unmatched_tracks
            rem_bboxes = np.array([self.tracks[t]["kalman"].state_bbox for t in rem_ids], dtype=np.float32)
            low_bboxes = np.array([[d["x"], d["y"], d["w"], d["h"]] for d in low], dtype=np.float32)
            iou_matrix = _iou_batch(rem_bboxes, low_bboxes)
            cost = 1.0 - iou_matrix
            raw = _hungarian(cost)
            matched_low = set()
            for r, c in raw:
                if iou_matrix[r, c] >= self.iou_threshold * 0.5:
                    det = low[c]
                    track = self.tracks[rem_ids[r]]
                    bbox = np.array([det["x"], det["y"], det["w"], det["h"]], dtype=np.float32)
                    track["kalman"].update(bbox)
                    track["x"], track["y"], track["w"], track["h"] = det["x"], det["y"], det["w"], det["h"]
                    track["confidence"] = det["confidence"]
                    track["time_since_update"] = 0
                    track["hits"] += 1
                    track["history"].append([det["x"], det["y"]])
                    matched_low.add(c)
            for i, det in enumerate(low):
                if i not in matched_low:
                    nt = self._new_track(det)
                    nt["history"].append([det["x"], det["y"]])
                    self.tracks[nt["track_id"]] = nt
        else:
            for det in low:
                nt = self._new_track(det)
                nt["history"].append([det["x"], det["y"]])
                self.tracks[nt["track_id"]] = nt

        # Stage C: unmatched high-confidence detections become new tracks
        for c in unmatched_high:
            nt = self._new_track(high[c])
            nt["history"].append([high[c]["x"], high[c]["y"]])
            self.tracks[nt["track_id"]] = nt

        # Stage D: delete stale tracks
        for tid in [t for t, tr in self.tracks.items() if tr["time_since_update"] > self.max_age]:
            del self.tracks[tid]

        # Stage E: output confirmed, active tracks
        results = []
        for tid, track in self.tracks.items():
            if track["hits"] >= self.min_hits and track["time_since_update"] == 0:
                results.append({
                    "track_id": track["track_id"],
                    "class": track["matched_class"],
                    "confidence": round(track["confidence"], 4),
                    "x": round(track["x"], 4),
                    "y": round(track["y"], 4),
                    "w": round(track["w"], 4),
                    "h": round(track["h"], 4),
                    "age": track["age"],
                    "hits": track["hits"],
                    "history": [list(p) for p in track["history"]],
                    "is_person": track.get("is_person", False),
                    "is_waste": track.get("is_waste", False),
                })
        return results

    def reset(self):
        self.tracks.clear()
        self._next_id = 1

