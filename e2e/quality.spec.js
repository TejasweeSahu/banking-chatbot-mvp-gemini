/**
 * Frontend-quality regressions for the Lighthouse findings: accessibility tree
 * (axe-core, same engine and rules Lighthouse uses), layout stability,
 * discovery files and keyboard navigation.
 */
import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { signIn } from './helpers.js';

// Injected via page.evaluate (DevTools protocol) because the app's CSP rightly blocks inline scripts.
const AXE_SOURCE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');

// Lighthouse 13 "agent-accessibility-tree" rule set, plus the two accessibility
// audits that failed in the baseline and a few structural checks.
const RULES = [
  'button-name', 'input-button-name', 'input-image-alt', 'label', 'link-name', 'select-name', 'document-title',
  'aria-allowed-attr', 'aria-allowed-role', 'aria-command-name', 'aria-conditional-attr', 'aria-dialog-name',
  'aria-hidden-body', 'aria-hidden-focus', 'aria-input-field-name', 'aria-prohibited-attr', 'aria-required-attr',
  'aria-required-children', 'aria-required-parent', 'aria-roles', 'aria-text', 'aria-toggle-field-name',
  'aria-tooltip-name', 'aria-treeitem-name', 'aria-valid-attr', 'aria-valid-attr-value', 'duplicate-id-aria',
  'definition-list', 'table-duplicate-name', 'tabindex', 'autocomplete-valid', 'presentation-role-conflict', 'svg-img-alt',
  'label-content-name-mismatch', 'color-contrast', 'list', 'listitem', 'nested-interactive', 'scrollable-region-focusable'
];

async function axeViolations(page) {
  await page.evaluate(AXE_SOURCE);
  const result = await page.evaluate(async (rules) => window.axe.run(document, { runOnly: { type: 'rule', values: rules }, resultTypes: ['violations'] }), RULES);
  return result.violations.map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(', ')}`);
}

test.describe('accessibility tree', () => {
  test('sign-in page', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
  });

  test('dashboard, including chart and transaction rows', async ({ page }) => {
    await signIn(page);
    await expect(page.locator('rect.hit').first()).toBeAttached();
    expect(await axeViolations(page)).toEqual([]);
  });

  test('assistant with cards, choices and a confirmation card', async ({ page }) => {
    await signIn(page);
    await page.getByRole('link', { name: 'Assistant' }).first().click();
    await page.getByLabel('Message the assistant').fill('Send ₹2,000 to Rahul');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: /Rahul Sharma — HDFC Bank/ })).toBeVisible();
    await page.getByLabel('Message the assistant').fill('Compare my spending with last month');
    await page.keyboard.press('Enter');
    await expect(page.locator('.compare')).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
  });

  test('transactions, payments, cards and help pages', async ({ page }) => {
    await signIn(page);
    for (const [link, ready] of [['Transactions', '.txn'], ['Payments', '.rec-list li'], ['Cards', '.plastic'], ['Help', '.topic']]) {
      await page.getByRole('link', { name: link }).first().click();
      await expect(page.locator(ready).first()).toBeVisible();
      expect(await axeViolations(page), link).toEqual([]);
    }
  });
});

test('chart months are reachable by keyboard and announce their figures', async ({ page }) => {
  await signIn(page);
  const month = page.getByRole('img', { name: /: income ₹[\d,.]+, spending ₹[\d,.]+/ }).first();
  await month.focus();
  await expect(page.locator('.tooltip')).toBeVisible();
  await expect(page.getByRole('group', { name: /Monthly income and spending/ })).toBeVisible();
});

test('skip link moves keyboard focus past navigation', async ({ page }) => {
  await signIn(page);
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
});

test('loading the signed-in dashboard causes no layout shift', async ({ page, context }) => {
  await signIn(page);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: 1.6e6 / 8, uploadThroughput: 750e3 / 8 });
  await page.addInitScript(() => {
    window.__cls = 0;
    new PerformanceObserver((list) => { for (const e of list.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: 'layout-shift', buffered: true });
  });
  await page.reload({ waitUntil: 'networkidle' });
  await expect(page.locator('.band-balance')).toBeVisible();
  await page.waitForTimeout(800);
  expect(await page.evaluate(() => window.__cls)).toBeLessThan(0.1);
});

test('discovery files: valid robots.txt and llms.txt, no HTML masquerading as ARD manifests', async ({ request }) => {
  const robots = await request.get('/robots.txt');
  expect(robots.status()).toBe(200);
  expect(robots.headers()['content-type']).toContain('text/plain');
  expect(await robots.text()).toMatch(/^User-agent: \*/m);
  const llms = await request.get('/llms.txt');
  expect(llms.status()).toBe(200);
  expect(await llms.text()).toMatch(/^# Northstar Bank/m);
  for (const path of ['/.well-known/ard.json', '/.well-known/ai-catalog.json']) {
    expect((await request.get(path)).status(), path).toBe(404);
  }
});

test.describe('accessibility tree in dark mode', () => {
  test.use({ colorScheme: 'dark' });
  test('dashboard and assistant', async ({ page }) => {
    await signIn(page);
    expect(await axeViolations(page), 'dashboard').toEqual([]);
    await page.getByRole('link', { name: 'Assistant' }).first().click();
    await page.getByLabel('Message the assistant').fill('Which subscriptions am I paying for?');
    await page.keyboard.press('Enter');
    await expect(page.locator('.followups').last()).toBeVisible();
    expect(await axeViolations(page), 'assistant').toEqual([]);
  });
});

test('startup: one request each, dashboard arrives with the session; signed-out visitors never request it', async ({ page }) => {
  const counts = {};
  page.on('request', (r) => {
    const path = new URL(r.url()).pathname;
    if (path.startsWith('/api/')) counts[path] = (counts[path] ?? 0) + 1;
  });
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  expect(counts['/api/dashboard'] ?? 0).toBe(0);
  expect(consoleErrors).toEqual([]);

  await signIn(page);
  for (const k of Object.keys(counts)) delete counts[k];
  await page.reload();
  await expect(page.locator('.band-balance')).toBeVisible();
  await page.waitForLoadState('networkidle');
  expect(counts['/api/auth/me']).toBe(1);
  expect(counts['/api/meta']).toBe(1);
  expect(counts['/api/dashboard'] ?? 0).toBe(0); // delivered with the session (one round trip)
});
