'use strict';

// ─── 状态 ─────────────────────────────────────────────────────
const state = {
  mode: 'image',
  drawMode: 'rect',      // 'rect' | 'brush'
  brushSize: 20,
  file: null,
  bgSource: null,
  originalW: 0,
  originalH: 0,
  rects: [],
  dragStart: null,
  dragCurrent: null,
  isDrawing: false,
  detecting: false,
  resultUrl: null,
  paintCanvas: null,     // OffscreenCanvas — 画笔涂抹层
  paintCtx: null,
  hasPaintStrokes: false,
  undoStack: [],         // [{type:'rect'} | {type:'paint', data:ImageData}]
};

// ─── DOM ──────────────────────────────────────────────────────
const canvas         = document.getElementById('main-canvas');
const ctx            = canvas.getContext('2d');
const uploadArea     = document.getElementById('upload-area');
const fileInput      = document.getElementById('file-input');
const canvasSec      = document.getElementById('canvas-section');
const loadingSec     = document.getElementById('loading-section');
const resultSec      = document.getElementById('result-section');
const uploadHint     = document.getElementById('upload-hint');
const loadingText    = document.getElementById('loading-text');
const resultImg      = document.getElementById('result-img');
const resultVideo    = document.getElementById('result-video');
const detectOverlay  = document.getElementById('detect-overlay');
const detectTip      = document.getElementById('detect-tip');
const autoDetectBtn  = document.getElementById('auto-detect-btn');
const brushSizeCtrl  = document.getElementById('brush-size-ctrl');
const brushSizeInput = document.getElementById('brush-size');
const drawHint       = document.getElementById('draw-hint');

const SECTIONS = [uploadArea, canvasSec, loadingSec, resultSec];
function show(sec) {
  SECTIONS.forEach(s => s.classList.toggle('hidden', s !== sec));
}

// ─── 文件模式切换（图片 / 视频）──────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.mode = btn.dataset.mode;
    fileInput.accept = state.mode === 'image' ? 'image/*' : 'video/*';
    uploadHint.textContent = state.mode === 'image'
      ? '支持 JPG / PNG / WEBP 格式'
      : '支持 MP4 / MOV / AVI 格式';
    reset();
  });
});

// ─── 绘制模式切换（矩形 / 画笔）──────────────────────────────
document.querySelectorAll('.mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.drawMode = btn.dataset.mode;
    const isBrush = state.drawMode === 'brush';
    brushSizeCtrl.classList.toggle('hidden', !isBrush);
    drawHint.textContent = isBrush
      ? '红色区域将被去除 — 按住拖动自由涂抹，可调节笔刷大小'
      : '红色区域将被去除 — 拖拽绘制矩形，可叠加多个';
  });
});

brushSizeInput.addEventListener('input', () => {
  state.brushSize = parseInt(brushSizeInput.value, 10);
});

// ─── 上传 ─────────────────────────────────────────────────────
uploadArea.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', e => { if (e.target.files[0]) loadFile(e.target.files[0]); });
uploadArea.addEventListener('dragover', e => { e.preventDefault(); uploadArea.classList.add('drag-over'); });
uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('drag-over'));
uploadArea.addEventListener('drop', e => {
  e.preventDefault();
  uploadArea.classList.remove('drag-over');
  if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
});

function loadFile(file) {
  state.file = file;
  state.rects = [];
  state.undoStack = [];
  detectTip.classList.add('hidden');
  state.mode === 'image' ? loadImage(file) : loadVideo(file);
}

function loadImage(file) {
  const img = new Image();
  img.onload = () => {
    state.bgSource = img;
    setupCanvas(img.naturalWidth, img.naturalHeight);
    render();
    show(canvasSec);
  };
  img.src = URL.createObjectURL(file);
}

function loadVideo(file) {
  const vid = document.createElement('video');
  vid.muted = true;
  vid.preload = 'metadata';
  vid.src = URL.createObjectURL(file);
  vid.addEventListener('loadedmetadata', () => {
    vid.currentTime = Math.max(0.01, vid.duration * 0.05);
  });
  vid.addEventListener('seeked', () => {
    state.bgSource = vid;
    setupCanvas(vid.videoWidth, vid.videoHeight);
    render();
    show(canvasSec);
  }, { once: true });
}

function setupCanvas(w, h) {
  state.originalW = w;
  state.originalH = h;
  canvas.width = w;
  canvas.height = h;
  state.paintCanvas = new OffscreenCanvas(w, h);
  state.paintCtx = state.paintCanvas.getContext('2d');
  state.hasPaintStrokes = false;
  state.undoStack = [];
}

// ─── 渲染 ─────────────────────────────────────────────────────
function render() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (state.bgSource) ctx.drawImage(state.bgSource, 0, 0);

  // 画笔涂抹层
  if (state.paintCanvas) ctx.drawImage(state.paintCanvas, 0, 0);

  for (const rect of state.rects) drawSelectionRect(ctx, rect, false);

  if (state.dragStart && state.dragCurrent) {
    drawSelectionRect(ctx, makeRect(state.dragStart, state.dragCurrent), true);
  }
}

function drawSelectionRect(targetCtx, rect, isActive) {
  if (rect.w < 2 || rect.h < 2) return;
  const lw = Math.max(3, Math.round(state.originalW / 350));

  targetCtx.save();
  targetCtx.fillStyle = isActive ? 'rgba(255,60,60,0.2)' : 'rgba(255,50,50,0.38)';
  targetCtx.fillRect(rect.x, rect.y, rect.w, rect.h);

  targetCtx.strokeStyle = isActive ? 'rgba(255,120,120,0.95)' : 'rgba(255,70,70,0.95)';
  targetCtx.lineWidth = lw;
  targetCtx.setLineDash([lw * 3, lw * 2]);
  targetCtx.strokeRect(rect.x, rect.y, rect.w, rect.h);

  targetCtx.setLineDash([]);
  targetCtx.fillStyle = 'rgba(255,80,80,0.95)';
  const c = lw * 2.5;
  [[rect.x, rect.y], [rect.x + rect.w - c, rect.y],
   [rect.x, rect.y + rect.h - c], [rect.x + rect.w - c, rect.y + rect.h - c]]
    .forEach(([cx, cy]) => targetCtx.fillRect(cx, cy, c, c));

  targetCtx.restore();
}

// ─── 画笔 ─────────────────────────────────────────────────────
function paintAt(point, radius) {
  if (!state.paintCtx) return;
  state.paintCtx.fillStyle = 'rgba(255,50,50,0.55)';
  state.paintCtx.beginPath();
  state.paintCtx.arc(point.x, point.y, radius, 0, Math.PI * 2);
  state.paintCtx.fill();
  state.hasPaintStrokes = true;
}

function savePaintSnapshot() {
  if (!state.paintCtx) return;
  const snap = state.paintCtx.getImageData(0, 0, state.originalW, state.originalH);
  state.undoStack.push({ type: 'paint', data: snap });
}

// ─── 坐标映射 ─────────────────────────────────────────────────
function getPoint(e) {
  const rect = canvas.getBoundingClientRect();
  const src = e.touches ? e.touches[0] : e;
  return {
    x: (src.clientX - rect.left) * (canvas.width / rect.width),
    y: (src.clientY - rect.top) * (canvas.height / rect.height),
  };
}

function makeRect(p1, p2) {
  return {
    x: Math.min(p1.x, p2.x),
    y: Math.min(p1.y, p2.y),
    w: Math.abs(p2.x - p1.x),
    h: Math.abs(p2.y - p1.y),
  };
}

// ─── 绘制事件 ─────────────────────────────────────────────────
function onStart(e) {
  if (state.detecting) return;
  state.isDrawing = true;
  const pt = getPoint(e);
  if (state.drawMode === 'brush') {
    savePaintSnapshot();
    paintAt(pt, state.brushSize);
    render();
  } else {
    state.dragStart = pt;
    state.dragCurrent = { ...pt };
  }
}

function onMove(e) {
  if (!state.isDrawing) return;
  const pt = getPoint(e);
  if (state.drawMode === 'brush') {
    paintAt(pt, state.brushSize);
    render();
  } else {
    state.dragCurrent = pt;
    render();
  }
}

function onEnd(e) {
  if (!state.isDrawing) return;
  if (state.drawMode === 'rect') {
    finalizeRect(e ? getPoint(e) : state.dragCurrent);
  } else {
    state.isDrawing = false;
  }
}

function onLeave() {
  if (!state.isDrawing) return;
  if (state.drawMode === 'rect' && state.dragCurrent) {
    finalizeRect(state.dragCurrent);
  } else {
    state.isDrawing = false;
  }
}

canvas.addEventListener('mousedown', onStart);
canvas.addEventListener('mousemove', onMove);
canvas.addEventListener('mouseup', onEnd);
canvas.addEventListener('mouseleave', onLeave);

canvas.addEventListener('touchstart', e => { e.preventDefault(); onStart(e); }, { passive: false });
canvas.addEventListener('touchmove',  e => { e.preventDefault(); onMove(e);  }, { passive: false });
canvas.addEventListener('touchend',   e => { e.preventDefault(); onEnd(null); }, { passive: false });

function finalizeRect(endPoint) {
  const rect = makeRect(state.dragStart, endPoint);
  if (rect.w > 4 && rect.h > 4) {
    state.rects.push(rect);
    state.undoStack.push({ type: 'rect' });
  }
  state.dragStart = null;
  state.dragCurrent = null;
  state.isDrawing = false;
  render();
}

// ─── 撤销 / 清除 ──────────────────────────────────────────────
document.getElementById('undo-btn').addEventListener('click', () => {
  const last = state.undoStack.pop();
  if (!last) return;
  if (last.type === 'rect') {
    state.rects.pop();
  } else if (last.type === 'paint' && state.paintCtx) {
    state.paintCtx.putImageData(last.data, 0, 0);
    state.hasPaintStrokes = state.undoStack.some(a => a.type === 'paint');
  }
  render();
});

document.getElementById('clear-btn').addEventListener('click', () => {
  state.rects = [];
  state.undoStack = [];
  if (state.paintCtx) {
    state.paintCtx.clearRect(0, 0, state.originalW, state.originalH);
    state.hasPaintStrokes = false;
  }
  detectTip.classList.add('hidden');
  render();
});

// ─── 自动识别 ─────────────────────────────────────────────────
autoDetectBtn.addEventListener('click', autoDetect);

async function autoDetect() {
  if (!state.file || !state.bgSource) return;

  let blob;
  if (state.mode === 'image') {
    blob = state.file;
  } else {
    const off = new OffscreenCanvas(state.originalW, state.originalH);
    const octx = off.getContext('2d');
    octx.drawImage(state.bgSource, 0, 0);
    blob = await off.convertToBlob({ type: 'image/png' });
  }

  state.detecting = true;
  autoDetectBtn.disabled = true;
  detectOverlay.classList.remove('hidden');
  detectTip.classList.add('hidden');

  try {
    const fd = new FormData();
    fd.append('image', blob, 'frame.png');

    const res = await fetch('/detect', { method: 'POST', body: fd });
    if (!res.ok) throw new Error(await res.text());

    const data = await res.json();

    if (data.rects && data.rects.length > 0) {
      for (const r of data.rects) {
        state.rects.push(r);
        state.undoStack.push({ type: 'rect' });
      }
      render();
      detectTip.classList.remove('hidden');
    } else {
      alert('未检测到明显水印，请手动框选或涂抹');
    }
  } catch (err) {
    alert('识别失败：' + err.message);
  } finally {
    state.detecting = false;
    autoDetectBtn.disabled = false;
    detectOverlay.classList.add('hidden');
  }
}

// ─── 生成 Mask ────────────────────────────────────────────────
async function generateMask() {
  const off = new OffscreenCanvas(state.originalW, state.originalH);
  const octx = off.getContext('2d');
  octx.fillStyle = '#000';
  octx.fillRect(0, 0, state.originalW, state.originalH);

  // 矩形区域 → 白色
  octx.fillStyle = '#fff';
  for (const rect of state.rects) {
    octx.fillRect(rect.x, rect.y, rect.w, rect.h);
  }

  // 画笔涂抹区域 → 白色
  if (state.hasPaintStrokes && state.paintCtx) {
    const paintData = state.paintCtx.getImageData(0, 0, state.originalW, state.originalH);
    const maskData  = octx.getImageData(0, 0, state.originalW, state.originalH);
    for (let i = 3; i < paintData.data.length; i += 4) {
      if (paintData.data[i] > 10) {
        const p = i - 3;
        maskData.data[p]     = 255;
        maskData.data[p + 1] = 255;
        maskData.data[p + 2] = 255;
        maskData.data[p + 3] = 255;
      }
    }
    octx.putImageData(maskData, 0, 0);
  }

  return off.convertToBlob({ type: 'image/png' });
}

// ─── 提交处理 ─────────────────────────────────────────────────
document.getElementById('process-btn').addEventListener('click', async () => {
  const hasMarks = state.rects.length > 0 || state.hasPaintStrokes;
  if (!state.file || !hasMarks) {
    alert('请先上传文件，然后框选或涂抹水印区域');
    return;
  }

  const maskBlob = await generateMask();
  const fd = new FormData();
  fd.append('mask', maskBlob, 'mask.png');

  let endpoint;
  if (state.mode === 'image') {
    fd.append('original', state.file, state.file.name);
    endpoint = '/inpaint/image';
    loadingText.textContent = '图片处理中，请稍候…';
  } else {
    fd.append('video', state.file, state.file.name);
    endpoint = '/inpaint/video';
    loadingText.textContent = '视频处理中（正在计算背景…），请耐心等待';
  }

  show(loadingSec);

  try {
    const res = await fetch(endpoint, { method: 'POST', body: fd });
    if (!res.ok) throw new Error(`服务器错误 ${res.status}: ${await res.text()}`);

    const blob = await res.blob();
    if (state.resultUrl) URL.revokeObjectURL(state.resultUrl);
    state.resultUrl = URL.createObjectURL(blob);

    if (state.mode === 'image') {
      resultImg.src = state.resultUrl;
      resultImg.style.display = 'block';
      resultVideo.style.display = 'none';
    } else {
      resultVideo.src = state.resultUrl;
      resultVideo.style.display = 'block';
      resultImg.style.display = 'none';
    }

    const ext = state.mode === 'image' ? 'png' : 'mp4';
    document.getElementById('download-btn').onclick = () => {
      const a = document.createElement('a');
      a.href = state.resultUrl;
      a.download = `result.${ext}`;
      a.click();
    };

    show(resultSec);
  } catch (err) {
    show(canvasSec);
    alert('处理失败：' + err.message);
  }
});

// ─── 结果页 ───────────────────────────────────────────────────
document.getElementById('edit-again-btn').addEventListener('click', () => show(canvasSec));
document.getElementById('reupload-btn').addEventListener('click', reset);

function reset() {
  state.file = null;
  state.bgSource = null;
  state.rects = [];
  state.undoStack = [];
  state.dragStart = null;
  state.dragCurrent = null;
  state.isDrawing = false;
  state.detecting = false;
  state.hasPaintStrokes = false;
  if (state.paintCtx) state.paintCtx.clearRect(0, 0, state.originalW, state.originalH);
  if (state.resultUrl) { URL.revokeObjectURL(state.resultUrl); state.resultUrl = null; }
  fileInput.value = '';
  detectTip.classList.add('hidden');
  show(uploadArea);
}

// ─── 显示手机访问地址 ─────────────────────────────────────────
fetch('/api/info')
  .then(r => r.json())
  .then(data => {
    const url = `http://${data.local_ip}:${data.port}`;
    const el = document.getElementById('mobile-url');
    if (el) {
      el.textContent = url;
      el.addEventListener('click', () => {
        navigator.clipboard?.writeText(url).then(() => {
          el.textContent = '已复制！';
          setTimeout(() => { el.textContent = url; }, 1500);
        });
      });
    }
  })
  .catch(() => {});
