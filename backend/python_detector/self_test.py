"""
Self-test for the ByteTrack tracker + movement + TemporalDumpingEngine pipeline.
Run:  python self_test.py
Validates:
  1. ByteTrack + Movement tracking (stable IDs, trajectories)
  2. Full Temporal Event State Flow:
     IDLE -> PERSON_DETECTED -> PERSON_NEAR_WASTE -> WASTE_PLACED -> PERSON_LEFT -> WASTE_STATIONARY -> DUMPING_CONFIRMED
  3. Negative Test 1: Person returns to waste (cancels dumping confirmation)
  4. Negative Test 2: Stationary waste without person presence (no dumping alert)
  5. Negative Test 3: Spatial Cooldown (suppresses duplicate alerts within radius)
"""
import sys
if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import tracker
import movement
import temporal_engine


def moving_person(frame, x0=0.2, dx=0.02, y=0.5):
    """Simulate a person walking across the frame."""
    return {
        "class": "person",
        "confidence": 0.92,
        "x": round(x0 + frame * dx, 4),
        "y": round(y, 4),
        "w": 0.08,
        "h": 0.25,
        "is_person": True,
        "is_waste": False,
    }


def bag_on_ground(frame, start_frame=5, x=0.55, y=0.6):
    """Simulate a stationary trash bag appearing at start_frame."""
    if frame < start_frame:
        return None
    return {
        "class": "trash",
        "confidence": 0.85,
        "x": round(x, 4),
        "y": round(y, 4),
        "w": 0.10,
        "h": 0.08,
        "is_person": False,
        "is_waste": True,
    }


def test_bytetrack_and_movement():
    print("\n--- Test 1: ByteTrack + Movement Tracking ---")
    t = tracker.ByteTrackTracker(track_history=30, min_hits=2)
    mv = movement.MovementTracker()

    person_tid = None
    bag_tid = None
    prev_px = None

    for frame in range(12):
        dets = [moving_person(frame)]
        b = bag_on_ground(frame, start_frame=5)
        if b:
            dets.append(b)

        tracked = mv.update(t.update(dets))
        for tr in tracked:
            if tr["class"] == "person":
                person_tid = tr["track_id"]
                prev_px = tr["x"]
            elif tr["class"] == "trash":
                bag_tid = tr["track_id"]

    assert person_tid is not None, "person track never created"
    assert bag_tid is not None and bag_tid != person_tid, "trash bag failed to receive unique track ID"
    assert prev_px > 0.4, "person displacement not tracked"
    print(f"[PASS] ByteTrack stable IDs: Person #{person_tid}, Waste #{bag_tid}")


def test_full_temporal_dumping_flow():
    print("\n--- Test 2: Temporal Dumping Event State Machine (Complete Flow) ---")
    t = tracker.ByteTrackTracker(track_history=30, min_hits=2)
    mv = movement.MovementTracker()
    engine = temporal_engine.TemporalDumpingEngine(
        proximity_threshold=0.20,
        leave_distance_threshold=0.30,
        stationary_duration_sec=3.0, # 3 seconds for test
        stationary_drift_tol=0.05,
        debug=False,
    )

    confirmed_events = []
    # 25 frames simulated at 0.5s per frame = 12.5 seconds total
    # Frames 0-4: Person walking towards drop site (x: 0.35 -> 0.51)
    # Frames 5-8: Person drops bag at (0.55, 0.6) and is near it (dist ~0.10)
    # Frames 9-14: Person walks away (x: 0.65 -> 0.90), distance > 0.30
    # Frames 15-24: Bag remains stationary for > 3.0 seconds
    for frame in range(25):
        sim_time = frame * 0.5
        dets = []

        # Person enters and moves across
        if frame < 15:
            dets.append(moving_person(frame, x0=0.35, dx=0.04, y=0.55))

        # Bag appears at frame 5 at (0.55, 0.60) and stays there
        if frame >= 5:
            dets.append({
                "class": "trash",
                "confidence": 0.88,
                "x": 0.55,
                "y": 0.60,
                "w": 0.10,
                "h": 0.08,
                "is_person": False,
                "is_waste": True,
            })

        tracked = mv.update(t.update(dets))
        res = engine.update(tracked, timestamp=sim_time)

        if res.get("confirmed_incidents"):
            confirmed_events.extend(res["confirmed_incidents"])

    assert len(confirmed_events) == 1, f"Expected exactly 1 confirmed dumping incident, got {len(confirmed_events)}"
    inc = confirmed_events[0]
    assert inc["stationary_duration"] >= 3.0, f"Expected stationary >= 3.0s, got {inc['stationary_duration']}"
    assert inc["state"] == temporal_engine.DumpingState.DUMPING_CONFIRMED
    print(f"[PASS] Confirmed Incident: {inc['incident_id']} (Stationary: {inc['stationary_duration']}s, Leave dist: {inc['leave_distance']:.2f})")


def test_negative_pickup_retrieval():
    print("\n--- Test 3: Negative Test - Person Returns and Picks Up Waste ---")
    t = tracker.ByteTrackTracker(track_history=30, min_hits=2)
    mv = movement.MovementTracker()
    engine = temporal_engine.TemporalDumpingEngine(
        proximity_threshold=0.20,
        leave_distance_threshold=0.30,
        stationary_duration_sec=3.0,
        debug=False,
    )

    confirmed_events = []
    # Person drops bag, steps back slightly, then returns and stands next to it
    for frame in range(15):
        sim_time = frame * 0.5
        dets = []

        # Person steps away at frame 6 then returns at frame 8
        px = 0.50 if frame < 6 else (0.75 if frame < 8 else 0.52)
        dets.append({
            "class": "person",
            "confidence": 0.90,
            "x": px,
            "y": 0.55,
            "w": 0.08,
            "h": 0.25,
            "is_person": True,
            "is_waste": False,
        })

        dets.append({
            "class": "trash",
            "confidence": 0.85,
            "x": 0.52,
            "y": 0.60,
            "w": 0.10,
            "h": 0.08,
            "is_person": False,
            "is_waste": True,
        })

        tracked = mv.update(t.update(dets))
        res = engine.update(tracked, timestamp=sim_time)
        if res.get("confirmed_incidents"):
            confirmed_events.extend(res["confirmed_incidents"])

    assert len(confirmed_events) == 0, "Person returned to object; dumping should NOT have triggered!"
    print("[PASS] Negative test passed: No false incident when person returns to object.")


def test_negative_stationary_without_person():
    print("\n--- Test 4: Negative Test - Static Object Without Person Event ---")
    t = tracker.ByteTrackTracker(track_history=30, min_hits=2)
    mv = movement.MovementTracker()
    engine = temporal_engine.TemporalDumpingEngine(
        proximity_threshold=0.20,
        stationary_duration_sec=3.0,
        debug=False,
    )

    confirmed_events = []
    # A bag sitting statically for 20 frames with NO person in the scene
    for frame in range(20):
        sim_time = frame * 0.5
        dets = [{
            "class": "trash",
            "confidence": 0.85,
            "x": 0.20,
            "y": 0.80,
            "w": 0.10,
            "h": 0.08,
            "is_person": False,
            "is_waste": True,
        }]

        tracked = mv.update(t.update(dets))
        res = engine.update(tracked, timestamp=sim_time)
        if res.get("confirmed_incidents"):
            confirmed_events.extend(res["confirmed_incidents"])

    assert len(confirmed_events) == 0, "Static object without person interaction should NOT trigger dumping!"
    print("[PASS] Negative test passed: No false incident on existing static background objects.")


def test_spatial_cooldown():
    print("\n--- Test 5: Spatial Cooldown & Duplicate Suppression ---")
    engine = temporal_engine.TemporalDumpingEngine(
        cooldown_minutes=15.0,
        spatial_cooldown_radius=0.08,
        debug=False,
    )

    now = 1000.0
    engine.register_confirmed_cooldown((0.55, 0.60), now, "INC-001")

    # Near same location (dist = 0.03 < 0.08) 2 minutes later
    cooled_down, remaining = engine.is_spatially_cooled_down((0.57, 0.61), now + 120.0)
    assert cooled_down, "Spatial cooldown should suppress nearby alert within cooldown window"
    print(f"[PASS] Duplicate alert suppressed by spatial cooldown ({remaining:.1f}m remaining)")

    # Far location (dist > 0.08) should NOT be cooled down
    cooled_down_far, _ = engine.is_spatially_cooled_down((0.80, 0.20), now + 120.0)
    assert not cooled_down_far, "Unrelated distant location should NOT be suppressed"
    print("[PASS] Distant location not affected by spatial cooldown")


def main():
    print("=" * 60)
    print("  TEMPORAL ILLEGAL DUMPING ENGINE - COMPREHENSIVE SELF-TEST")
    print("=" * 60)

    test_bytetrack_and_movement()
    test_full_temporal_dumping_flow()
    test_negative_pickup_retrieval()
    test_negative_stationary_without_person()
    test_spatial_cooldown()

    print("\n" + "=" * 60)
    print("  ALL 5 SELF-TEST SUITES PASSED SUCCESSFULLY [OK]")
    print("=" * 60)
    return 0


if __name__ == "__main__":
    sys.exit(main())