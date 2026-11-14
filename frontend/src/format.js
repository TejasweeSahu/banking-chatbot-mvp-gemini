/** Display helpers. Money is always pre-formatted by the backend ({ formatted }). */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function shortDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return `${d} ${MONTHS[m - 1]}${y !== new Date().getFullYear() ? ` ${y}` : ''}`;
}

export function dayLabel(iso, todayIso) {
  if (!iso) return '';
  if (iso === todayIso) return 'Today';
  const t = new Date(`${todayIso}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() - 1);
  if (iso === t.toISOString().slice(0, 10)) return 'Yesterday';
  return shortDate(iso);
}

export function time(isoTs) {
  if (!isoTs) return '';
  return new Date(isoTs).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });
}

export function relativeTime(isoTs) {
  const diff = (Date.now() - Date.parse(isoTs)) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  return shortDate(isoTs.slice(0, 10));
}

/** Compact axis label from paise: 4500000 → "₹45k", 15000000 → "₹1.5L". */
export function compactINR(paise) {
  const rupees = paise / 100;
  if (rupees >= 100000) return `₹${(rupees / 100000).toFixed(rupees % 100000 === 0 ? 0 : 1)}L`;
  if (rupees >= 1000) return `₹${Math.round(rupees / 1000)}k`;
  return `₹${Math.round(rupees)}`;
}

export const STATUS_LABELS = { success: 'Completed', pending: 'Pending', failed: 'Failed' };
export const CHANNEL_LABELS = { upi: 'UPI', card: 'Card', neft: 'NEFT', imps: 'IMPS', rtgs: 'RTGS', netbanking: 'Net banking', auto_debit: 'Auto-debit', atm: 'ATM', internal: 'Own account' };
export const CATEGORY_OPTIONS = [
  ['food', 'Food & dining'], ['groceries', 'Groceries'], ['transport', 'Transport'], ['shopping', 'Shopping'], ['bills', 'Bills & utilities'],
  ['subscriptions', 'Subscriptions'], ['entertainment', 'Entertainment'], ['health', 'Health'], ['travel', 'Travel'], ['rent', 'Rent & housing'],
  ['investments', 'Investments'], ['transfers', 'Transfers'], ['income', 'Income'], ['refunds', 'Refunds']
];
