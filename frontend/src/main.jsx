/**
 * Northstar web app: session bootstrap, hash routing and the app shell.
 */

import { lazy, StrictMode, Suspense, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api } from './api.js';
import { getMeta, getSession, resetSession } from './startup.js';
import { Icon, Mark } from './components/Icon.jsx';
import { Skeleton } from './components/ui.jsx';
import { Login } from './pages/Login.jsx';
import { Dashboard } from './pages/Dashboard.jsx';

// The dashboard (first screen after sign-in) ships in the main bundle; every
// other page is a separate chunk loaded on first visit.
const named = (load, name) => lazy(() => load().then((m) => ({ default: m[name] })));
const Assistant = named(() => import('./pages/Assistant.jsx'), 'Assistant');
const Transactions = named(() => import('./pages/Transactions.jsx'), 'Transactions');
const Payments = named(() => import('./pages/Payments.jsx'), 'Payments');
const Cards = named(() => import('./pages/Cards.jsx'), 'Cards');
const Support = named(() => import('./pages/Support.jsx'), 'Support');
import './styles.css';

const NAV = [
  { id: 'dashboard', label: 'Home', icon: 'home' },
  { id: 'assistant', label: 'Assistant', icon: 'chat' },
  { id: 'transactions', label: 'Transactions', icon: 'list' },
  { id: 'payments', label: 'Payments', icon: 'pay' },
  { id: 'cards', label: 'Cards', icon: 'card' },
  { id: 'support', label: 'Help', icon: 'help' }
];

const readRoute = () => {
  const id = window.location.hash.replace(/^#\/?/, '').split('?')[0];
  return NAV.some((n) => n.id === id) ? id : 'dashboard';
};

function App() {
  const [user, setUser] = useState(undefined);
  const [page, setPage] = useState(readRoute);
  const [prompt, setPrompt] = useState(null);
  const [openTxn, setOpenTxn] = useState(null);
  const [version, setVersion] = useState(0);
  const [today, setToday] = useState(new Date().toISOString().slice(0, 10));

  useEffect(() => {
    getSession().then((r) => setUser(r.user)).catch(() => setUser(null));
    getMeta().then((m) => m.today && setToday(m.today)).catch(() => {});
    const onSignedOut = () => setUser(null);
    const onHash = () => setPage(readRoute());
    window.addEventListener('northstar:signed-out', onSignedOut);
    window.addEventListener('hashchange', onHash);
    return () => {
      window.removeEventListener('northstar:signed-out', onSignedOut);
      window.removeEventListener('hashchange', onHash);
    };
  }, []);

  const navigate = useCallback((id, opts = {}) => {
    setOpenTxn(opts.open ?? null);
    window.location.hash = `/${id}`;
    setPage(id);
    window.scrollTo(0, 0);
  }, []);
  const ask = useCallback((text) => {
    setPrompt(text);
    navigate('assistant');
  }, [navigate]);
  const dataChanged = useCallback(() => setVersion((v) => v + 1), []);

  async function signOut() {
    try { await api('/auth/logout', { method: 'POST' }); } catch { /* session may already be gone */ }
    resetSession();
    setUser(null);
  }

  // Distinct keys: React must replace the boot element rather than morph it into
  // the shell (morphing one box into another was counted as a large layout shift).
  if (user === undefined) return <div key="boot" className="boot" role="status" aria-label="Loading Northstar"><Mark size={40} /></div>;
  if (user === null) return <Login key="login" onSignedIn={(u) => { resetSession(); setUser(u); navigate('dashboard'); }} />;

  return (
    <div key="shell" className="shell">
      <a className="skip-link" href="#main">Skip to content</a>
      <aside className="sidebar">
        <div className="brand"><Mark size={32} /><span>Northstar</span></div>
        <nav aria-label="Main">
          {NAV.map((n) => (
            <a key={n.id} href={`#/${n.id}`} className={`nav-item ${page === n.id ? 'active' : ''}`} aria-current={page === n.id ? 'page' : undefined} onClick={(e) => { e.preventDefault(); navigate(n.id); }}>
              <Icon name={n.icon} /><span>{n.label}</span>
            </a>
          ))}
        </nav>
        <div className="sidebar-foot">
          <p className="sim-banner"><Icon name="shield" size={16} />Demo bank. Balances, payments and cards are simulated.</p>
          <div className="profile">
            <span className="avatar" aria-hidden="true">{user.firstName.slice(0, 1)}</span>
            <span><strong>{user.fullName}</strong><small>{user.role === 'viewer' ? 'Read-only access' : 'Personal banking'}</small></span>
            <button className="icon-btn" onClick={signOut} aria-label="Sign out" title="Sign out"><Icon name="logout" /></button>
          </div>
        </div>
      </aside>

      <header className="mobile-top">
        <div className="brand"><Mark size={28} /><span>Northstar</span></div>
        <button className="icon-btn" onClick={signOut} aria-label="Sign out"><Icon name="logout" /></button>
      </header>

      <main id="main" className={`main main-${page}`}>
        {user.role === 'viewer' && <p className="readonly-banner"><Icon name="lock" size={15} />You have read-only access. Payments and card changes are disabled.</p>}
        <Suspense fallback={<div className="page"><Skeleton lines={6} height={22} /></div>}>
          {page === 'dashboard' && <Dashboard key={version} user={user} navigate={navigate} ask={ask} />}
          {page === 'assistant' && <Assistant user={user} initialPrompt={prompt} onConsumePrompt={() => setPrompt(null)} onDataChanged={dataChanged} />}
          {page === 'transactions' && <Transactions key={version} today={today} ask={ask} openId={openTxn} />}
          {page === 'payments' && <Payments key={version} user={user} ask={ask} />}
          {page === 'cards' && <Cards key={version} user={user} />}
          {page === 'support' && <Support key={version} ask={ask} />}
        </Suspense>
      </main>

      <nav className="tabbar" aria-label="Main">
        {NAV.map((n) => (
          <a key={n.id} href={`#/${n.id}`} className={page === n.id ? 'active' : ''} aria-current={page === n.id ? 'page' : undefined} onClick={(e) => { e.preventDefault(); navigate(n.id); }}>
            <Icon name={n.icon} size={20} /><span>{n.label}</span>
          </a>
        ))}
      </nav>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<StrictMode><App /></StrictMode>);
