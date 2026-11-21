import './style.css';
import { unlockAudio, audioState, beep, speak, success } from './audio.js';
import { createObjectDetector, createHandLandmarker, DETECTOR_NAME } from './vision.js';
import { askMistral, snapshot, snapshotCrop } from './mistral.js';
import { guide, noPointerTick, resetGuidance } from './guidance.js';
import { colorHist, histSim } from './appearance.js';

// COCO labels EfficientDet-Lite0 uses for our objects (a can usually shows up as "bottle" or "cup").
const TARGET_LABELS = new Set(['bottle', 'cup', 'wine glass']);
const MIN_DISPLAY_SCORE = 0.3; // numbered boxes; tracking also uses weaker detections
const AUTO_CONFIRM_AFTER_MS = 1000; // phone mode: on target this long → ask Mistral "what is this?"
const GRAB_AFTER_MS = 700; // hand mode: hand on the beer this long → ask Mistral "is it held?"
const GRAB_RECHECK_MS = 2500; // wait between "held?" checks if Mistral said not yet
const GRAB_MAX_CHECKS = 4; // per lock – protects the credits
const GRAB_BOX_MARGIN = 0.3; // hand landmarks within this margin of the box count as "on the beer"
const GRAB_MIN_LANDMARKS = 4; // …and this many of the 21 landmarks must be there
const HAND_KEEP_MS = 400; // keep the last hand this long when the tracker drops out (gripping occludes it)
const HAND_BOX_MARGIN = 0.15; // fingertip touching the can's edge counts as inside
const DETECT_EVERY = 3; // hand mode: object detector on every 3rd frame, hand tracker on the rest
const HAND_NEAR_MARGIN = 0.5; // hand this close to the beer → hold the box (hand occludes the can)
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
const handBtn = $('handBtn');

const state = {
  phase: 'idle', // idle | starting | detecting | asking | guiding | done | reloading | error
  delegate: '-',
  fps: 0,
  targets: [], // [{ n, label, score, box: {originX, originY, width, height} }] in video pixels
  others: [],
  all: [], // every detection ≥ 0.2, any label – used to keep tracking the locked beer
  lock: null, // { box, brand, source, seen, lastSeen, insideSince, confirmed }
  guidance: null,
  handMode: loadHandMode(), // Level 2: guide the fingertip (phone static) instead of the phone
  handDelegate: '-',
  hand: null, // { tip: {x, y} normalized, landmarks } or null when no hand visible
  busy: false, // a Mistral call is in flight
  mistral: '—', // last Mistral status line for debug
  error: '',
};

let detector = null;
let hands = null; // HandLandmarker, loaded in the background after Start
let lastVideoTime = -1;
let frameNo = 0;

// ---------- UI wiring ----------

startBtn.addEventListener('click', start);
$('debugToggle').addEventListener('click', () => debugEl.classList.toggle('hidden'));
findBtn.addEventListener('click', findBeer);
$('demoBtn').addEventListener('click', demoPick);
$('confirmBtn').addEventListener('click', () => confirmObject());
$('resetBtn').addEventListener('click', reset);
handBtn.addEventListener('click', toggleHandMode);
renderHandBtn();
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
    loadHands(); // background – Level 1 works while this loads
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

async function loadHands(forceCpu = params.has('cpu')) {
  if (hands) return;
  state.handDelegate = 'loading…';
  try {
    const res = await createHandLandmarker({ forceCpu });
    hands = res.hands;
    state.handDelegate = res.delegate + (forceCpu && !params.has('cpu') ? ' (fallback)' : '');
  } catch (err) {
    console.error('HandLandmarker failed', err);
    state.handDelegate = 'FAILED: ' + (err?.message || err);
  }
}

function loadHandMode() {
  try {
    return localStorage.getItem('handMode') === '1';
  } catch {
    return false;
  }
}

function toggleHandMode() {
  state.handMode = !state.handMode;
  try {
    localStorage.setItem('handMode', state.handMode ? '1' : '0');
  } catch {
    /* ignore */
  }
  state.hand = null;
  resetGuidance();
  renderHandBtn();
  speak(state.handMode ? 'Hand mode' : 'Phone mode');
}

function renderHandBtn() {
  handBtn.textContent = state.handMode ? 'Hand: ON' : 'Hand: OFF';
  handBtn.classList.toggle('on', state.handMode);
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
  if (state.busy || !['detecting', 'guiding', 'done'].includes(state.phase)) return;
  // Freeze this frame's numbering + colour fingerprints (the phone may move during the Mistral call).
  const picks = state.targets.map((t) => ({ ...t, box: { ...t.box }, hist: colorHist(video, t.box) }));
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
    lockTarget(chosen, brand, 'mistral', picks.length);
  } catch (err) {
    console.error(err);
    state.mistral = `pick FAILED: ${err.message}`;
    const fallback = largest(picks);
    speak('Mistral did not answer. Using the biggest bottle.');
    lockTarget(fallback, null, 'fallback', picks.length);
  } finally {
    state.busy = false;
    findBtn.disabled = false;
  }
}

// Demo mode: skip Mistral, lock the biggest bottle (or biggest target if no bottle).
function demoPick() {
  if (state.busy || !['detecting', 'guiding', 'done'].includes(state.phase)) return;
  if (state.targets.length === 0) {
    speak("I can't see any bottles or cups.");
    return;
  }
  state.mistral = 'demo pick (Mistral skipped)';
  lockTarget(largest(state.targets), null, 'demo', state.targets.length);
}

function largest(targets) {
  const bottles = targets.filter((t) => t.label === 'bottle');
  const pool = bottles.length ? bottles : targets;
  return pool.reduce((a, b) => (b.box.width * b.box.height > a.box.width * a.box.height ? b : a));
}

function lockTarget(t, brand, source, count) {
  state.lock = {
    box: { originX: t.box.originX, originY: t.box.originY, width: t.box.width, height: t.box.height },
    brand: brand && brand !== 'null' ? brand : null,
    source,
    seen: true,
    lastSeen: performance.now(),
    insideSince: 0,
    confirmed: false,
    grabChecks: 0,
    lastGrabCheck: 0,
    grab: '',
    rank: t.n - 1, // left→right position among the green boxes when picked
    count, // how many green boxes there were when picked
    matchedN: t.n, // which green box is the beer in the current frame (drawn yellow instead)
    hist: t.hist || colorHist(video, t.box), // colour fingerprint of the beer at pick time
    sims: '',
  };
  resetGuidance();
  state.phase = 'guiding';
  const what = state.lock.brand ? `a ${state.lock.brand}` : 'the beer';
  const how = state.handMode ? 'Reach out your hand and follow the beeps.' : 'Follow the beeps.';
  speak(`Found ${what}, ${direction(state.lock.box)}. ${how}`);
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
  if (['guiding', 'asking', 'done'].includes(state.phase)) state.phase = 'detecting';
  speak('Reset');
}

// ---------- Main loop ----------

let fpsFrames = 0;
let fpsT0 = performance.now();
let lastDebugUpdate = 0;

function loop(now) {
  requestAnimationFrame(loop);
  if (!['detecting', 'asking', 'guiding', 'done'].includes(state.phase) || video.readyState < 2) return;
  if (video.currentTime === lastVideoTime) return; // no new camera frame yet
  lastVideoTime = video.currentTime;

  syncCanvasSize();

  // Hand mode + beer locked: alternate frames – hand tracker on most frames, object detector
  // every DETECT_EVERY-th frame to keep following the beer (chest-mounted phone still moves a bit).
  const handActive = state.phase === 'guiding' && state.handMode && !!hands;
  frameNo++;
  const runDetector = !handActive || frameNo % DETECT_EVERY === 0;

  if (!runDetector) {
    try {
      processHand(hands.detectForVideo(video, now), now);
    } catch (err) {
      console.error('hand detectForVideo failed', err);
      handleHandFailure();
      return;
    }
  } else {
    let result;
    try {
      result = detector.detectForVideo(video, now);
    } catch (err) {
      console.error('detectForVideo failed', err);
      handleDetectorFailure(err);
      return;
    }
    processDetections(result.detections);
    if (!handActive) state.hand = null; // keep the last hand between alternating frames
  }

  if (state.phase === 'guiding' && state.lock) {
    if (runDetector && !(handActive && params.has('freeze'))) updateLock(now, handActive);
    const silent = !!window.speechSynthesis?.speaking;
    if (handActive) {
      if (state.hand) {
        state.guidance = guide(now, state.hand.tip, expandBox(normBox(state.lock.box), HAND_BOX_MARGIN), { silent });
      } else {
        state.guidance = null;
        noPointerTick(now, { silent });
      }
    } else {
      state.guidance = guide(now, { x: 0.5, y: 0.5 }, normBox(state.lock.box), { silent });
    }
    handleArrival(now, handActive);
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
function handleArrival(now, handActive) {
  const lock = state.lock;
  // Phone mode: crosshair on the beer. Hand mode: fingertip on it, OR several hand landmarks on it
  // (when gripping, the index fingertip is often hidden behind the can).
  let onBeer = !!state.guidance?.inside;
  if (handActive && state.hand) {
    const zone = expandBox(normBox(lock.box), GRAB_BOX_MARGIN);
    const n = state.hand.landmarks.filter((p) => isInside(p, zone)).length;
    lock.grab = `${n}/21 landmarks on beer`;
    onBeer = onBeer || n >= GRAB_MIN_LANDMARKS;
  } else if (handActive) {
    lock.grab = 'no hand';
  }

  if (!onBeer) {
    lock.insideSince = 0;
    return;
  }
  if (!lock.insideSince) lock.insideSince = now;

  if (!handActive) {
    // Level 1: say once what we're pointing at.
    if (!lock.confirmed && now - lock.insideSince > AUTO_CONFIRM_AFTER_MS) {
      lock.confirmed = true;
      confirmObject();
    }
    return;
  }

  // Level 2: hand on the beer for a moment → ask Mistral if it's actually held (close-up crop).
  if (
    now - lock.insideSince > GRAB_AFTER_MS &&
    now - lock.lastGrabCheck > GRAB_RECHECK_MS &&
    lock.grabChecks < GRAB_MAX_CHECKS &&
    !state.busy
  ) {
    lock.lastGrabCheck = now;
    lock.grabChecks++;
    checkHeld();
  }
}

async function checkHeld() {
  const lock = state.lock;
  state.busy = true;
  try {
    const res = await askMistral('held', snapshotCrop(video, lock.box, 1));
    const r = res.result || {};
    state.mistral = `held#${lock.grabChecks} → holding=${r.holding} ${r.object}/${r.brand} beer=${r.is_beer} (${res.clientMs}ms)`;
    if (state.lock !== lock || state.phase !== 'guiding') return; // reset meanwhile
    if (r.holding && r.is_beer) {
      state.phase = 'done'; // stop guidance beeps
      success();
      setTimeout(() => speak(r.say || `You're holding ${lock.brand ? 'a ' + lock.brand : 'your beer'}. Cheers!`), 500);
    } else if (r.holding) {
      speak(r.say || "That's not your beer.");
    }
    // not holding yet → stay quiet, keep guiding; we re-check after GRAB_RECHECK_MS
  } catch (err) {
    console.error(err);
    state.mistral = `held FAILED: ${err.message}`;
    // Mistral down: trust the hand tracker so the demo still completes.
    if (state.lock === lock && state.phase === 'guiding') {
      state.phase = 'done';
      success();
      setTimeout(() => speak("You've got your beer."), 500);
    }
  } finally {
    state.busy = false;
  }
}

// The phone moves in Level 1, so follow the locked beer by matching it to this frame's detections.
// If nothing matches (occluded / missed), keep the last known box.
// The yellow box IS one of the green boxes: each detector frame, decide which green box is the beer.
// Score = looks like the beer (colour fingerprint from pick time) – distance from last position,
// with small bonuses for "same left→right rank as at pick time" and "barely moved".
// No acceptable match → keep the last position (drawn dashed).
const MIN_SIM = 0.6; // colour similarity needed to accept a box that isn't right next to the last position

function updateLock(now, handActive) {
  const lock = state.lock;
  lock.matchedN = null;
  // Hand on/near the can: the hand pollutes the box and colours → hold the last position.
  lock.held = !!(handActive && state.hand && isInside(state.hand.tip, expandBox(normBox(lock.box), HAND_NEAR_MARGIN)));
  if (lock.held) return;

  const diag = Math.hypot(video.videoWidth, video.videoHeight);
  const lockArea = lock.box.width * lock.box.height;
  const cands = state.targets;
  const sameLayout = cands.length === lock.count;

  let best = null;
  let bestScore = -Infinity;
  let bestInfo = '';
  const sims = [];
  for (const t of cands) {
    const d = Math.hypot(cx(t.box) - cx(lock.box), cy(t.box) - cy(lock.box)) / diag;
    const r = (t.box.width * t.box.height) / lockArea;
    const close = d < 0.08 && r > 0.4 && r < 2.5;
    const sim = histSim(lock.hist, colorHist(video, t.box));
    sims.push(`#${t.n}:${sim.toFixed(2)}`);
    if (sim < MIN_SIM && !close) continue; // doesn't look like the beer and isn't where it was
    let score = sim - 0.6 * d;
    if (close) score += 0.2;
    if (sameLayout && t.n - 1 === lock.rank) score += 0.15;
    if (score > bestScore) {
      bestScore = score;
      best = t;
      bestInfo = `sim ${sim.toFixed(2)} d ${d.toFixed(2)}`;
    }
  }
  lock.sims = sims.join(' ');

  lock.seen = !!best;
  if (best) {
    lock.lastSeen = now;
    lock.matchedN = best.n;
    lock.matched = `#${best.n} ${best.label} (${bestInfo})`;
    lock.box = { originX: best.box.originX, originY: best.box.originY, width: best.box.width, height: best.box.height };
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

function processHand(result, now) {
  const lm = result.landmarks?.[0];
  if (lm) {
    state.hand = { tip: { x: lm[8].x, y: lm[8].y }, landmarks: lm, seenAt: now }; // 8 = index fingertip
  } else if (state.hand && now - state.hand.seenAt > HAND_KEEP_MS) {
    state.hand = null; // only drop after a real gap – gripping the can briefly hides the hand
  }
}

// Same idea as the detector: if GPU fails at inference time, rebuild on CPU once.
let handFailedOnce = false;
async function handleHandFailure() {
  const old = hands;
  hands = null; // loop falls back to phone-mode guidance meanwhile
  try {
    old?.close();
  } catch {
    /* ignore */
  }
  if (handFailedOnce) {
    state.handDelegate = 'FAILED twice – hand mode unavailable';
    return;
  }
  handFailedOnce = true;
  await loadHands(true);
}

function isInside(p, b) {
  return p.x >= b.x0 && p.x <= b.x1 && p.y >= b.y0 && p.y <= b.y1;
}

function expandBox(b, f) {
  const mx = (b.x1 - b.x0) * f;
  const my = (b.y1 - b.y0) * f;
  return { x0: b.x0 - mx, y0: b.y0 - my, x1: b.x1 + mx, y1: b.y1 + my };
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
  const all = [];
  for (const d of detections) {
    const c = d.categories[0];
    if (!c) continue;
    const item = { label: c.categoryName, score: c.score, box: d.boundingBox };
    all.push(item);
    if (c.score < MIN_DISPLAY_SCORE) continue;
    (TARGET_LABELS.has(item.label) ? targets : others).push(item);
  }
  state.all = all;
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

  for (const t of state.targets) {
    // The beer is drawn yellow below; also hide any green box sitting on it (e.g. while held).
    if (state.lock && (t.n === state.lock.matchedN || iou(t.box, state.lock.box) > 0.3)) continue;
    drawBox(ctx, t, '#00e676', unit, { number: true, label: true });
  }
  if (debugOn) {
    for (const o of state.others) drawBox(ctx, o, 'rgba(255,255,255,0.5)', unit, { number: false, label: true });
  }

  if (state.lock) {
    const name = state.lock.brand ? `BEER: ${state.lock.brand}` : 'BEER';
    ctx.setLineDash(state.lock.seen || state.lock.held ? [] : [unit * 2, unit]);
    drawBox(ctx, { label: name, box: state.lock.box }, '#ffd600', unit * 1.6, { number: false, label: true });
    ctx.setLineDash([]);
  }

  if (state.hand) {
    const inside = state.guidance?.inside;
    ctx.fillStyle = 'rgba(0, 200, 255, 0.8)';
    for (const p of state.hand.landmarks) {
      ctx.beginPath();
      ctx.arc(p.x * canvas.width, p.y * canvas.height, unit * 0.6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = inside ? '#ffd600' : '#00c8ff';
    ctx.beginPath();
    ctx.arc(state.hand.tip.x * canvas.width, state.hand.tip.y * canvas.height, unit * 2, 0, Math.PI * 2);
    ctx.fill();
  }

  if (state.phase === 'guiding' && !(state.handMode && hands)) {
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
    `state: ${state.phase}${state.busy ? ' (mistral…)' : ''}   detector: ${DETECTOR_NAME} [${state.delegate}]`,
    `fps: ${state.fps.toFixed(1)}   video: ${video.videoWidth}x${video.videoHeight}   audio: ${audioState()}`,
    `targets: ${state.targets.map(fmt).join(', ') || '—'}`,
    `others: ${state.others.map(fmt).join(', ') || '—'}`,
    lock
      ? `lock: ${lock.source} ${lock.brand || ''} ${
          lock.held ? 'HELD (hand near)' : lock.seen ? `seen as ${lock.matched || '-'}` : `LOST ${((performance.now() - lock.lastSeen) / 1000).toFixed(1)}s`
        }${params.has('freeze') ? ' [freeze]' : ''}\nsims: ${lock.sims || '—'}`
      : 'lock: —',
    gd
      ? `guide: dx=${gd.dx.toFixed(2)} dy=${gd.dy.toFixed(2)} f=${Math.round(gd.freq)}Hz every ${Math.round(gd.interval)}ms${gd.inside ? ' ON TARGET' : ''}`
      : '',
    lock && state.handMode ? `grab: ${lock.grab || '—'}  checks ${lock.grabChecks}/${GRAB_MAX_CHECKS}` : '',
    `hand: ${state.handMode ? 'ON' : 'off'} [${state.handDelegate}] ${
      state.hand ? `tip=(${state.hand.tip.x.toFixed(2)}, ${state.hand.tip.y.toFixed(2)})` : 'no hand'
    }`,
    `mistral: ${state.mistral}`,
    state.error ? `ERROR: ${state.error}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

renderDebug();
