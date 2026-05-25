'use strict';

// ─── 全局状态 ────────────────────────────────────────────
const state = {
  mode: 'image',        // 'image' | 'video'
  file: null,
  bgSource: null,       // HTMLImageElement 或 HTMLVideoElement
  originalW: 0,
  originalH: 0,
  rects: [],            // 已完成选框 [{x, y, w, h}]
  dragStart: null,      // 当前拖拽起点 {x, y}
  dragCurrent: null,    // 当前拖拽终点 {x, y}
  isDrawing: false,
  resultUrl: null,
};

// ─── DOM 引用 ─────────────────────────────────────────────
const canvas      = document.getElementById('main-canvas');
const ctx         = canvas.getContext('2d');
const uploadArea  = document.getElementById('upload-area');
const fileInput   = document.getElementById('file-input');
const canvasSec   = document.getElementById('canvas-section');
const loadingSec  = document.getElementById('loading-section');
const resultSec   = document.getElementById('result-section');
const uploadHint  = document.getElementById('upload-hint');
const loadingText = document.getElementById('loading-text');
const resultImg   = document.getElementById('result-img');
const resultVideo = document.getElementById('result-video');

const SECTIONS = [uploadArea, canvasSec, loadingSec, resultSec];
function show(sec) {
  SECTIONS.forEach(s => s.classList.toggle('hidden', s !== sec));
}

// ─── 模式切换 ─────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.mode = btn.dataset.mode;
    if (state.mode === 'image') {
      fileInput.accept = 'image/*';
      uploadHint.textContent = '支持 JPG / PNG / WEBP 格式';
    } else {
      fileInput.accept = 'video/*';
      uploadHint.textContent = '支持 MP4 / MOV / AVI 格式';
    }
    reset();
  });
});

// ─── 上传 ─────────────────────────────────────────────────
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
  canvas.width  = w;
  canvas.height = h;
}

// ─── 渲染 ─────────────────────────────────────────────────
function render() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (state.bgSource) ctx.drawImage(state.bgSource, 0, 0);

  // 绘制所有已完成选框
  for (const rect of state.rects) drawSelectionRect(ctx, rect, false);

  // 绘制正在拖拽中的选框
  if (state.dragStart && state.dragCurrent) {
    drawSelectionRect(ctx, makeRect(state.dragStart, state.dragCurrent), true);
  }
}

function drawSelectionRect(targetCtx, rect, isActive) {
  if (rect.w < 2 || rect.h < 2) return;

  // 边框粗细随图片尺寸等比缩放
  const lw = Math.max(3, Math.round(state.originalW / 350));

  targetCtx.save();

  // 半透明红色填充
  targetCtx.fillStyle = isActive ? 'rgba(255, 60, 60, 0.25)' : 'rgba(255, 50, 50, 0.38)';
  targetCtx.fillRect(rect.x, rect.y, rect.w, rect.h);

  // 虚线边框
  targetCtx.strokeStyle = isActive ? 'rgba(255, 120, 120, 0.95)' : 'rgba(255, 70, 70, 0.95)';
  targetCtx.lineWidth = lw;
  targetCtx.setLineDash([lw * 3, lw * 2]);
  targetCtx.strokeRect(rect.x, rect.y, rect.w, rect.h);

  // 选框角标（四个小方块，帮助识别边界）
  targetCtx.setLineDash([]);
  targetCtx.fillStyle = 'rgba(255, 80, 80, 0.95)';
  const corner = lw * 2.5;
  [[rect.x, rect.y], [rect.x + rect.w - corner, rect.y],
   [rect.x, rect.y + rect.h - corner], [rect.x + rect.w - corner, rect.y + rect.h - corner]]
    .forEach(([cx, cy]) => targetCtx.fillRect(cx, cy, corner, corner));

  targetCtx.restore();
}

// ─── 坐标映射 ─────────────────────────────────────────────
// canvas 以 CSS max-width/max-height 缩放显示，需要将屏幕坐标还原为画布像素坐标
function getPoint(e) {
  const rect = canvas.getBoundingClientRect();
  const src  = e.touches ? e.touches[0] : e;
  return {
    x: (src.clientX - rect.left)  * (canvas.width  / rect.width),
    y: (src.clientY - rect.top)   * (canvas.height / rect.height),
  };
}

// 根据两点生成规范化矩形（确保 x/y 是左上角）
function makeRect(p1, p2) {
  return {
    x: Math.min(p1.x, p2.x),
    y: Math.min(p1.y, p2.y),
    w: Math.abs(p2.x - p1.x),
    h: Math.abs(p2.y - p1.y),
  };
}

// ─── 框选事件（鼠标）──────────────────────────────────────
canvas.addEventListener('mousedown', e => {
  state.isDrawing  = true;
  state.dragStart  = getPoint(e);
  state.dragCurrent = { ...state.dragStart };
});
canvas.addEventListener('mousemove', e => {
  if (!state.isDrawing) return;
  state.dragCurrent = getPoint(e);
  render();
});
canvas.addEventListener('mouseup', e => {
  if (!state.isDrawing) return;
  finalizeRect(getPoint(e));
});
canvas.addEventListener('mouseleave', () => {
  // 鼠标移出画布时也完成框选
  if (state.isDrawing && state.dragCurrent) finalizeRect(state.dragCurrent);
});

// ─── 框选事件（触摸）──────────────────────────────────────
canvas.addEventListener('touchstart', e => {
  e.preventDefault();
  state.isDrawing  = true;
  state.dragStart  = getPoint(e);
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
  if (!state.isDrawing) return;
  finalizeRect(state.dragCurrent);
}, { passive: false });

function finalizeRect(endPoint) {
  const rect = makeRect(state.dragStart, endPoint);
  if (rect.w > 4 && rect.h > 4) state.rects.push(rect);
  state.dragStart   = null;
  state.dragCurrent = null;
  state.isDrawing   = false;
  render();
}

// ─── 撤销 / 清除 ──────────────────────────────────────────
document.getElementById('undo-btn').addEventListener('click', () => { state.rects.pop(); render(); });
document.getElementById('clear-btn').addEventListener('click', () => { state.rects = []; render(); });

// ─── 生成黑白 Mask ────────────────────────────────────────
// 黑底白框：后端 inpaint 的待修复区域为白色区域
async function generateMask() {
  const off  = new OffscreenCanvas(state.originalW, state.originalH);
  const octx = off.getContext('2d');
  octx.fillStyle = '#000';
  octx.fillRect(0, 0, state.originalW, state.originalH);
  octx.fillStyle = '#fff';
  for (const rect of state.rects) {
    octx.fillRect(rect.x, rect.y, rect.w, rect.h);
  }
  return off.convertToBlob({ type: 'image/png' });
}

// ─── 提交处理 ─────────────────────────────────────────────
document.getElementById('process-btn').addEventListener('click', async () => {
  if (!state.file || !state.rects.length) {
    alert('请先上传文件，然后框选水印区域');
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
    loadingText.textContent = '视频处理中，帧数越多耗时越长，请耐心等待…';
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

// ─── 结果页操作 ───────────────────────────────────────────
document.getElementById('edit-again-btn').addEventListener('click', () => show(canvasSec));
document.getElementById('reupload-btn').addEventListener('click', reset);

function reset() {
  state.file = null;
  state.bgSource = null;
  state.rects = [];
  state.dragStart = null;
  state.dragCurrent = null;
  state.isDrawing = false;
  if (state.resultUrl) { URL.revokeObjectURL(state.resultUrl); state.resultUrl = null; }
  fileInput.value = '';
  show(uploadArea);
}

// ─── 显示局域网访问地址（手机扫码用）──────────────────────
fetch('/api/info')
  .then(r => r.json())
  .then(data => {
    const url = `http://${data.local_ip}:${data.port}`;
    const el  = document.getElementById('mobile-url');
    if (el) {
      el.textContent = url;
      el.title = '点击复制';
      el.style.cursor = 'pointer';
      el.addEventListener('click', () => {
        navigator.clipboard?.writeText(url).then(() => {
          el.textContent = '已复制！';
          setTimeout(() => { el.textContent = url; }, 1500);
        });
      });
    }
  })
  .catch(() => {});
