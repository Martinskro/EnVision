import './style.css';
import { unlockAudio, audioState, beep, speak } from './audio.js';
import { createObjectDetector } from './vision.js';

// COCO labels EfficientDet-Lite0 uses for our objects (a can usually shows up as "bottle" or "cup").
const TARGET_LABELS = new Set(['bottle', 'cup', 'wine glass']);
const params = new URLSearchParams(location.search);

const video = document.getElementById('video');
const canvas = document.getElementById('overlay');
const ctx = canvas.getContext('2d');
const debugEl = document.getElementById('debug');
const debugToggle = document.getElementById('debugToggle');
const startScreen = document.getElementById('startScreen');
const startBtn = document.getElementById('startBtn');
const startMsg = document.getElementById('startMsg');

const state = {
  phase: 'idle', // idle | starting | detecting | reloading | error
  delegate: '-',
  fps: 0,
  targets: [], // [{ n, label, score, box: {originX, originY, width, height} }] in video pixels
  others: [],
  error: '',
};

let detector = null;
let lastVideoTime = -1;

// ---------- Start ----------

startBtn.addEventListener('click', start);
debugToggle.addEventListener('click', () => debugEl.classList.toggle('hidden'));
if (params.has('nodebug')) debugEl.classList.add('hidden');

async function start() {
  // Everything audio-related must happen synchronously inside the tap (iOS).
  unlockAudio();
  speak('Starting');
  beep({ freq: 660, duration: 0.12 });
  requestWakeLock();

  startBtn.disabled = true;
  state.phase = 'starting';
  state.error = '';
  try {
    startMsg.textContent = 'Starting camera…';
    await startCamera();
    startMsg.textContent = 'Loading detector…';
    if (!detector) {
      const res = await createObjectDetector({ forceCpu: params.has('cpu') });
      detector = res.detector;
      state.delegate = res.delegate;
    }
    startScreen.hidden = true;
    state.phase = 'detecting';
    requestAnimationFrame(loop);
  } catch (err) {
    console.error(err);
    state.phase = 'error';
    state.error = err?.message || String(err);
    startMsg.textContent = `Error: ${state.error} — tap Start to retry`;
    startBtn.disabled = false;
  }
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('No camera API – page must be opened over HTTPS');
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: 1280 },
      height: { ideal: 720 },
    },
  });
  video.srcObject = stream;
  await video.play();
  if (video.readyState < 2) {
    await new Promise((r) => video.addEventListener('loadeddata', r, { once: true }));
  }
  syncCanvasSize();
}

async function requestWakeLock() {
  try {
    await navigator.wakeLock?.request('screen');
  } catch {
    /* not supported / denied – fine */
  }
}

// ---------- Main loop ----------

let fpsFrames = 0;
let fpsT0 = performance.now();
let lastDebugUpdate = 0;

function loop(now) {
  requestAnimationFrame(loop);
  if (state.phase !== 'detecting' || video.readyState < 2) return;
  if (video.currentTime === lastVideoTime) return; // no new camera frame yet
  lastVideoTime = video.currentTime;

  syncCanvasSize();

  let result;
  try {
    result = detector.detectForVideo(video, now);
  } catch (err) {
    console.error('detectForVideo failed', err);
    handleDetectorFailure(err);
    return;
  }

  processDetections(result.detections);
  draw();

  fpsFrames++;
  if (now - fpsT0 >= 1000) {
    state.fps = (fpsFrames * 1000) / (now - fpsT0);
    fpsFrames = 0;
    fpsT0 = now;
  }
  if (now - lastDebugUpdate > 200) {
    lastDebugUpdate = now;
    renderDebug();
  }
}

// GPU can create fine on iPhone but fail at inference time → rebuild on CPU once.
async function handleDetectorFailure(err) {
  if (state.delegate !== 'GPU') {
    state.phase = 'error';
    state.error = err?.message || String(err);
    renderDebug();
    return;
  }
  state.phase = 'reloading';
  renderDebug();
  try {
    detector.close();
  } catch {
    /* ignore */
  }
  try {
    const res = await createObjectDetector({ forceCpu: true });
    detector = res.detector;
    state.delegate = res.delegate + ' (fallback)';
    state.phase = 'detecting';
  } catch (e) {
    state.phase = 'error';
    state.error = 'CPU fallback failed: ' + (e?.message || e);
    renderDebug();
  }
}

function processDetections(detections) {
  const targets = [];
  const others = [];
  for (const d of detections) {
    const c = d.categories[0];
    if (!c) continue;
    const item = { label: c.categoryName, score: c.score, box: d.boundingBox };
    (TARGET_LABELS.has(item.label) ? targets : others).push(item);
  }
  // Number left → right so numbers are stable-ish and easy to say out loud.
  targets.sort((a, b) => centerX(a.box) - centerX(b.box));
  targets.forEach((t, i) => (t.n = i + 1));
  state.targets = targets;
  state.others = others;
}

const centerX = (b) => b.originX + b.width / 2;

// ---------- Drawing ----------

function syncCanvasSize() {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (w && h && (canvas.width !== w || canvas.height !== h)) {
    canvas.width = w;
    canvas.height = h;
  }
}

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const unit = Math.max(canvas.width, canvas.height) / 100; // scale strokes/text to resolution

  for (const t of state.targets) drawBox(t, '#00e676', unit, true);
  if (!debugEl.classList.contains('hidden')) {
    for (const o of state.others) drawBox(o, 'rgba(255,255,255,0.5)', unit, false);
  }
}

function drawBox(item, color, unit, numbered) {
  const { originX: x, originY: y, width: w, height: h } = item.box;
  ctx.lineWidth = numbered ? unit * 0.6 : unit * 0.25;
  ctx.strokeStyle = color;
  ctx.strokeRect(x, y, w, h);

  ctx.font = `${unit * 2}px ui-monospace, Menlo, monospace`;
  ctx.fillStyle = color;
  ctx.fillText(`${item.label} ${Math.round(item.score * 100)}%`, x + unit * 0.5, y + h - unit * 0.6);

  if (numbered) {
    const r = unit * 2.6;
    ctx.beginPath();
    ctx.arc(x + r, y + r, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#000';
    ctx.font = `bold ${r * 1.4}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(item.n), x + r, y + r * 1.05);
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
  }
}

// ---------- Debug overlay ----------

function renderDebug() {
  if (debugEl.classList.contains('hidden')) return;
  const fmt = (d) => `${d.n ?? '-'}:${d.label} ${d.score.toFixed(2)}`;
  debugEl.textContent = [
    `state: ${state.phase}   delegate: ${state.delegate}`,
    `fps: ${state.fps.toFixed(1)}   video: ${video.videoWidth}x${video.videoHeight}`,
    `audio: ${audioState()}`,
    `targets: ${state.targets.map(fmt).join(', ') || '—'}`,
    `others: ${state.others.map(fmt).join(', ') || '—'}`,
    state.error ? `ERROR: ${state.error}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

renderDebug();
