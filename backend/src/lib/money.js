/**
 * Decimal-safe money helpers. All amounts are stored and computed as integer
 * paise (1 INR = 100 paise). Floats are never used for arithmetic; external
 * input is parsed from its decimal string form.
 */

const MAX_PAISE = 10_000_000_000_00; // ₹10,000,000,000 — far above any mock limit.

/** Parse "2000", "2,000.50", "₹1,499.5" or a JS number into integer paise. Returns null when invalid. */
export function toPaise(input) {
  let text;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return null;
    text = String(input);
  } else if (typeof input === 'string') {
    text = input.trim().replace(/^(₹|rs\.?|inr)\s*/i, '').replace(/,/g, '');
  } else {
    return null;
  }
  const match = /^(\d{1,13})(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) return null;
  const paise = BigInt(match[1]) * 100n + BigInt((match[2] ?? '').padEnd(2, '0'));
  if (paise > BigInt(MAX_PAISE)) return null;
  return Number(paise);
}

/** Integer paise -> "2000.50" (exact decimal string, safe for JSON transport). */
export function paiseToDecimal(paise) {
  assertPaise(paise);
  const negative = paise < 0;
  const abs = Math.abs(paise);
  const rupees = Math.trunc(abs / 100);
  const rest = String(abs % 100).padStart(2, '0');
  return `${negative ? '-' : ''}${rupees}.${rest}`;
}

/** Integer paise -> "₹2,000.50" using Indian digit grouping. */
export function formatINR(paise) {
  assertPaise(paise);
  const negative = paise < 0;
  const [rupees, rest] = paiseToDecimal(Math.abs(paise)).split('.');
  const last3 = rupees.slice(-3);
  const head = rupees.slice(0, -3);
  const grouped = head ? `${head.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}` : last3;
  return `${negative ? '-' : ''}₹${grouped}.${rest}`;
}

/** Shape used in every API/tool response so clients never re-derive money. */
export function money(paise) {
  return { paise, value: paiseToDecimal(paise), formatted: formatINR(paise) };
}

export function sumPaise(values) {
  let total = 0;
  for (const v of values) {
    assertPaise(v);
    total += v;
  }
  if (!Number.isSafeInteger(total)) throw new RangeError('Money total overflow.');
  return total;
}

/** Percentage change as a one-decimal number; null when the base is zero. Used for display only. */
export function percentChange(fromPaise, toPaiseValue) {
  if (fromPaise === 0) return null;
  return Math.round(((toPaiseValue - fromPaise) * 1000) / fromPaise) / 10;
}

/** Integer-safe ratio as a whole percentage (e.g. budget used). */
export function percentOf(part, whole) {
  if (whole <= 0) return null;
  return Math.round((part * 100) / whole);
}

function assertPaise(value) {
  if (!Number.isSafeInteger(value)) throw new TypeError(`Money must be integer paise, received ${value}`);
}
