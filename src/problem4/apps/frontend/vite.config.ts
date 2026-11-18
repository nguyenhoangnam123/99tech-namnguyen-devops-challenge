import { defineConfig } from 'vite';

// CI sets the commit; index.html carries it so a smoke test can
// tell which build CloudFront is serving.
process.env.VITE_APP_VERSION ??= 'dev';

export default defineConfig({
  build: { assetsDir: 'assets' },
  server: { proxy: { '/api': 'http://localhost:8080' } },
});
