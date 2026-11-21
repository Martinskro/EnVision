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
};

let rec = null;
let enabled = false;
let armedUntil = 0;
let lastFire = 0;
let handlers = {};
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
    const r = e.results[e.results.length - 1];
    const text = r[0].transcript.toLowerCase().trim();
    voiceState.heard = text;
    if (isSpeaking()) return; // ignore Helen hearing herself
    handle(text, r.isFinal);
  };
  rec.onerror = (e) => {
    voiceState.status = `error: ${e.error}`;
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') enabled = false;
  };
  rec.onend = () => {
    // iOS/Chrome end the session after silence or errors → restart while enabled.
    if (enabled) setTimeout(safeStart, 250);
    else voiceState.status = 'off';
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

function safeStart() {
  if (!enabled) return;
  try {
    rec.start();
    voiceState.status = 'listening';
  } catch {
    /* already started – fine */
  }
}

function handle(text, isFinal) {
  const now = performance.now();
  if (now - lastFire < COOLDOWN_MS) return;

  const wake = WAKE.test(text);
  const armed = now < armedUntil;
  if (!wake && !armed) return;

  // Only look at what comes after the wake word ("hey helen where is my beer" → "where is my beer").
  const m = text.match(WAKE);
  const command = m ? text.slice(m.index + m[0].length) : text;
  const hit = INTENTS.find((i) => i.re.test(command));

  if (hit) {
    fire(hit.intent, now, text);
    return;
  }
  // Wake word alone, sentence finished → "Yes?" and wait for the command.
  if (wake && isFinal) {
    armedUntil = now + ARMED_MS;
    voiceState.status = 'armed';
    lastFire = now - COOLDOWN_MS + 800; // short pause so "Yes?" isn't interrupted by the same result
    handlers.wake?.();
  }
}

function fire(intent, now, text) {
  lastFire = now;
  armedUntil = 0;
  voiceState.status = 'listening';
  voiceState.lastIntent = `${intent} ← "${text}"`;
  // Restart the session so the same utterance isn't matched again by later interim results.
  try {
    rec.abort();
  } catch {
    /* ignore */
  }
  handlers[intent]?.();
}
