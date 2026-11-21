import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    // Needed so the cloudflared tunnel hostname (*.trycloudflare.com) is accepted.
    allowedHosts: true,
  },
});
