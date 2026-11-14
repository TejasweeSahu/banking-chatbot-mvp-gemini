import { useState } from 'react';
import { api } from '../api.js';
import { Mark } from '../components/Icon.jsx';

export function Login({ onSignedIn }) {
  const [username, setUsername] = useState('tejas');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { user } = await api('/auth/login', { method: 'POST', body: { username, password } });
      onSignedIn(user);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <section className="login-panel">
        <div className="brand"><Mark size={36} /><span>Northstar</span></div>
        <h1>Sign in to your bank</h1>
        <form className="form" onSubmit={submit}>
          <label>Username<input autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required maxLength={40} /></label>
          <label>Password<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required maxLength={128} autoFocus /></label>
          {error && <p className="inline-error" role="alert">{error}</p>}
          <button className="btn btn-primary btn-block" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        </form>
        <div className="demo-creds">
          <p><strong>Demo bank.</strong> All accounts, payments and cards are simulated.</p>
          <p>Password for every demo profile: <code>Northstar@2026</code></p>
          <ul>
            <li><button type="button" className="link-btn" onClick={() => setUsername('tejas')}>tejas</button> full customer with three accounts</li>
            <li><button type="button" className="link-btn" onClick={() => setUsername('aisha')}>aisha</button> a second customer</li>
            <li><button type="button" className="link-btn" onClick={() => setUsername('meera')}>meera</button> read-only profile</li>
          </ul>
        </div>
      </section>
      <aside className="login-aside" aria-hidden="true">
        <p className="login-quote">Ask about your money in plain words. Every figure comes from your ledger, and nothing moves until you approve it.</p>
      </aside>
    </main>
  );
}
