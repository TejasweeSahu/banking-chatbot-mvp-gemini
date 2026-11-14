import { useState } from 'react';
import { api } from '../api.js';
import { ConfirmationCard } from '../components/ConfirmationCard.jsx';
import { ErrorState, Modal, Skeleton, StatusBadge, useAsync } from '../components/ui.jsx';

const REASONS = [['temporary', 'Temporarily (I can unblock later)'], ['lost', 'Lost card (permanent)'], ['stolen', 'Stolen card (permanent)'], ['suspicious_activity', 'Suspicious activity (permanent)'], ['damaged', 'Damaged card (permanent)']];

export function Cards({ user }) {
  const cards = useAsync(() => api('/cards'), []);
  const [modal, setModal] = useState(null);
  const [reason, setReason] = useState('temporary');
  const readOnly = user.role === 'viewer';

  async function prepare(type, card) {
    try {
      const res = await api('/actions', { method: 'POST', body: { type, params: { card: card.id, ...(type === 'card_block' ? { reason } : {}) } } });
      setModal({ title: type === 'card_block' ? 'Block card' : 'Unblock card', action: res.action });
    } catch (e) {
      setModal({ title: 'Card', error: e });
    }
  }

  return (
    <div className="page">
      <header className="page-head"><h1>Cards</h1><p className="muted">Block a card instantly if it's lost or you notice something wrong.</p></header>
      {cards.error && <ErrorState error={cards.error} onRetry={cards.reload} />}
      {cards.loading && !cards.data && <Skeleton lines={4} />}
      <div className="card-grid">
        {cards.data?.items.map((c) => (
          <section key={c.id} className="panel card-panel">
            <div className={`plastic plastic-${c.network} ${c.status !== 'active' ? 'plastic-off' : ''}`} aria-hidden="true">
              <span className="plastic-variant">{c.variant}</span>
              <span className="plastic-number">{c.maskedNumber}</span>
              <span className="plastic-foot"><span>{user.fullName}</span><span>{c.expiry}</span></span>
            </div>
            <dl className="kv-list">
              <div className="kv"><dt>Status</dt><dd><StatusBadge status={c.status} label={c.statusLabel} /></dd></div>
              <div className="kv"><dt>Linked account</dt><dd>{c.linkedAccount.nickname} {c.linkedAccount.maskedNumber}</dd></div>
              <div className="kv"><dt>Daily limit</dt><dd>{c.dailyLimit.formatted}</dd></div>
              <div className="kv"><dt>Online payments</dt><dd>{c.onlineEnabled ? 'On' : 'Off'}</dd></div>
              <div className="kv"><dt>International use</dt><dd>{c.internationalEnabled ? 'On' : 'Off'}</dd></div>
            </dl>
            {!readOnly && c.status === 'active' && (
              <div className="card-actions">
                <label className="inline-select">Block<select value={reason} onChange={(e) => setReason(e.target.value)}>{REASONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
                <button className="btn btn-danger" onClick={() => prepare('card_block', c)}>Review block</button>
              </div>
            )}
            {!readOnly && c.status === 'temporarily_blocked' && <button className="btn btn-quiet" onClick={() => prepare('card_unblock', c)}>Review unblock</button>}
            {c.status === 'blocked' && <p className="muted small">This card is permanently blocked. A replacement is issued in 5–7 working days.</p>}
          </section>
        ))}
      </div>
      <Modal open={Boolean(modal)} onClose={() => { setModal(null); cards.reload(); }} title={modal?.title}>
        {modal?.error && <ErrorState error={modal.error} />}
        {modal?.action && <ConfirmationCard action={modal.action} onResolved={() => cards.reload()} />}
      </Modal>
    </div>
  );
}
