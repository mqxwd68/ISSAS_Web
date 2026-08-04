"""
ISSAS Web — FastAPI backend
===========================

A web re-implementation of the ISSAS smart-annotation tool. SAM2 stays in Python
(run this in your `sam2` conda env); the frontend is HTML/CSS/JS served from ./static.

Run:
    conda activate sam2
    pip install fastapi "uvicorn[standard]" python-multipart pillow numpy scipy
    python server.py            # then open http://127.0.0.1:8000

If SAM2 / torch is unavailable, the server runs in SIMULATION mode so the whole UI
(zoom, prompting, brush, save, etc.) still works for development — predicted masks are
just circles/boxes instead of real segmentation.

Design note: masks are ALWAYS stored and returned at the frame's native resolution.
Zoom is a pure display concern handled entirely on the client; every coordinate that
reaches this backend is already in native pixels.
"""

import os
import io
import sys
import json
import base64
import re
import subprocess
import traceback

import numpy as np
from PIL import Image, ImageFilter, ImageDraw

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, Response, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from typing import List, Optional

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PNG2YOLO = os.path.join(SCRIPT_DIR, "A000_generate_yolo_from_png.py")

# Default folder shown when the "Browse…" picker opens (override with ISSAS_DEFAULT_PATH)
DEFAULT_BROWSE_PATH = os.environ.get(
    "ISSAS_DEFAULT_PATH",
    "/home/mqxwd68/Downloads/sam2/ISSAS/Test_data/Gastro28/S01/images",
)
IMG_EXTS = (".jpg", ".jpeg", ".png", ".tiff")
VIDEO_EXTS = (".mp4", ".mov", ".m4v", ".webm")


def _norm(p):
    """Normalize native/Windows paths for the WSL-hosted local server."""
    p = (p or "").replace("\\", "/").strip()
    drive = re.match(r"^([A-Za-z]):/(.*)$", p)
    if drive and os.name != "nt":
        p = f"/mnt/{drive.group(1).lower()}/{drive.group(2)}"
    return os.path.expanduser(p)

# --------------------------------------------------------------------------- #
#  Class maps (Gastro28 default palette — same IDs as the desktop tool)
# --------------------------------------------------------------------------- #
CLASS_MAP_T = {
    'Common hepatic artery': 1, 'Proper hepatic artery': 2, 'Gastroduodenal artery': 3,
    'Left gastric artery': 4, 'Right gastric artery': 5, 'Left gastric vein': 6,
    'Right gastric vein': 7, 'Pancreas': 8, 'Duodenal stump': 9, 'Liver': 10,
    'Gallbladder': 11, 'Falciform ligament': 23, 'Stomach': 24, 'Blood pool': 26,
}
CLASS_MAP_I = {
    'Curved grasper': 12, 'Straight grasper': 13, 'Irrigation tube': 14,
    'Harmonic scalpel': 15, 'Stapler': 16, 'Hem-o-lok': 17, 'Gauze': 18,
    'Nndoscopic scissor': 19, 'Needle holder': 20, 'Needle': 21, 'Suture': 22,
    'Hemoloc applier': 25, 'Ligasure': 27,
}
CLASS_MAP_ALL = {**CLASS_MAP_T, **CLASS_MAP_I}
_DEFAULT_T, _DEFAULT_I = dict(CLASS_MAP_T), dict(CLASS_MAP_I)

# --------------------------------------------------------------------------- #
#  SAM2 initialisation (mirrors A003_Smart_annotation_1.py, with graceful
#  fallback to a simulation predictor so the UI is always usable)
# --------------------------------------------------------------------------- #
predictor = None
device = None
SAM2_AVAILABLE = False
TORCH_OK = False
CURRENT_CKPT = None
CURRENT_CFG = None

try:
    import torch
    TORCH_OK = True

    if torch.cuda.is_available():
        device = torch.device("cuda")
    elif torch.backends.mps.is_available():
        device = torch.device("mps")
    else:
        device = torch.device("cpu")
    print(f"[issas] using device: {device}")

    try:
        from sam2.build_sam import build_sam2_video_predictor

        # Same resolution logic as the desktop tool; override via env vars if needed.
        ckpt = os.environ.get(
            "SAM2_CHECKPOINT",
            os.path.join(SCRIPT_DIR, "SAM_model/sam2.1_hiera_large.pt"),
        )
        cfg = os.environ.get(
            "SAM2_CONFIG", "../sam2/configs/sam2.1/sam2.1_hiera_l.yaml"
        )
        predictor = build_sam2_video_predictor(cfg, ckpt, device=device)
        SAM2_AVAILABLE = True
        CURRENT_CKPT, CURRENT_CFG = ckpt, cfg
        print("[issas] SAM2 predictor initialised successfully")
    except Exception as e:  # noqa: BLE001
        print(f"[issas] SAM2 predictor unavailable ({e}). Running in SIMULATION mode.")
except Exception as e:  # noqa: BLE001
    print(f"[issas] torch unavailable ({e}). Running in SIMULATION mode.")

try:
    from scipy.ndimage import binary_erosion, binary_dilation, label
    HAS_SCIPY = True
except Exception:  # noqa: BLE001
    HAS_SCIPY = False
    print("[issas] SciPy not installed — morphology / components ops will be limited.")


# --------------------------------------------------------------------------- #
#  Session state (single active session, like the desktop app)
# --------------------------------------------------------------------------- #
class Session:
    def __init__(self):
        self.frame_dir: Optional[str] = None
        self.frame_names: List[str] = []
        self.video_dir: Optional[str] = None
        self.video_dir_display: Optional[str] = None
        self.video_path: Optional[str] = None
        self.video_fps_override: Optional[float] = None
        self.video_probe = None
        self.inference_state = None
        # propagation
        self.frame_generator = None
        self.generated_frames = {}      # frame_idx -> (obj_ids, mask_logits)
        self.propagation_started = False
        # cache of the last frame's size
        self.sizes = {}                 # idx -> (w, h)

    def reset_propagation(self):
        self.frame_generator = None
        self.generated_frames = {}
        self.propagation_started = False


SESSION = Session()


def _case_name(frame_dir: Optional[str]) -> Optional[str]:
    if not frame_dir:
        return None
    path = os.path.normpath(frame_dir)
    name = os.path.basename(path)
    if name.lower() in {"images", "image", "imgs", "frames", "frame", "jpeg", "jpg", "png"}:
        name = os.path.basename(os.path.dirname(path))
    return name or None


def _find_case_video() -> Optional[str]:
    SESSION.video_path = None
    case = _case_name(SESSION.frame_dir)
    if not case or not SESSION.video_dir or not os.path.isdir(SESSION.video_dir):
        return None
    wanted = case.casefold()
    for entry in os.scandir(SESSION.video_dir):
        stem, ext = os.path.splitext(entry.name)
        if entry.is_file() and ext.lower() in VIDEO_EXTS and stem.casefold() == wanted:
            SESSION.video_path = entry.path
            return entry.path
    return None


def _probe_video(path: str):
    cached = SESSION.video_probe
    stamp = (path, os.path.getmtime(path), SESSION.video_fps_override)
    if cached and cached.get("_stamp") == stamp:
        return cached
    info = {"fps": SESSION.video_fps_override or 25.0, "duration": None,
            "width": None, "height": None, "_stamp": stamp}
    try:
        result = subprocess.run([
            "ffprobe", "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream=avg_frame_rate,width,height:format=duration",
            "-of", "json", path,
        ], capture_output=True, text=True, timeout=4, check=True)
        data = json.loads(result.stdout or "{}")
        stream = (data.get("streams") or [{}])[0]
        rate = str(stream.get("avg_frame_rate") or "0/1").split("/")
        detected = float(rate[0]) / float(rate[1]) if len(rate) == 2 and float(rate[1]) else 0
        if not SESSION.video_fps_override and detected > 0:
            info["fps"] = detected
        info["duration"] = float((data.get("format") or {}).get("duration") or 0) or None
        info["width"] = stream.get("width")
        info["height"] = stream.get("height")
    except (FileNotFoundError, subprocess.SubprocessError, ValueError, json.JSONDecodeError):
        pass
    SESSION.video_probe = info
    return info


def _video_status():
    path = SESSION.video_path if SESSION.video_path and os.path.isfile(SESSION.video_path) else _find_case_video()
    case = _case_name(SESSION.frame_dir)
    if not path:
        return {"configured": bool(SESSION.video_dir), "available": False,
                "directory": SESSION.video_dir_display or SESSION.video_dir, "case": case,
                "expected": f"{case}.mp4" if case else None}
    probe = _probe_video(path)
    return {"configured": True, "available": True,
            "directory": SESSION.video_dir_display or SESSION.video_dir,
            "case": case, "name": os.path.basename(path), "fps": probe["fps"],
            "duration": probe["duration"], "width": probe["width"], "height": probe["height"]}


# --------------------------------------------------------------------------- #
#  Helpers: mask <-> base64 PNG (single channel, native resolution)
# --------------------------------------------------------------------------- #
def mask_to_b64(mask: np.ndarray) -> str:
    """bool/uint8 HxW mask -> base64 PNG (mode 'L', 0/255)."""
    if mask.ndim > 2:
        mask = mask.squeeze()
    arr = (np.asarray(mask) > 0).astype(np.uint8) * 255
    im = Image.fromarray(arr, mode="L")
    buf = io.BytesIO()
    im.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def b64_to_mask(b64: str) -> np.ndarray:
    """base64 PNG -> bool HxW mask."""
    raw = base64.b64decode(b64)
    im = Image.open(io.BytesIO(raw)).convert("L")
    return np.array(im) > 127


def hsl_to_rgb(h, s, l):
    h, s, l = h / 360.0, s / 100.0, l / 100.0
    if s == 0:
        r = g = b = l
    else:
        def hue2rgb(p, q, t):
            if t < 0: t += 1
            if t > 1: t -= 1
            if t < 1 / 6: return p + (q - p) * 6 * t
            if t < 1 / 2: return q
            if t < 2 / 3: return p + (q - p) * (2 / 3 - t) * 6
            return p
        q = l * (1 + s) if l < 0.5 else l + s - l * s
        p = 2 * l - q
        r = hue2rgb(p, q, h + 1 / 3)
        g = hue2rgb(p, q, h)
        b = hue2rgb(p, q, h - 1 / 3)
    return int(r * 255), int(g * 255), int(b * 255)


def obj_color(obj_id: int):
    hue = (obj_id * 137.5) % 360
    return hsl_to_rgb(hue, 65, 60)


def _save_palette_png(class_mask, path):
    """Write a class-id-indexed palette PNG (same palette as the desktop tool)."""
    img = Image.fromarray(class_mask, mode="P")
    palette = []
    for i in range(256):
        if i == 0:
            palette.extend([0, 0, 0])
        else:
            r, g, b = hsl_to_rgb((i * 77) % 360, 85 + (i % 15), 55 + (i % 10))
            palette.extend([r, g, b])
    img.putpalette(palette)
    img.save(path)


def frame_size(idx: int):
    if idx in SESSION.sizes:
        return SESSION.sizes[idx]
    path = os.path.join(SESSION.frame_dir, SESSION.frame_names[idx])
    with Image.open(path) as im:
        w, h = im.size
    SESSION.sizes[idx] = (w, h)
    return w, h


def extract_number(filename):
    base = os.path.splitext(filename)[0]
    if base.isdigit():
        return int(base)
    try:
        return int(''.join(filter(str.isdigit, base)))
    except Exception:
        return 0


# --------------------------------------------------------------------------- #
#  Core SAM2 prediction (native resolution in, native resolution out)
# --------------------------------------------------------------------------- #
def sam_predict(frame_idx, obj_id, points, labels, box):
    w, h = frame_size(frame_idx)

    # ---- Simulation fallback (no SAM2) ----
    if not SAM2_AVAILABLE or predictor is None or SESSION.inference_state is None:
        mask = np.zeros((h, w), dtype=np.uint8)
        if box is not None:
            x1, y1, x2, y2 = [int(v) for v in box]
            mask[max(0, y1):min(h, y2), max(0, x1):min(w, x2)] = 1
        for i, (px, py) in enumerate(points or []):
            cx, cy = int(px), int(py)
            val = 1 if (labels and i < len(labels) and labels[i] == 1) else 0
            r = 40
            yy, xx = np.ogrid[max(0, cy - r):min(h, cy + r), max(0, cx - r):min(w, cx + r)]
            circ = (yy - cy) ** 2 + (xx - cx) ** 2 <= r * r
            mask[max(0, cy - r):min(h, cy + r), max(0, cx - r):min(w, cx + r)][circ] = val
        return mask.astype(bool)

    # ---- Real SAM2 ----
    points_np = np.array(points, dtype=np.float32) if points else None
    if points_np is not None and points_np.ndim == 1:
        points_np = points_np.reshape(1, -1)
    labels_np = np.array(labels, dtype=np.int32) if labels else None
    box_np = np.array(box, dtype=np.float32) if box else None

    _, out_obj_ids, out_mask_logits = predictor.add_new_points_or_box(
        inference_state=SESSION.inference_state,
        frame_idx=frame_idx,
        obj_id=obj_id,
        points=points_np,
        labels=labels_np,
        box=box_np,
    )
    if out_mask_logits.nelement() == 0:
        return np.zeros((h, w), dtype=bool)
    pos = out_obj_ids.index(obj_id)
    return (out_mask_logits[pos] > 0.0).cpu().numpy().squeeze()


# --------------------------------------------------------------------------- #
#  Propagation (mirrors initialize_video_propagation / generate_frame)
# --------------------------------------------------------------------------- #
def propagation_init():
    SESSION.reset_propagation()
    if SAM2_AVAILABLE and predictor is not None and SESSION.inference_state is not None:
        SESSION.frame_generator = predictor.propagate_in_video(SESSION.inference_state)
    print("[issas] propagation generator initialised")


def _box_from_mask(mask):
    ys, xs = np.where(mask > 0)
    if len(xs) == 0:
        return None
    return np.array([xs.min(), ys.min(), xs.max(), ys.max()], dtype=np.float32)


def reseed_from_frame(frame_idx, corrected):
    """Seed corrected masks on `frame_idx` and restart forward propagation there.

    `corrected` is {obj_id: bool HxW}. Prefers add_new_mask (preserves the exact
    corrected shape); falls back to a box derived from the mask if that API is
    unavailable in the installed sam2. Returns (used_mask_api, n_seeded).
    """
    if not SAM2_AVAILABLE or predictor is None or SESSION.inference_state is None:
        # simulation: just reset the (no-op) generator start point
        SESSION.reset_propagation()
        return (False, 0)

    used_mask_api = False
    n = 0
    # reset tracking so ONLY the objects we seed here (the visible ones) propagate forward
    try:
        predictor.reset_state(SESSION.inference_state)
    except Exception as e:  # noqa: BLE001
        print(f"[issas] reset_state before reseed failed ({e})")
    has_add_mask = hasattr(predictor, "add_new_mask")
    for oid, mask in corrected.items():
        if mask is None or mask.sum() == 0:
            continue
        seeded = False
        if has_add_mask:
            try:
                predictor.add_new_mask(
                    inference_state=SESSION.inference_state,
                    frame_idx=frame_idx,
                    obj_id=int(oid),
                    mask=mask.astype(bool),
                )
                used_mask_api = True
                seeded = True
            except Exception as e:  # noqa: BLE001
                print(f"[issas] add_new_mask failed for obj {oid} ({e}); using box fallback")
        if not seeded:
            box = _box_from_mask(mask)
            if box is None:
                continue
            predictor.add_new_points_or_box(
                inference_state=SESSION.inference_state,
                frame_idx=frame_idx, obj_id=int(oid),
                points=None, labels=None, box=box,
            )
        n += 1

    # restart the forward generator from this frame; drop stale downstream cache
    SESSION.generated_frames = {}
    SESSION.propagation_started = True
    SESSION.gen_start = frame_idx
    SESSION.frame_generator = predictor.propagate_in_video(
        SESSION.inference_state, start_frame_idx=frame_idx)
    print(f"[issas] re-propagating from frame {frame_idx}: seeded {n} objects "
          f"({'mask' if used_mask_api else 'box'} seeds)")
    return (used_mask_api, n)


PROP_PROGRESS = {"active": False, "start": 0, "current": 0, "target": 0}


def propagation_generate(target_idx):
    """Advance the generator until target_idx is produced; return its masks."""
    if not SAM2_AVAILABLE or SESSION.frame_generator is None:
        return None  # nothing to propagate (simulation or not initialised)

    if target_idx in SESSION.generated_frames:
        obj_ids, mask_logits = SESSION.generated_frames[target_idx]
        return {int(oid): (mask_logits[i] > 0.0).cpu().numpy().squeeze()
                for i, oid in enumerate(obj_ids)}

    if not SESSION.propagation_started:
        SESSION.propagation_started = True
        current = 0
    elif SESSION.generated_frames:
        current = max(SESSION.generated_frames.keys()) + 1
    else:
        # generator was (re)started from a known frame; begin there
        current = getattr(SESSION, "gen_start", 0)

    try:
        PROP_PROGRESS.update(active=True, start=current, current=current, target=target_idx)
        for _ in range(target_idx - current + 1):
            fidx, obj_ids, mask_logits = next(SESSION.frame_generator)
            SESSION.generated_frames[fidx] = (obj_ids, mask_logits)
            PROP_PROGRESS["current"] = fidx
            if fidx == target_idx:
                break
    except StopIteration:
        SESSION.frame_generator = None
        PROP_PROGRESS["active"] = False
        return None
    finally:
        PROP_PROGRESS["active"] = False

    if target_idx not in SESSION.generated_frames:
        return None
    obj_ids, mask_logits = SESSION.generated_frames[target_idx]
    return {int(oid): (mask_logits[i] > 0.0).cpu().numpy().squeeze()
            for i, oid in enumerate(obj_ids)}


# --------------------------------------------------------------------------- #
#  Post-processing (ported 1:1 from the desktop tool)
# --------------------------------------------------------------------------- #
def pp_gaussian(mask, kernel_size):
    radius = max(1, kernel_size // 2)
    im = Image.fromarray((mask * 255).astype(np.uint8))
    blurred = np.array(im.filter(ImageFilter.GaussianBlur(radius=radius)))
    return blurred > 128


def pp_morph(mask, kernel_size):
    if not HAS_SCIPY:
        return mask
    structure = np.ones((max(2, kernel_size), max(2, kernel_size)), dtype=bool) \
        if kernel_size > 1 else np.ones((3, 3), dtype=bool)
    opened = binary_dilation(binary_erosion(mask, structure=structure), structure=structure)
    closed = binary_erosion(binary_dilation(opened, structure=structure), structure=structure)
    return closed


def pp_components(mask, n):
    if not HAS_SCIPY:
        return mask
    labeled, num = label(mask)
    if num == 0:
        return mask
    sizes = [np.sum(labeled == i) for i in range(1, num + 1)]
    top = np.argsort(sizes)[::-1][:min(n, num)]
    new = np.zeros_like(mask, dtype=bool)
    for i in top:
        new |= (labeled == i + 1)
    return new


# --------------------------------------------------------------------------- #
#  FastAPI app + request models
# --------------------------------------------------------------------------- #
app = FastAPI(title="ISSAS Web")


class OpenFolderReq(BaseModel):
    path: str


class VideoFolderReq(BaseModel):
    path: str
    fps: Optional[float] = None


class PredictReq(BaseModel):
    frame_idx: int
    obj_id: int
    points: List[List[float]] = []
    labels: List[int] = []
    box: Optional[List[float]] = None


class PropagateReq(BaseModel):
    frame_idx: int


class PostProcessReq(BaseModel):
    op: str                    # 'gaussian' | 'morph' | 'components'
    mask: str                  # base64 png
    kernel: int = 17
    n: int = 1


class ImportDirReq(BaseModel):
    dir: str
    frame_idx: int = 0


class SaveObj(BaseModel):
    class_id: int
    mask: str                  # base64 png


class SaveReq(BaseModel):
    frame_idx: int
    png_dir: str
    yolo_dir: str
    objects: List[SaveObj]
    yolo: bool = True          # when False, write only the lossless palette PNG
    raw_objects: List[SaveObj] = []   # SAM2's raw masks for this frame (saved to sam_dir)
    sam_dir: str = ""


class ReseedObj(BaseModel):
    obj_id: int
    mask: str                  # base64 png (corrected, native res)


class ReseedReq(BaseModel):
    frame_idx: int
    objects: List[ReseedObj]


class DiceObj(BaseModel):
    frame_idx: int
    obj_id: int
    class_id: int
    kind: str                  # 'prompt' | 'propagation'
    raw: str                   # base64 png — SAM2's initial mask
    final: str                 # base64 png — human-final mask


class DiceReq(BaseModel):
    records: List[DiceObj]


@app.get("/", response_class=HTMLResponse)
def index():
    with open(os.path.join(SCRIPT_DIR, "static", "index.html"), encoding="utf-8") as f:
        return f.read()


@app.get("/workflow", response_class=HTMLResponse)
def workflow():
    with open(os.path.join(SCRIPT_DIR, "static", "ISSAS-workflow.html"), encoding="utf-8") as f:
        return f.read()


@app.get("/api/classes")
def get_classes():
    return {"class_map": CLASS_MAP_ALL, "tissue": CLASS_MAP_T, "instrument": CLASS_MAP_I}


class ClassesLoadReq(BaseModel):
    text: Optional[str] = None
    path: Optional[str] = None
    format: str = "json"     # 'json' | 'yaml'  (inferred from extension when path is given)


def _to_map(d):
    m = {}
    if isinstance(d, dict):
        for k, v in d.items():
            m[str(k)] = int(v)
    elif isinstance(d, list):
        for i, item in enumerate(d, 1):
            if isinstance(item, dict):
                name = item.get("name") or item.get("class") or str(item.get("id"))
                m[str(name)] = int(item.get("id", i))
            else:
                m[str(item)] = i
    return m


@app.post("/api/classes/load")
def classes_load(req: ClassesLoadReq):
    """Load a custom class map from JSON/YAML text. Accepts:
       {name:id,...} | [names] | [{name,id}] | {classes:...} | {tissue:{...},instrument:{...}}"""
    global CLASS_MAP_ALL, CLASS_MAP_T, CLASS_MAP_I
    text, fmt = req.text, req.format
    if req.path:
        p = _norm(req.path)
        if not os.path.isfile(p):
            raise HTTPException(400, f"File not found: {p}")
        with open(p, encoding="utf-8") as f:
            text = f.read()
        fmt = "yaml" if p.lower().endswith((".yaml", ".yml")) else "json"
    if not text:
        raise HTTPException(400, "No class file provided")
    try:
        if fmt in ("yaml", "yml"):
            import yaml
            data = yaml.safe_load(text)
        else:
            data = json.loads(text)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"Could not parse file: {e}")

    tissue, instrument = {}, {}
    if isinstance(data, dict) and ("tissue" in data or "instrument" in data):
        tissue = _to_map(data.get("tissue", {}))
        instrument = _to_map(data.get("instrument", {}))
        allm = {**tissue, **instrument}
    elif isinstance(data, dict) and "classes" in data:
        allm = _to_map(data["classes"])
    else:
        allm = _to_map(data)
    if not allm:
        raise HTTPException(400, "No classes found in file")
    if not tissue and not instrument:
        tissue = allm            # ungrouped -> single group so the picker still works

    CLASS_MAP_ALL, CLASS_MAP_T, CLASS_MAP_I = allm, tissue, instrument
    SESSION.inference_state = None
    SESSION.reset_propagation()
    return {"class_map": allm, "tissue": tissue, "instrument": instrument, "n": len(allm)}


@app.post("/api/classes/reset")
def classes_reset():
    global CLASS_MAP_ALL, CLASS_MAP_T, CLASS_MAP_I
    CLASS_MAP_T, CLASS_MAP_I = dict(_DEFAULT_T), dict(_DEFAULT_I)
    CLASS_MAP_ALL = {**CLASS_MAP_T, **CLASS_MAP_I}
    SESSION.inference_state = None
    SESSION.reset_propagation()
    return {"class_map": CLASS_MAP_ALL, "tissue": CLASS_MAP_T, "instrument": CLASS_MAP_I,
            "n": len(CLASS_MAP_ALL)}


@app.get("/api/model/current")
def model_current():
    return {"ckpt": CURRENT_CKPT, "config": CURRENT_CFG,
            "available": SAM2_AVAILABLE, "torch": TORCH_OK,
            "device": str(device) if device is not None else "cpu"}


class ModelLoadReq(BaseModel):
    ckpt: str
    config: Optional[str] = None


@app.post("/api/model/load")
def model_load(req: ModelLoadReq):
    global predictor, SAM2_AVAILABLE, CURRENT_CKPT, CURRENT_CFG
    if not TORCH_OK:
        raise HTTPException(400, "PyTorch is not available in this environment")
    ckpt = _norm(req.ckpt)
    if not os.path.isfile(ckpt):
        raise HTTPException(400, f"Checkpoint not found: {ckpt}")
    cfg = _norm(req.config) if req.config else (CURRENT_CFG or
          "../sam2/configs/sam2.1/sam2.1_hiera_l.yaml")
    try:
        from sam2.build_sam import build_sam2_video_predictor
        predictor = build_sam2_video_predictor(cfg, ckpt, device=device)
        SAM2_AVAILABLE = True
        CURRENT_CKPT, CURRENT_CFG = ckpt, cfg
    except Exception as e:  # noqa: BLE001
        traceback.print_exc()
        raise HTTPException(400, f"Model load failed: {e}")
    SESSION.inference_state = None
    SESSION.reset_propagation()
    return {"ok": True, "ckpt": ckpt, "config": cfg}


class BrowseReq(BaseModel):
    path: Optional[str] = None
    exts: Optional[List[str]] = None    # if set, also list files with these extensions


class MkdirReq(BaseModel):
    parent: str
    name: str


@app.get("/api/user")
def get_user():
    return {"user": DEFAULT_USER}


@app.get("/api/tree_root")
def tree_root():
    return {"root": os.path.abspath(DEFAULT_TREE_ROOT)}


class TreeReq(BaseModel):
    path: Optional[str] = None


@app.post("/api/tree")
def tree(req: TreeReq):
    """One directory level (lazy): subfolders + image files. Cheap by design."""
    path = _norm(req.path or DEFAULT_TREE_ROOT)
    if not os.path.isdir(path):
        raise HTTPException(400, f"Not a directory: {path}")
    path = os.path.abspath(path)
    try:
        entries = list(os.scandir(path))
    except PermissionError:
        raise HTTPException(400, f"Permission denied: {path}")
    dirs = sorted((e.name for e in entries if e.is_dir()), key=str.lower)
    imgs = sorted((e.name for e in entries
                   if e.is_file() and os.path.splitext(e.name)[1].lower() in IMG_EXTS),
                  key=extract_number)
    parent = os.path.dirname(path)
    return {"path": path, "parent": parent if parent != path else None,
            "dirs": [{"name": d, "path": os.path.join(path, d)} for d in dirs],
            "images": imgs, "n_images": len(imgs)}


@app.post("/api/mkdir")
def mkdir(req: MkdirReq):
    parent = _norm(req.parent)
    if not os.path.isdir(parent):
        raise HTTPException(400, f"Parent not found: {parent}")
    name = (req.name or "").strip().replace("/", "").replace("\\", "")
    if not name or name in (".", ".."):
        raise HTTPException(400, "Invalid folder name")
    path = os.path.join(parent, name)
    try:
        os.makedirs(path, exist_ok=True)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"Could not create folder: {e}")
    return {"path": path}


@app.get("/api/default_path")
def default_path():
    return {"path": DEFAULT_BROWSE_PATH}


@app.post("/api/browse")
def browse(req: BrowseReq):
    """List sub-directories of a server-side path (for the folder picker)."""
    path = req.path or DEFAULT_BROWSE_PATH
    path = _norm(path)
    # if the path doesn't exist, walk up to the first existing ancestor
    if not os.path.isdir(path):
        while path and not os.path.isdir(path):
            parent = os.path.dirname(path)
            if parent == path:
                break
            path = parent
        if not os.path.isdir(path):
            path = os.path.sep
    path = os.path.abspath(path)
    try:
        entries = os.listdir(path)
    except PermissionError:
        raise HTTPException(400, f"Permission denied: {path}")
    dirs = sorted((d for d in entries if os.path.isdir(os.path.join(path, d))),
                  key=str.lower)
    image_count = sum(1 for e in entries
                      if os.path.splitext(e)[1].lower() in IMG_EXTS)
    files = []
    if req.exts:
        exts = tuple(e.lower() if e.startswith(".") else "." + e.lower() for e in req.exts)
        files = sorted((f for f in entries
                        if os.path.isfile(os.path.join(path, f))
                        and os.path.splitext(f)[1].lower() in exts), key=str.lower)
    parent = os.path.dirname(path)
    if parent == path:
        parent = None
    return {"path": path, "parent": parent, "dirs": dirs,
            "image_count": image_count, "files": files}


@app.post("/api/open_folder")
def open_folder(req: OpenFolderReq):
    path = _norm(req.path)
    if not os.path.isdir(path):
        raise HTTPException(400, f"Not a directory: {path}")

    names = [p for p in os.listdir(path)
             if os.path.splitext(p)[-1].lower() in (".jpg", ".jpeg", ".png", ".tiff")]
    names.sort(key=extract_number)
    if not names:
        raise HTTPException(400, "No image files found in folder")

    SESSION.frame_dir = path
    SESSION.frame_names = names
    SESSION.sizes = {}
    SESSION.inference_state = None
    SESSION.reset_propagation()
    SESSION.video_probe = None
    _find_case_video()

    w, h = frame_size(0)
    return {
        "count": len(names),
        "names": names,
        "width": w,
        "height": h,
        "sam2_available": SAM2_AVAILABLE,
        "device": str(device) if device is not None else "cpu",
        "case": _case_name(path),
        "video": _video_status(),
    }


@app.post("/api/video/config")
def video_config(req: VideoFolderReq):
    path = _norm(req.path)
    if not os.path.isdir(path):
        raise HTTPException(400, f"Video directory not found: {path}")
    if req.fps is not None and (req.fps <= 0 or req.fps > 240):
        raise HTTPException(400, "FPS must be between 0 and 240")
    SESSION.video_dir = os.path.abspath(path)
    SESSION.video_dir_display = req.path.strip()
    SESSION.video_fps_override = req.fps
    SESSION.video_probe = None
    _find_case_video()
    return _video_status()


@app.get("/api/video/status")
def video_status():
    return _video_status()


def _file_chunks(path, start, end, chunk_size=1024 * 1024):
    with open(path, "rb") as source:
        source.seek(start)
        remaining = end - start + 1
        while remaining > 0:
            chunk = source.read(min(chunk_size, remaining))
            if not chunk:
                break
            remaining -= len(chunk)
            yield chunk


@app.get("/api/video/file")
def video_file(request: Request):
    path = SESSION.video_path
    if not path or not os.path.isfile(path):
        raise HTTPException(404, "No video matches the current case")
    size = os.path.getsize(path)
    start, end, status = 0, size - 1, 200
    range_header = request.headers.get("range")
    if range_header:
        match = re.match(r"bytes=(\d*)-(\d*)", range_header)
        if not match:
            return Response(status_code=416, headers={"Content-Range": f"bytes */{size}"})
        left, right = match.groups()
        if not left:
            suffix = int(right or 0)
            start = max(0, size - suffix)
        else:
            start = int(left)
        if right and left:
            end = min(int(right), size - 1)
        if start >= size or start > end:
            return Response(status_code=416, headers={"Content-Range": f"bytes */{size}"})
        status = 206
    ext = os.path.splitext(path)[1].lower()
    media_type = {".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime",
                  ".webm": "video/webm"}.get(ext, "application/octet-stream")
    headers = {"Accept-Ranges": "bytes", "Content-Length": str(end - start + 1),
               "Cache-Control": "private, max-age=3600"}
    if status == 206:
        headers["Content-Range"] = f"bytes {start}-{end}/{size}"
    return StreamingResponse(_file_chunks(path, start, end), status_code=status,
                             media_type=media_type, headers=headers)


@app.post("/api/init")
def init_state():
    """Initialise the SAM2 inference state for the loaded folder (may be slow)."""
    if SESSION.frame_dir is None:
        raise HTTPException(400, "No folder open")
    if not SAM2_AVAILABLE or predictor is None:
        return {"ok": True, "simulated": True}
    try:
        SESSION.inference_state = predictor.init_state(video_path=SESSION.frame_dir)
        SESSION.reset_propagation()
        return {"ok": True, "simulated": False}
    except Exception as e:  # noqa: BLE001
        traceback.print_exc()
        raise HTTPException(500, f"init_state failed: {e}")


@app.get("/api/frame_image/{idx}")
def frame_image(idx: int):
    if SESSION.frame_dir is None or idx < 0 or idx >= len(SESSION.frame_names):
        raise HTTPException(404, "frame not found")
    path = os.path.join(SESSION.frame_dir, SESSION.frame_names[idx])
    with open(path, "rb") as f:
        data = f.read()
    ext = os.path.splitext(path)[1].lower()
    media = "image/png" if ext == ".png" else "image/jpeg"
    return Response(content=data, media_type=media)


@app.get("/api/frame_meta/{idx}")
def frame_meta(idx: int):
    if SESSION.frame_dir is None or idx < 0 or idx >= len(SESSION.frame_names):
        raise HTTPException(404, "frame not found")
    w, h = frame_size(idx)
    return {"idx": idx, "name": SESSION.frame_names[idx], "width": w, "height": h}


@app.post("/api/predict")
def predict(req: PredictReq):
    try:
        mask = sam_predict(req.frame_idx, req.obj_id, req.points, req.labels, req.box)
        return {"obj_id": req.obj_id, "mask": mask_to_b64(mask)}
    except Exception as e:  # noqa: BLE001
        traceback.print_exc()
        raise HTTPException(500, f"predict failed: {e}")


@app.post("/api/propagate/init")
def propagate_init():
    propagation_init()
    return {"ok": True, "simulated": not SAM2_AVAILABLE}


@app.post("/api/propagate/frame")
def propagate_frame(req: PropagateReq):
    masks = propagation_generate(req.frame_idx)
    if masks is None:
        return {"frame_idx": req.frame_idx, "masks": [], "available": False}
    return {
        "frame_idx": req.frame_idx,
        "available": True,
        "masks": [{"obj_id": oid, "mask": mask_to_b64(m)} for oid, m in masks.items()],
    }


@app.get("/api/propagate/progress")
def propagate_progress():
    return PROP_PROGRESS


@app.post("/api/propagate/reseed")
def propagate_reseed(req: ReseedReq):
    """Seed the current frame's corrected masks and restart propagation from here."""
    corrected = {o.obj_id: b64_to_mask(o.mask) for o in req.objects}
    used_mask, n = reseed_from_frame(req.frame_idx, corrected)
    return {"ok": True, "frame_idx": req.frame_idx, "seeded": n,
            "seed_kind": ("mask" if used_mask else "box"),
            "simulated": not SAM2_AVAILABLE}


def _dice(a, b):
    a = a > 0
    b = b > 0
    sa, sb = int(a.sum()), int(b.sum())
    if sa == 0 and sb == 0:
        return 1.0, sa, sb          # both empty: perfect agreement (no work needed)
    inter = int(np.logical_and(a, b).sum())
    return (2.0 * inter) / (sa + sb), sa, sb


@app.post("/api/dice")
def dice(req: DiceReq):
    """Dice between SAM2's initial mask and the human-final mask, per record.

    Returns per-record rows plus per-class and overall summaries (with n and the
    empty-case counts surfaced), split by kind ('prompt' vs 'propagation')."""
    rows = []
    for r in req.records:
        raw = b64_to_mask(r.raw)
        fin = b64_to_mask(r.final)
        d, ra, fa = _dice(raw, fin)
        rows.append({
            "frame_idx": r.frame_idx, "obj_id": r.obj_id, "class_id": r.class_id,
            "class_name": _class_name_for_id(r.class_id), "kind": r.kind,
            "dice": round(d, 4), "initial_area": ra, "final_area": fa,
            "empty_initial": ra == 0, "empty_final": fa == 0,
        })

    def summarize(subset):
        by_class = {}
        for row in subset:
            by_class.setdefault(row["class_id"], []).append(row)
        per_class = []
        for cid, rws in sorted(by_class.items()):
            dices = [x["dice"] for x in rws]
            per_class.append({
                "class_id": cid, "class_name": _class_name_for_id(cid),
                "n": len(rws), "mean_dice": round(float(np.mean(dices)), 4),
                "empty_initial": sum(1 for x in rws if x["empty_initial"]),
            })
        overall = round(float(np.mean([x["dice"] for x in subset])), 4) if subset else None
        return {"overall_mean_dice": overall, "n": len(subset), "per_class": per_class}

    return {
        "rows": rows,
        "prompt": summarize([r for r in rows if r["kind"] == "prompt"]),
        "propagation": summarize([r for r in rows if r["kind"] == "propagation"]),
        "all": summarize(rows),
    }


# ===================================================================== #
#  Review mode — multi-annotator agreement over ROOT/<annotator>/<case>/
# ===================================================================== #
import re
import csv
from itertools import combinations

DEFAULT_RESULTS_ROOT = os.environ.get(
    "ISSAS_RESULTS_ROOT", os.path.join(SCRIPT_DIR, "Results"))
DEFAULT_FRAMES_BASE = os.environ.get(
    "ISSAS_FRAMES_BASE",
    "/home/mqxwd68/Downloads/sam2/CRF/Results/sam2_l/003_1s_extraction_OFS10/Gastro28")
DEFAULT_USER = os.environ.get("ISSAS_USER", "ISSAS_USER")
DEFAULT_TREE_ROOT = os.environ.get("ISSAS_DATA_ROOT", SCRIPT_DIR)


class ReviewScanReq(BaseModel):
    root: str


class ReviewAgreeReq(BaseModel):
    root: str
    case: str
    annotators: Optional[List[str]] = None   # default: all with this case


def _load_palette_classes(png_path):
    """palette PNG -> {class_id: bool HxW}."""
    im = Image.open(png_path)
    arr = np.array(im if im.mode == "P" else im.convert("P"))
    return {int(v): (arr == v) for v in np.unique(arr) if v != 0}


def _case_mask_dir(root, ann, case):
    """Directory holding a case's PNG masks: prefer <case>/masks, else flat <case>."""
    base = os.path.join(root, ann, case)
    md = os.path.join(base, "masks")
    if os.path.isdir(md):
        return md
    return base


def _count_case_pngs(root, ann, case):
    d = _case_mask_dir(root, ann, case)
    return len([f for f in os.listdir(d) if f.lower().endswith(".png")]) if os.path.isdir(d) else 0


def _case_pngs(root, ann, case):
    d = _case_mask_dir(root, ann, case)
    return ({f for f in os.listdir(d) if f.lower().endswith(".png")}, d) if os.path.isdir(d) else (set(), d)


def _annotator_base(aid):
    """Strip a repeat-pass suffix so intra-observer is recoverable (userA_p2 -> userA)."""
    return re.sub(r'[_-]?p(ass)?\d+$', '', aid, flags=re.I)


def _boundary_points(mask):
    if not HAS_SCIPY or mask.sum() == 0:
        return None
    b = mask & ~binary_erosion(mask)
    ys, xs = np.where(b)
    if len(xs) == 0:
        ys, xs = np.where(mask)
    return np.stack([xs, ys], axis=1)


def _pair_metrics(a, b):
    a = a > 0; b = b > 0
    sa, sb = int(a.sum()), int(b.sum())
    inter = int(np.logical_and(a, b).sum())
    union = int(np.logical_or(a, b).sum())
    dice = 1.0 if (sa == 0 and sb == 0) else (2.0 * inter / (sa + sb) if (sa + sb) else 0.0)
    iou = 1.0 if union == 0 else inter / union
    hd = hd95 = None
    if sa > 0 and sb > 0 and HAS_SCIPY:
        try:
            from scipy.spatial import cKDTree
            pa, pb = _boundary_points(a), _boundary_points(b)
            if pa is not None and pb is not None:
                da, _ = cKDTree(pb).query(pa)
                db, _ = cKDTree(pa).query(pb)
                alld = np.concatenate([da, db])
                hd = float(alld.max())
                hd95 = float(np.percentile(alld, 95))
        except Exception:
            pass
    return {"dice": round(dice, 4), "iou": round(iou, 4),
            "hd": None if hd is None else round(hd, 2),
            "hd95": None if hd95 is None else round(hd95, 2)}


@app.get("/api/review/default_root")
def review_default_root():
    return {"root": DEFAULT_RESULTS_ROOT}


@app.get("/api/review/frames_base")
def review_frames_base():
    return {"base": DEFAULT_FRAMES_BASE}


class ResolveFramesReq(BaseModel):
    base: str
    case: str


@app.post("/api/review/resolve_frames")
def resolve_frames(req: ResolveFramesReq):
    """Find the actual image folder for a case: <base>/<case>/images or <base>/<case>."""
    base = _norm(req.base)
    exts = (".jpg", ".jpeg", ".png", ".tiff", ".bmp")
    for d in (os.path.join(base, req.case, "images"), os.path.join(base, req.case)):
        if os.path.isdir(d) and any(f.lower().endswith(exts) for f in os.listdir(d)):
            return {"dir": d, "found": True}
    return {"dir": os.path.join(base, req.case), "found": False}


@app.post("/api/review/scan")
def review_scan(req: ReviewScanReq):
    root = os.path.abspath(_norm(req.root))
    if not os.path.isdir(root):
        raise HTTPException(400, f"Not a directory: {root}")
    annotators = sorted(d for d in os.listdir(root)
                        if os.path.isdir(os.path.join(root, d)))
    info = []
    case_set = set()
    for a in annotators:
        adir = os.path.join(root, a)
        cases = {}
        for c in sorted(os.listdir(adir)):
            cdir = os.path.join(adir, c)
            if not os.path.isdir(cdir):
                continue
            n = _count_case_pngs(root, a, c)
            if n:
                cases[c] = n
                case_set.add(c)
        info.append({"id": a, "base": _annotator_base(a), "cases": cases,
                     "is_sam": a.endswith("_sam")})
    return {"root": root, "annotators": info, "cases": sorted(case_set)}


def _case_rows(root, case, anns):
    """Pairwise per-class metric rows for one case (tagged with 'case'). Returns (rows, n_shared)."""
    present = [a for a in anns if os.path.isdir(os.path.join(root, a, case))]
    if len(present) < 2:
        return [], 0
    mask_dir = {a: _case_mask_dir(root, a, case) for a in present}
    frames_by_ann = {a: set(f for f in os.listdir(mask_dir[a]) if f.lower().endswith(".png"))
                     for a in present}
    fc = {}
    for a in present:
        for f in frames_by_ann[a]:
            fc[f] = fc.get(f, 0) + 1
    shared = sorted(f for f, n in fc.items() if n >= 2)
    cache = {}
    def load(a, f):
        k = (a, f)
        if k not in cache:
            cache[k] = _load_palette_classes(os.path.join(mask_dir[a], f))
        return cache[k]
    rows = []
    for f in shared:
        here = [a for a in present if f in frames_by_ann[a]]
        for a, b in combinations(here, 2):
            ma, mb = load(a, f), load(b, f)
            classes = set(ma) | set(mb)
            kind = "intra" if _annotator_base(a) == _annotator_base(b) else "inter"
            for cid in sorted(classes):
                base = next(iter((ma or mb).values()))
                A = ma.get(cid, np.zeros(base.shape, bool))
                B = mb.get(cid, np.zeros(A.shape, bool))
                m = _pair_metrics(A, B)
                rows.append({"case": case, "frame": f, "class_id": cid,
                             "class_name": _class_name_for_id(cid),
                             "ann_a": a, "ann_b": b, "kind": kind,
                             "one_sided": (cid not in ma) or (cid not in mb), **m})
    return rows, len(shared)


def _mean(vals):
    vals = [v for v in vals if v is not None]
    return round(float(np.mean(vals)), 4) if vals else None


def _agg(subset, multi):
    METRICS = ("dice", "iou", "hd", "hd95")
    by_class = {}
    for r in subset:
        by_class.setdefault(r["class_id"], []).append(r)
    per_class = []
    for cid, rs in sorted(by_class.items()):
        micro = {k: _mean([x[k] for x in rs]) for k in METRICS}
        if multi:
            by_case = {}
            for x in rs:
                by_case.setdefault(x["case"], []).append(x)
            macro = {k: _mean([_mean([x[k] for x in cs]) for cs in by_case.values()])
                     for k in METRICS}
            n_cases = len(by_case)
        else:
            macro, n_cases = micro, 1
        row = {"class_id": cid, "class_name": _class_name_for_id(cid),
               "n": len(rs), "n_hd": sum(1 for x in rs if x["hd"] is not None),
               "n_cases": n_cases, "one_sided": sum(1 for x in rs if x["one_sided"])}
        for k in METRICS:
            row[k] = macro[k]              # headline = macro (per-case averaged) in multi mode
            row[k + "_micro"] = micro[k]   # pooled, shown in tooltip
        per_class.append(row)

    per_case = []
    if multi:
        by_case = {}
        for r in subset:
            by_case.setdefault(r["case"], []).append(r)
        for case, rs in sorted(by_case.items()):
            row = {"case": case, "n": len(rs)}
            by_cls = {}
            for x in rs:
                by_cls.setdefault(x["class_id"], []).append(x)
            for k in METRICS:
                # headline = macro (per-class averaged within the case); _micro = pooled over samples
                row[k] = _mean([_mean([x[k] for x in cs]) for cs in by_cls.values()])
                row[k + "_micro"] = _mean([x[k] for x in rs])
            per_case.append(row)

    overall = {k: _mean([x[k] for x in subset]) for k in METRICS}   # pooled = n-weighted average
    def col(rows, k):
        return _mean([r.get(k) for r in rows])
    return {
        "n": len(subset), "per_class": per_class, "per_case": per_case, "overall": overall,
        # Average rows: unweighted (mean of the shown rows) + weighted (pooled overall)
        "class_avg_unweighted": {k: col(per_class, k) for k in METRICS},
        "class_avg_weighted": overall,
        "case_avg_unweighted": ({k: col(per_case, k) for k in METRICS} if multi else None),
        "case_avg_weighted": overall,
    }


@app.post("/api/review/agreement")
def review_agreement(req: ReviewAgreeReq):
    root = os.path.abspath(_norm(req.root))
    all_ann = [a for a in os.listdir(root) if os.path.isdir(os.path.join(root, a))]
    sel = [a for a in (req.annotators or all_ann) if a in all_ann]
    multi = req.case in ("ALL", "*", "__all__")

    if multi:
        case_present = {}
        for a in sel:
            adir = os.path.join(root, a)
            if not os.path.isdir(adir):
                continue
            for c in sorted(os.listdir(adir)):
                if os.path.isdir(os.path.join(adir, c)) and _count_case_pngs(root, a, c) > 0:
                    case_present.setdefault(c, set()).add(a)
        cases = sorted(c for c, s in case_present.items() if len(s) >= 2)
        if not cases:
            raise HTTPException(400, "No case has ≥2 of the selected annotators")
        rows, shared_total = [], 0
        for c in cases:
            r, sh = _case_rows(root, c, sel)
            rows += r
            shared_total += sh
    else:
        anns = [a for a in sel if os.path.isdir(os.path.join(root, a, req.case))]
        if len(anns) < 2:
            raise HTTPException(400, "Need at least 2 annotators with this case")
        rows, shared_total = _case_rows(root, req.case, anns)
        cases = [req.case]

    result = {
        "root": root, "case": req.case, "multi": multi, "cases": cases,
        "annotators": sel, "n_shared_frames": shared_total,
        "inter": _agg([r for r in rows if r["kind"] == "inter"], multi),
        "intra": _agg([r for r in rows if r["kind"] == "intra"], multi),
        "all": _agg(rows, multi),
    }

    outdir = os.path.join(root, "_review_all") if multi else os.path.join(root, req.case, "_review")
    os.makedirs(outdir, exist_ok=True)
    json_path = os.path.join(outdir, "agreement.json")
    csv_path = os.path.join(outdir, "agreement.csv")
    with open(json_path, "w") as fp:
        json.dump({**result, "rows": rows}, fp, indent=2)
    with open(csv_path, "w", newline="") as fp:
        w = csv.writer(fp)
        w.writerow(["case", "frame", "class_id", "class_name", "ann_a", "ann_b",
                    "kind", "one_sided", "dice", "iou", "hd", "hd95"])
        for r in rows:
            w.writerow([r.get("case", req.case), r["frame"], r["class_id"], r["class_name"],
                        r["ann_a"], r["ann_b"], r["kind"], r["one_sided"],
                        r["dice"], r["iou"], r["hd"], r["hd95"]])
    result["rows"] = rows
    result["saved"] = {"json": json_path, "csv": csv_path}
    return result


class FrameListReq(BaseModel):
    root: str
    case: str
    ann_a: str
    ann_b: str


class FrameCompareReq(BaseModel):
    root: str
    case: str
    ann_a: str
    ann_b: str
    frame: str


class ReviewImageReq(BaseModel):
    dir: str
    frame: str


@app.post("/api/review/frames")
def review_frames(req: FrameListReq):
    root = os.path.abspath(_norm(req.root))
    da = _case_mask_dir(root, req.ann_a, req.case)
    db = _case_mask_dir(root, req.ann_b, req.case)
    fa = {f for f in os.listdir(da) if f.lower().endswith(".png")} if os.path.isdir(da) else set()
    fb = {f for f in os.listdir(db) if f.lower().endswith(".png")} if os.path.isdir(db) else set()
    return {"frames": sorted(fa & fb), "only_a": sorted(fa - fb), "only_b": sorted(fb - fa)}


@app.post("/api/review/frame_scores")
def review_frame_scores(req: FrameListReq):
    """Mean Dice per shared frame for the A/B pair (for the timeline plot)."""
    root = os.path.abspath(_norm(req.root))
    da = _case_mask_dir(root, req.ann_a, req.case)
    db = _case_mask_dir(root, req.ann_b, req.case)
    fa = {f for f in os.listdir(da) if f.lower().endswith(".png")} if os.path.isdir(da) else set()
    fb = {f for f in os.listdir(db) if f.lower().endswith(".png")} if os.path.isdir(db) else set()
    shared = sorted(fa & fb)
    scores = []
    for f in shared:
        pa, pb = os.path.join(da, f), os.path.join(db, f)
        with Image.open(pa) as im:
            w, h = im.size
        ma, mb = _load_palette_classes(pa), _load_palette_classes(pb)
        dices = []
        for cid in sorted(set(ma) | set(mb)):
            A = ma.get(cid, np.zeros((h, w), bool))
            B = mb.get(cid, np.zeros((h, w), bool))
            dices.append(_pair_metrics(A, B)["dice"])
        scores.append({"frame": f, "dice": round(float(np.mean(dices)), 4) if dices else None})
    return {"scores": scores}


@app.post("/api/review/frame_compare")
def review_frame_compare(req: FrameCompareReq):
    root = os.path.abspath(_norm(req.root))
    pa = os.path.join(_case_mask_dir(root, req.ann_a, req.case), req.frame)
    pb = os.path.join(_case_mask_dir(root, req.ann_b, req.case), req.frame)
    if not (os.path.exists(pa) and os.path.exists(pb)):
        raise HTTPException(404, "frame missing for one annotator")
    with Image.open(pa) as im:
        w, h = im.size
    ma, mb = _load_palette_classes(pa), _load_palette_classes(pb)
    classes = sorted(set(ma) | set(mb))
    out = []
    for cid in classes:
        A = ma.get(cid, np.zeros((h, w), bool))
        B = mb.get(cid, np.zeros((h, w), bool))
        m = _pair_metrics(A, B)
        out.append({"class_id": cid, "class_name": _class_name_for_id(cid),
                    "mask_a": mask_to_b64(A), "mask_b": mask_to_b64(B),
                    "only_a": (cid not in ma), "only_b": (cid not in mb), **m})
    return {"width": w, "height": h, "frame": req.frame, "classes": out}


@app.get("/api/review/image")
def review_image(dir: str, frame: str):
    d = _norm(dir)
    base = os.path.splitext(frame)[0]
    candidates = [frame] + [base + e for e in (".png", ".jpg", ".jpeg", ".tiff", ".bmp")]
    for name in candidates:
        p = os.path.join(d, name)
        if os.path.isfile(p):
            with open(p, "rb") as f:
                data = f.read()
            ext = os.path.splitext(p)[1].lower()
            return Response(content=data,
                            media_type="image/png" if ext == ".png" else "image/jpeg")
    raise HTTPException(404, "image not found")


@app.post("/api/postprocess")
def postprocess(req: PostProcessReq):
    mask = b64_to_mask(req.mask)
    if req.op == "gaussian":
        out = pp_gaussian(mask, req.kernel)
    elif req.op == "morph":
        out = pp_morph(mask, req.kernel)
    elif req.op == "components":
        out = pp_components(mask, req.n)
    else:
        raise HTTPException(400, f"unknown op {req.op}")
    return {"mask": mask_to_b64(out)}


def _class_name_for_id(cid):
    for name, i in CLASS_MAP_ALL.items():
        if i == cid:
            return name
    return f"class_{cid}"


@app.post("/api/import_mask")
def import_mask(req: ImportDirReq):
    """Find <basename>.png or <basename>.txt in `dir` and parse into objects+masks."""
    if SESSION.frame_dir is None:
        raise HTTPException(400, "No folder open")
    base = os.path.splitext(SESSION.frame_names[req.frame_idx])[0]
    w, h = frame_size(req.frame_idx)

    png_path = os.path.join(_norm(req.dir), f"{base}.png")
    txt_path = os.path.join(_norm(req.dir), f"{base}.txt")

    objects = []
    if os.path.exists(txt_path):
        with open(txt_path) as f:
            lines = f.readlines()
        class_polys = {}
        for line in lines:
            parts = line.split()
            if not parts:
                continue
            cid = int(parts[0])
            pts = [float(x) for x in parts[1:]]
            poly = [(pts[i] * w, pts[i + 1] * h) for i in range(0, len(pts), 2)]
            class_polys.setdefault(cid, []).append(poly)
        for cid, polys in class_polys.items():
            img = Image.new("L", (w, h), 0)
            d = ImageDraw.Draw(img)
            for poly in polys:
                if len(poly) >= 3:
                    d.polygon(poly, fill=255)
            objects.append((cid, np.array(img) > 0))
    elif os.path.exists(png_path):
        im = Image.open(png_path)
        if im.mode != "P":
            raise HTTPException(400, "PNG must be palette-indexed (mode P)")
        arr = np.array(im)
        for val in np.unique(arr):
            if val == 0:
                continue
            objects.append((int(val), arr == val))
    else:
        raise HTTPException(404, f"No {base}.png or {base}.txt in {req.dir}")

    out = []
    for cid, m in objects:
        out.append({
            "class_id": cid,
            "obj_id": cid,
            "name": _class_name_for_id(cid),
            "color": obj_color(cid),
            "mask": mask_to_b64(m),
        })
    return {"objects": out}


@app.post("/api/import_prompts")
def import_prompts(req: ImportDirReq):
    """Parse Supervisely-style rectangle JSONs; run prediction on the current frame."""
    if SESSION.frame_dir is None:
        raise HTTPException(400, "No folder open")
    pdir = _norm(req.dir)
    if not os.path.isdir(pdir):
        raise HTTPException(400, f"Not a directory: {pdir}")

    frame_bases = [os.path.splitext(n)[0] for n in SESSION.frame_names]
    prompt_files = [f for f in os.listdir(pdir) if f.endswith((".json", ".txt"))]

    # collect prompts per frame
    per_frame = {}
    for pf in prompt_files:
        base = os.path.splitext(pf)[0]
        fidx = next((i for i, fb in enumerate(frame_bases) if fb in base), None)
        if fidx is None:
            continue
        try:
            with open(os.path.join(pdir, pf)) as f:
                data = json.load(f)
        except Exception:
            continue
        objs = data.get("objects", [])
        if not any(o.get("geometryType") == "rectangle" for o in objs):
            continue
        per_frame.setdefault(fidx, []).extend(objs)

    def to_boxes(objs):
        boxes = []
        class_counts = {}
        for o in objs:
            if o.get("geometryType") != "rectangle":
                continue
            title = o.get("classTitle", "")
            title = (title[0].upper() + title[1:]) if title else title
            base_id = CLASS_MAP_ALL.get(title)
            if base_id is None:
                continue
            class_counts[base_id] = class_counts.get(base_id, 0) + 1
            oid = base_id * 1000 + class_counts[base_id]
            ext = o.get("points", {}).get("exterior", [])
            if len(ext) < 2:
                continue
            x1, y1 = min(ext[0][0], ext[1][0]), min(ext[0][1], ext[1][1])
            x2, y2 = max(ext[0][0], ext[1][0]), max(ext[0][1], ext[1][1])
            boxes.append({"obj_id": oid, "class_id": base_id, "name": title,
                          "color": obj_color(oid), "box": [x1, y1, x2, y2]})
        return boxes

    # process current frame immediately
    current_boxes = to_boxes(per_frame.get(req.frame_idx, []))
    masks_out = []
    if current_boxes:
        if SAM2_AVAILABLE and predictor is not None:
            if SESSION.inference_state is None:
                SESSION.inference_state = predictor.init_state(video_path=SESSION.frame_dir)
            else:
                predictor.reset_state(SESSION.inference_state)
        for b in current_boxes:
            m = sam_predict(req.frame_idx, b["obj_id"], [], [], b["box"])
            masks_out.append({**b, "mask": mask_to_b64(m)})
        propagation_init()

    pending = {str(k): to_boxes(v) for k, v in per_frame.items() if k != req.frame_idx}
    return {"current": masks_out, "pending_frames": sorted(int(k) for k in pending.keys())}


@app.post("/api/save")
def save(req: SaveReq):
    if SESSION.frame_dir is None:
        raise HTTPException(400, "No folder open")
    w, h = frame_size(req.frame_idx)
    class_mask = np.zeros((h, w), dtype=np.uint8)
    for o in req.objects:
        m = b64_to_mask(o.mask)
        class_mask[m] = o.class_id

    base = os.path.splitext(os.path.basename(SESSION.frame_names[req.frame_idx]))[0]
    png_dir = _norm(req.png_dir)
    os.makedirs(png_dir, exist_ok=True)
    png_path = os.path.join(png_dir, f"{base}.png")
    _save_palette_png(class_mask, png_path)

    # SAM2-raw masks (automatic, always lossless PNG) -> sam_dir
    sam_path = None
    if req.raw_objects and req.sam_dir:
        sam_dir = _norm(req.sam_dir)
        os.makedirs(sam_dir, exist_ok=True)
        raw_mask = np.zeros((h, w), dtype=np.uint8)
        for o in req.raw_objects:
            raw_mask[b64_to_mask(o.mask)] = o.class_id
        sam_path = os.path.join(sam_dir, f"{base}.png")
        _save_palette_png(raw_mask, sam_path)

    if not req.yolo:
        return {"png_path": png_path, "txt_path": None, "yolo_ok": True,
                "yolo_skipped": True, "yolo_err": "", "sam_path": sam_path}

    yolo_dir = _norm(req.yolo_dir)
    os.makedirs(yolo_dir, exist_ok=True)
    txt_path = os.path.join(yolo_dir, f"{base}.txt")

    # YOLO polygons via the existing A000 script (same as desktop tool)
    yolo_ok, yolo_err = True, ""
    if os.path.exists(PNG2YOLO):
        try:
            r = subprocess.run([sys.executable, PNG2YOLO, png_path, txt_path],
                               capture_output=True, text=True)
            yolo_ok = r.returncode == 0
            yolo_err = r.stderr
        except Exception as e:  # noqa: BLE001
            yolo_ok, yolo_err = False, str(e)

    return {"png_path": png_path, "txt_path": txt_path if yolo_ok else None,
            "yolo_ok": yolo_ok, "yolo_err": yolo_err, "sam_path": sam_path}


# static assets (js/css)
app.mount("/static", StaticFiles(directory=os.path.join(SCRIPT_DIR, "static")), name="static")


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", "9000"))
    print(f"[issas] open http://127.0.0.1:{port}")
    uvicorn.run(app, host="127.0.0.1", port=port)
