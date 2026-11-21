import { defineConfig, loadEnv } from 'vite';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

// Dev-only: serve api/mistral.js (the Vercel function) from the Vite dev server,
// so /api/mistral works through the cloudflared tunnel without `vercel dev`.
function apiDevPlugin() {
  return {
    name: 'api-dev',
    configureServer(server) {
      server.middlewares.use('/api/mistral', async (req, res) => {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        try {
          req.body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
        } catch {
          req.body = null;
        }
        // Minimal shim of Vercel's res helpers.
        res.status = (code) => {
          res.statusCode = code;
          return res;
        };
        res.json = (obj) => {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(obj));
          return res;
        };
        try {
          // Cache-bust so edits to the handler apply without restarting Vite.
          const url = pathToFileURL(resolve('api/mistral.js')).href + `?t=${Date.now()}`;
          const { default: handler } = await import(url);
          await handler(req, res);
        } catch (err) {
          res.status(500).json({ ok: false, error: String(err) });
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  // Load MISTRAL_* from .env.local into process.env for the dev API (never exposed to the client).
  const env = loadEnv(mode, process.cwd(), 'MISTRAL_');
  for (const [k, v] of Object.entries(env)) process.env[k] ??= v;

  return {
    plugins: [apiDevPlugin()],
    server: {
      // Needed so the cloudflared tunnel hostname (*.trycloudflare.com) is accepted.
      allowedHosts: true,
    },
  };
});
