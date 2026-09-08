# Python Detection Service

The **ML layer** of the Smart Waste Dumping Detection system, written in Python.

The Node.js backend (`services/roboflow.js`, `ROBOFLOW_MODE=python`) forwards every
camera frame to this service over HTTP. This service runs object detection and returns
normalized detections in the exact canonical shape the classification logic expects:

```json
{
  "backend": "yolov8+bytetrack",
  "detections": [
    { "class": "garbage", "confidence": 0.91, "x": 0.52, "y": 0.63, "w": 0.24, "h": 0.31 }
  ],
  "tracks": [
    {
      "track_id": 3,
      "class": "person",
      "confidence": 0.87,
      "x": 0.5, "y": 0.4, "w": 0.1, "h": 0.3,
      "age": 12, "hits": 12,
      "history": [[0.3, 0.2], [0.4, 0.25], [0.5, 0.3]],
      "movement": {
        "direction": "moving",
        "speed": 0.012,
        "displacement": 0.2,
        "compass": "east",
        "trail": [[0.3, 0.2], [0.4, 0.25], [0.5, 0.3]],
        "frames": 3
      }
    }
  ],
  "took_ms": 87
}
```

(`x`, `y` are the box **center**, all in 0..1 relative to the frame size.)

## What it does

1. **YOLO-World open-vocabulary object detection** — `ultralytics` runs the active model
   (`yolov8s-worldv2.pt`, ~25MB, auto-downloaded on first use). Because it is
   open-vocabulary, nothing needs to be trained: the model is prompted with
   `person` + the `WASTE_CLASSES` vocabulary and detects any object matching those
   words, fully offline with no API cost. (A fine-tuned closed-class model such as
   `waste_model.pt` also works — set `OPEN_VOCABULARY=0`.)
2. **ByteTrack multi-object tracking** — every object gets a stable `track_id` across
   frames (Kalman filter + IoU/Hungarian matching, high+low confidence two-stage).
3. **Movement analysis** — per-track position history produces a `movement` profile:
   direction, speed, displacement, compass bearing and the trajectory `trail`.

The **detections** array feeds the existing Node zone classification (`classification.js`);
the **tracks** array powers the live overlay trail/arrow visualisation.

## Setup

```bash
cd backend/python_detector
pip install -r requirements.txt
```

## Run

```bash
python detector.py
# or:  python -m uvicorn detector:app --host 127.0.0.1 --port 8001
```

Health check: <http://127.0.0.1:8001/health>

## Self-test (no camera needed)

```bash
python self_test.py          # validates ByteTrack + movement with synthetic detections
python multi_frame_test.py   # live HTTP test (service running) - send 6 frames, watch track IDs
```

## Configuration (env)

| Variable | Default | Purpose |
|----------|---------|---------|
| `DETECTOR_BACKEND` | `yolov8` | `yolov8` (RECOMMENDED), `roboflow`, or `local` (raw ONNX) |
| `LOCAL_MODEL_PATH` | `yolov8s-worldv2.pt` | **Active model**: the YOLO-World open-vocabulary weights (`.pt`). Auto-downloads once via ultralytics if missing. |
| `OPEN_VOCABULARY` | `1` | `1` = YOLO-World open-vocabulary mode: person + every class in `WASTE_CLASSES` as prompt; `0` = run a closed-class custom model (e.g. `waste_model.pt` after training) |
| `WASTE_CLASSES` | `garbage,trash_bag,plastic_bag,waste` | Waste vocabulary the open-vocabulary model must detect (person is added automatically) |
| `LOCAL_NAMES` | — | Optional comma-separated class filter |
| `ENABLE_TRACKING` | `1` | `1` = ByteTrack + movement + temporal dumping engine, `0` = detection only |
| `TRACK_HISTORY` | `30` | Frames of position history kept per tracked object |
| `ROBOFLOW_CONFIDENCE` | `0.25` | detection confidence threshold (0.25 recommended for open-vocabulary) |
| `PYTHON_DETECTOR_URL` | `http://127.0.0.1:8001/detect` | URL the **Node** service posts frames to |
| `ROBOFLOW_MODE` | `model` | `model` (trained version) or `workflow` (SAM 3) — only for `roboflow` backend |
| `ROBOFLOW_API_KEY` | — | your Roboflow private API key (roboflow backend) |
| `ROBOFLOW_MODEL_ID` | — | `<project>/<version>` for the model endpoint |

The Python service **reads these from its own environment** (`.env` in this folder). The
Node service only needs `ROBOFLOW_MODE=python` and `PYTHON_DETECTOR_URL`.

### Active model

Out of the box the service builds with the **YOLO-World open-vocabulary** model
(`LOCAL_MODEL_PATH=yolov8s-worldv2.pt`, `OPEN_VOCABULARY=1`). No training dataset or
Roboflow keys are required — the vocabulary in `WASTE_CLASSES` is used as the detection
prompt. The detector service was started and verified with this model; `GET /health` and
`POST /detect` both return 200 with the canonical payload.

## After you train your own waste model

1. Export the trained Roboflow weights to YOLO format (`.pt`) or leave as ONNX.
2. Point `LOCAL_MODEL_PATH` at it and set `LOCAL_NAMES=your,class,names`.
3. Restart the Python service. Node needs no change.

For the older hosted path, set `DETECTOR_BACKEND=roboflow` + `ROBOFLOW_MODE=model` +
`ROBOFLOW_MODEL_ID=<your-project>/<version>` and restart.

## API

- `POST /detect` — multipart form: `file` (image bytes), `width`, `height`.
  Returns `{ detections, tracks, backend, took_ms }`.
- `GET /health` — liveness/backend info.
