import './style.css';
import { unlockAudio, audioState, beep, speak } from './audio.js';
import { createObjectDetector } from './vision.js';
import { askMistral, snapshot } from './mistral.js';
import { guide, resetGuidance } from './guidance.js';

// COCO labels EfficientDet-Lite0 uses for our objects (a can usually shows up as "bottle" or "cup").
const TARGET_LABELS = new Set(['bottle', 'cup', 'wine glass']);
const AUTO_CONFIRM_AFTER_MS = 1000; // on target this long → ask Mistral "what is this?"
const params = new URLSearchParams(location.search);

const $ = (id) => document.getElementById(id);
const video = $('video');
const canvas = $('overlay');
const ctx = canvas.getContext('2d');
const debugEl = $('debug');
const startScreen = $('startScreen');
const startBtn = $('startBtn');
const startMsg = $('startMsg');
const controls = $('controls');
const findBtn = $('findBtn');

const state = {
  phase: 'idle', // idle | starting | detecting | asking | guiding | reloading | error
  delegate: '-',
  fps: 0,
  targets: [], // [{ n, label, score, box: {originX, originY, width, height} }] in video pixels
  others: [],
  lock: null, // { box, brand, source, seen, lastSeen, insideSince, confirmed }
  guidance: null,
  busy: false, // a Mistral call is in flight
  mistral: '—', // last Mistral status line for debug
  error: '',
};

let detector = null;
let lastVideoTime = -1;

// ---------- UI wiring ----------

startBtn.addEventListener('click', start);
$('debugToggle').addEventListener('click', () => debugEl.classList.toggle('hidden'));
findBtn.addEventListener('click', findBeer);
$('demoBtn').addEventListener('click', demoPick);
$('confirmBtn').addEventListener('click', () => confirmObject());
$('resetBtn').addEventListener('click', reset);
if (params.has('nodebug')) debugEl.classList.add('hidden');

// ---------- Start ----------

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
    controls.hidden = false;
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

// ---------- Level 1: pick the beer ----------

async function findBeer() {
  if (state.busy || !['detecting', 'guiding'].includes(state.phase)) return;
  const picks = state.targets.map((t) => ({ ...t, box: { ...t.box } })); // freeze this frame's numbering
  if (picks.length === 0) {
    speak("I can't see any bottles or cups. Point the phone at the table.");
    return;
  }

  state.lock = null;
  state.phase = 'asking';
  state.busy = true;
  findBtn.disabled = true;
  speak('Looking for your beer');
  const image = snapshot(video, (g) => {
    const unit = Math.max(g.canvas.width, g.canvas.height) / 100;
    for (const t of picks) drawBox(g, t, '#00e676', unit, { number: true, label: false });
  });

  try {
    const res = await askMistral('pick', image, picks.length);
    const { beer, brand, reason } = res.result || {};
    state.mistral = `pick → beer=${beer} brand=${brand} (${res.clientMs}ms, ${res.model}) ${reason || ''}`;
    const chosen = picks.find((t) => t.n === Number(beer));
    if (!chosen) {
      speak("I couldn't find a beer here. Try pointing at the table again.");
      state.phase = 'detecting';
      return;
    }
    lockTarget(chosen, brand, 'mistral');
  } catch (err) {
    console.error(err);
    state.mistral = `pick FAILED: ${err.message}`;
    const fallback = largest(picks);
    speak('Mistral did not answer. Using the biggest bottle.');
    lockTarget(fallback, null, 'fallback');
  } finally {
    state.busy = false;
    findBtn.disabled = false;
  }
}

// Demo mode: skip Mistral, lock the biggest bottle (or biggest target if no bottle).
function demoPick() {
  if (state.busy || !['detecting', 'guiding'].includes(state.phase)) return;
  if (state.targets.length === 0) {
    speak("I can't see any bottles or cups.");
    return;
  }
  state.mistral = 'demo pick (Mistral skipped)';
  lockTarget(largest(state.targets), null, 'demo');
}

function largest(targets) {
  const bottles = targets.filter((t) => t.label === 'bottle');
  const pool = bottles.length ? bottles : targets;
  return pool.reduce((a, b) => (b.box.width * b.box.height > a.box.width * a.box.height ? b : a));
}

function lockTarget(t, brand, source) {
  state.lock = {
    box: { originX: t.box.originX, originY: t.box.originY, width: t.box.width, height: t.box.height },
    brand: brand && brand !== 'null' ? brand : null,
    source,
    seen: true,
    lastSeen: performance.now(),
    insideSince: 0,
    confirmed: false,
  };
  resetGuidance();
  state.phase = 'guiding';
  const what = state.lock.brand ? `a ${state.lock.brand}` : 'the beer';
  speak(`Found ${what}, ${direction(state.lock.box)}. Follow the beeps.`);
}

function direction(box) {
  const x = (box.originX + box.width / 2) / video.videoWidth;
  if (x < 0.4) return 'on your left';
  if (x > 0.6) return 'on your right';
  return 'straight ahead';
}

// Ask Mistral what the camera is pointed at / what's in hand, and say it.
async function confirmObject() {
  if (state.busy || !video.videoWidth) return;
  state.busy = true;
  try {
    const res = await askMistral('confirm', snapshot(video, null, 0.85));
    const r = res.result || {};
    state.mistral = `confirm → ${r.object} / ${r.brand} beer=${r.is_beer} (${res.clientMs}ms)`;
    speak(r.say || `This is ${r.object || 'something I cannot recognise'}.`);
  } catch (err) {
    console.error(err);
    state.mistral = `confirm FAILED: ${err.message}`;
    speak(state.lock ? "You're on the beer." : "Sorry, I couldn't check that.");
  } finally {
    state.busy = false;
  }
}

function reset() {
  state.lock = null;
  state.guidance = null;
  if (state.phase === 'guiding' || state.phase === 'asking') state.phase = 'detecting';
  speak('Reset');
}

// ---------- Main loop ----------

let fpsFrames = 0;
let fpsT0 = performance.now();
let lastDebugUpdate = 0;

function loop(now) {
  requestAnimationFrame(loop);
  if (!['detecting', 'asking', 'guiding'].includes(state.phase) || video.readyState < 2) return;
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

  if (state.phase === 'guiding' && state.lock) {
    updateLock(now);
    const speaking = window.speechSynthesis?.speaking;
    state.guidance = guide(now, { x: 0.5, y: 0.5 }, normBox(state.lock.box), { silent: speaking });
    handleArrival(now);
  }

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

// Once the pointer has stayed on the beer for a moment, confirm with Mistral (once per lock).
function handleArrival(now) {
  const lock = state.lock;
  if (!state.guidance?.inside) {
    lock.insideSince = 0;
    return;
  }
  if (!lock.insideSince) lock.insideSince = now;
  if (!lock.confirmed && now - lock.insideSince > AUTO_CONFIRM_AFTER_MS) {
    lock.confirmed = true;
    confirmObject();
  }
}

// The phone moves in Level 1, so follow the locked beer by matching it to this frame's detections.
// If nothing matches (occluded / missed), keep the last known box.
function updateLock(now) {
  const lock = state.lock;
  const diag = Math.hypot(video.videoWidth, video.videoHeight);
  const lockArea = lock.box.width * lock.box.height;
  let best = null;
  let bestScore = 0;
  for (const t of state.targets) {
    const overlap = iou(lock.box, t.box);
    const centerDist = Math.hypot(cx(t.box) - cx(lock.box), cy(t.box) - cy(lock.box)) / diag;
    const areaRatio = (t.box.width * t.box.height) / lockArea;
    const near = centerDist < 0.1 && areaRatio > 0.4 && areaRatio < 2.5;
    const score = overlap > 0.2 ? overlap + 1 : near ? 1 - centerDist : 0;
    if (score > bestScore) {
      bestScore = score;
      best = t;
    }
  }
  lock.seen = !!best;
  if (best) {
    lock.lastSeen = now;
    const a = 0.6; // light smoothing against jitter
    for (const k of ['originX', 'originY', 'width', 'height']) lock.box[k] += (best.box[k] - lock.box[k]) * a;
  }
}

const cx = (b) => b.originX + b.width / 2;
const cy = (b) => b.originY + b.height / 2;

function iou(a, b) {
  const x0 = Math.max(a.originX, b.originX);
  const y0 = Math.max(a.originY, b.originY);
  const x1 = Math.min(a.originX + a.width, b.originX + b.width);
  const y1 = Math.min(a.originY + a.height, b.originY + b.height);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const union = a.width * a.height + b.width * b.height - inter;
  return union > 0 ? inter / union : 0;
}

function normBox(b) {
  const w = video.videoWidth;
  const h = video.videoHeight;
  return { x0: b.originX / w, y0: b.originY / h, x1: (b.originX + b.width) / w, y1: (b.originY + b.height) / h };
}

// GPU can create fine on iPhone but fail at inference time → rebuild on CPU once.
async function handleDetectorFailure(err) {
  if (!String(state.delegate).startsWith('GPU')) {
    state.phase = 'error';
    state.error = err?.message || String(err);
    renderDebug();
    return;
  }
  const resumePhase = state.lock ? 'guiding' : 'detecting';
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
    state.phase = resumePhase;
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
  targets.sort((a, b) => cx(a.box) - cx(b.box));
  targets.forEach((t, i) => (t.n = i + 1));
  state.targets = targets;
  state.others = others;
}

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
  const debugOn = !debugEl.classList.contains('hidden');

  for (const t of state.targets) drawBox(ctx, t, '#00e676', unit, { number: true, label: true });
  if (debugOn) {
    for (const o of state.others) drawBox(ctx, o, 'rgba(255,255,255,0.5)', unit, { number: false, label: true });
  }

  if (state.lock) {
    const name = state.lock.brand ? `BEER: ${state.lock.brand}` : 'BEER';
    ctx.setLineDash(state.lock.seen ? [] : [unit * 2, unit]);
    drawBox(ctx, { label: name, box: state.lock.box }, '#ffd600', unit * 1.6, { number: false, label: true });
    ctx.setLineDash([]);
  }

  if (state.phase === 'guiding') {
    // Crosshair = where the phone is pointing (Level 1 pointer).
    const x = canvas.width / 2;
    const y = canvas.height / 2;
    ctx.strokeStyle = state.guidance?.inside ? '#ffd600' : '#fff';
    ctx.lineWidth = unit * 0.5;
    ctx.beginPath();
    ctx.moveTo(x - unit * 3, y);
    ctx.lineTo(x + unit * 3, y);
    ctx.moveTo(x, y - unit * 3);
    ctx.lineTo(x, y + unit * 3);
    ctx.stroke();
  }
}

function drawBox(g, item, color, unit, { number, label }) {
  const { originX: x, originY: y, width: w, height: h } = item.box;
  g.lineWidth = number ? unit * 0.6 : unit * 0.3;
  g.strokeStyle = color;
  g.strokeRect(x, y, w, h);
  g.fillStyle = color;

  if (label) {
    const score = item.score != null ? ` ${Math.round(item.score * 100)}%` : '';
    g.font = `${unit * 2}px ui-monospace, Menlo, monospace`;
    g.fillText(`${item.label}${score}`, x + unit * 0.5, y + h - unit * 0.6);
  }

  if (number) {
    const r = unit * 2.6;
    g.beginPath();
    g.arc(x + r, y + r, r, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#000';
    g.font = `bold ${r * 1.4}px system-ui, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(String(item.n), x + r, y + r * 1.05);
    g.textAlign = 'start';
    g.textBaseline = 'alphabetic';
  }
}

// ---------- Debug overlay ----------

function renderDebug() {
  if (debugEl.classList.contains('hidden')) return;
  const fmt = (d) => `${d.n ?? '-'}:${d.label} ${d.score.toFixed(2)}`;
  const lock = state.lock;
  const gd = state.guidance;
  debugEl.textContent = [
    `state: ${state.phase}${state.busy ? ' (mistral…)' : ''}   delegate: ${state.delegate}`,
    `fps: ${state.fps.toFixed(1)}   video: ${video.videoWidth}x${video.videoHeight}   audio: ${audioState()}`,
    `targets: ${state.targets.map(fmt).join(', ') || '—'}`,
    `others: ${state.others.map(fmt).join(', ') || '—'}`,
    lock
      ? `lock: ${lock.source} ${lock.brand || ''} ${lock.seen ? 'seen' : `LOST ${((performance.now() - lock.lastSeen) / 1000).toFixed(1)}s`}`
      : 'lock: —',
    gd
      ? `guide: dx=${gd.dx.toFixed(2)} dy=${gd.dy.toFixed(2)} f=${Math.round(gd.freq)}Hz every ${Math.round(gd.interval)}ms${gd.inside ? ' ON TARGET' : ''}`
      : '',
    `mistral: ${state.mistral}`,
    state.error ? `ERROR: ${state.error}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

renderDebug();
