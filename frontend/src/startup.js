/**
 * Startup requests, fired as soon as the main module evaluates rather than
 * after React mounts. On the dashboard route the session check also returns
 * the dashboard data, so the balance needs one API round trip instead of two:
 *   before: JS → /auth/me → render shell + dashboard → /api/dashboard
 *   after:  JS → /auth/me?include=dashboard
 * Shared promises also stop React StrictMode's double effects (development
 * only) from issuing every startup request twice.
 */

import { api } from './api.js';

const shared = new Map();
function once(path) {
  if (!shared.has(path)) {
    const promise = api(path);
    promise.catch(() => shared.delete(path)); // allow a retry after a failure
    shared.set(path, promise);
  }
  return shared.get(path);
}

const route = () => window.location.hash.replace(/^#\/?/, '').split('?')[0];
const SESSION_PATH = !route() || route() === 'dashboard' ? '/auth/me?include=dashboard' : '/auth/me';
export const getSession = () => once(SESSION_PATH);
export const getMeta = () => once('/meta');

/** Forget the cached session (sign-in / sign-out changes it). */
export function resetSession() {
  shared.delete(SESSION_PATH);
  dashboardPrefetch = null;
}

let dashboardPrefetch = null;

/** Dashboard data delivered with the session (signed-out visitors get user: null and no 401). */
function prefetchDashboard() {
  if (SESSION_PATH !== '/auth/me?include=dashboard') return;
  dashboardPrefetch = getSession().then((r) => r.dashboard ?? null);
  dashboardPrefetch.catch(() => {});
}

/**
 * Hand the prefetched dashboard to its first consumer. Callers in the same tick
 * (StrictMode's double effect) share it; anything later, such as a reload after
 * a payment, fetches fresh data.
 */
export function takeDashboardPrefetch() {
  const p = dashboardPrefetch;
  if (!p) return null;
  setTimeout(() => { if (dashboardPrefetch === p) dashboardPrefetch = null; }, 0);
  // Signed out at startup (prefetch resolved to null) → fetch now that we're signed in.
  return p.then((data) => data ?? api('/dashboard'));
}

getSession().catch(() => {});
getMeta().catch(() => {});
prefetchDashboard();
