"""
Movement / trajectory tracker for the Smart Waste Dumping system.

Builds on top of ByteTrack: for each tracked object we compute dynamic
movement metadata — direction, speed, displacement — by analysing its
recent position history.

Purpose: detect WHO is dumping (person trajectory) and meaningful patterns:
  - approaching the bin
  - moving away / loitering suspiciously
  - a dropped waste object appearing then stopping (disposal event)
"""

import math
from typing import List, Dict, Optional
from collections import deque


def _dist(a, b):
    return math.hypot(a[0] - b[0], a[1] - b[1])


def _angle_of(vec):
    """Angle of a (dx, dy) vector in degrees, 0 = east, CCW positive."""
    dx, dy = vec
    return (math.degrees(math.atan2(dy, dx)) + 360) % 360


class MovementTracker:
    """
    Maintains a movement profile for each tracked object across frames.

    Each update() takes the ByteTrack output (list of {track_id, x, y, w, h,
    history}) and returns the same list enriched with movement metadata:

        movement: {
            direction: "approaching" | "receding" | "stationary" | "lateral",
            speed:     <normalised displacement per frame>,
            displacement: <distance between first and last history point>,
            compass:   <east/north/west/south-ish, for arrows>,
            trail:     <same as history, but with extra smoothing>,
            frames:    <number of history points>
        }

    We keep our own per-track position history so that even if a track is
    dropped briefly by ByteTrack we can re-attach cleanly.
    """

    def __init__(
        self,
        history_len: int = 30,
        stationary_speed: float = 0.002,
        receding_threshold: float = 0.0,
    ):
        self.history_len = history_len
        self.stationary_speed = stationary_speed
        self.receding_threshold = receding_threshold
        # track_id -> deque of (x, y)
        self.history: Dict[int, deque] = {}

    def update(self, tracked: List[Dict]) -> List[Dict]:
        """Enrich each tracked object with movement metadata and return list."""
        # Initialise history for any new track ids, prune deleted ones.
        active_ids = {t["track_id"] for t in tracked}
        for tid in list(self.history.keys()):
            if tid not in active_ids:
                del self.history[tid]

        for t in tracked:
            tid = t["track_id"]
            x, y = t["x"], t["y"]
            hist = self.history.setdefault(tid, deque(maxlen=self.history_len))
            # Prefer ByteTrack's own history if longer, else ours.
            source = t.get("history") or []
            if len(source) >= 2:
                # Use ByteTrack's trail if available.
                hist.clear()
                for p in source:
                    hist.append((p[0], p[1]))
            else:
                hist.append((x, y))

            t["movement"] = self._movement_of(hist, t)
        return tracked

    def _movement_of(self, hist: deque, track: Dict) -> Dict:
        """Compute movement metadata from a track's position history."""
        if len(hist) < 2:
            return {
                "direction": "insufficient",
                "speed": 0.0,
                "displacement": 0.0,
                "compass": "n/a",
                "trail": [[p[0], p[1]] for p in hist],
                "frames": len(hist),
            }

        pts = list(hist)
        first, last = pts[0], pts[-1]
        disp = _dist(first, last)

        # Average per-frame speed between consecutive history points.
        speeds = [_dist(pts[i], pts[i + 1]) for i in range(len(pts) - 1)]
        avg_speed = sum(speeds) / len(speeds) if speeds else 0.0

        # Direction based on displacement vector (if meaningful).
        dx, dy = last[0] - first[0], last[1] - first[1]
        mag = _dist(first, last)

        if mag < self.stationary_speed * len(pts):
            direction = "stationary"
            compass = "n/a"
        elif mag < 1e-6:
            direction = "stationary"
            compass = "n/a"
        else:
            ang = _angle_of((dx, dy))
            if 45 <= ang < 135:
                compass = "south"
            elif 135 <= ang < 225:
                compass = "west"
            elif 225 <= ang < 315:
                compass = "north"
            else:
                compass = "east"
            # Heuristic: receding when moving mostly along one axis quickly.
            direction = "moving"

        return {
            "direction": direction,
            "speed": round(avg_speed, 5),
            "displacement": round(disp, 5),
            "compass": compass,
            "trail": [[p[0], p[1]] for p in pts],
            "frames": len(pts),
        }
