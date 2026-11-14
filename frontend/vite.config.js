/**
 * Vite config. In development, /api is proxied to the Express backend so the
 * browser talks to a single origin (session cookie is SameSite=Strict).
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiPort = process.env.API_PORT || 4000;

/**
 * Vite's SPA fallback answers unknown URLs with index.html (HTTP 200). For
 * discovery files such as /.well-known/ard.json that makes crawlers and agents
 * parse HTML as JSON, so return a real 404 instead (matches the Express server).
 */
const wellKnown404 = () => {
  const middleware = (req, res, next) => {
    if (req.url?.startsWith('/.well-known/')) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('Not found');
      return;
    }
    next();
  };
  return {
    name: 'well-known-404',
    configureServer: (server) => { server.middlewares.use(middleware); },
    configurePreviewServer: (server) => { server.middlewares.use(middleware); }
  };
};

export default defineConfig({
  plugins: [react(), wellKnown404()],
  server: { port: 5173, proxy: { '/api': `http://localhost:${apiPort}` } },
  preview: { port: 4174, proxy: { '/api': `http://localhost:${apiPort}` } },
  build: {
    rollupOptions: {
      output: {
        // React rarely changes: keep it in its own long-cached chunk.
        manualChunks: (id) => (/node_modules\/(react|react-dom|scheduler)\//.test(id) ? 'react' : undefined)
      }
    }
  }
});
