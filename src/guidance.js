// Turns "pointer → target box" into sound. Generic so Level 1 (pointer = image center,
// i.e. where the phone points) and Level 2 (pointer = fingertip) share the same code.
//
//   left/right offset  → stereo pan (sound comes from the side the target is on)
//   up/down offset     → pitch (target higher in image = higher pitch)
//   distance           → beep rate (faster when closer)
//   pointer inside box → distinct "grab now" chirp + vibration
//
// All coordinates are normalized 0..1 in image space.

import { beep, vibrate } from './audio.js';

const BASE_FREQ = 600;
const MIN_INTERVAL = 90; // ms between beeps when very close
const MAX_INTERVAL = 750; // ms between beeps when far
const ON_TARGET_INTERVAL = 160;

let lastBeep = 0;
let lastVibe = 0;

export function resetGuidance() {
  lastBeep = 0;
  lastVibe = 0;
}

// pointer: {x, y}; box: {x0, y0, x1, y1}. silent: compute only (e.g. while speech is playing).
// Returns info for the debug overlay.
export function guide(now, pointer, box, { silent = false } = {}) {
  const cx = (box.x0 + box.x1) / 2;
  const cy = (box.y0 + box.y1) / 2;
  const inside = pointer.x >= box.x0 && pointer.x <= box.x1 && pointer.y >= box.y0 && pointer.y <= box.y1;

  // Offset from pointer to target, scaled so the frame edges are ~±1.
  const dx = clamp((cx - pointer.x) * 2, -1, 1);
  const dy = clamp((cy - pointer.y) * 2, -1, 1);
  const dist = Math.min(1, Math.hypot(dx, dy));

  if (inside) {
    if (!silent && now - lastBeep > ON_TARGET_INTERVAL) {
      lastBeep = now;
      // Rising two-tone square chirp: clearly different from the guidance beeps.
      beep({ freq: 1320, duration: 0.05, gain: 0.25, type: 'square' });
      beep({ freq: 1760, duration: 0.05, gain: 0.25, type: 'square', delay: 0.06 });
    }
    if (!silent && now - lastVibe > 400) {
      lastVibe = now;
      vibrate(120);
    }
    return { inside, dx, dy, dist, freq: 1760, interval: ON_TARGET_INTERVAL };
  }

  const freq = clamp(BASE_FREQ * Math.pow(2, -dy), 250, 1400); // up = higher, one octave per half-frame
  const interval = MIN_INTERVAL + dist * (MAX_INTERVAL - MIN_INTERVAL);
  if (!silent && now - lastBeep > interval) {
    lastBeep = now;
    beep({ freq, pan: dx, duration: 0.07, gain: 0.3 });
  }
  return { inside, dx, dy, dist, freq, interval };
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
