// Client side of /api/mistral. Only called at key moments (pick, confirm) – never per frame.

const TIMEOUT_MS = 15000;

export async function askMistral(task, imageDataUrl, count = 0, kind = null) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const t0 = performance.now();
  try {
    const r = await fetch('/api/mistral', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task, image: imageDataUrl, count, kind }),
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

// Close-up crop around a box (video pixels), expanded by `pad` box-sizes on each side,
// so Mistral sees the hand + can instead of the whole table.
export function snapshotCrop(video, box, pad = 1, maxSide = 768, quality = 0.85) {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const x0 = Math.max(0, box.originX - box.width * pad);
  const y0 = Math.max(0, box.originY - box.height * pad);
  const x1 = Math.min(vw, box.originX + box.width * (1 + pad));
  const y1 = Math.min(vh, box.originY + box.height * (1 + pad));
  const w = x1 - x0;
  const h = y1 - y0;
  const scale = Math.min(1, maxSide / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * scale);
  c.height = Math.round(h * scale);
  c.getContext('2d').drawImage(video, x0, y0, w, h, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', quality);
}
