// "Hey Helen, …" voice commands via the browser's Web Speech API (no library).
// Chrome/Android: solid. iOS Safari: works but stops after silence → we auto-restart.
//
// A wake word is required so the pitch itself ("…finds your beer…") doesn't trigger commands.
// "Helen" is often misheard, so we accept common variants.

const WAKE = /\b(helen|hellen|helena|ellen|elan|hey allen|hey hello|hey hell)\b/;
const ARMED_MS = 6000; // after "Hey Helen" alone, the next sentence is the command
const COOLDOWN_MS = 2500;

const INTENTS = [
  // order matters: first match wins
  { intent: 'stop', re: /\b(stop|reset|cancel|never ?mind)\b/ },
  { intent: 'holding', re: /\b(holding|what is this|what's this|what am i)\b/ },
  { intent: 'describe', re: /\b(describe|table|what do you see|what can you see|around me|in front of me)\b/ },
  { intent: 'find', re: /\b(beer|drink|find|where)\b/ },
];

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

export const voiceSupported = !!SR;

export const voiceState = {
  status: SR ? 'off' : 'unsupported', // off | listening | armed | error:… | unsupported
  heard: '',
  lastIntent: '',
  why: '', // why the last thing heard did (not) trigger – for the debug overlay
};

let rec = null;
let enabled = false;
let paused = false; // half-duplex: mic off while Helen speaks / while guiding
let gateOpenSince = 0;
let armedUntil = 0;
let lastFire = 0;
let handlers = {};
let consumed = 0; // results in this session already used for a command – never re-match them
let isSpeaking = () => false;

// Call from the Start tap handler (mic permission prompt needs a user gesture on iOS).
// onIntent: { find, holding, describe, stop, wake } callbacks. speaking(): true while TTS talks.
export function startVoice(onIntent, speaking) {
  if (!SR || enabled) return;
  handlers = onIntent;
  isSpeaking = speaking || isSpeaking;
  enabled = true;
  rec = new SR();
  rec.lang = 'en-US';
  rec.continuous = true;
  rec.interimResults = true; // react before the sentence is "final" → faster
  rec.maxAlternatives = 1;

  rec.onresult = (e) => {
    // "Hey Helen" and "where is my beer" often arrive as separate results after a short pause,
    // so match on the last two results joined, not only the latest one.
    const n = e.results.length;
    const from = Math.max(consumed, n - 2);
    if (from >= n) return;
    const parts = [];
    for (let i = from; i < n; i++) parts.push(e.results[i][0].transcript);
    const text = parts.join(' ').toLowerCase().replace(/[.,!?]/g, ' ').replace(/\s+/g, ' ').trim();
    voiceState.heard = text;
    if (isSpeaking()) {
      voiceState.why = 'ignored: Helen is speaking';
      return;
    }
    if (handle(text, e.results[n - 1].isFinal)) consumed = n;
  };
  rec.onerror = (e) => {
    voiceState.status = `error: ${e.error}`;
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') enabled = false;
  };
  rec.onend = () => {
    // iOS/Chrome end the session after silence or errors → restart while enabled.
    if (enabled && !paused) setTimeout(safeStart, 250);
    else voiceState.status = paused ? 'paused' : 'off';
  };
  safeStart();
}

export function stopVoice() {
  enabled = false;
  try {
    rec?.stop();
  } catch {
    /* ignore */
  }
}

// Mic off now (called right before Helen speaks, and while guiding). On iOS an active mic
// makes speech output quiet / cut off / routed to the earpiece.
export function pauseVoice() {
  gateOpenSince = 0;
  if (!enabled || paused) return false;
  paused = true;
  voiceState.status = 'paused';
  try {
    rec.abort();
  } catch {
    /* ignore */
  }
  return true; // was listening
}

export function isListening() {
  return enabled && !paused;
}

// Called every frame: open = OK to listen now. Resumes only after it has been open for a moment,
// so back-to-back phrases don't toggle the mic (each toggle can pause the camera on iOS).
export function voiceGate(open, now) {
  if (!enabled) return;
  if (!open) {
    if (!paused) pauseVoice();
    gateOpenSince = 0;
    return;
  }
  if (!paused) return;
  if (!gateOpenSince) gateOpenSince = now;
  if (now - gateOpenSince > 600) {
    paused = false;
    safeStart();
  }
}

function safeStart() {
  if (!enabled || paused) return;
  try {
    rec.start();
    consumed = 0; // new session → result indices start from 0 again
    voiceState.status = 'listening';
  } catch {
    /* already started – fine */
  }
}

function handle(text, isFinal) {
  const now = performance.now();
  if (now - lastFire < COOLDOWN_MS) {
    voiceState.why = 'ignored: cooldown';
    return;
  }

  const wake = WAKE.test(text);
  if (wake) armedUntil = Math.max(armedUntil, now + ARMED_MS); // a command may follow in a later result
  const armed = now < armedUntil;
  if (!wake && !armed) {
    voiceState.why = 'no wake word';
    return;
  }

  // Only look at what comes after the wake word ("hey helen where is my beer" → "where is my beer").
  const m = text.match(WAKE);
  const command = m ? text.slice(m.index + m[0].length) : text;
  const hit = INTENTS.find((i) => i.re.test(command));

  if (hit) {
    fire(hit.intent, now, text);
    return true;
  }
  voiceState.why = 'wake word, waiting for command';
  voiceState.status = 'armed';
  // Wake word alone, sentence finished → "Yes?" and wait for the command.
  if (wake && isFinal && command.trim() === '') {
    armedUntil = now + ARMED_MS;
    lastFire = now - COOLDOWN_MS + 800; // short pause so "Yes?" isn't interrupted by the same result
    handlers.wake?.();
  }
}

function fire(intent, now, text) {
  lastFire = now;
  armedUntil = 0;
  voiceState.status = 'listening';
  voiceState.lastIntent = `${intent} ← "${text}"`;
  voiceState.why = `fired: ${intent}`;
  handlers.heard?.(text);
  // No rec.abort()/restart here: on iOS that reconfigures audio and pauses the camera video.
  // Already-used results are skipped via `consumed` instead.
  handlers[intent]?.();
}
