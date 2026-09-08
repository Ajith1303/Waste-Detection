"""
Python Detection Service - the ML layer for the Smart Waste Dumping system.

The Node.js backend forwards every camera frame here via POST /detect.
This service runs object detection and returns a NORMALIZED (0..1) array of
detections in the exact canonical shape the Node classification logic expects:

    [ { class, confidence, x, y, w, h } ]      (x,y = box CENTER, 0..1)

Two detection backends (env DETECTOR_BACKEND):
  - "roboflow"  (default) : calls your trained Roboflow model or SAM workflow.
                            env: ROBOFLOW_MODE  model|workflow
                                 ROBOFLOW_MODEL_ID, ROBOFLOW_API_KEY, ...
  - "local"     : runs a local ONNX model (YOLOv8 exported from your trained
                  Roboflow dataset). env: LOCAL_MODEL_PATH=/path/to/model.onnx
                  + LOCAL_NAMES=class0,class1,...

Why Python? The ML ecosystem (YOLO, ONNX, torch, dataset tooling) is much
stronger here than in Node. Once your Roboflow training (TRAINING_GUIDE.md) is
done you can either keep the hosted "roboflow" backend or export the model to
ONNX and run it fully locally ("local") - zero per-frame API cost.
"""

import sys
if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

import os
import json
import base64
import time
import urllib.request
import urllib.error

from fastapi import FastAPI, UploadFile, File, Form
from pydantic import BaseModel


def _load_dotenv(path):
    """Load KEY=VALUE lines from the detector's own .env file.

    For a self-contained microservice the file beats the inherited process env
    (avoids accidental leaks like ROBOFLOW_MODE=python from a parent shell).
    Explicitly passing env on the command line still works by editing .env.
    """
    if not os.path.exists(path):
        return
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            key, val = key.strip(), val.strip().strip('"').strip("'")
            if key:
                os.environ[key] = val


# Load python_detector/.env if present (config for the ML layer lives here).
_load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))

app = FastAPI(title="Waste Detection Service", version="1.0")


def clamp01(v):
    return min(1.0, max(0.0, v))
# ============================ Roboflow backend =============================
def _call_roboflow(image_bytes: bytes):
    """Call Roboflow hosted inference (model OR SAM workflow). Returns the raw
    prediction JSON object."""
    mode = (os.environ.get("ROBOFLOW_MODE", "model") or "").lower()
    key = os.environ.get("ROBOFLOW_API_KEY", "").strip()
    if not key:
        raise RuntimeError("ROBOFLOW_API_KEY is not set for the roboflow backend")

    url = None
    headers = {}
    body = None

    if mode == "workflow":
        workspace = os.environ.get("ROBOFLOW_WORKSPACE", "").strip()
        workflow_id = os.environ.get("ROBOFLOW_WORKFLOW_ID", "").strip()
        classes = [
            c.strip()
            for c in os.environ.get("ROBOFLOW_WORKFLOW_CLASSES", "").split(",")
            if c.strip()
        ]
        if not workspace or not workflow_id or not classes:
            raise RuntimeError(
                "ROBOFLOW_WORKSPACE / ROBOFLOW_WORKFLOW_ID / ROBOFLOW_WORKFLOW_CLASSES "
                "are required for workflow mode"
            )
        b64 = base64.b64encode(image_bytes).decode("ascii")
        url = f"https://serverless.roboflow.com/infer/workflows/{workspace}/{workflow_id}"
        headers = {"Content-Type": "application/json", "Authorization": f"Bearer {key}"}
        body = json.dumps(
            {"inputs": {"image": {"type": "base64", "value": b64}, "classes": classes}}
        ).encode("utf-8")
    else:  # model
        model_id = os.environ.get("ROBOFLOW_MODEL_ID", "").strip()
        if not model_id:
            raise RuntimeError("ROBOFLOW_MODEL_ID is not set (trained model version)")
        # Host inference requires the fully-qualified model string:
        #   workspace/project/version  (e.g. ajith-m-jqkia/illegal-dumping-detection-a5otx/1)
        # ROBOFLOW_MODEL_ID may be given as "project/version" (workspace-relative).
        ws = os.environ.get("ROBOFLOW_WORKSPACE", "").strip()
        parts = [p for p in model_id.split("/") if p]
        if len(parts) == 3:
            # Model id already fully qualified (workspace/project/version).
            qualified = model_id
        elif len(parts) == 2 and ws:
            qualified = f"{ws}/{model_id}"
        elif len(parts) == 2:
            # No workspace configured -> ask the API which workspace owns this key.
            try:
                who = json.loads(
                    urllib.request.urlopen(
                        f"https://api.roboflow.com/?api_key={key}", timeout=20
                    ).read().decode("utf-8")
                )
                auto_ws = (who.get("workspace") or "").strip()
            except Exception:
                auto_ws = ""
            if not auto_ws:
                raise RuntimeError(
                    "Cannot resolve workspace for ROBOFLOW_MODEL_ID; set "
                    "ROBOFLOW_WORKSPACE (your Roboflow workspace name) in python_detector/.env"
                )
            qualified = f"{auto_ws}/{model_id}"
        else:
            raise RuntimeError(
                f"ROBOFLOW_MODEL_ID must be '<project>/<version>' or "
                f"'<workspace>/<project>/<version>', got '{model_id}'"
            )
        # Try serverless cloud first, then legacy detect endpoint.
        url = f"https://serverless.roboflow.com/{qualified}"
        headers = {
            "Authorization": f"Bearer {key}",
            "Content-Type": "multipart/form-data; boundary=rf-frame",
        }
        body = None  # set per attempt

    fd = (
        b"--rf-frame\r\n"
        b'Content-Disposition: form-data; name="file"; filename="frame.jpg"\r\n'
        b"Content-Type: image/jpeg\r\n\r\n"
    )
    tail = b"\r\n--rf-frame--\r\n"

    def attempt(target_url, hdrs, payload):
        if payload is None:
            payload = fd + image_bytes + tail
        req = urllib.request.Request(target_url, data=payload, headers=hdrs, method="POST")
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode("utf-8"))

    attempts = [url]
    if mode != "workflow":
        legacy = f"https://detect.roboflow.com/{qualified}?api_key={key}"
        attempts.append(legacy)

    last_err = None
    for i, target in enumerate(attempts):
        try:
            hdrs = dict(headers)
            payload = body
            if i > 0:  # legacy fallback
                hdrs = {"Content-Type": "application/octet-stream"}
                payload = image_bytes
            return attempt(target, hdrs, payload)
        except (urllib.error.HTTPError, urllib.error.URLError, json.JSONDecodeError) as e:
            last_err = e
            if i + 1 < len(attempts):
                time.sleep(1.0)
    raise RuntimeError(f"Roboflow call failed: {last_err}")
def _normalize_roboflow(payload, img_w, img_h):
    """Flatten a Roboflow response (model or workflow) into normalized detections."""
    results = []
    if isinstance(payload, list):
        preds = payload
    elif isinstance(payload, dict):
        # model endpoint:  { predictions: [...], image: {...} }
        # workflow:        { outputs: [ { predictions: [...] } ] } or
        #                  { outputs: [ { predictions: { predictions: [...] } } ] }
        preds = payload.get("predictions", [])
        if not preds and isinstance(payload.get("outputs"), list):
            inner = payload["outputs"][0]
            preds = inner.get("predictions", [])
            if isinstance(preds, dict):  # wrapped { image:..., predictions: [...] }
                preds = preds.get("predictions", [])
    else:
        preds = []

    size_w = img_w or 1280
    size_h = img_h or 720
    for p in preds:
        if not isinstance(p, dict):
            continue
        x, y = p.get("x"), p.get("y")
        if not isinstance(x, (int, float)) or not isinstance(y, (int, float)):
            continue
        w = p.get("width", p.get("w", 0)) or 0
        h = p.get("height", p.get("h", 0)) or 0
        conf = p.get("confidence", p.get("score", 0)) or 0
        # Normalized-in detection already? SAM returns pixel coords.
        already = x <= 1.0 and y <= 1.0 and w <= 1.0 and h <= 1.0
        if not already:
            x, w = x / size_w, w / size_w
            y, h = y / size_h, h / size_h
        results.append(
            {
                "class": p.get("class", "object"),
                "confidence": float(conf),
                "x": clamp01(x),
                "y": clamp01(y),
                "w": clamp01(max(0.0, w)),
                "h": clamp01(max(0.0, h)),
            }
        )
    return results
# ============================== Local backend ==============================
_LOADED = None


def _load_local():
    """Load a local ONNX object-detection model (YOLOv8 format)."""
    global _LOADED
    import numpy as np

    if _LOADED is not None:
        return _LOADED

    model_path = os.environ.get("LOCAL_MODEL_PATH", "").strip()
    if model_path and not os.path.isabs(model_path):
        # Resolve relative paths against this module's folder, not the CWD, so
        # the service works no matter where it is launched from.
        model_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), model_path)
    if not model_path or not os.path.exists(model_path):
        raise RuntimeError(
            "LOCAL_MODEL_PATH does not exist. Export your trained Roboflow model to "
            "ONNX (roboflow export guide) or keep DETECTOR_BACKEND=roboflow."
        )

    try:
        import onnxruntime as ort
    except ImportError:
        raise RuntimeError("onnxruntime not installed - run: pip install onnxruntime")

    names_raw = os.environ.get("LOCAL_NAMES", "").strip().split(",")
    names = [n.strip() for n in names_raw if n.strip()]
    session = ort.InferenceSession(model_path, providers=["CPUExecutionProvider"])
    _LOADED = {"session": session, "names": names, "np": np}
    return _LOADED


def _run_local(image_bytes: bytes):
    """Run the local ONNX model. Returns normalized detections in canonical form."""
    state = _load_local()
    np = state["np"]
    try:
        import cv2
    except ImportError:
        raise RuntimeError("opencv-python not installed - run: pip install opencv-python")

    # decode image (bytes -> BGR ndarray), YOLO wants HxWx3 float RGB
    nparr = np.frombuffer(image_bytes, np.uint8)
    img_bgr = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    if img_bgr is None:
        raise RuntimeError("Local backend could not decode the image (bad jpeg?)")
    img_h, img_w = img_bgr.shape[:2]
    rgb = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)
    model_in = np.expand_dims(rgb / 255.0, axis=0).astype(np.float32)

    session = state["session"]
    input_name = session.get_inputs()[0].name
    outputs = session.run(None, {input_name: model_in})[0]  # [1, 84, 8400]

    preds = outputs[0]  # (84, 8400): rows = 4 bbox + 80 class probs
    coords = preds[:4, :].T          # (8400, 4) normalized xywh
    scores = preds[4:, :].T          # (8400, 80)

    names = state["names"] or [f"class{i}" for i in range(scores.shape[1])]
    detections = []
    conf_thr = float(os.environ.get("ROBOFLOW_CONFIDENCE", "0.45"))
    for i in range(coords.shape[0]):
        row = scores[i]
        cls_idx = int(row.argmax())
        conf = float(row[cls_idx])
        if conf < conf_thr:
            continue
        cx, cy, w, h = coords[i]
        detections.append(
            {
                "class": names[cls_idx] if cls_idx < len(names) else f"class{cls_idx}",
                "confidence": conf,
                "x": clamp01(float(cx)),
                "y": clamp01(float(cy)),
                "w": clamp01(float(w)),
                "h": clamp01(float(h)),
            }
        )
    return detections
# ============================== HTTP endpoint ==============================
class DetectRequest(BaseModel):
    width: int = 1280
    height: int = 720


@app.post("/detect")
async def detect(
    file: UploadFile = File(...),
    width: int = Form(1280),
    height: int = Form(720),
    zone_box_json: str = Form(None),
):
    """Detection and temporal event tracking entrypoint called by the Node backend.

    Returns: { detections, tracks, temporal_state, candidates, confirmed_incidents, backend, took_ms }
    """
    image_bytes = await file.read()
    if not image_bytes:
        return {"error": "empty image", "detections": []}

    backend = (os.environ.get("DETECTOR_BACKEND", "yolov8") or "").lower().strip()
    t0 = time.time()
    try:
        zone_box = None
        if zone_box_json:
            try:
                zone_box = json.loads(zone_box_json)
            except Exception:
                pass

        if backend in ("yolo", "yolov8"):
            import yolo_backend
            det = yolo_backend.get_detector()
            detections, img_np = det.detect(image_bytes)
            # Enrich with ByteTrack + movement (when ENABLE_TRACKING=1)
            tracks = det.track(detections)
            # Run multi-frame Temporal State Engine
            temporal_res = det.update_temporal(tracks, frame_img=img_np, zone_box=zone_box)
            took = int((time.time() - t0) * 1000)

            # Format confirmed incidents for JSON response (base64 encode snapshots)
            incidents_payload = []
            for inc in temporal_res.get("confirmed_incidents", []):
                inc_dict = dict(inc)
                if inc_dict.get("evidence_image_bytes"):
                    inc_dict["evidence_image_b64"] = base64.b64encode(inc_dict["evidence_image_bytes"]).decode("ascii")
                    del inc_dict["evidence_image_bytes"]
                if "evidence_image_np" in inc_dict:
                    del inc_dict["evidence_image_np"]
                incidents_payload.append(inc_dict)

            return {
                "backend": "yolov8+bytetrack+temporal",
                "detections": detections,
                "tracks": tracks,
                "temporal_state": temporal_res.get("state", "IDLE"),
                "candidates": temporal_res.get("candidates", []),
                "confirmed_incidents": incidents_payload,
                "took_ms": took,
            }
        elif backend == "local":
            detections = _run_local(image_bytes)
            return {
                "backend": backend,
                "detections": detections,
                "tracks": [],
                "temporal_state": "IDLE",
                "confirmed_incidents": [],
                "took_ms": int((time.time() - t0) * 1000),
            }
        elif backend == "roboflow":
            payload = _call_roboflow(image_bytes)
            detections = _normalize_roboflow(payload, width, height)
            return {
                "backend": backend,
                "detections": detections,
                "tracks": [],
                "temporal_state": "IDLE",
                "confirmed_incidents": [],
                "took_ms": int((time.time() - t0) * 1000),
            }
        else:
            return {"error": f"unknown DETECTOR_BACKEND {backend!r}", "detections": []}
    except Exception as e:
        return {"error": str(e), "backend": backend, "detections": []}


@app.post("/reset")
def reset():
    """Reset tracker and temporal state machine."""
    try:
        import yolo_backend
        det = yolo_backend.get_detector()
        det.reset()
        return {"ok": True, "message": "Tracker and temporal state reset."}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@app.get("/health")
def health():
    return {
        "ok": True,
        "service": "waste-detector",
        "backend": os.environ.get("DETECTOR_BACKEND", "yolov8"),
        "temporal_engine": "active",
    }


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PYTHON_DETECTOR_PORT", "8001"))
    backend = os.environ.get("DETECTOR_BACKEND", "yolov8")
    print(f"Waste Detector service -> http://127.0.0.1:{port} (DETECTOR_BACKEND={backend})")
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")