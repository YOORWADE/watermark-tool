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
    # 膨胀边缘，消除水印残留
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    return cv2.dilate(binary, kernel, iterations=2)


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
    result = cv2.inpaint(img, mask_bin, inpaintRadius=5, flags=cv2.INPAINT_TELEA)

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

        fourcc = cv2.VideoWriter_fourcc(*"mp4v")
        writer = cv2.VideoWriter(tmp_out_path, fourcc, fps, (w, h))

        while True:
            ret, frame = cap.read()
            if not ret:
                break
            repaired = cv2.inpaint(frame, mask_bin, inpaintRadius=5, flags=cv2.INPAINT_TELEA)
            writer.write(repaired)

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
    """返回本机局域网 IP，供前端展示手机访问地址。"""
    import socket
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
    except Exception:
        ip = "127.0.0.1"
    return {"local_ip": ip, "port": 8000}


# 挂载前端静态文件，必须放在路由定义之后
app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/")
async def index():
    return FileResponse("static/index.html")
