/**
 * Regression tests for production frontend serving and the discovery files
 * audited by Lighthouse (robots.txt, llms.txt, ARD / ai-catalog).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliCompressSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { freshDb } from '../helpers.js';
import { createApp } from '../../src/app.js';

const PUBLIC = fileURLToPath(new URL('../../../frontend/public/', import.meta.url));

function fakeDist() {
  const dir = mkdtempSync(join(tmpdir(), 'northstar-dist-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Northstar Bank</title>');
  const js = 'console.log("northstar");'.repeat(100);
  writeFileSync(join(dir, 'assets', 'app-abc123.js'), js);
  writeFileSync(join(dir, 'assets', 'app-abc123.js.br'), brotliCompressSync(js));
  writeFileSync(join(dir, 'robots.txt'), readFileSync(join(PUBLIC, 'robots.txt')));
  writeFileSync(join(dir, 'llms.txt'), readFileSync(join(PUBLIC, 'llms.txt')));
  return dir;
}

let server;
let base;
test.before(async () => {
  const app = createApp({ db: freshDb(), llm: null, frontendDist: fakeDist() });
  server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => new Promise((r) => server.close(r)));

test('page routes get the SPA shell, uncached', async () => {
  for (const path of ['/', '/dashboard']) {
    const res = await fetch(base + path, { headers: { Accept: 'text/html' } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.equal(res.headers.get('cache-control'), 'no-cache');
  }
});

test('discovery files are real text files, never index.html', async () => {
  for (const path of ['/robots.txt', '/llms.txt']) {
    const res = await fetch(base + path);
    assert.equal(res.status, 200, path);
    assert.match(res.headers.get('content-type'), /text\/plain/, path);
    assert.ok(!(await res.text()).includes('<!doctype'), `${path} must not be HTML`);
  }
});

test('missing files and /.well-known return 404 (ARD / ai-catalog audits become not-applicable)', async () => {
  for (const path of ['/.well-known/ard.json', '/.well-known/ai-catalog.json', '/missing.json', '/assets/missing.js', '/favicon.ico']) {
    const res = await fetch(base + path, { headers: { Accept: '*/*' } });
    assert.equal(res.status, 404, path);
    assert.ok(!(await res.text()).includes('<!doctype'), `${path} must not fall back to index.html`);
  }
});

test('hashed assets are pre-compressed when accepted and cached immutably', async () => {
  const br = await fetch(`${base}/assets/app-abc123.js`, { headers: { 'Accept-Encoding': 'br' } });
  assert.equal(br.status, 200);
  assert.equal(br.headers.get('content-encoding'), 'br');
  assert.match(br.headers.get('content-type'), /javascript/);
  assert.match(br.headers.get('cache-control'), /immutable/);
  assert.match(br.headers.get('vary'), /Accept-Encoding/);
  assert.match(await br.text(), /northstar/, 'body decodes to the original file');
  const plain = await fetch(`${base}/assets/app-abc123.js`, { headers: { 'Accept-Encoding': 'identity' } });
  assert.equal(plain.headers.get('content-encoding'), null);
  assert.match(plain.headers.get('cache-control'), /immutable/);
});

test('path traversal is rejected', async () => {
  const res = await fetch(`${base}/assets/..%2f..%2fpackage.json`, { headers: { 'Accept-Encoding': 'br' } });
  assert.notEqual(res.status, 200);
});

test('API routes are unaffected by the SPA fallback', async () => {
  const res = await fetch(`${base}/api/health`);
  assert.equal((await res.json()).status, 'ok');
  assert.equal((await fetch(`${base}/api/nope`)).status, 401, 'unknown API paths stay behind auth (no route enumeration)');
});

test('CSP only allows same-origin fonts and styles (fonts are self-hosted)', async () => {
  const csp = (await fetch(`${base}/`, { headers: { Accept: 'text/html' } })).headers.get('content-security-policy');
  assert.match(csp, /font-src 'self'/);
  assert.ok(!csp.includes('googleapis') && !csp.includes('gstatic'));
});

test('robots.txt uses only valid directives (Lighthouse robots-txt rules)', () => {
  const lines = readFileSync(join(PUBLIC, 'robots.txt'), 'utf8').split('\n').map((l) => l.replace(/#.*/, '').trim()).filter(Boolean);
  assert.ok(lines.length >= 2);
  for (const line of lines) assert.match(line, /^(user-agent|allow|disallow|sitemap|crawl-delay):\s*\S*$/i, line);
  assert.match(lines[0], /^user-agent:/i, 'rules must start with a user-agent group');
  assert.ok(lines.some((l) => /^disallow:\s*\/api\/$/i.test(l)), 'private API is disallowed');
});

test('llms.txt follows the format Lighthouse checks (H1, a Markdown link, not trivially short)', () => {
  const content = readFileSync(join(PUBLIC, 'llms.txt'), 'utf8');
  assert.match(content, /^\s*#\s+.+/m);
  assert.match(content, /\[.+\]\(.+\)/);
  assert.ok(content.length >= 50);
  assert.match(content, /^>\s+.+/m, 'llmstxt.org: blockquote summary after the title');
});
