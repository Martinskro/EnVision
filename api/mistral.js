// Vercel serverless function: POST /api/mistral
// Body: { task: "pick" | "confirm" | "held" | "describe", image: "data:image/jpeg;base64,...", count?: number }
// The Mistral key lives only here (MISTRAL_API_KEY env var), never in client code.
// Locally the same handler is served by the Vite dev plugin in vite.config.js.

const MISTRAL_URL = 'https://api.mistral.ai/v1/chat/completions';
const DEFAULT_MODEL = 'mistral-medium-latest'; // vision-capable; override with MISTRAL_MODEL
const MAX_IMAGE_CHARS = 4_000_000; // stay under Vercel's 4.5 MB body limit

const KINDS = 'can, bottle, cup, glass, other';

function prompts(task, count, kind) {
  if (task === 'pick') {
    return [
      `This photo shows a table. ${count} objects are outlined with green boxes.`,
      `Each box has a number (1 to ${count}) in a green circle at its top-left corner.`,
      `First classify each numbered object as one of: ${KINDS}.`,
      'Then say which number is the beer: a beer can (metal/aluminium can) or a beer bottle (usually brown or green glass).',
      'Clear water bottles, plastic bottles, cups and mugs are NOT the beer. If there is exactly one can, it is the beer.',
      'Ignore brands and labels.',
      'Reply with JSON only, exactly this shape:',
      '{"objects": {"1": "<kind>", "2": "<kind>"}, "beer": <number or null if no beer>, "kind": "<can|bottle|null>"}',
    ].join('\n');
  }
  if (task === 'held') {
    return [
      'Close-up from a chest-mounted camera. A blind person is reaching for an object on a table.',
      'Is a hand actually gripping an object – fingers wrapped around it or clearly touching it?',
      'A hand that is only in front of the object, above it, or closer to the camera does NOT count.',
      'If it is gripping, what kind of object is it?',
      `Kinds: ${KINDS}. Ignore brands and labels.`,
      'Reply with JSON only, exactly this shape:',
      '{"holding": <true|false>, "object": "<kind or none>"}',
    ].join('\n');
  }
  if (task === 'describe') {
    return [
      "Photo from a blind person's chest-mounted camera, looking at a table in front of them.",
      'Briefly tell them what is on the table and where (left / middle / right, near / far).',
      'Name drinks by container type (can, bottle, cup, glass). Do not mention brands.',
      'Maximum 2 short sentences, friendly, no filler.',
      'Reply with JSON only, exactly this shape: {"say": "<what to speak aloud>"}',
    ].join('\n');
  }
  // confirm
  return [
    'A blind person is pointing their phone camera at something.',
    'Identify the object they are holding, or if no hand is holding anything, the main object in the center of the image.',
    `Use a simple kind (${KINDS}, or another short name). Do not mention brands.`,
    'Reply with JSON only, exactly this shape:',
    '{"object": "<short name>", "say": "<one short sentence to speak aloud, e.g. \\"This is a can.\\">"}',
  ].join('\n');
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/); // tolerate ```json fences or chatter
    if (m) return JSON.parse(m[0]);
    throw new Error('Model did not return JSON');
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  const key = process.env.MISTRAL_API_KEY;
  if (!key) return res.status(500).json({ ok: false, error: 'MISTRAL_API_KEY not set' });

  const { task, image, count } = req.body || {};
  const kind = String(req.body?.kind || '').replace(/[^a-z ]/gi, '').slice(0, 20) || null;
  if (!['pick', 'confirm', 'held', 'describe'].includes(task)) {
    return res.status(400).json({ ok: false, error: 'task must be pick, confirm, held or describe' });
  }
  if (typeof image !== 'string' || !image.startsWith('data:image/') || image.length > MAX_IMAGE_CHARS) {
    return res.status(400).json({ ok: false, error: 'image must be a data:image/... URL under 4 MB' });
  }

  const model = process.env.MISTRAL_MODEL || DEFAULT_MODEL;
  const t0 = Date.now();
  try {
    const r = await fetch(MISTRAL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 200,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompts(task, Number(count) || 0, kind) },
              { type: 'image_url', image_url: image },
            ],
          },
        ],
      }),
    });
    const data = await r.json();
    if (!r.ok) {
      return res.status(502).json({ ok: false, error: data?.message || data?.error || `Mistral HTTP ${r.status}`, model });
    }
    const text = data.choices?.[0]?.message?.content ?? '';
    const result = parseJson(text);
    return res.status(200).json({ ok: true, task, model, ms: Date.now() - t0, result, usage: data.usage });
  } catch (err) {
    return res.status(502).json({ ok: false, error: err?.message || String(err), model, ms: Date.now() - t0 });
  }
}
