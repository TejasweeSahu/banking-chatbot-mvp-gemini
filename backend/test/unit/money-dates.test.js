import test from 'node:test';
import assert from 'node:assert/strict';
import { formatINR, money, paiseToDecimal, percentChange, sumPaise, toPaise } from '../../src/lib/money.js';
import { addMonths, isValidIsoDate, resolvePeriod } from '../../src/lib/dates.js';

test('toPaise parses decimal strings and numbers without float error', () => {
  assert.equal(toPaise('2000'), 200000);
  assert.equal(toPaise('2,000.50'), 200050);
  assert.equal(toPaise('₹1,499.5'), 149950);
  assert.equal(toPaise('Rs. 99.99'), 9999);
  assert.equal(toPaise(2000), 200000);
  assert.equal(toPaise(1499.5), 149950);
  assert.equal(toPaise(0.29), 29);
});

test('toPaise rejects invalid, negative and over-precise amounts', () => {
  for (const bad of ['-5', '1.005', 'abc', '', '1e5', null, undefined, NaN, Infinity, 0.1 + 0.2, {}, '12..5']) {
    assert.equal(toPaise(bad), null, `expected ${String(bad)} to be rejected`);
  }
});

test('formatINR uses Indian digit grouping and exact paise', () => {
  assert.equal(formatINR(19489575), '₹1,94,895.75');
  assert.equal(formatINR(50), '₹0.50');
  assert.equal(formatINR(100000000), '₹10,00,000.00');
  assert.equal(formatINR(-48600), '-₹486.00');
  assert.equal(paiseToDecimal(5), '0.05');
  assert.deepEqual(money(12345), { paise: 12345, value: '123.45', formatted: '₹123.45' });
});

test('sumPaise rejects non-integer money and percentChange handles zero base', () => {
  assert.equal(sumPaise([10, 20, 30]), 60);
  assert.throws(() => sumPaise([10, 0.5]), TypeError);
  assert.equal(percentChange(0, 100), null);
  assert.equal(percentChange(4922400, 6754800), 37.2);
});

test('periods are reproducible, including across the year boundary', () => {
  assert.deepEqual(
    { s: resolvePeriod('last_month', '2026-01-15').startDate, e: resolvePeriod('last_month', '2026-01-15').endDate },
    { s: '2025-12-01', e: '2025-12-31' }
  );
  assert.equal(resolvePeriod('this_month', '2026-11-14').startDate, '2026-11-01');
  assert.equal(resolvePeriod('this_month', '2026-11-14').endDate, '2026-11-14');
  assert.equal(resolvePeriod('last_30_days', '2026-11-14').startDate, '2026-10-16');
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(isValidIsoDate('2026-02-30'), false);
  assert.equal(isValidIsoDate('2026-02-28'), true);
});
