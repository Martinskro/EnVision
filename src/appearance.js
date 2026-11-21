// Tiny colour "fingerprint" of an object, so the lock can tell the beer apart from decoys
// by how it looks, not only by where it is. 12 hue bins for coloured pixels + 4 brightness
// bins for grey/white/black pixels, compared with the Bhattacharyya coefficient (0..1).

const SIZE = 24;
const c = document.createElement('canvas');
c.width = c.height = SIZE;
const g = c.getContext('2d', { willReadFrequently: true });

// box in video pixels. Samples the inner 60% of the box to avoid background around the object.
export function colorHist(video, box) {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  let sx = box.originX + box.width * 0.2;
  let sy = box.originY + box.height * 0.2;
  let sw = box.width * 0.6;
  let sh = box.height * 0.6;
  // Clamp to the frame (Safari draws nothing for out-of-bounds source rects).
  const x0 = Math.max(0, sx);
  const y0 = Math.max(0, sy);
  sw = Math.min(vw, sx + sw) - x0;
  sh = Math.min(vh, sy + sh) - y0;
  sx = x0;
  sy = y0;
  if (sw < 4 || sh < 4) return null;

  g.drawImage(video, sx, sy, sw, sh, 0, 0, SIZE, SIZE);
  const d = g.getImageData(0, 0, SIZE, SIZE).data;
  const bins = new Float32Array(16);
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i] / 255;
    const gr = d[i + 1] / 255;
    const b = d[i + 2] / 255;
    const max = Math.max(r, gr, b);
    const chroma = max - Math.min(r, gr, b);
    if (chroma > 0.15 && max > 0.15) {
      let h;
      if (max === r) h = ((gr - b) / chroma + 6) % 6;
      else if (max === gr) h = (b - r) / chroma + 2;
      else h = (r - gr) / chroma + 4;
      bins[Math.floor(h * 2) % 12] += 1;
    } else {
      bins[12 + Math.min(3, Math.floor(max * 4))] += 1;
    }
  }
  const n = SIZE * SIZE;
  for (let i = 0; i < bins.length; i++) bins[i] /= n;
  return bins;
}

export function histSim(a, b) {
  if (!a || !b) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.sqrt(a[i] * b[i]);
  return s;
}
