// Web Audio + speech helpers. unlockAudio() MUST be called inside a tap handler (iOS).
import { pauseVoice } from './voice.js';

let ctx = null;

export function unlockAudio() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!ctx) ctx = new AC();
  if (ctx.state !== 'running') ctx.resume();

  // Playing a silent buffer inside the gesture fully unlocks audio on iOS.
  const buf = ctx.createBuffer(1, 1, 22050);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start(0);
  return ctx;
}

export function audioState() {
  return ctx ? ctx.state : 'none';
}

// Short sine beep. pan: -1 (left) .. 1 (right). delay: seconds from now.
export function beep({ freq = 880, duration = 0.08, pan = 0, gain = 0.3, delay = 0, type = 'sine' } = {}) {
  if (!ctx) return;
  if (ctx.state !== 'running') {
    ctx.resume(); // iOS can suspend after interruptions (calls, Siri, lock screen)
    return;
  }
  const t = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
  osc.connect(g);

  let out = g;
  if (ctx.createStereoPanner) {
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    g.connect(p);
    out = p;
  }
  out.connect(ctx.destination);
  osc.start(t);
  osc.stop(t + duration + 0.02);
}

// Android only – iOS Safari has no vibration API.
export function vibrate(ms) {
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* ignore */
  }
}

// iOS only allows speechSynthesis after a first speak() inside a user gesture,
// so call speak() once from the Start tap handler.
//
// isSpeaking() uses our own timer instead of speechSynthesis.speaking, which can get stuck on
// true (seen with the mic active) – that silently blocked voice commands and guidance beeps.
let speakingUntil = 0;

export function speak(text) {
  if (!('speechSynthesis' in window)) return;
  // Half-duplex: turn the mic off first. If it was on, give iOS a moment to switch the
  // audio session back to playback before talking.
  const wasListening = pauseVoice();
  const delay = wasListening ? 300 : 0;
  // Upper bound for how long this takes to say; cleared early when the utterance really ends.
  speakingUntil = performance.now() + delay + Math.min(8000, 800 + text.length * 75);
  const say = () => {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-US';
    u.rate = 1.05;
    u.onend = u.onerror = () => {
      speakingUntil = 0;
    };
    window.speechSynthesis.speak(u);
  };
  if (delay) setTimeout(say, delay);
  else say(); // keep synchronous when possible (first speak must be inside the Start tap on iOS)
}

export function isSpeaking() {
  return performance.now() < speakingUntil;
}

// Short rising "success" arpeggio when the beer is confirmed in hand.
export function success() {
  [523, 659, 784, 1047].forEach((f, i) => beep({ freq: f, duration: 0.14, gain: 0.3, delay: i * 0.11 }));
}
