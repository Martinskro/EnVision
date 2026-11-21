// Vercel serverless function: POST /api/mistral
// Body: { task: "pick" | "confirm", image: "data:image/jpeg;base64,...", count?: number }
// The Mistral key lives only here (MISTRAL_API_KEY env var), never in client code.
// Locally the same handler is served by the Vite dev plugin in vite.config.js.

const MISTRAL_URL = 'https://api.mistral.ai/v1/chat/completions';
const DEFAULT_MODEL = 'mistral-medium-latest'; // vision-capable; override with MISTRAL_MODEL
const MAX_IMAGE_CHARS = 4_000_000; // stay under Vercel's 4.5 MB body limit

function prompts(task, count) {
  if (task === 'pick') {
    return [
      `This photo shows a table. ${count} objects are outlined with green boxes.`,
      `Each box has a number (1 to ${count}) in a green circle at its top-left corner.`,
      'Which numbered object is the beer (a beer can or beer bottle)? Read the brand if visible.',
      'Reply with JSON only, exactly this shape:',
      '{"beer": <number or null if no beer>, "brand": "<brand name or null>", "reason": "<max 10 words>"}',
    ].join('\n');
  }
  // confirm
  return [
    'A blind person is using their phone camera to find their beer.',
    'Identify the object they are holding, or if no hand is holding anything, the main object in the center of the image.',
    'Reply with JSON only, exactly this shape:',
    '{"object": "<short name>", "brand": "<brand or null>", "is_beer": <true|false>,',
    ' "say": "<one short sentence to speak aloud, e.g. \\"You\'re holding a Tuborg can.\\">"}',
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
  if (task !== 'pick' && task !== 'confirm') {
    return res.status(400).json({ ok: false, error: 'task must be "pick" or "confirm"' });
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
              { type: 'text', text: prompts(task, Number(count) || 0) },
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
