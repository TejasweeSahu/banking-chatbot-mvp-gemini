import { test, expect } from '@playwright/test';
import { availableOnSavings, signIn, trackErrors } from './helpers.js';

test('sign in, see the dashboard, sign out', async ({ page }) => {
  const errors = trackErrors(page);
  await signIn(page);
  await expect(page.getByRole('heading', { name: 'Accounts' })).toBeVisible();
  await expect(page.getByText('Income and spending')).toBeVisible();
  await expect(page.locator('.budget').first()).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).first().click();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('wrong password shows a clear error', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Password').fill('nope');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toHaveText('Incorrect username or password.');
});

test('ambiguous transfer → choose payee → approve → receipt → balance drops by exactly ₹2,000', async ({ page }) => {
  const errors = trackErrors(page);
  await signIn(page);
  const before = await availableOnSavings(page);
  await page.getByRole('link', { name: 'Assistant' }).first().click();
  await page.getByLabel('Message the assistant').fill('Send ₹2,000 to Rahul');
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: /Rahul Sharma — HDFC Bank/ }).click();
  const card = page.locator('.confirm-pending');
  await expect(card).toContainText('₹2,000.00');
  await expect(card).toContainText('Rahul Sharma');
  await expect(card).toContainText('Simulated');
  await card.getByRole('button', { name: 'Send money' }).click();
  const receipt = page.locator('.confirm-completed').first();
  await expect(receipt).toContainText('Money sent');
  await expect(receipt).toContainText(/NST\d{8}[A-Z0-9]{6}/);
  const after = await availableOnSavings(page);
  expect(before - after).toBe(200000);
  expect(errors).toEqual([]);
});

test('typing "yes" never executes; cancelling leaves the balance unchanged', async ({ page }) => {
  await signIn(page);
  const before = await availableOnSavings(page);
  await page.getByRole('link', { name: 'Assistant' }).first().click();
  await page.getByLabel('Message the assistant').fill('Send 1500 to Priya');
  await page.keyboard.press('Enter');
  await expect(page.locator('.confirm-pending')).toBeVisible();
  await page.getByLabel('Message the assistant').fill('yes do it');
  await page.keyboard.press('Enter');
  await expect(page.locator('.msg-assistant').last()).not.toContainText('Thinking');
  await page.locator('.confirm-pending').getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByText('Cancelled. Nothing was changed.')).toBeVisible();
  expect(await availableOnSavings(page)).toBe(before);
});

test('analytics answers render as cards', async ({ page }) => {
  await signIn(page);
  await page.getByRole('link', { name: 'Assistant' }).first().click();
  await page.getByRole('button', { name: /Why it changed/ }).click();
  await expect(page.locator('.compare')).toBeVisible();
  await expect(page.locator('.compare')).toContainText('Shopping');
  await page.getByLabel('Message the assistant').fill('Which subscriptions am I paying for?');
  await page.keyboard.press('Enter');
  await expect(page.getByText('Disney+ Hotstar').first()).toBeVisible();
  await expect(page.locator('.followups').last()).toBeVisible();
});

test('conversation history is saved and reopens', async ({ page }) => {
  await signIn(page);
  await page.getByRole('link', { name: 'Assistant' }).first().click();
  await page.getByLabel('Message the assistant').fill("What's my balance?");
  await page.keyboard.press('Enter');
  await expect(page.locator('.block', { hasText: 'Your accounts' })).toBeVisible();
  await page.getByRole('button', { name: 'New conversation' }).click();
  await expect(page.locator('.chat-empty')).toBeVisible();
  await page.locator('.history-item', { hasText: "What's my balance?" }).first().click();
  await expect(page.locator('.block', { hasText: 'Your accounts' })).toBeVisible();
});

test('block and unblock a card from the Cards page', async ({ page }) => {
  await signIn(page);
  await page.getByRole('link', { name: 'Cards' }).first().click();
  const panel = page.locator('.card-panel', { hasText: 'Visa Signature Debit' });
  await panel.getByRole('button', { name: 'Review block' }).click();
  await page.locator('dialog[open]').getByRole('button', { name: 'Block card' }).click();
  await expect(page.locator('dialog[open]')).toContainText('Card blocked');
  await page.locator('dialog[open]').getByRole('button', { name: 'Close' }).click();
  await expect(panel).toContainText('Temporarily blocked');
  await panel.getByRole('button', { name: 'Review unblock' }).click();
  await page.locator('dialog[open]').getByRole('button', { name: 'Unblock card' }).click();
  await expect(page.locator('dialog[open]')).toContainText('Card unblocked');
});

test('pay a bill from the dashboard', async ({ page }) => {
  await signIn(page);
  const row = page.locator('.rec-list li', { hasText: 'Jio Postpaid' });
  await row.getByRole('button', { name: 'Pay now' }).click();
  await page.locator('dialog[open]').getByRole('button', { name: 'Pay bill' }).click();
  await expect(page.locator('dialog[open]')).toContainText('Bill paid');
  await page.locator('dialog[open]').getByRole('button', { name: 'Close' }).click();
  await expect(page.locator('.rec-list li', { hasText: 'Jio Postpaid' })).toHaveCount(0);
});

test('transactions page filters and opens details', async ({ page }) => {
  await signIn(page);
  await page.getByRole('link', { name: 'Transactions' }).first().click();
  await page.getByLabel('Status').selectOption('failed');
  await expect(page.locator('.txn')).toHaveCount(1);
  await page.locator('.txn-btn').first().click();
  await expect(page.locator('dialog[open]')).toContainText('did not respond');
});

test('read-only profile cannot move money', async ({ page }) => {
  await signIn(page, 'meera');
  await expect(page.getByText('You have read-only access')).toBeVisible();
  await page.getByRole('link', { name: 'Payments' }).first().click();
  await expect(page.getByRole('button', { name: 'Send money' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Assistant' }).first().click();
  await page.getByLabel('Message the assistant').fill('Send 100 to Priya');
  await page.keyboard.press('Enter');
  await expect(page.locator('.msg-assistant').last()).toContainText('read-only');
  await expect(page.locator('.confirm-pending')).toHaveCount(0);
});
