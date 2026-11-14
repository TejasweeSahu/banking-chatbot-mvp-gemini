import { expect } from '@playwright/test';

export async function signIn(page, username = 'tejas') {
  await page.goto('/');
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill('Northstar@2026');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('.band-balance')).toBeVisible();
}

/** Parse "₹1,94,895.75" into integer paise for before/after comparisons. */
export function toPaise(text) {
  const [r, p = '00'] = text.replace(/[^\d.]/g, '').split('.');
  return Number(r) * 100 + Number(p.padEnd(2, '0'));
}

export async function availableOnSavings(page) {
  await page.goto('/#/dashboard');
  const row = page.locator('.acct-list li', { hasText: 'Everyday Savings' });
  const text = await row.locator('.acct-money small').innerText();
  return toPaise(text.split('available')[0]);
}

export function trackErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  return errors;
}
