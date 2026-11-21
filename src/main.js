import './style.css';
import { unlockAudio, unlockSpeech, audioState, beep, speak, success, checking, notYet, isSpeaking, onSpeak } from './audio.js';
import { createObjectDetector, createHandLandmarker, DETECTOR_NAME } from './vision.js';
import { askMistral, snapshot, snapshotCrop } from './mistral.js';
import { guide, noPointerTick, resetGuidance } from './guidance.js';
import { colorHist, histSim } from './appearance.js';
import { startVoice, voiceState, isListening, voiceReady } from './voice.js';

// COCO labels EfficientDet-Lite0 uses for our objects (a can usually shows up as "bottle" or "cup").
const TARGET_LABELS = new Set(['bottle', 'cup', 'wine glass']);
const MIN_DISPLAY_SCORE = 0.3; // numbered boxes; tracking also uses weaker detections
const AUTO_CONFIRM_AFTER_MS = 1000; // phone mode: on target this long → ask Mistral "what is this?"
const GRAB_AFTER_MS = 1000; // hand mode: hand on the beer this long → grabbed (local decision)
const GRAB_GRACE_MS = 700; // hand may drop out / slip off this long without restarting the timer
const GRAB_MAX_CHECKS = 4; // Mistral grab checks per lock – after that, trust the local check
const GRAB_VERIFY_TIMEOUT_MS = 4000; // Mistral slower than this → trust the local check
// Depth check: a hand right in front of the camera can cover the bottle in the image while being
// far from it. At the bottle's depth a palm is about can-sized; nearer the camera it looks bigger.
// palm size / beer box width must be ≤ this. Tune with ?ratio=2.4 (debug shows the live ratio).
const MAX_HAND_RATIO = Number(params.get('ratio')) || 2.0;
const GRAB_BOX_MARGIN = 0.3; // hand landmarks within this margin of the box count as "on the beer"
const GRAB_MIN_LANDMARKS = 4; // …and this many of the 21 landmarks must be there
const HAND_KEEP_MS = 400; // keep the last hand this long when the tracker drops out (gripping occludes it)
const HAND_BOX_MARGIN = 0.15; // fingertip touching the can's edge counts as inside
const DETECT_EVERY = 3; // hand mode: object detector on every 3rd frame, hand tracker on the rest
const HAND_NEAR_MARGIN = 0.5; // hand this close to the beer → hold the box (hand occludes the can)
const params = new URLSearchParams(location.search);
// Voice commands are opt-in (?voice): the always-on mic made iOS audio unreliable.
const VOICE_ON = params.has('voice');

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
  lock: null, // { box, kind, source, seen, lastSeen, insideSince, confirmed, … }
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
let lastFrameAt = 0; // for the camera watchdog
let lastRecoverAt = 0;
let recoverTries = 0;
let cameraRecoveries = 0;

// ---------- UI wiring ----------

startBtn.addEventListener('click', start);
// Debug overlay + developer buttons: hidden by default (pitch UI), 'dbg' toggles them, ?debug shows at load.
const setDebug = (on) => {
  document.body.classList.toggle('nodebug', !on);
  debugEl.classList.toggle('hidden', !on);
};
setDebug(params.has('debug'));
$('debugToggle').addEventListener('click', () => setDebug(document.body.classList.contains('nodebug')));
findBtn.addEventListener('click', findBeer);
// "Tap anywhere": the camera area also starts a search, but only when idle (not while reaching).
$('stage').addEventListener('click', () => {
  if (['detecting', 'done'].includes(state.phase)) findBeer();
});
$('demoBtn').addEventListener('click', demoPick);
$('confirmBtn').addEventListener('click', () => confirmObject());
$('resetBtn').addEventListener('click', reset);
handBtn.addEventListener('click', toggleHandMode);
renderHandBtn();
// Subtitles so the audience can follow what you said and what Helen says.
const subYou = $('subYou');
const subHelen = $('subHelen');
const subTimers = new Map();
function showSub(el, text) {
  el.textContent = text;
  el.classList.remove('faded');
  clearTimeout(subTimers.get(el));
  subTimers.set(el, setTimeout(() => el.classList.add('faded'), 9000));
}
onSpeak((text) => showSub(subHelen, text));
// iOS pauses the camera <video> when the audio session changes (speech recognition) → resume at once.
video.addEventListener('pause', () => {
  if (state.phase !== 'idle') video.play().catch(() => {});
});

// ---------- Start ----------

async function start() {
  // Everything audio-related must be unlocked synchronously inside the tap (iOS) – silently,
  // so Helen doesn't talk over the camera/mic permission prompts. She greets once they're done.
  unlockAudio();
  unlockSpeech();
  // Voice commands ("Hey Helen, where is my beer?"). Must start inside the tap on iOS.
  if (VOICE_ON) {
    startVoice(
      {
        find: findBeer,
        holding: () => confirmObject(),
        describe: describeTable,
        stop: reset,
        wake: () => speak('Yes?', { interrupt: true }),
        heard: (text) => showSub(subYou, `“${text.charAt(0).toUpperCase() + text.slice(1)}”`),
      },
      isSpeaking,
    );
  }
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
    greetWhenReady();
  } catch (err) {
    console.error(err);
    state.phase = 'error';
    state.error = err?.message || String(err);
    startMsg.textContent = `Error: ${state.error} — tap Start to retry`;
    startBtn.disabled = false;
  }
}

// Greet only after camera + mic permissions are settled (mic: granted, refused, or 5 s max).
async function greetWhenReady() {
  const voiceOn = VOICE_ON;
  if (voiceOn) await Promise.race([voiceReady, new Promise((r) => setTimeout(r, 5000))]);
  const canTalk = voiceOn && isListening();
  speak(
    canTalk
      ? "Hi, I'm Helen. Ask me where your beer is."
      : "Hi, I'm Helen. Tap the bottom of the screen to find your beer.",
  );
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
    return localStorage.getItem('handMode') !== '0'; // hand mode (Level 2) is the default
  } catch {
    return true;
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

// Camera watchdog: first try to resume the paused video; if frames still don't come, restart the camera.
async function recoverCamera(now) {
  if (now - lastRecoverAt < 1500) return;
  lastRecoverAt = now;
  cameraRecoveries++;
  recoverTries++;
  const track = video.srcObject?.getVideoTracks?.()[0];
  const dead = !track || track.readyState === 'ended';
  try {
    if (dead || recoverTries > 2) {
      video.srcObject?.getTracks().forEach((t) => t.stop());
      await startCamera();
    } else {
      await video.play();
    }
  } catch (err) {
    console.warn('camera recover failed', err);
  }
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
    const { beer, kind, objects } = res.result || {};
    state.mistral = `pick → beer=${beer} kind=${kind} ${JSON.stringify(objects || {})} (${res.clientMs}ms)`;
    const chosen = picks.find((t) => t.n === Number(beer));
    if (!chosen) {
      speak("I couldn't find a beer here. Try pointing at the table again.");
      state.phase = 'detecting';
      return;
    }
    lockTarget(chosen, normKind(kind), 'mistral', picks.length);
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

function normKind(k) {
  const v = String(k || '').toLowerCase();
  return v.includes('can') ? 'can' : v.includes('bottle') ? 'bottle' : null;
}

function lockTarget(t, kind, source, count) {
  state.lock = {
    box: { originX: t.box.originX, originY: t.box.originY, width: t.box.width, height: t.box.height },
    kind, // 'can' | 'bottle' | null – what the beer is, used to check what's held
    source,
    seen: true,
    lastSeen: performance.now(),
    insideSince: 0,
    confirmed: false,
    grabChecks: 0,
    lastOnBeerAt: 0,
    grab: '',
    rank: t.n - 1, // left→right position among the green boxes when picked
    count, // how many green boxes there were when picked
    matchedN: t.n, // which green box is the beer in the current frame (drawn yellow instead)
    hist: t.hist || colorHist(video, t.box), // colour fingerprint of the beer at pick time
    sims: '',
  };
  resetGuidance();
  state.phase = 'guiding';
  const what = state.lock.kind ? `your beer ${state.lock.kind}` : 'your beer';
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
    state.mistral = `confirm → ${r.object} (${res.clientMs}ms)`;
    speak(r.say || `This is ${r.object || 'something I cannot recognise'}.`);
  } catch (err) {
    console.error(err);
    state.mistral = `confirm FAILED: ${err.message}`;
    speak(state.lock ? "You're on the beer." : "Sorry, I couldn't check that.");
  } finally {
    state.busy = false;
  }
}

// "Hey Helen, what's on the table?" – Mistral describes the scene.
async function describeTable() {
  if (state.busy || !video.videoWidth) return;
  state.busy = true;
  speak('Let me look.');
  try {
    const res = await askMistral('describe', snapshot(video, null, 0.8));
    const say = res.result?.say;
    state.mistral = `describe → "${say}" (${res.clientMs}ms)`;
    speak(say || "I couldn't make out the table.");
  } catch (err) {
    console.error(err);
    state.mistral = `describe FAILED: ${err.message}`;
    speak("Sorry, I couldn't look at the table right now.");
  } finally {
    state.busy = false;
  }
}

function reset() {
  state.lock = null;
  state.guidance = null;
  if (['guiding', 'asking', 'done'].includes(state.phase)) state.phase = 'detecting';
  speak('Reset', { interrupt: true });
}

// ---------- Main loop ----------

let fpsFrames = 0;
let fpsT0 = performance.now();
let lastDebugUpdate = 0;

function loop(now) {
  requestAnimationFrame(loop);
  if (!['detecting', 'asking', 'guiding', 'done'].includes(state.phase) || video.readyState < 2) return;
  if (video.currentTime === lastVideoTime) {
    // No new camera frame. iOS pauses the <video> when speech recognition (re)starts → recover.
    if (lastFrameAt && now - lastFrameAt > 1000) recoverCamera(now);
    return;
  }
  lastVideoTime = video.currentTime;
  lastFrameAt = now;
  recoverTries = 0;


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
    const silent = isSpeaking();
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
    renderStatus();
  }
}

// Once the pointer has stayed on the beer for a moment, confirm with Mistral (once per lock).
// Palm size in video pixels: max of palm width (index→pinky knuckle, scaled to palm length) and
// palm length (wrist→middle knuckle). Using both is robust when one of them is foreshortened.
function palmSize(lm) {
  const W = video.videoWidth;
  const H = video.videoHeight;
  const d = (a, b) => Math.hypot((lm[a].x - lm[b].x) * W, (lm[a].y - lm[b].y) * H);
  return Math.max(d(5, 17) * 1.25, d(0, 9));
}

function handleArrival(now, handActive) {
  const lock = state.lock;
  // Phone mode: crosshair on the beer. Hand mode: fingertip on it, OR several hand landmarks on it
  // (when gripping, the index fingertip is often hidden behind the can) – AND the hand must be at
  // roughly the bottle's depth (not just in front of it, closer to the camera).
  let onBeer = !!state.guidance?.inside;
  let n = 0;
  let ratio = 0;
  if (handActive && state.hand) {
    const zone = expandBox(normBox(lock.box), GRAB_BOX_MARGIN);
    n = state.hand.landmarks.filter((p) => isInside(p, zone)).length;
    ratio = palmSize(state.hand.landmarks) / Math.max(1, lock.box.width);
    onBeer = (onBeer || n >= GRAB_MIN_LANDMARKS) && ratio <= MAX_HAND_RATIO;
  }

  if (onBeer) {
    lock.lastOnBeerAt = now;
    if (!lock.insideSince) lock.insideSince = now;
  } else if (!lock.lastOnBeerAt || now - lock.lastOnBeerAt > GRAB_GRACE_MS) {
    lock.insideSince = 0; // only restart after a real gap – gripping hides the hand for moments
  }
  const held = lock.insideSince ? now - lock.insideSince : 0;
  lock.grab = handActive
    ? state.hand
      ? `${n}/21 on beer  size ${ratio.toFixed(2)}${ratio > MAX_HAND_RATIO ? ' TOO CLOSE TO CAMERA' : ' ok'} (max ${MAX_HAND_RATIO})  on-beer ${(held / 1000).toFixed(1)}s`
      : 'no hand'
    : '';
  if (!lock.insideSince) return;

  if (!handActive) {
    // Level 1: say once what we're pointing at.
    if (!lock.confirmed && held > AUTO_CONFIRM_AFTER_MS) {
      lock.confirmed = true;
      confirmObject();
    }
    return;
  }

  // Level 2: hand on the beer at the right depth for a moment → Mistral checks the grip.
  if (held > GRAB_AFTER_MS && !lock.verifying) verifyGrab(lock);
}

function grabbed(lock) {
  state.phase = 'done'; // stops guidance beeps
  success();
  setTimeout(() => speak(`Got it! That's your beer${lock.kind ? ' ' + lock.kind : ''}. Cheers!`), 450);
}

// Mistral looks at a close-up: are the fingers actually around the can (not just in front of it)?
// Yes → grabbed. No → "not yet", keep guiding. Slow / failed / out of checks → trust the local check.
async function verifyGrab(lock) {
  if (lock.grabChecks >= GRAB_MAX_CHECKS) {
    state.mistral = 'verify: out of checks → trusting local grab';
    grabbed(lock);
    return;
  }
  lock.verifying = true;
  lock.grabChecks++;
  checking();
  const image = snapshotCrop(video, lock.box, 1);
  try {
    const res = await askMistral('held', image, 0, lock.kind, GRAB_VERIFY_TIMEOUT_MS);
    const r = res.result || {};
    const obj = String(r.object || '').toLowerCase().trim();
    state.mistral = `verify#${lock.grabChecks} → holding=${r.holding} object=${obj} (${res.clientMs}ms)`;
    if (state.lock !== lock || state.phase !== 'guiding') return; // reset meanwhile
    if (r.holding && obj && obj !== 'none' && !/can|bottle/.test(obj)) {
      speak(`That's a ${obj}, not your beer.`, { interrupt: true });
      lock.insideSince = 0;
    } else if (r.holding) {
      grabbed(lock);
    } else {
      notYet(); // hand near, but not gripping yet – keep guiding, check again after another 1 s
      lock.insideSince = 0;
    }
  } catch (err) {
    console.error(err);
    state.mistral = `verify FAILED (trusting local grab): ${err.message}`;
    if (state.lock === lock && state.phase === 'guiding') grabbed(lock);
  } finally {
    lock.verifying = false;
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
    const name = state.lock.kind ? `BEER (${state.lock.kind})` : 'BEER';
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

// ---------- Pitch UI status ----------

const findMain = $('findMain');
const findSub = $('findSub');
const micEl = $('mic');

function renderStatus() {
  const [main, sub] = {
    detecting: ['Tap anywhere or say “Hey Helen”', '“…where is my beer?”'],
    asking: ['Looking for your beer…', 'Asking Mistral'],
    guiding: state.handMode
      ? ['Reach out and follow the beeps', 'Faster = closer · chirp = grab it']
      : ['Follow the beeps', 'Faster = closer'],
    done: ['Cheers! You have your beer', 'Tap or say “Hey Helen” to go again'],
  }[state.phase] || ['Helen', ''];
  if (findMain.textContent !== main) findMain.textContent = main;
  if (findSub.textContent !== sub) findSub.textContent = sub;

  const on = isListening() && voiceState.status !== 'paused';
  micEl.textContent = !voiceState.status || voiceState.status === 'unsupported' || !VOICE_ON
    ? ''
    : on
      ? '● listening'
      : '○ mic off';
  micEl.classList.toggle('on', on);
}

// ---------- Debug overlay ----------

function renderDebug() {
  if (debugEl.classList.contains('hidden')) return;
  const fmt = (d) => `${d.n ?? '-'}:${d.label} ${d.score.toFixed(2)}`;
  const lock = state.lock;
  const gd = state.guidance;
  debugEl.textContent = [
    `state: ${state.phase}${state.busy ? ' (mistral…)' : ''}   detector: ${DETECTOR_NAME} [${state.delegate}]`,
    `fps: ${state.fps.toFixed(1)}   video: ${video.videoWidth}x${video.videoHeight}   audio: ${audioState()}   cam-recover: ${cameraRecoveries}`,
    `targets: ${state.targets.map(fmt).join(', ') || '—'}`,
    `others: ${state.others.map(fmt).join(', ') || '—'}`,
    lock
      ? `lock: ${lock.source} ${lock.kind || ''} ${
          lock.held ? 'HELD (hand near)' : lock.seen ? `seen as ${lock.matched || '-'}` : `LOST ${((performance.now() - lock.lastSeen) / 1000).toFixed(1)}s`
        }${params.has('freeze') ? ' [freeze]' : ''}\nsims: ${lock.sims || '—'}`
      : 'lock: —',
    gd
      ? `guide: dx=${gd.dx.toFixed(2)} dy=${gd.dy.toFixed(2)} f=${Math.round(gd.freq)}Hz every ${Math.round(gd.interval)}ms${gd.inside ? ' ON TARGET' : ''}`
      : '',
    lock && state.handMode ? `grab: ${lock.grab || '—'}  verify ${lock.grabChecks}/${GRAB_MAX_CHECKS}` : '',
    `hand: ${state.handMode ? 'ON' : 'off'} [${state.handDelegate}] ${
      state.hand ? `tip=(${state.hand.tip.x.toFixed(2)}, ${state.hand.tip.y.toFixed(2)})` : 'no hand'
    }`,
    `voice: ${voiceState.status}  heard: "${voiceState.heard}"\n  why: ${voiceState.why || '—'}${
      voiceState.lastIntent ? `\n  last: ${voiceState.lastIntent}` : ''
    }`,
    `mistral: ${state.mistral}`,
    state.error ? `ERROR: ${state.error}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

renderDebug();
