/**
 * Serves the built frontend in production.
 *  - /assets/* are content-hashed: cached for a year, served pre-compressed
 *    (.br / .gz written at build time) when the client accepts it.
 *  - index.html is never cached, so new deployments are picked up immediately.
 *  - The SPA fallback only applies to page routes (no file extension, not
 *    /.well-known/); missing files return a real 404 instead of index.html, so
 *    robots/llms/ARD discovery never receives HTML disguised as a 200.
 */

import express from 'express';
import { existsSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';

const YEAR = 'public, max-age=31536000, immutable';
const ENCODINGS = [['br', '.br'], ['gzip', '.gz']];

function precompressed(root) {
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const accept = req.get('accept-encoding') ?? '';
    let rel;
    try { rel = decodeURIComponent(req.path); } catch { return next(); }
    const file = resolve(root, `.${rel}`);
    if (!file.startsWith(root + sep)) return next();
    for (const [encoding, suffix] of ENCODINGS) {
      if (!new RegExp(`\\b${encoding}\\b`).test(accept) || !existsSync(file + suffix)) continue;
      res.setHeader('Content-Encoding', encoding);
      res.setHeader('Vary', 'Accept-Encoding');
      res.setHeader('Cache-Control', YEAR);
      res.type(extname(file));
      return res.sendFile(file + suffix);
    }
    return next();
  };
}

export function serveFrontend(app, dist) {
  const root = resolve(dist);
  const assets = join(root, 'assets');
  app.use('/assets', precompressed(assets), express.static(assets, { index: false, immutable: true, maxAge: '1y', fallthrough: false }));
  app.use('/fonts', express.static(join(root, 'fonts'), { index: false, maxAge: '30d', fallthrough: false }));
  app.use(express.static(root, { index: false, maxAge: '1h' }));
  app.get(/^\/(?!api\/|\.well-known\/)[^.]*$/, (req, res, next) => {
    if (!req.accepts('html')) return next();
    res.setHeader('Cache-Control', 'no-cache');
    return res.sendFile(join(root, 'index.html'));
  });
  app.use((req, res) => res.status(404).type('text/plain').send('Not found'));
}

export const frontendDistExists = (dist) => existsSync(join(dist, 'index.html'));
