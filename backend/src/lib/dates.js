/**
 * Calendar-date helpers. Banking dates are handled as ISO "YYYY-MM-DD" strings
 * in UTC so period calculations are reproducible regardless of server timezone.
 * The clock can be pinned (DEMO_ANCHOR_DATE or tests) so seed data and
 * "this month" calculations stay deterministic.
 */

let pinnedToday = null;

export function setToday(isoDate) {
  pinnedToday = isoDate ?? null;
}

export function today() {
  return pinnedToday ?? new Date().toISOString().slice(0, 10);
}

/** Current timestamp; when the date is pinned, keeps the real time-of-day on the pinned date. */
export function nowIso() {
  const real = new Date().toISOString();
  return pinnedToday ? `${pinnedToday}${real.slice(10)}` : real;
}

export function parseIso(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function toIso(date) {
  return date.toISOString().slice(0, 10);
}

export function isValidIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return toIso(parseIso(value)) === value;
}

export function addDays(iso, days) {
  const d = parseIso(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return toIso(d);
}

export function addMonths(iso, months) {
  const d = parseIso(iso);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  d.setUTCDate(Math.min(day, daysInMonth(d.getUTCFullYear(), d.getUTCMonth())));
  return toIso(d);
}

export function daysInMonth(year, monthIndex) {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

export function monthStart(iso) {
  return `${iso.slice(0, 7)}-01`;
}

export function monthEnd(iso) {
  const d = parseIso(iso);
  return toIso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)));
}

export function daysBetween(fromIso, toIsoDate) {
  return Math.round((parseIso(toIsoDate) - parseIso(fromIso)) / 86_400_000);
}

export function monthLabel(iso) {
  return parseIso(iso).toLocaleString('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/**
 * Resolve a named period to an inclusive date range.
 * "this_month" is month-to-date; "last_month" is the full previous month.
 */
export function resolvePeriod(period, ref = today()) {
  switch (period) {
    case 'this_month':
      return { period, startDate: monthStart(ref), endDate: ref, label: `${monthLabel(ref)} (to date)` };
    case 'last_month': {
      const start = addMonths(monthStart(ref), -1);
      return { period, startDate: start, endDate: monthEnd(start), label: monthLabel(start) };
    }
    case 'last_7_days':
      return { period, startDate: addDays(ref, -6), endDate: ref, label: 'Last 7 days' };
    case 'last_30_days':
      return { period, startDate: addDays(ref, -29), endDate: ref, label: 'Last 30 days' };
    case 'last_90_days':
      return { period, startDate: addDays(ref, -89), endDate: ref, label: 'Last 90 days' };
    case 'this_year':
      return { period, startDate: `${ref.slice(0, 4)}-01-01`, endDate: ref, label: `${ref.slice(0, 4)} (to date)` };
    default:
      throw new Error(`Unknown period: ${period}`);
  }
}

export const PERIODS = ['this_month', 'last_month', 'last_7_days', 'last_30_days', 'last_90_days', 'this_year'];
