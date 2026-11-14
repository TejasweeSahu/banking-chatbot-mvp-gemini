import { useState } from 'react';
import { api } from '../api.js';
import { AddBeneficiaryForm } from '../components/AddBeneficiaryForm.jsx';
import { ConfirmationCard } from '../components/ConfirmationCard.jsx';
import { Icon } from '../components/Icon.jsx';
import { EmptyState, ErrorState, Modal, Skeleton, StatusBadge, useAsync } from '../components/ui.jsx';
import { shortDate } from '../format.js';

export function Payments({ user, ask }) {
  const benef = useAsync(() => api('/beneficiaries'), []);
  const bills = useAsync(() => api('/bills'), []);
  const recurring = useAsync(() => api('/recurring'), []);
  const [modal, setModal] = useState(null);
  const readOnly = user.role === 'viewer';

  async function payBill(id) {
    try {
      const res = await api('/actions', { method: 'POST', body: { type: 'bill_payment', params: { bill: id } } });
      setModal({ kind: 'action', title: 'Pay bill', action: res.action });
    } catch (e) {
      setModal({ kind: 'error', title: 'Pay bill', error: e });
    }
  }
  const close = () => { setModal(null); benef.reload(); bills.reload(); };

  return (
    <div className="page">
      <header className="page-head"><h1>Payments</h1><p className="muted">Send money to saved beneficiaries, pay bills and review recurring payments. All payments are simulated.</p></header>
      <div className="dash-grid">
        <section className="panel">
          <header className="panel-head"><h2>Beneficiaries</h2>{!readOnly && <button className="btn btn-quiet btn-sm" onClick={() => setModal({ kind: 'add', title: 'Add a beneficiary' })}><Icon name="plus" size={15} />Add</button>}</header>
          {benef.error && <ErrorState error={benef.error} onRetry={benef.reload} />}
          {benef.loading && !benef.data && <Skeleton />}
          {benef.data && (benef.data.items.length ? (
            <ul className="rec-list">
              {benef.data.items.map((b) => (
                <li key={b.id}>
                  <span><strong>{b.name}{b.nickname ? ` (${b.nickname})` : ''}</strong><small>{b.bankName} {b.maskedAccount}{b.upiEnabled ? ' · UPI' : ''}{b.lastPaidAt ? ` · last paid ${shortDate(b.lastPaidAt.slice(0, 10))}` : ''}</small></span>
                  {!readOnly && <button className="btn btn-quiet btn-sm" onClick={() => ask(`Send money to ${b.name}`)}>Send money</button>}
                </li>
              ))}
            </ul>
          ) : <EmptyState title="No saved beneficiaries yet" />)}
          <p className="fine">To send money, choose Send money and tell the assistant the amount. You'll review a preview before anything is sent.</p>
        </section>

        <div className="dash-col">
          <section className="panel">
            <header className="panel-head"><h2>Bills</h2></header>
            {bills.error && <ErrorState error={bills.error} onRetry={bills.reload} />}
            {bills.data && (
              <ul className="rec-list">
                {bills.data.items.map((b) => (
                  <li key={b.id}>
                    <span><strong>{b.biller}</strong><small>{b.period} · consumer {b.consumerNumber} · due {shortDate(b.dueDate)}</small></span>
                    <span className="rec-side"><strong>{b.amount.formatted}</strong>{b.status === 'due' ? (!readOnly && <button className="link-btn" onClick={() => payBill(b.id)}>Pay now</button>) : <StatusBadge status="completed" label="Paid" />}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="panel">
            <header className="panel-head"><h2>Recurring payments</h2>{recurring.data && <span className="muted small">{recurring.data.monthlyCommitted.formatted} a month</span>}</header>
            {recurring.data && (
              <ul className="rec-list">
                {recurring.data.scheduled.map((r) => (
                  <li key={r.id}>
                    <span><strong>{r.name}</strong><small>{r.kindLabel} · next {shortDate(r.nextDueDate)}</small></span>
                    <span className="rec-side"><strong>{r.amount.formatted}</strong></span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
      <Modal open={Boolean(modal)} onClose={close} title={modal?.title}>
        {modal?.kind === 'add' && <AddBeneficiaryForm onDone={() => benef.reload()} />}
        {modal?.kind === 'action' && <ConfirmationCard action={modal.action} onResolved={() => bills.reload()} />}
        {modal?.kind === 'error' && <ErrorState error={modal.error} />}
      </Modal>
    </div>
  );
}
