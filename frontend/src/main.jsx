/**
 * @file frontend/src/main.jsx
 * @description Main React 19 application component for the Northstar Banking interface.
 * Implements:
 * - Real-time conversational interface with assistant messaging, typing indicators, and prompt suggestions.
 * - Human-in-the-loop pending approval cards (`PendingAction`) for sensitive operations (transfers, card blocking).
 * - Interactive sidebar and overview panel reflecting live account balance, masked numbers, and debit card status.
 * - API communication with `/api/chat`, `/api/confirm`, and `/api/demo-state`.
 */

import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const suggestions = [
  'What’s my balance?',
  'Show my last 5 transactions',
  'How much did I spend on food this month?',
  'Transfer ₹5000 to Rahul',
  'Block my card'
];

function money(value) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(value ?? 0);
}

function PendingAction({ action, onConfirm, onCancel, busy }) {
  const transfer = action.type === 'transfer';
  return (
    <section className="approval-card" aria-label="Pending action confirmation">
      <div className="approval-head">
        <div className="approval-icon">{transfer ? '₹' : '!'}</div>
        <div>
          <div className="approval-kicker">ACTION REQUIRES APPROVAL</div>
          <h3>{transfer ? 'Confirm money transfer' : 'Confirm card block'}</h3>
        </div>
        <span className="pending-pill">Pending</span>
      </div>
      {transfer ? (
        <div className="approval-details">
          <div><span>Amount</span><strong>{money(action.amount)}</strong></div>
          <div><span>To</span><strong>{action.recipient}</strong></div>
          <div><span>Beneficiary account</span><strong>•••• {action.recipientAccountLast4}</strong></div>
          <div><span>From account</span><strong>•••• {action.sourceAccountLast4}</strong></div>
        </div>
      ) : (
        <p className="approval-copy">This will block the debit card ending in <strong>{action.cardLast4}</strong>. Card payments may be declined after the action completes.</p>
      )}
      <p className="approval-warning">Nothing has happened yet. Choose Confirm to execute this action.</p>
      <div className="approval-actions">
        <button className="button button-quiet" onClick={() => onCancel(action.confirmationId)} disabled={busy}>Cancel</button>
        <button className="button button-danger" onClick={() => onConfirm(action.confirmationId)} disabled={busy}>{busy ? 'Processing…' : transfer ? 'Confirm transfer' : 'Confirm block'}</button>
      </div>
    </section>
  );
}

function App() {
  const [messages, setMessages] = useState([
    { id: 'welcome', role: 'assistant', content: 'Hello Tejas. I’m your banking assistant for this mock account. I can check your balance, review transactions, summarise spending, prepare transfers, and block your debit card.' }
  ]);
  const [pending, setPending] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [busyConfirmation, setBusyConfirmation] = useState(false);
  const [mode, setMode] = useState('demo');
  const [account, setAccount] = useState(null);
  const [card, setCard] = useState(null);
  const [error, setError] = useState('');
  const bottomRef = useRef(null);
  const inputRef = useRef(null);

  async function refreshState() {
    try {
      const response = await fetch('/api/demo-state');
      if (!response.ok) throw new Error('Could not load account overview.');
      const data = await response.json();
      setAccount(data);
      setCard(data.card);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => { refreshState(); }, []);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, pending]);

  async function sendMessage(value = input) {
    const content = value.trim();
    if (!content || busy) return;
    setError('');
    setInput('');
    const next = [...messages, { id: crypto.randomUUID(), role: 'user', content }];
    setMessages(next);
    setBusy(true);
    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: next.filter((item) => item.role !== 'system').map(({ role, content: text }) => ({ role, content: text })) })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'The assistant could not respond.');
      setMode(data.mode);
      setPending((current) => [...current, ...(data.pending || [])]);
      setMessages((current) => [...current, { id: crypto.randomUUID(), role: 'assistant', content: data.reply }]);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }

  async function confirmAction(confirmationId, approved) {
    setBusyConfirmation(true);
    setError('');
    try {
      const response = await fetch('/api/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmationId, approved })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not process confirmation.');
      setPending((current) => current.filter((item) => item.confirmationId !== confirmationId));
      setMessages((current) => [...current, {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: approved ? data.result.message : data.message
      }]);
      await refreshState();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyConfirmation(false);
    }
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand-row">
          <div className="brand-mark">N</div>
          <div><div className="brand-name">northstar</div><div className="brand-sub">DIGITAL BANKING</div></div>
        </div>
        <div className="sidebar-label">YOUR ACCOUNT</div>
        <div className="account-card">
          <div className="account-card-top"><span className="account-dot" /> <span>Everyday account</span></div>
          <div className="account-number">•••• •••• •••• {account?.user?.accountLast4 || '2048'}</div>
          <div className="account-balance-label">Available balance</div>
          <div className="account-balance">{account ? money(account.balance.balance) : '••••••'}</div>
        </div>
        <div className="sidebar-label section-gap">TOOLS</div>
        <div className="side-nav-item active"><span className="nav-icon">✧</span> AI assistant</div>
        <div className="side-nav-item"><span className="nav-icon">▤</span> Transactions <span className="nav-soon">DEMO</span></div>
        <div className="side-nav-item"><span className="nav-icon">▣</span> Cards</div>
        <div className="sidebar-bottom">
          <div className="security-note"><span className="lock-icon">⌑</span><div><strong>Secure demo environment</strong><p>All account data is simulated. No real funds or cards are connected.</p></div></div>
          <div className="profile-row"><div className="avatar">T</div><div><strong>Tejas</strong><span>Mock authenticated user</span></div><span className="profile-menu">•••</span></div>
        </div>
      </aside>

      <section className="main-panel">
        <header className="topbar">
          <div><div className="breadcrumb">Workspace <span>/</span> AI assistant</div><h1>Banking assistant</h1></div>
          <div className="topbar-right"><span className={`mode-pill ${mode === 'gemini' ? 'live' : ''}`}><span />{mode === 'gemini' ? 'LLM connected' : 'Demo mode'}</span><button className="help-button" title="Demo environment information">?</button></div>
        </header>

        <div className="content-area">
          <div className="chat-column">
            <div className="chat-heading"><div><h2>Chat with Northstar</h2><p>Ask questions or complete everyday banking tasks.</p></div><div className="online-status"><span /> Online</div></div>
            <div className="chat-window">
              <div className="date-divider"><span>Today</span></div>
              {messages.map((message) => (
                <div className={`message-row ${message.role}`} key={message.id}>
                  {message.role === 'assistant' && <div className="assistant-avatar">N</div>}
                  <div className="message-content">
                    <div className="message-meta">{message.role === 'assistant' ? 'NORTHSTAR ASSISTANT' : 'YOU'} <span>{message.role === 'assistant' ? '· AI' : ''}</span></div>
                    <div className={`bubble ${message.role}`}>
                      {message.content.split('\n').map((line, index) => <React.Fragment key={index}>{line}{index < message.content.split('\n').length - 1 && <br />}</React.Fragment>)}
                    </div>
                    {message.role === 'assistant' && message.id === 'welcome' && (
                      <div className="suggestion-wrap"><div className="suggestion-label">TRY ASKING</div><div className="suggestions">{suggestions.slice(0, 3).map((suggestion) => <button key={suggestion} onClick={() => sendMessage(suggestion)} disabled={busy}>{suggestion}</button>)}</div></div>
                    )}
                  </div>
                  {message.role === 'user' && <div className="user-avatar">T</div>}
                </div>
              ))}
              {pending.map((action) => <div className="pending-wrap" key={action.confirmationId}><PendingAction action={action} onConfirm={(id) => confirmAction(id, true)} onCancel={(id) => confirmAction(id, false)} busy={busyConfirmation} /></div>)}
              {busy && <div className="message-row assistant"><div className="assistant-avatar">N</div><div className="typing">Northstar is thinking<span>.</span><span>.</span><span>.</span></div></div>}
              {error && <div className="error-banner">{error}</div>}
              <div ref={bottomRef} />
            </div>
            <form className="composer" onSubmit={(event) => { event.preventDefault(); sendMessage(); }}>
              <input ref={inputRef} value={input} onChange={(event) => setInput(event.target.value)} placeholder="Ask about your account or make a request…" aria-label="Message the banking assistant" />
              <button type="submit" disabled={busy || !input.trim()} aria-label="Send message"><span>↑</span></button>
            </form>
            <div className="composer-note"><span>⌑</span> Never share your PIN, password, or OTP in chat.</div>
          </div>

          <aside className="right-panel">
            <div className="right-card overview-card"><div className="right-card-title">ACCOUNT OVERVIEW <span>•••</span></div><div className="overview-label">Total available balance</div><div className="overview-balance">{account ? money(account.balance.balance) : 'Loading…'}</div><div className="account-subline">Everyday account ·· {account?.user?.accountLast4 || '2048'}</div><div className="overview-divider" /><div className="mini-stat"><span>Account status</span><strong><i className="status-dot" /> Active</strong></div><div className="mini-stat"><span>Debit card</span><strong>{card?.blocked ? <em className="blocked-text">Blocked</em> : 'Active'} ·· {card?.cardLast4 || '7812'}</strong></div></div>
            <div className="right-card actions-card"><div className="right-card-title">QUICK ACTIONS</div><button onClick={() => sendMessage('What’s my balance?')} disabled={busy}><span className="quick-icon">₹</span><span>Check balance</span><b>›</b></button><button onClick={() => sendMessage('Show my last 5 transactions')} disabled={busy}><span className="quick-icon">↗</span><span>Recent transactions</span><b>›</b></button><button onClick={() => sendMessage('How much did I spend on food this month?')} disabled={busy}><span className="quick-icon">◷</span><span>Spending summary</span><b>›</b></button><button onClick={() => sendMessage('Block my card')} disabled={busy}><span className="quick-icon">▣</span><span>Block debit card</span><b>›</b></button></div>
            <div className="right-card safety-card"><div className="safety-icon">✓</div><div><strong>You’re in control</strong><p>Transfers and card blocking always need your confirmation before anything changes.</p></div></div>
            <div className="footer-note">NORTHSTAR BANKING · MVP ASSESSMENT BUILD</div>
          </aside>
        </div>
      </section>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
