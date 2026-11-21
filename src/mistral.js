// Client side of /api/mistral. Only called at key moments (pick, confirm) – never per frame.

const TIMEOUT_MS = 15000;

export async function askMistral(task, imageDataUrl, count = 0) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const t0 = performance.now();
  try {
    const r = await fetch('/api/mistral', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task, image: imageDataUrl, count }),
      signal: ctrl.signal,
    });
    const data = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
    data.clientMs = Math.round(performance.now() - t0);
    if (!data.ok) throw new Error(data.error || `HTTP ${r.status}`);
    return data;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Mistral timed out after ${TIMEOUT_MS / 1000}s`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Grab the current video frame as JPEG, optionally with numbered boxes drawn on it.
// drawBoxes(ctx) is called after the frame is drawn, in video pixel coordinates.
export function snapshot(video, drawBoxes, quality = 0.8) {
  const c = document.createElement('canvas');
  c.width = video.videoWidth;
  c.height = video.videoHeight;
  const g = c.getContext('2d');
  g.drawImage(video, 0, 0, c.width, c.height);
  if (drawBoxes) drawBoxes(g);
  return c.toDataURL('image/jpeg', quality);
}
