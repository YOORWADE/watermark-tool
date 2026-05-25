import os
import tempfile
from io import BytesIO

import cv2
import numpy as np
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

app = FastAPI(title="去水印服务")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─────────────────────────── 工具函数 ───────────────────────────

def decode_mask(mask_bytes: bytes, target_hw: tuple) -> np.ndarray:
    """解码 Mask 并对齐到目标尺寸，返回二值化掩膜。"""
    arr = np.frombuffer(mask_bytes, np.uint8)
    mask = cv2.imdecode(arr, cv2.IMREAD_GRAYSCALE)
    if mask is None:
        raise HTTPException(status_code=400, detail="Mask 解码失败")
    h, w = target_hw
    if mask.shape != (h, w):
        mask = cv2.resize(mask, (w, h), interpolation=cv2.INTER_NEAREST)
    _, binary = cv2.threshold(mask, 127, 255, cv2.THRESH_BINARY)
    # 轻微膨胀覆盖水印边缘（1次即可，避免过度扩张）
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    return cv2.dilate(binary, kernel, iterations=1)


def feather_mask(mask_binary: np.ndarray, radius: int = 12) -> np.ndarray:
    """
    生成羽化遮罩（软边缘），避免修复区域与原图之间出现硬边。
    返回 [0,1] 浮点数组：1.0 = 深度修复区，0.0 = 原始区域。
    """
    dist = cv2.distanceTransform(mask_binary, cv2.DIST_L2, 5)
    return np.clip(dist / radius, 0, 1).astype(np.float32)


def temporal_median_bg(cap: cv2.VideoCapture, n_samples: int = 15) -> np.ndarray | None:
    """
    对视频随机采样 N 帧并逐像素取中值，得到"无水印背景"估算。
    原理：水印是静态叠加层，背景内容随时间变化；
          N 帧中值滤波后，水印信号被内容信号覆盖而消除。
    """
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    if total < 3:
        return None

    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    # 4K 以上分辨率先降采样，避免内存溢出
    scale = 0.5 if w * h > 1920 * 1080 else 1.0

    indices = np.linspace(0, total - 1, min(n_samples, total), dtype=int)
    frames = []
    for idx in indices:
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(idx))
        ret, frame = cap.read()
        if ret:
            if scale < 1.0:
                frame = cv2.resize(frame, (int(w * scale), int(h * scale)))
            frames.append(frame)

    cap.set(cv2.CAP_PROP_POS_FRAMES, 0)  # 复位到开头

    if len(frames) < 3:
        return None

    median = np.median(np.array(frames), axis=0).astype(np.uint8)

    if scale < 1.0:
        median = cv2.resize(median, (w, h))

    return median


def _iou(a: dict, b: dict) -> float:
    ix1 = max(a["x"], b["x"])
    iy1 = max(a["y"], b["y"])
    ix2 = min(a["x"] + a["w"], b["x"] + b["w"])
    iy2 = min(a["y"] + a["h"], b["y"] + b["h"])
    if ix2 <= ix1 or iy2 <= iy1:
        return 0.0
    inter = (ix2 - ix1) * (iy2 - iy1)
    union = a["w"] * a["h"] + b["w"] * b["h"] - inter
    return inter / union if union else 0.0


def _nms(rects: list, thresh: float = 0.35) -> list:
    kept = []
    for r in rects:
        if all(_iou(r, k) < thresh for k in kept):
            kept.append(r)
    return kept


def detect_watermark_regions(img: np.ndarray) -> list[dict]:
    """
    启发式水印区域检测：
    1. 边缘密度图（捕捉文字/Logo 水印的锐利轮廓）
    2. 高亮度区域（白色半透明水印）
    两者叠加后，找连通域并过滤尺寸。
    注意：无法达到 AI 模型的精度，建议用户在结果上手动微调。
    """
    h, w = img.shape[:2]
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    # 自适应核大小（随图片分辨率缩放）
    k = max(5, min(w, h) // 50)

    # 边缘密度
    edges = cv2.Canny(gray, 80, 180)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (k, k))
    edge_map = cv2.dilate(edges, kernel, iterations=2)

    # 高亮区域（白色水印）
    _, bright = cv2.threshold(gray, 210, 255, cv2.THRESH_BINARY)
    bright_map = cv2.dilate(bright, kernel, iterations=1)

    combined = cv2.bitwise_or(edge_map, bright_map)

    # 闭运算：填补内部空洞
    close_k = cv2.getStructuringElement(cv2.MORPH_RECT, (k * 2, k * 2))
    combined = cv2.morphologyEx(combined, cv2.MORPH_CLOSE, close_k)

    contours, _ = cv2.findContours(combined, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    min_area = (h * w) * 0.0008
    max_area = (h * w) * 0.22

    rects = []
    for cnt in contours:
        area = cv2.contourArea(cnt)
        if min_area < area < max_area:
            x, y, cw, ch = cv2.boundingRect(cnt)
            if cw < w * 0.85 and ch < h * 0.85:
                pad = max(5, k // 2)
                rects.append({
                    "x": int(max(0, x - pad)),
                    "y": int(max(0, y - pad)),
                    "w": int(min(w - max(0, x - pad), cw + 2 * pad)),
                    "h": int(min(h - max(0, y - pad), ch + 2 * pad)),
                })

    rects.sort(key=lambda r: r["w"] * r["h"], reverse=True)
    return _nms(rects)[:8]


# ─────────────────────────── 接口 ───────────────────────────────

@app.post("/detect")
async def detect(image: UploadFile = File(...)):
    """接收图片（或视频首帧），返回疑似水印区域的矩形列表。"""
    img_bytes = await image.read()
    img = cv2.imdecode(np.frombuffer(img_bytes, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise HTTPException(status_code=400, detail="图片解码失败")
    rects = detect_watermark_regions(img)
    return {"rects": rects}


@app.post("/inpaint/image")
async def inpaint_image(
    original: UploadFile = File(...),
    mask: UploadFile = File(...),
):
    orig_bytes = await original.read()
    mask_bytes = await mask.read()

    img = cv2.imdecode(np.frombuffer(orig_bytes, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise HTTPException(status_code=400, detail="原图解码失败")

    mask_bin = decode_mask(mask_bytes, img.shape[:2])

    # 用较小的 inpaintRadius（3 vs 5），减少模糊感
    inpainted = cv2.inpaint(img, mask_bin, inpaintRadius=3, flags=cv2.INPAINT_TELEA)

    # 羽化软混合：避免修复边缘出现硬切割
    alpha = feather_mask(mask_bin, radius=10)
    alpha_3d = np.stack([alpha] * 3, axis=-1)
    result = (img.astype(np.float32) * (1 - alpha_3d) +
              inpainted.astype(np.float32) * alpha_3d).astype(np.uint8)

    _, buf = cv2.imencode(".png", result)
    return StreamingResponse(BytesIO(buf.tobytes()), media_type="image/png")


@app.post("/inpaint/video")
async def inpaint_video(
    video: UploadFile = File(...),
    mask: UploadFile = File(...),
):
    video_bytes = await video.read()
    mask_bytes = await mask.read()

    ext = os.path.splitext(video.filename or "video.mp4")[1] or ".mp4"
    tmp_in = tempfile.NamedTemporaryFile(suffix=ext, delete=False)
    tmp_out_path = tmp_in.name + "_result.mp4"

    try:
        tmp_in.write(video_bytes)
        tmp_in.close()

        cap = cv2.VideoCapture(tmp_in.name)
        if not cap.isOpened():
            raise HTTPException(status_code=400, detail="视频文件无法打开")

        fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
        w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

        mask_bin = decode_mask(mask_bytes, (h, w))

        # ── 核心优化：时序中值背景估算 ──────────────────────────
        # 对多帧取中值 → 动态背景保留、静态水印消除
        bg = temporal_median_bg(cap, n_samples=15)

        if bg is not None:
            # 对背景估算做一次 inpaint，消除可能残留的水印痕迹
            bg = cv2.inpaint(bg, mask_bin, inpaintRadius=3, flags=cv2.INPAINT_TELEA)

        # 羽化遮罩：软边缘混合，无硬切割感
        alpha = feather_mask(mask_bin, radius=12)
        alpha_3d = np.stack([alpha] * 3, axis=-1)

        fourcc = cv2.VideoWriter_fourcc(*"mp4v")
        writer = cv2.VideoWriter(tmp_out_path, fourcc, fps, (w, h))

        while True:
            ret, frame = cap.read()
            if not ret:
                break

            if bg is not None:
                # 用中值背景填充水印区域，羽化边缘融合
                # 时序一致性极佳：每帧填充内容相同，零闪烁
                result = (frame.astype(np.float32) * (1 - alpha_3d) +
                          bg.astype(np.float32) * alpha_3d).astype(np.uint8)
            else:
                # 视频帧数过少时退回传统 inpaint
                result = cv2.inpaint(frame, mask_bin, inpaintRadius=3, flags=cv2.INPAINT_TELEA)

            writer.write(result)

        cap.release()
        writer.release()

        with open(tmp_out_path, "rb") as f:
            result_bytes = f.read()

        return StreamingResponse(
            BytesIO(result_bytes),
            media_type="video/mp4",
            headers={"Content-Disposition": "attachment; filename=result.mp4"},
        )
    finally:
        for path in (tmp_in.name, tmp_out_path):
            if os.path.exists(path):
                os.unlink(path)


@app.get("/api/info")
async def api_info():
    import socket
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
    except Exception:
        ip = "127.0.0.1"
    return {"local_ip": ip, "port": 8000}


app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/")
async def index():
    return FileResponse("static/index.html")
