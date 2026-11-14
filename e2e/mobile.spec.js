import { test, expect } from '@playwright/test';
import { signIn } from './helpers.js';

test('mobile: tab bar navigation and chat work without horizontal scroll', async ({ page }) => {
  await signIn(page);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.locator('.tabbar').getByRole('link', { name: 'Assistant' }).click();
  await page.getByLabel('Message the assistant').fill('How much did I spend on food this month?');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('.block', { hasText: 'Food & dining spending' })).toBeVisible();
  await page.locator('.tabbar').getByRole('link', { name: 'Help' }).click();
  await expect(page.getByRole('heading', { name: 'Help and complaints' })).toBeVisible();
});
