/**
 * Approval card for a pending action. The only UI control that can execute a
 * transfer, bill payment, card change or new payee — via POST /api/actions/:id/confirm.
 */

import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Icon } from './Icon.jsx';
import { SimulatedTag, StatusBadge } from './ui.jsx';

const TITLES = {
  transfer: 'Review transfer',
  bill_payment: 'Review bill payment',
  card_block: 'Review card block',
  card_unblock: 'Review card unblock',
  add_beneficiary: 'Review new beneficiary'
};
const CONFIRM_LABEL = { transfer: 'Send money', bill_payment: 'Pay bill', card_block: 'Block card', card_unblock: 'Unblock card', add_beneficiary: 'Add beneficiary' };
const DONE_TITLE = { transfer: 'Money sent', bill_payment: 'Bill paid', card_block: 'Card blocked', card_unblock: 'Card unblocked', add_beneficiary: 'Beneficiary added' };

function Row({ label, children }) {
  return <div className="kv"><dt>{label}</dt><dd>{children}</dd></div>;
}

function Details({ action }) {
  const p = action.preview;
  if (action.type === 'transfer') {
    return (
      <>
        <div className="confirm-amount">{p.amount.formatted}</div>
        <dl className="kv-list">
          <Row label="To">{p.to.name}{p.to.nickname ? ` (${p.to.nickname})` : ''}<small>{p.to.bankName} {p.to.maskedAccount}</small></Row>
          <Row label="From">{p.from.nickname} {p.from.maskedNumber}<small>Available after: {p.from.availableAfter.formatted}</small></Row>
          <Row label="Method">{p.methodLabel}<small>{p.eta} · Fee {p.fee.formatted}</small></Row>
          {p.note && <Row label="Note">{p.note}</Row>}
        </dl>
        {p.warnings?.map((w) => <p key={w.code} className="inline-warning"><Icon name="alert" size={15} />{w.message}</p>)}
      </>
    );
  }
  if (action.type === 'bill_payment') {
    return (
      <>
        <div className="confirm-amount">{p.amount.formatted}</div>
        <dl className="kv-list">
          <Row label="Biller">{p.bill.biller}<small>Consumer no. {p.bill.consumerNumber} · {p.bill.period}</small></Row>
          <Row label="Due">{p.bill.dueDate}</Row>
          <Row label="From">{p.from.nickname} {p.from.maskedNumber}<small>Available after: {p.from.availableAfter.formatted}</small></Row>
        </dl>
      </>
    );
  }
  if (action.type === 'card_block' || action.type === 'card_unblock') {
    return (
      <>
        <dl className="kv-list">
          <Row label="Card">{p.card.variant}<small>{p.card.maskedNumber}</small></Row>
          {action.type === 'card_block' && <Row label="Block type">{p.permanent ? `Permanent (${p.reason.replace('_', ' ')})` : 'Temporary'}</Row>}
        </dl>
        <p className="confirm-note">{p.consequence}</p>
      </>
    );
  }
  return (
    <>
      <dl className="kv-list">
        <Row label="Name">{p.name}{p.nickname ? ` (${p.nickname})` : ''}</Row>
        <Row label="Bank">{p.bankName}<small>IFSC {p.ifsc}</small></Row>
        <Row label="Account">{p.maskedAccount}</Row>
        <Row label="UPI">{p.upiEnabled ? 'Enabled' : 'Not added'}</Row>
      </dl>
      <p className="confirm-note">{p.notice}</p>
    </>
  );
}

function Receipt({ action }) {
  const r = action.result ?? {};
  return (
    <div className="receipt">
      <dl className="kv-list">
        {r.amount && <Row label="Amount">{r.amount.formatted}</Row>}
        {r.to && <Row label="To">{r.to.name}<small>{r.to.bankName} {r.to.maskedAccount}</small></Row>}
        {r.biller && <Row label="Biller">{r.biller}</Row>}
        {r.card && <Row label="Card">{r.card.variant} ••{r.card.last4}<small>{r.card.statusLabel}</small></Row>}
        {r.beneficiary && <Row label="Beneficiary">{r.beneficiary.name}<small>{r.beneficiary.bankName} {r.beneficiary.maskedAccount}</small></Row>}
        {r.reference && <Row label="Reference"><span className="mono-ref">{r.reference}</span></Row>}
        {r.newAvailableBalance && <Row label="Available balance">{r.newAvailableBalance.formatted}</Row>}
      </dl>
    </div>
  );
}

function useCountdown(expiresAt, active) {
  const [left, setLeft] = useState(() => Date.parse(expiresAt) - Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const t = setInterval(() => setLeft(Date.parse(expiresAt) - Date.now()), 1000);
    return () => clearInterval(t);
  }, [expiresAt, active]);
  return left;
}

export function ConfirmationCard({ action: initial, onResolved, readOnly = false }) {
  const [action, setAction] = useState(initial);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => setAction(initial), [initial]);
  const pending = action.status === 'pending';
  const left = useCountdown(action.expiresAt, pending);
  const expired = pending && left <= 0;

  async function resolve(kind) {
    setBusy(kind);
    setError('');
    try {
      const res = await api(`/actions/${action.id}/${kind}`, { method: 'POST' });
      setAction(res.action);
      onResolved?.(res);
    } catch (e) {
      setError(e.message);
      if (e.status === 409 || e.status === 422) {
        try { setAction(await api(`/actions/${action.id}`)); } catch { /* keep current */ }
      }
    } finally {
      setBusy(null);
    }
  }

  const status = expired ? 'expired' : action.status;
  return (
    <section className={`confirm confirm-${status}`} aria-label={TITLES[action.type]}>
      <header className="confirm-head">
        <div>
          <h3>{status === 'completed' ? DONE_TITLE[action.type] : TITLES[action.type]}</h3>
          <SimulatedTag />
        </div>
        <StatusBadge status={status} label={status === 'pending' ? 'Awaiting your approval' : undefined} />
      </header>
      {status === 'completed' ? <Receipt action={action} /> : <Details action={action} />}
      {status === 'pending' && (
        <>
          {error && <p className="inline-error" role="alert">{error}</p>}
          <div className="confirm-actions">
            <span className="muted small"><Icon name="clock" size={14} />Expires in {Math.max(0, Math.floor(left / 60000))}:{String(Math.max(0, Math.floor((left % 60000) / 1000))).padStart(2, '0')}</span>
            <button className="btn btn-quiet" onClick={() => resolve('cancel')} disabled={Boolean(busy) || readOnly}>{busy === 'cancel' ? 'Cancelling…' : 'Cancel'}</button>
            <button className="btn btn-confirm" onClick={() => resolve('confirm')} disabled={Boolean(busy) || readOnly}>{busy === 'confirm' ? 'Processing…' : CONFIRM_LABEL[action.type]}</button>
          </div>
          <p className="confirm-fine">Nothing happens until you choose {CONFIRM_LABEL[action.type]}. Northstar is a demo: no real money or cards are involved.</p>
        </>
      )}
      {status === 'failed' && <p className="inline-error">{action.error || error || 'This could not be completed. Nothing was changed.'}</p>}
      {status === 'expired' && <p className="confirm-note">This request expired for your security. Ask again to get a fresh preview.</p>}
      {status === 'cancelled' && <p className="confirm-note">Cancelled. Nothing was changed.</p>}
    </section>
  );
}
