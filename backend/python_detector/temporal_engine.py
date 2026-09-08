"""
Temporal Event Detection Engine for Illegal Waste Dumping Detection.

Implements a robust multi-frame state machine:
    IDLE -> PERSON_DETECTED -> PERSON_NEAR_WASTE -> WASTE_PLACED -> PERSON_LEFT -> WASTE_STATIONARY -> DUMPING_CONFIRMED

Combines:
  1. Object Detection (Person + Waste)
  2. ByteTrack Multi-Object Tracking (persistent IDs, Kalman filter, trajectory)
  3. Spatial Proximity (person-to-waste distance)
  4. Movement & Departure Analysis (person separating and leaving)
  5. Stationary Object Verification (waste stays in place for configurable duration)
  6. Spatial Cooldown & Deduplication (prevents repeated alerts for the same dumped object)
  7. Evidence Snapshot and Optional Video Clip Generation
"""

import os
import math
import time
from collections import deque
from typing import List, Dict, Tuple, Optional, Set
import numpy as np


class DumpingState:
    IDLE = "IDLE"
    PERSON_DETECTED = "PERSON_DETECTED"
    PERSON_NEAR_WASTE = "PERSON_NEAR_WASTE"
    WASTE_PLACED = "WASTE_PLACED"
    PERSON_LEFT = "PERSON_LEFT"
    WASTE_STATIONARY = "WASTE_STATIONARY"
    DUMPING_CONFIRMED = "DUMPING_CONFIRMED"


def dist(p1: Tuple[float, float], p2: Tuple[float, float]) -> float:
    """Euclidean distance between two normalized 2D points."""
    return math.hypot(p1[0] - p2[0], p1[1] - p2[1])


class CandidateInteraction:
    """Tracks a person-waste candidate interaction over time."""

    def __init__(self, person_id: int, waste_id: int, start_time: float, waste_pos: Tuple[float, float]):
        self.person_id = person_id
        self.waste_id = waste_id
        self.state = DumpingState.PERSON_NEAR_WASTE
        self.start_time = start_time
        self.drop_pos = waste_pos                     # (x, y) where waste was placed
        self.last_waste_pos = waste_pos
        self.waste_positions: List[Tuple[float, float, float]] = [(waste_pos[0], waste_pos[1], start_time)]
        self.person_positions: List[Tuple[float, float, float]] = []

        self.placed_time: Optional[float] = None
        self.person_left_time: Optional[float] = None
        self.stationary_start_time: Optional[float] = None
        self.confirmed_time: Optional[float] = None

        self.min_dist: float = float("inf")
        self.max_dist: float = 0.0
        self.max_drift: float = 0.0
        self.person_last_seen: float = start_time
        self.waste_last_seen: float = start_time
        self.person_exited_frame: bool = False
        self.confirmed: bool = False
        self.cooldown_until: float = 0.0

    @property
    def stationary_elapsed(self) -> float:
        if self.stationary_start_time is None:
            return 0.0
        return max(0.0, self.waste_last_seen - self.stationary_start_time)


class TemporalDumpingEngine:
    """
    Multi-frame Temporal State Machine for illegal waste dumping detection.
    """

    def __init__(
        self,
        proximity_threshold: float = 0.22,      # Max normalized distance to consider person near waste
        leave_distance_threshold: float = 0.35, # Min distance person must move away to consider "left"
        stationary_duration_sec: float = 5.0,   # Seconds waste must remain stationary
        stationary_drift_tol: float = 0.045,    # Max drift allowed for stationary object
        cooldown_minutes: float = 15.0,         # Cooldown to suppress duplicate alerts
        spatial_cooldown_radius: float = 0.08,  # Spatial radius to suppress same spot duplicates
        buffer_size: int = 60,                  # Circular frame buffer for evidence clips
        debug: bool = True,
    ):
        self.proximity_threshold = float(os.environ.get("PROXIMITY_THRESHOLD", proximity_threshold))
        self.leave_distance_threshold = float(os.environ.get("LEAVE_DISTANCE_THRESHOLD", leave_distance_threshold))
        self.stationary_duration_sec = float(os.environ.get("STATIONARY_DURATION_SEC", stationary_duration_sec))
        self.stationary_drift_tol = float(os.environ.get("STATIONARY_DRIFT_TOL", stationary_drift_tol))
        self.cooldown_minutes = float(os.environ.get("COOLDOWN_MINUTES", cooldown_minutes))
        self.spatial_cooldown_radius = float(os.environ.get("SPATIAL_COOLDOWN_RADIUS", spatial_cooldown_radius))
        self.debug = debug

        # Active candidates keyed by (person_id, waste_id)
        self.candidates: Dict[Tuple[int, int], CandidateInteraction] = {}

        # Spatial cooldown registry: list of dicts {x, y, confirmed_at, incident_id}
        self.cooldown_registry: List[Dict] = []

        # Confirmed waste track IDs
        self.confirmed_waste_ids: Set[int] = set()

        # Rolling frame buffer for evidence generation: deque of (timestamp, ndarray)
        self.frame_buffer = deque(maxlen=buffer_size)

        # Global incident counter
        self._incident_counter = 0

        # Current overall scene state for telemetry
        self.current_state = DumpingState.IDLE

    def log(self, msg: str):
        if self.debug:
            print(f"[TEMPORAL] {msg}")

    def is_spatially_cooled_down(self, pos: Tuple[float, float], current_time: float) -> Tuple[bool, float]:
        """Check if position is within cooldown radius of an already confirmed dumping event."""
        cooldown_sec = self.cooldown_minutes * 60.0
        for entry in self.cooldown_registry:
            time_since = current_time - entry["confirmed_at"]
            if time_since < cooldown_sec:
                d = dist(pos, (entry["x"], entry["y"]))
                if d <= self.spatial_cooldown_radius:
                    remaining_min = (cooldown_sec - time_since) / 60.0
                    return True, remaining_min
        return False, 0.0

    def register_confirmed_cooldown(self, pos: Tuple[float, float], current_time: float, incident_id: str):
        """Record a confirmed incident location in the spatial cooldown registry."""
        self.cooldown_registry.append({
            "x": pos[0],
            "y": pos[1],
            "confirmed_at": current_time,
            "incident_id": incident_id,
        })
        # Prune old records
        cooldown_sec = self.cooldown_minutes * 60.0
        self.cooldown_registry = [
            e for e in self.cooldown_registry
            if (current_time - e["confirmed_at"]) < cooldown_sec
        ]

    def _get_person_contact_point(self, person: Dict) -> Tuple[float, float]:
        """
        Return the representative point of a person for ground interaction.
        Uses lower center of the bounding box (where hands/feet/ground meet).
        """
        px = person["x"]
        py_bottom = person["y"] + person["h"] / 2.0
        py_center = person["y"]
        # Blend center and bottom (70% towards ground)
        return (px, 0.3 * py_center + 0.7 * py_bottom)

    def _calc_person_waste_distance(self, person: Dict, waste: Dict) -> float:
        """
        Calculates distance between person and waste considering:
        - Center-to-center
        - Bottom-to-center (ground placement)
        - Bounding box gap
        """
        wx, wy = waste["x"], waste["y"]
        center_dist = dist((person["x"], person["y"]), (wx, wy))
        contact_pt = self._get_person_contact_point(person)
        contact_dist = dist(contact_pt, (wx, wy))
        return min(center_dist, contact_dist)

    def update(
        self,
        tracks: List[Dict],
        frame_img: Optional[np.ndarray] = None,
        timestamp: Optional[float] = None,
        zone_box: Optional[Dict] = None,
    ) -> Dict:
        """
        Process tracked objects for the current frame and advance temporal state.

        Args:
            tracks: list of tracked objects from ByteTrack [{track_id, class, is_person, is_waste, x, y, w, h, ...}]
            frame_img: optional OpenCV BGR frame (for evidence snapshot & buffer)
            timestamp: optional time (seconds); if None, uses time.time()
            zone_box: optional normalized {x1, y1, x2, y2} of dustbin zone

        Returns:
            Dict with:
              - state: current dominant state
              - candidates: active candidate summary
              - confirmed_incidents: list of confirmed incidents triggered in this frame
              - debug_info: explanation of current decisions
        """
        now = time.time() if timestamp is None else float(timestamp)

        if frame_img is not None:
            self.frame_buffer.append((now, frame_img.copy()))

        # Separate persons and waste objects
        persons: Dict[int, Dict] = {}
        waste_items: Dict[int, Dict] = {}

        for t in tracks:
            cls_name = str(t.get("class", "")).lower()
            is_p = t.get("is_person", False) or cls_name == "person"
            is_w = t.get("is_waste", False) or cls_name in (
                "garbage", "trash", "waste", "trash_bag", "plastic_bag",
                "litter", "rubbish", "backpack", "handbag", "suitcase", "bottle"
            )

            if is_p:
                persons[t["track_id"]] = t
            elif is_w:
                waste_items[t["track_id"]] = t

        # Update scene state baseline
        if persons:
            dominant_state = DumpingState.PERSON_DETECTED
        else:
            dominant_state = DumpingState.IDLE

        confirmed_incidents = []
        active_candidate_keys = set()

        # Step 1: Detect/Update pairings between persons and waste objects
        for pid, p in persons.items():
            ppos = (p["x"], p["y"])
            for wid, w in waste_items.items():
                # Skip waste if already confirmed and permanently handled
                if wid in self.confirmed_waste_ids:
                    continue

                wpos = (w["x"], w["y"])
                d = self._calc_person_waste_distance(p, w)
                pair_key = (pid, wid)

                if pair_key not in self.candidates:
                    # Check spatial cooldown: if this location was already alerted, skip new candidate
                    cooled_down, remaining_min = self.is_spatially_cooled_down(wpos, now)
                    if cooled_down:
                        self.log(
                            f"Waste #{wid} near Person #{pid} at ({wpos[0]:.2f}, {wpos[1]:.2f}) "
                            f"is in spatial cooldown ({remaining_min:.1f}m remaining). Skipping."
                        )
                        continue

                    # New candidate condition: person and waste in close proximity
                    if d <= self.proximity_threshold:
                        cand = CandidateInteraction(pid, wid, now, wpos)
                        cand.person_positions.append((ppos[0], ppos[1], now))
                        cand.min_dist = d
                        cand.max_dist = d
                        self.candidates[pair_key] = cand
                        self.log(
                            f"[STATE TRANSITION] Pair (Person #{pid}, Waste #{wid}) -> PERSON_NEAR_WASTE "
                            f"(dist={d:.3f} <= threshold {self.proximity_threshold:.3f})"
                        )
                else:
                    # Existing candidate update
                    cand = self.candidates[pair_key]
                    cand.person_last_seen = now
                    cand.waste_last_seen = now
                    cand.last_waste_pos = wpos
                    cand.waste_positions.append((wpos[0], wpos[1], now))
                    cand.person_positions.append((ppos[0], ppos[1], now))
                    cand.min_dist = min(cand.min_dist, d)
                    cand.max_dist = max(cand.max_dist, d)

                    # Check drift of waste from drop point
                    drift = dist(wpos, cand.drop_pos)
                    cand.max_drift = max(cand.max_drift, drift)

                active_candidate_keys.add(pair_key)

        # Step 2: Advance state machine for all active candidates
        for pair_key, cand in list(self.candidates.items()):
            pid, wid = pair_key

            # Has the waste disappeared?
            if wid not in waste_items and (now - cand.waste_last_seen) > 3.0:
                self.log(f"Candidate ({pid}, {wid}) cancelled: waste object disappeared from scene.")
                del self.candidates[pair_key]
                continue

            person_present = pid in persons
            waste_present = wid in waste_items

            if waste_present:
                w = waste_items[wid]
                wpos = (w["x"], w["y"])
                cand.last_waste_pos = wpos
                cand.waste_last_seen = now
                drift = dist(wpos, cand.drop_pos)
                cand.max_drift = max(cand.max_drift, drift)

            # Measure distance from drop position to person (if person present)
            if person_present:
                p = persons[pid]
                ppos = (p["x"], p["y"])
                cand.person_last_seen = now
                cand.person_positions.append((ppos[0], ppos[1], now))
                curr_dist = self._calc_person_waste_distance(p, {"x": cand.drop_pos[0], "y": cand.drop_pos[1], "w": 0, "h": 0})
                cand.max_dist = max(cand.max_dist, curr_dist)
            else:
                # Person is no longer detected in this frame
                curr_dist = float("inf")
                time_since_person = now - cand.person_last_seen
                if time_since_person > 1.0:
                    cand.person_exited_frame = True

            # STATE 1 -> STATE 2: PERSON_NEAR_WASTE -> WASTE_PLACED
            if cand.state == DumpingState.PERSON_NEAR_WASTE:
                # Check if separation has started
                if curr_dist > (self.proximity_threshold * 1.1) or cand.person_exited_frame:
                    cand.state = DumpingState.WASTE_PLACED
                    cand.placed_time = now
                    self.log(
                        f"[STATE TRANSITION] Candidate ({pid}, {wid}) -> WASTE_PLACED "
                        f"(dist increased to {curr_dist:.3f}, placed at ({cand.drop_pos[0]:.2f}, {cand.drop_pos[1]:.2f}))"
                    )

            # STATE 2 -> STATE 3: WASTE_PLACED -> PERSON_LEFT
            if cand.state == DumpingState.WASTE_PLACED:
                person_has_left = (curr_dist >= self.leave_distance_threshold) or cand.person_exited_frame
                if person_has_left:
                    cand.state = DumpingState.PERSON_LEFT
                    cand.person_left_time = now
                    cand.stationary_start_time = now
                    self.log(
                        f"[STATE TRANSITION] Candidate ({pid}, {wid}) -> PERSON_LEFT "
                        f"(dist={curr_dist:.3f} >= leave threshold {self.leave_distance_threshold:.3f} "
                        f"or exited={cand.person_exited_frame}). Beginning stationarity timer."
                    )

            # STATE 3 -> STATE 4: PERSON_LEFT -> WASTE_STATIONARY / DUMPING_CONFIRMED
            if cand.state in (DumpingState.PERSON_LEFT, DumpingState.WASTE_STATIONARY):
                # Verify waste is stationary
                if cand.max_drift > self.stationary_drift_tol:
                    self.log(
                        f"Candidate ({pid}, {wid}) stationarity reset: drift {cand.max_drift:.3f} "
                        f"> tolerance {self.stationary_drift_tol:.3f}"
                    )
                    # Reset stationarity timer if object moved significantly
                    cand.drop_pos = cand.last_waste_pos
                    cand.stationary_start_time = now
                    cand.max_drift = 0.0

                # Negative condition check: Did the person return and pick up the waste?
                if person_present and curr_dist < (self.proximity_threshold * 0.8):
                    self.log(
                        f"Candidate ({pid}, {wid}) reset: Person #{pid} returned to waste (dist={curr_dist:.3f}). "
                        f"Cancelling dumping event (retrieval / false alarm)."
                    )
                    cand.state = DumpingState.PERSON_NEAR_WASTE
                    cand.stationary_start_time = None
                    continue

                if cand.stationary_start_time is not None:
                    elapsed = now - cand.stationary_start_time
                    if elapsed >= 1.0:
                        cand.state = DumpingState.WASTE_STATIONARY

                    self.log(
                        f"[STATIONARY CHECK] Candidate ({pid}, {wid}): stationary for {elapsed:.1f}s / "
                        f"{self.stationary_duration_sec:.1f}s (drift={cand.max_drift:.4f})"
                    )

                    if elapsed >= self.stationary_duration_sec:
                        # Check zone check: is waste outside the designated dustbin zone?
                        is_inside_bin = False
                        if zone_box is not None:
                            wx, wy = cand.drop_pos
                            is_inside_bin = (
                                zone_box.get("x1", 0) <= wx <= zone_box.get("x2", 1) and
                                zone_box.get("y1", 0) <= wy <= zone_box.get("y2", 1)
                            )

                        if is_inside_bin:
                            self.log(
                                f"Candidate ({pid}, {wid}) at ({cand.drop_pos[0]:.2f}, {cand.drop_pos[1]:.2f}) "
                                f"is INSIDE dustbin zone. Classified as proper disposal, not illegal dumping."
                            )
                            # Remove candidate so it doesn't alert
                            del self.candidates[pair_key]
                            continue

                        # All criteria satisfied -> CONFIRM DUMPING INCIDENT!
                        cand.state = DumpingState.DUMPING_CONFIRMED
                        cand.confirmed_time = now
                        cand.confirmed = True
                        self._incident_counter += 1
                        incident_id = f"INC-{int(now)}-{self._incident_counter:04d}"

                        # Register spatial cooldown and track suppression
                        self.register_confirmed_cooldown(cand.drop_pos, now, incident_id)
                        self.confirmed_waste_ids.add(wid)

                        # Generate annotated evidence snapshot
                        evidence_img_bytes, evidence_img_np = self._generate_evidence_snapshot(
                            frame_img=frame_img,
                            cand=cand,
                            person=persons.get(pid),
                            waste=waste_items.get(wid),
                            incident_id=incident_id,
                            elapsed=elapsed,
                        )

                        incident_record = {
                            "incident_id": incident_id,
                            "timestamp": now,
                            "person_id": pid,
                            "waste_id": wid,
                            "drop_position": {"x": round(cand.drop_pos[0], 4), "y": round(cand.drop_pos[1], 4)},
                            "stationary_duration": round(elapsed, 2),
                            "leave_distance": round(cand.max_dist, 4),
                            "drift": round(cand.max_drift, 4),
                            "person_trajectory": [[round(p[0], 4), round(p[1], 4)] for p in cand.person_positions[-20:]],
                            "evidence_image_bytes": evidence_img_bytes,
                            "evidence_image_np": evidence_img_np,
                            "state": DumpingState.DUMPING_CONFIRMED,
                            "reason": (
                                f"Illegal waste dumping confirmed: Person #{pid} dropped waste #{wid} at "
                                f"({cand.drop_pos[0]:.2f}, {cand.drop_pos[1]:.2f}), moved away {cand.max_dist:.2f} units, "
                                f"and waste remained stationary for {elapsed:.1f}s outside dustbin zone."
                            ),
                        }

                        confirmed_incidents.append(incident_record)
                        self.log(f"*** {incident_record['reason']} ***")

                        # Remove from active candidates now that it's confirmed
                        del self.candidates[pair_key]

            # Track dominant state
            if cand.state == DumpingState.DUMPING_CONFIRMED:
                dominant_state = DumpingState.DUMPING_CONFIRMED
            elif cand.state in (DumpingState.WASTE_STATIONARY, DumpingState.PERSON_LEFT):
                dominant_state = DumpingState.WASTE_STATIONARY
            elif cand.state == DumpingState.WASTE_PLACED and dominant_state != DumpingState.WASTE_STATIONARY:
                dominant_state = DumpingState.WASTE_PLACED
            elif cand.state == DumpingState.PERSON_NEAR_WASTE and dominant_state not in (DumpingState.WASTE_STATIONARY, DumpingState.WASTE_PLACED):
                dominant_state = DumpingState.PERSON_NEAR_WASTE

        self.current_state = dominant_state

        return {
            "state": dominant_state,
            "candidates_count": len(self.candidates),
            "candidates": [
                {
                    "person_id": c.person_id,
                    "waste_id": c.waste_id,
                    "state": c.state,
                    "stationary_elapsed": round(c.stationary_elapsed, 1),
                    "drop_pos": [round(c.drop_pos[0], 3), round(c.drop_pos[1], 3)],
                    "max_dist": round(c.max_dist, 3),
                    "drift": round(c.max_drift, 4),
                }
                for c in self.candidates.values()
            ],
            "confirmed_incidents": confirmed_incidents,
            "active_tracks_count": len(tracks),
            "cooldown_active_count": len(self.cooldown_registry),
        }

    def _generate_evidence_snapshot(
        self,
        frame_img: Optional[np.ndarray],
        cand: CandidateInteraction,
        person: Optional[Dict],
        waste: Optional[Dict],
        incident_id: str,
        elapsed: float,
    ) -> Tuple[Optional[bytes], Optional[np.ndarray]]:
        """
        Creates an annotated evidence snapshot highlighting:
        - Bounding boxes for person and waste
        - Departure trail and distance
        - Metadata status banner
        """
        if frame_img is None:
            return None, None

        try:
            import cv2
            annotated = frame_img.copy()
            h, w = annotated.shape[:2]

            # 1. Draw waste box (Red)
            wx, wy = cand.drop_pos
            ww = (waste.get("w", 0.08) if waste else 0.08)
            wh = (waste.get("h", 0.08) if waste else 0.08)
            x1 = int(max(0, (wx - ww / 2) * w))
            y1 = int(max(0, (wy - wh / 2) * h))
            x2 = int(min(w - 1, (wx + ww / 2) * w))
            y2 = int(min(h - 1, (wy + wh / 2) * h))

            cv2.rectangle(annotated, (x1, y1), (x2, y2), (0, 0, 230), 3)
            cv2.putText(annotated, f"WASTE #{cand.waste_id} (Stationary {elapsed:.1f}s)", (x1, max(20, y1 - 8)),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 230), 2, cv2.LINE_AA)

            # 2. Draw person trajectory trail (Cyan/Blue)
            if cand.person_positions:
                pts = [np.array([int(p[0] * w), int(p[1] * h)]) for p in cand.person_positions]
                for i in range(1, len(pts)):
                    cv2.line(annotated, tuple(pts[i - 1]), tuple(pts[i]), (255, 200, 0), 2, cv2.LINE_AA)

            # 3. If person still present, draw person box
            if person:
                px1 = int(max(0, (person["x"] - person["w"] / 2) * w))
                py1 = int(max(0, (person["y"] - person["h"] / 2) * h))
                px2 = int(min(w - 1, (person["x"] + person["w"] / 2) * w))
                py2 = int(min(h - 1, (person["y"] + person["h"] / 2) * h))
                cv2.rectangle(annotated, (px1, py1), (px2, py2), (255, 140, 0), 2)
                cv2.putText(annotated, f"PERSON #{cand.person_id} (Left scene)", (px1, max(20, py1 - 8)),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 140, 0), 2, cv2.LINE_AA)

                # Line connecting drop position to current person position
                cv2.line(annotated, (int(wx * w), int(wy * h)), (int(person["x"] * w), int(person["y"] * h)),
                         (0, 165, 255), 2, cv2.LINE_AA)

            # 4. Draw Header Overlay Banner
            banner_h = 50
            overlay = annotated.copy()
            cv2.rectangle(overlay, (0, 0), (w, banner_h), (0, 0, 160), -1)
            cv2.addWeighted(overlay, 0.75, annotated, 0.25, 0, annotated)

            banner_text = f"ILLEGAL DUMPING CONFIRMED | ID: {incident_id} | Person #{cand.person_id} -> Waste #{cand.waste_id}"
            sub_text = f"Stationary: {elapsed:.1f}s | Separation: {cand.max_dist:.2f} | Time: {time.strftime('%Y-%m-%d %H:%M:%S')}"
            cv2.putText(annotated, banner_text, (16, 22), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2, cv2.LINE_AA)
            cv2.putText(annotated, sub_text, (16, 42), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (220, 220, 220), 1, cv2.LINE_AA)

            # Encode to JPEG
            ok, buf = cv2.imencode(".jpg", annotated, [cv2.IMWRITE_JPEG_QUALITY, 85])
            if ok:
                return buf.tobytes(), annotated
            return None, annotated
        except Exception as e:
            self.log(f"Failed to generate annotated snapshot: {e}")
            return None, None

    def export_evidence_video(self, output_path: str, fps: int = 15) -> bool:
        """Export buffered frames to an evidence video file (e.g. .mp4 or .avi)."""
        if len(self.frame_buffer) < 5:
            return False
        try:
            import cv2
            first_frame = self.frame_buffer[0][1]
            h, w = first_frame.shape[:2]
            fourcc = cv2.VideoWriter_fourcc(*"mp4v")
            writer = cv2.VideoWriter(output_path, fourcc, fps, (w, h))
            if not writer.isOpened():
                fourcc = cv2.VideoWriter_fourcc(*"MJPG")
                writer = cv2.VideoWriter(output_path, fourcc, fps, (w, h))

            for _, frame in self.frame_buffer:
                writer.write(frame)
            writer.release()
            self.log(f"Saved evidence video clip: {output_path} ({len(self.frame_buffer)} frames)")
            return True
        except Exception as e:
            self.log(f"Failed to export evidence video: {e}")
            return False

    def reset(self):
        """Reset internal state, tracking candidates, and buffer."""
        self.candidates.clear()
        self.frame_buffer.clear()
        self.current_state = DumpingState.IDLE
        self.log("Temporal Dumping Engine reset.")
