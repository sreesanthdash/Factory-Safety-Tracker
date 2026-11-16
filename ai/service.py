"""Local-only YOLO inference service for the Factory Safety Console."""

from __future__ import annotations

import base64
import binascii
import json
import logging
import os
import threading
import time
from collections import deque
from pathlib import Path
from typing import Any

import cv2
import numpy as np
import supervision as sv
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from trackers import ByteTrackTracker
from ultralytics import YOLO
from .model_cache import cached_model_directory


ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / ".env.local")


def configured_path(key: str) -> Path | None:
    value = os.getenv(key, "").strip().strip('"').strip("'")
    if not value:
        return None
    path = Path(value).expanduser()
    return path if path.is_absolute() else (ROOT / path).resolve()


MODEL_PATHS = {
    "ppe": configured_path("PPE_MODEL_PATH"),
    # Fire/smoke detection works out of the box after running
    # ai/download_hazard_model.py. A custom spark model supplements it.
    "hazards": ROOT / "ai" / "models" / "hazards" / "fire_smoke.pt",
    "custom_hazards": configured_path("HAZARD_MODEL_PATH"),
    "pose": configured_path("POSE_MODEL_PATH") or ROOT / "ai" / "models" / "pose" / "yolo26n-pose.pt",
    "action": configured_path("ACTION_MODEL_PATH"),
}
MODELS: dict[str, YOLO] = {}
MODEL_ERRORS: dict[str, str] = {}
TRACKERS: dict[str, tuple[ByteTrackTracker, float]] = {}
ACTION_FRAMES: dict[str, deque[tuple[float, np.ndarray]]] = {}
ACTION_CALLS: dict[str, int] = {}
ACTION_CONFIRMATIONS: dict[str, tuple[str, int, list[int], float]] = {}
ACTION_MODEL: Any = None
ACTION_PROCESSOR: Any = None
ACTION_MODEL_SIGNATURE: tuple[tuple[str, int, int], ...] | None = None
ACTION_ERROR = ""
ACTION_REPO = os.getenv("ACTION_MODEL_ID", "MCG-NJU/videomae-base-finetuned-kinetics")
ACTION_LOCK = threading.RLock()
ACTION_FRAME_COUNT = int(os.getenv("ACTION_FRAME_COUNT", "16"))
ACTION_INFER_EVERY = max(1, int(os.getenv("ACTION_INFER_EVERY", "1")))
ACTION_FIGHT_MIN_CONFIDENCE = float(os.getenv("ACTION_FIGHT_MIN_CONFIDENCE", "0.78"))
ACTION_FALL_MIN_CONFIDENCE = float(os.getenv("ACTION_FALL_MIN_CONFIDENCE", "0.45"))
ACTION_CONFIRM_WINDOW = float(os.getenv("ACTION_CONFIRM_WINDOW", "8"))
INFERENCE_LOCK = threading.RLock()
LOGGER = logging.getLogger("uvicorn.error")

app = FastAPI(title="Factory Safety Local Vision", docs_url=None, redoc_url=None)


class FrameRequest(BaseModel):
    cameraId: str = Field(min_length=1, max_length=100)
    imageBase64: str = Field(min_length=16, max_length=5_500_000)


def model_status(key: str) -> dict[str, Any]:
    path = MODEL_PATHS[key]
    error = MODEL_ERRORS.get(key)
    return {
        "ready": bool(path and path.is_file() and not error),
        "configured": bool(path),
        "loaded": key in MODELS,
        "error": error,
    }


def action_model_cached() -> bool:
    if MODEL_PATHS["action"]:
        return all((MODEL_PATHS["action"] / filename).is_file() for filename in ("config.json", "preprocessor_config.json", "model.safetensors"))
    return cached_model_directory(ACTION_REPO) is not None


def action_checkpoint_labels() -> list[str]:
    path = MODEL_PATHS["action"]
    config_path = path / "config.json" if path else None
    if not config_path or not config_path.is_file():
        return []
    try:
        config = json.loads(config_path.read_text(encoding="utf-8"))
        return sorted({str(label).lower().strip() for label in config.get("id2label", {}).values()})
    except (OSError, ValueError, AttributeError):
        return []


def action_model_signature() -> tuple[tuple[str, int, int], ...] | None:
    path = MODEL_PATHS["action"]
    if not path or not path.is_dir():
        return None
    signature = []
    for name in ("config.json", "preprocessor_config.json", "model.safetensors"):
        try:
            item = (path / name).stat()
        except OSError:
            return None
        signature.append((name, item.st_mtime_ns, item.st_size))
    return tuple(signature)


def health_payload() -> dict[str, Any]:
    ppe = model_status("ppe")
    hazards = model_status("hazards")
    custom_hazards = model_status("custom_hazards")
    pose = model_status("pose")
    action_ready = bool(ACTION_MODEL is not None or action_model_cached())
    action_labels = action_checkpoint_labels()
    fall_trained = any("fall" in label for label in action_labels)
    fight_trained = any(label in {"fight", "fighting", "violence", "violent"} for label in action_labels)
    action = {
        "ready": action_ready and not ACTION_ERROR,
        "configured": bool(MODEL_PATHS["action"] or ACTION_REPO),
        "loaded": ACTION_MODEL is not None,
        "name": "VideoMAE action classifier",
        "trainedForSiteSafety": fall_trained or fight_trained,
        "trainedClasses": action_labels,
        "fallTrained": fall_trained,
        "fightTrained": fight_trained,
        "genericFightCue": False,
        "detail": ACTION_ERROR or (
            f"Fine-tuned classes: {', '.join(action_labels)}. Generic Kinetics predictions are not used to create safety incidents."
            if MODEL_PATHS["action"]
            else "Generic Kinetics weights are not used to create safety incidents. Configure a fine-tuned VideoMAE checkpoint with labeled fall/fight classes."
            if action_ready
            else "VideoMAE weights are not cached yet. Run ai/download_videomae.py while online, or set ACTION_MODEL_PATH to a local fine-tuned model folder."
        ),
    }
    enabled = ppe["ready"] or hazards["ready"] or custom_hazards["ready"] or pose["ready"] or action["ready"]
    message = ""
    if not enabled:
        message = "No local vision weights are configured. Add YOLO26n-Pose and VideoMAE action weights, or configure the PPE model."
    hazard_detail = MODEL_ERRORS.get("hazards") or (
        "Local fire/smoke weights are missing. Run ai/download_hazard_model.py. Spark/arc video detection requires a spark-labeled custom model; connected electrical sensors can raise those alerts now."
        if not hazards["ready"]
        else "Fire and smoke detection is ready. Electrical spark/arc detections are accepted from a custom hazard checkpoint or a connected sensor."
    )
    hazards["detail"] = hazard_detail
    custom_hazards["detail"] = MODEL_ERRORS.get("custom_hazards") or (
        "Optional spark/arc detector is configured. It runs alongside the fire/smoke detector."
        if custom_hazards["ready"]
        else "No custom spark/arc weights configured. Set HAZARD_MODEL_PATH after training; connected electrical sensors can still raise alerts."
    )
    return {
        "available": True,
        "enabled": enabled,
        "message": message,
        "models": {
            "ppe": {**ppe, "name": "YOLO26 Construction-PPE"},
            "hazards": {**hazards, "name": "YOLO26 fire/smoke detector"},
            "customHazards": {**custom_hazards, "name": "Custom spark/arc detector"},
            "pose": {**pose, "name": "YOLO26n-Pose", "keypoints": 17},
            "tracking": {"ready": True, "name": "ByteTrack", "scope": "one tracker per camera"},
            "action": action,
        },
    }


def load_model(key: str) -> YOLO | None:
    if key in MODELS:
        return MODELS[key]
    path = MODEL_PATHS[key]
    if not path or not path.is_file():
        return None
    try:
        model = YOLO(str(path))
        MODELS[key] = model
        MODEL_ERRORS.pop(key, None)
        return model
    except Exception as error:  # surfaced in /health and the API response
        MODEL_ERRORS[key] = f"Could not load {path.name}: {type(error).__name__}"
        raise


def load_action_model() -> tuple[Any, Any]:
    global ACTION_MODEL, ACTION_PROCESSOR, ACTION_ERROR, ACTION_MODEL_SIGNATURE
    signature = action_model_signature()
    with ACTION_LOCK:
        if ACTION_MODEL is not None and ACTION_PROCESSOR is not None and signature == ACTION_MODEL_SIGNATURE:
            return ACTION_MODEL, ACTION_PROCESSOR
        if ACTION_MODEL is not None and signature != ACTION_MODEL_SIGNATURE:
            LOGGER.info("Action checkpoint changed on disk; reloading VideoMAE weights.")
            ACTION_MODEL = None
            ACTION_PROCESSOR = None
        try:
            from transformers import AutoImageProcessor, AutoModelForVideoClassification

            model_ref = str(MODEL_PATHS["action"]) if MODEL_PATHS["action"] else cached_model_directory(ACTION_REPO)
            if not model_ref:
                raise FileNotFoundError("VideoMAE weights are not cached. Run ai/download_videomae.py while online first.")
            ACTION_PROCESSOR = AutoImageProcessor.from_pretrained(model_ref, local_files_only=True)
            ACTION_MODEL = AutoModelForVideoClassification.from_pretrained(model_ref, local_files_only=True)
            import torch

            requested = os.getenv("ACTION_DEVICE", "auto").lower()
            if requested == "cpu":
                device = torch.device("cpu")
            elif requested not in {"auto", "cuda", "0"}:
                device = torch.device(requested)
            else:
                device = torch.device("cuda:0" if torch.cuda.is_available() else "cpu")
            ACTION_MODEL.to(device).eval()
            ACTION_MODEL_SIGNATURE = signature
            ACTION_ERROR = ""
            LOGGER.info("Loaded VideoMAE %s on %s", model_ref, device)
        except Exception as error:
            ACTION_MODEL = None
            ACTION_PROCESSOR = None
            ACTION_MODEL_SIGNATURE = None
            ACTION_ERROR = f"VideoMAE could not load local weights: {type(error).__name__}. Run ai/download_videomae.py while online, or set ACTION_MODEL_PATH."
            LOGGER.exception("Could not load action model")
            raise
        return ACTION_MODEL, ACTION_PROCESSOR


def class_name(names: Any, index: int) -> str:
    if isinstance(names, dict):
        return str(names.get(index, index))
    if isinstance(names, (list, tuple)) and index < len(names):
        return str(names[index])
    return str(index)


def camera_tracker(camera_id: str) -> ByteTrackTracker:
    now = time.monotonic()
    for key, (_, last_seen) in list(TRACKERS.items()):
        if now - last_seen > 600:
            del TRACKERS[key]
    entry = TRACKERS.get(camera_id)
    if entry:
        tracker, _ = entry
    else:
        tracker = ByteTrackTracker(
            frame_rate=1,
            track_activation_threshold=0.35,
            high_conf_det_threshold=0.35,
            minimum_consecutive_frames=1,
        )
    TRACKERS[camera_id] = (tracker, now)
    return tracker


def tracked_people(predictions: list[dict[str, Any]], frame_width: int, frame_height: int, camera_id: str) -> None:
    people = [item for item in predictions if item["label"].strip().lower() == "person"]
    if not people:
        return
    xyxy = np.array(
        [
            [
                item["box"]["x"] * frame_width,
                item["box"]["y"] * frame_height,
                (item["box"]["x"] + item["box"]["width"]) * frame_width,
                (item["box"]["y"] + item["box"]["height"]) * frame_height,
            ]
            for item in people
        ],
        dtype=np.float32,
    )
    confidence = np.array([item["confidence"] for item in people], dtype=np.float32)
    detections = sv.Detections(
        xyxy=xyxy,
        confidence=confidence,
        class_id=np.zeros(len(people), dtype=int),
        data={"prediction_index": np.arange(len(people), dtype=int)},
    )
    tracked = camera_tracker(camera_id).update(detections)
    ids = tracked.tracker_id
    source_indices = tracked.data.get("prediction_index")
    if ids is None or source_indices is None:
        return
    for source_index, track_id in zip(source_indices.tolist(), ids.tolist(), strict=False):
        if track_id is not None and track_id >= 0:
            people[int(source_index)]["trackId"] = int(track_id)


def intersection_over_union(left: dict[str, float], right: dict[str, float]) -> float:
    x1 = max(left["x"], right["x"])
    y1 = max(left["y"], right["y"])
    x2 = min(left["x"] + left["width"], right["x"] + right["width"])
    y2 = min(left["y"] + left["height"], right["y"] + right["height"])
    intersection = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    union = left["width"] * left["height"] + right["width"] * right["height"] - intersection
    return intersection / union if union else 0.0


def pose_predictions(frame: np.ndarray, frame_width: int, frame_height: int, camera_id: str) -> list[dict[str, Any]]:
    model = load_model("pose")
    if model is None:
        return []
    result = model.predict(frame, conf=0.35, iou=0.5, imgsz=640, verbose=False, device=os.getenv("VISION_DEVICE") or None)[0]
    if result.boxes is None or len(result.boxes) == 0:
        return []
    boxes = result.boxes.xyxy.cpu().numpy()
    confidences = result.boxes.conf.cpu().numpy()
    keypoints = result.keypoints.xy.cpu().numpy() if result.keypoints is not None else np.empty((len(boxes), 0, 2))
    point_confidences = result.keypoints.conf.cpu().numpy() if result.keypoints is not None and result.keypoints.conf is not None else np.ones(keypoints.shape[:2])
    point_names = ["nose", "left_eye", "right_eye", "left_ear", "right_ear", "left_shoulder", "right_shoulder", "left_elbow", "right_elbow", "left_wrist", "right_wrist", "left_hip", "right_hip", "left_knee", "right_knee", "left_ankle", "right_ankle"]
    output = []
    for index, (coords, confidence) in enumerate(zip(boxes, confidences, strict=False)):
        left, top, right, bottom = [float(value) for value in coords]
        x = min(max(left, 0), frame_width)
        y = min(max(top, 0), frame_height)
        x2 = min(max(right, x), frame_width)
        y2 = min(max(bottom, y), frame_height)
        points = []
        for point_index, (px, py) in enumerate(keypoints[index]):
            points.append({
                "name": point_names[point_index] if point_index < len(point_names) else str(point_index),
                "x": min(1.0, max(0.0, float(px) / frame_width)),
                "y": min(1.0, max(0.0, float(py) / frame_height)),
                "confidence": float(point_confidences[index][point_index]),
            })
        output.append({
            "label": "person", "confidence": float(confidence), "model": "pose", "trackId": None,
            "keypoints": points,
            "box": {"x": x / frame_width, "y": y / frame_height, "width": (x2 - x) / frame_width, "height": (y2 - y) / frame_height},
        })
    tracked_people(output, frame_width, frame_height, camera_id)
    return output


def assign_person_tracks(predictions: list[dict[str, Any]], people: list[dict[str, Any]]) -> None:
    for prediction in predictions:
        if prediction.get("model") in {"pose", "action"} or prediction.get("trackId") is not None:
            continue
        if not people:
            continue
        person = max(people, key=lambda item: intersection_over_union(prediction["box"], item["box"]))
        if intersection_over_union(prediction["box"], person["box"]) >= 0.08:
            prediction["trackId"] = person.get("trackId")


def action_candidate_label(label: str) -> str | None:
    normalized = label.lower().replace("_", " ").strip()
    if normalized in {"fight", "fighting", "violent", "violence", "physical altercation"}:
        return "fight"
    if normalized in {"fall", "fallen", "fall down", "falling", "falling down", "trip", "tripping", "slip", "slipping"}:
        return "fall"
    return None


def plausible_fight_pair(people: list[dict[str, Any]]) -> bool:
    """Reject fight cues without two nearby, reasonably framed people."""
    boxes = [person.get("box") for person in people if person.get("box")]
    for index, first in enumerate(boxes):
        first_w, first_h = float(first.get("width", 0)), float(first.get("height", 0))
        if first_w <= 0 or first_h <= 0 or first_w > 0.68 or first_h > 0.9:
            continue
        first_x, first_y = float(first.get("x", 0)), float(first.get("y", 0))
        for second in boxes[index + 1:]:
            second_w, second_h = float(second.get("width", 0)), float(second.get("height", 0))
            if second_w <= 0 or second_h <= 0 or second_w > 0.68 or second_h > 0.9:
                continue
            second_x, second_y = float(second.get("x", 0)), float(second.get("y", 0))
            gap_x = max(0.0, first_x - (second_x + second_w), second_x - (first_x + first_w))
            gap_y = max(0.0, first_y - (second_y + second_h), second_y - (first_y + first_h))
            center_x = (first_x + first_w / 2) - (second_x + second_w / 2)
            center_y = (first_y + first_h / 2) - (second_y + second_h / 2)
            if float(np.hypot(gap_x, gap_y)) <= 0.12 and float(np.hypot(center_x, center_y)) <= 0.72:
                return True
    return False


def pose_fall_person(people: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Find a conservative lying-down cue from visible YOLO pose landmarks."""
    for person in people:
        points = person.get("keypoints") or []
        if len(points) < 13 or any(points[index].get("confidence", 0) < 0.3 for index in (5, 6, 11, 12)):
            continue
        shoulder_x = (points[5]["x"] + points[6]["x"]) / 2
        shoulder_y = (points[5]["y"] + points[6]["y"]) / 2
        hip_x = (points[11]["x"] + points[12]["x"]) / 2
        hip_y = (points[11]["y"] + points[12]["y"]) / 2
        torso_dx, torso_dy = abs(shoulder_x - hip_x), abs(shoulder_y - hip_y)
        box = person.get("box") or {}
        width, height = float(box.get("width", 0)), float(box.get("height", 0))
        bottom = float(box.get("y", 0)) + height
        if torso_dx >= 0.1 and torso_dy <= torso_dx * 0.65 and width >= height * 0.85 and bottom >= 0.58:
            return person
    return None


def confirmed_action_prediction(
    camera_id: str,
    event: str,
    confidence: float,
    raw_label: str,
    people: list[dict[str, Any]],
    now: float,
    required_hits: int,
    model_name: str = "action",
) -> list[dict[str, Any]]:
    track_ids = sorted({int(person["trackId"]) for person in people if person.get("trackId") is not None})[:4]
    previous = ACTION_CONFIRMATIONS.get(camera_id)
    same_recent_event = bool(previous and previous[0] == event and now - previous[3] <= ACTION_CONFIRM_WINDOW)
    hits = previous[1] + 1 if same_recent_event else 1
    ACTION_CONFIRMATIONS[camera_id] = (event, hits, track_ids, now)
    if hits < required_hits:
        return []
    if people:
        left = min(person["box"]["x"] for person in people)
        top = min(person["box"]["y"] for person in people)
        right = max(person["box"]["x"] + person["box"]["width"] for person in people)
        bottom = max(person["box"]["y"] + person["box"]["height"] for person in people)
        box = {"x": left, "y": top, "width": right - left, "height": bottom - top}
    else:
        box = {"x": 0, "y": 0, "width": 1, "height": 1}
    return [{
        "label": f"possible {event}", "rawLabel": raw_label, "confidence": confidence,
        "model": model_name, "trackId": track_ids[0] if len(track_ids) == 1 else None,
        "trackIds": track_ids, "box": box,
    }]


def action_predictions(frame: np.ndarray, camera_id: str, people: list[dict[str, Any]]) -> list[dict[str, Any]]:
    now = time.monotonic()
    frames = ACTION_FRAMES.setdefault(camera_id, deque(maxlen=ACTION_FRAME_COUNT))
    if frames and now - frames[-1][0] > 30:
        frames.clear()
        ACTION_CALLS[camera_id] = 0
        ACTION_CONFIRMATIONS.pop(camera_id, None)
    horizontal_person = pose_fall_person(people)
    if horizontal_person:
        return confirmed_action_prediction(
            camera_id, "fall", 0.62, "sustained horizontal body posture (YOLO26n-Pose)",
            [horizontal_person], now, 2, model_name="pose",
        )
    previous = ACTION_CONFIRMATIONS.get(camera_id)
    if previous and previous[0] == "fall":
        ACTION_CONFIRMATIONS.pop(camera_id, None)
    frames.append((now, cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)))
    calls = ACTION_CALLS.get(camera_id, 0) + 1
    ACTION_CALLS[camera_id] = calls
    if len(frames) < ACTION_FRAME_COUNT or calls % ACTION_INFER_EVERY:
        return []
    # Do not spend inference time on generic Kinetics labels. They are not
    # calibrated for workplace fall/fight alerts.
    if not MODEL_PATHS["action"]:
        ACTION_CONFIRMATIONS.pop(camera_id, None)
        return []
    model, processor = load_action_model()
    selected = np.linspace(0, len(frames) - 1, ACTION_FRAME_COUNT).astype(int)
    video = [frames[index][1] for index in selected]
    import torch

    def classify(action_model: Any, image_processor: Any) -> dict[str, float]:
        inputs = image_processor(images=[video], return_tensors="pt")
        device = next(action_model.parameters()).device
        model_inputs = {key: value.to(device) for key, value in inputs.items()}
        with torch.inference_mode():
            logits = action_model(**model_inputs).logits[0]
            probabilities = torch.softmax(logits, dim=-1)
        label_map = action_model.config.id2label
        return {
            str(label_map.get(index, label_map.get(str(index), "unknown"))): float(probability.item())
            for index, probability in enumerate(probabilities)
        }

    event_scores: dict[str, tuple[float, str]] = {}
    for raw_label, score in classify(model, processor).items():
        event = action_candidate_label(raw_label)
        if event and score > event_scores.get(event, (0.0, ""))[0]:
            event_scores[event] = (score, raw_label)

    fight_score, fight_label = event_scores.get("fight", (0.0, ""))
    fall_score, fall_label = event_scores.get("fall", (0.0, ""))
    candidate: tuple[str, float, str] | None = None
    if fall_score >= ACTION_FALL_MIN_CONFIDENCE and fall_score > fight_score * 1.08:
        candidate = ("fall", fall_score, fall_label)
    elif fight_score >= ACTION_FIGHT_MIN_CONFIDENCE and fight_score > fall_score * 1.15 and plausible_fight_pair(people):
        candidate = ("fight", fight_score, fight_label)
    if candidate is None:
        # A false or ambiguous window breaks the streak instead of accumulating
        # unrelated predictions across the whole confirmation window.
        ACTION_CONFIRMATIONS.pop(camera_id, None)
        return []

    event, confidence, raw_label = candidate
    required_hits = 3 if event == "fight" else 2
    return confirmed_action_prediction(camera_id, event, confidence, raw_label, people, now, required_hits)


def run_detector(key: str, frame: np.ndarray, frame_width: int, frame_height: int) -> list[dict[str, Any]]:
    model = load_model(key)
    if model is None:
        return []
    results = model.predict(frame, conf=0.35, iou=0.5, imgsz=640, verbose=False, device=os.getenv("VISION_DEVICE") or None)
    result = results[0]
    detections = result.boxes
    if detections is None or len(detections) == 0:
        return []
    xyxy = detections.xyxy.cpu().numpy()
    confidences = detections.conf.cpu().numpy()
    class_ids = detections.cls.cpu().numpy().astype(int)
    output: list[dict[str, Any]] = []
    for coords, confidence, class_id in zip(xyxy, confidences, class_ids, strict=False):
        left, top, right, bottom = [float(value) for value in coords]
        left = min(max(left, 0), frame_width)
        right = min(max(right, left), frame_width)
        top = min(max(top, 0), frame_height)
        bottom = min(max(bottom, top), frame_height)
        output.append(
            {
                "label": class_name(result.names, int(class_id)),
                "confidence": float(confidence),
                "model": key,
                "trackId": None,
                "box": {
                    "x": left / frame_width,
                    "y": top / frame_height,
                    "width": (right - left) / frame_width,
                    "height": (bottom - top) / frame_height,
                },
            }
        )
    return output


@app.get("/health")
def health() -> dict[str, Any]:
    return health_payload()


@app.post("/infer")
def infer(request: FrameRequest) -> dict[str, Any]:
    encoded = request.imageBase64.partition(",")[2] if request.imageBase64.startswith("data:") else request.imageBase64
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(status_code=400, detail="The camera frame is not valid base64 image data.") from None
    if len(raw) > 4_000_000:
        raise HTTPException(status_code=413, detail="The camera frame must be smaller than 4 MB.")
    frame = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
    if frame is None:
        raise HTTPException(status_code=400, detail="Could not decode this camera frame.")
    frame_height, frame_width = frame.shape[:2]
    if frame_width * frame_height > 3_000_000:
        raise HTTPException(status_code=413, detail="Resize the camera frame below 3 megapixels.")

    status = health_payload()
    if not status["enabled"]:
        raise HTTPException(status_code=422, detail=status["message"])
    try:
        with INFERENCE_LOCK:
            predictions: list[dict[str, Any]] = []
            predictions.extend(run_detector("ppe", frame, frame_width, frame_height))
            predictions.extend(run_detector("hazards", frame, frame_width, frame_height))
            predictions.extend(run_detector("custom_hazards", frame, frame_width, frame_height))
            people = pose_predictions(frame, frame_width, frame_height, request.cameraId)
            if not people:
                tracked_people(predictions, frame_width, frame_height, request.cameraId)
                people = [item for item in predictions if item["label"].strip().lower() == "person"]
            else:
                assign_person_tracks(predictions, people)
            predictions.extend(people)
            models = health_payload()["models"]
            if models["action"]["ready"] or models["pose"]["ready"]:
                try:
                    predictions.extend(action_predictions(frame, request.cameraId, people))
                except Exception:
                    LOGGER.exception("Action inference failed for camera %s", request.cameraId)
    except HTTPException:
        raise
    except Exception as error:
        LOGGER.exception("Local model inference failed for camera %s", request.cameraId)
        raise HTTPException(status_code=503, detail=f"Local model inference failed: {type(error).__name__}. Check the model path and Python terminal.") from error
    return {"predictions": predictions, "width": frame_width, "height": frame_height, "models": health_payload()["models"]}
