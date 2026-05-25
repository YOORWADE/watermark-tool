'use strict';

// ─── 状态 ─────────────────────────────────────────────────────
const state = {
  mode: 'image',
  file: null,
  bgSource: null,       // HTMLImageElement | HTMLVideoElement
  originalW: 0,
  originalH: 0,
  rects: [],            // 已完成选框 [{x,y,w,h}]
  dragStart: null,
  dragCurrent: null,
  isDrawing: false,
  detecting: false,     // 自动识别进行中
  resultUrl: null,
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

const SECTIONS = [uploadArea, canvasSec, loadingSec, resultSec];
function show(sec) {
  SECTIONS.forEach(s => s.classList.toggle('hidden', s !== sec));
}

// ─── 模式切换 ─────────────────────────────────────────────────
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
}

// ─── 渲染 ─────────────────────────────────────────────────────
function render() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (state.bgSource) ctx.drawImage(state.bgSource, 0, 0);

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

// ─── 框选事件 ─────────────────────────────────────────────────
canvas.addEventListener('mousedown', e => {
  if (state.detecting) return;
  state.isDrawing = true;
  state.dragStart = getPoint(e);
  state.dragCurrent = { ...state.dragStart };
});
canvas.addEventListener('mousemove', e => {
  if (!state.isDrawing) return;
  state.dragCurrent = getPoint(e);
  render();
});
canvas.addEventListener('mouseup', e => { if (state.isDrawing) finalizeRect(getPoint(e)); });
canvas.addEventListener('mouseleave', () => {
  if (state.isDrawing && state.dragCurrent) finalizeRect(state.dragCurrent);
});

canvas.addEventListener('touchstart', e => {
  if (state.detecting) return;
  e.preventDefault();
  state.isDrawing = true;
  state.dragStart = getPoint(e);
  state.dragCurrent = { ...state.dragStart };
}, { passive: false });
canvas.addEventListener('touchmove', e => {
  e.preventDefault();
  if (!state.isDrawing) return;
  state.dragCurrent = getPoint(e);
  render();
}, { passive: false });
canvas.addEventListener('touchend', e => {
  e.preventDefault();
  if (state.isDrawing) finalizeRect(state.dragCurrent);
}, { passive: false });

function finalizeRect(endPoint) {
  const rect = makeRect(state.dragStart, endPoint);
  if (rect.w > 4 && rect.h > 4) state.rects.push(rect);
  state.dragStart = null;
  state.dragCurrent = null;
  state.isDrawing = false;
  render();
}

// ─── 撤销 / 清除 ──────────────────────────────────────────────
document.getElementById('undo-btn').addEventListener('click', () => { state.rects.pop(); render(); });
document.getElementById('clear-btn').addEventListener('click', () => {
  state.rects = [];
  detectTip.classList.add('hidden');
  render();
});

// ─── 自动识别 ─────────────────────────────────────────────────
autoDetectBtn.addEventListener('click', autoDetect);

async function autoDetect() {
  if (!state.file || !state.bgSource) return;

  // 将当前帧导出为 PNG blob 发给后端
  let blob;
  if (state.mode === 'image') {
    blob = state.file;
  } else {
    // 视频：把首帧画到离屏 canvas 再导出
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
      // 将后端返回的矩形合并到现有选框中
      state.rects = [...state.rects, ...data.rects];
      render();
      detectTip.classList.remove('hidden');
    } else {
      alert('未检测到明显水印，请手动框选');
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
  octx.fillStyle = '#fff';
  for (const rect of state.rects) {
    octx.fillRect(rect.x, rect.y, rect.w, rect.h);
  }
  return off.convertToBlob({ type: 'image/png' });
}

// ─── 提交处理 ─────────────────────────────────────────────────
document.getElementById('process-btn').addEventListener('click', async () => {
  if (!state.file || !state.rects.length) {
    alert('请先上传文件，然后框选或自动识别水印区域');
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
  state.dragStart = null;
  state.dragCurrent = null;
  state.isDrawing = false;
  state.detecting = false;
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
