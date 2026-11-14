import { useState } from 'react';
import { api } from '../api.js';
import { takeDashboardPrefetch } from '../startup.js';
import { BudgetMeter, CategoryBars, TrendChart } from '../components/charts.jsx';
import { TransactionList } from '../components/TransactionList.jsx';
import { ConfirmationCard } from '../components/ConfirmationCard.jsx';
import { Icon } from '../components/Icon.jsx';
import { EmptyState, ErrorState, Modal, Skeleton, useAsync } from '../components/ui.jsx';
import { shortDate } from '../format.js';

export function Dashboard({ user, navigate, ask }) {
  const { data, loading, error, reload } = useAsync(() => takeDashboardPrefetch() ?? api('/dashboard'), []);
  const [modal, setModal] = useState(null);
  const [editing, setEditing] = useState(null);
  const readOnly = user.role === 'viewer';

  if (loading && !data) return <div className="page"><Skeleton lines={6} height={22} /></div>;
  if (error) return <div className="page"><ErrorState error={error} onRetry={reload} /></div>;

  const d = data;
  const insights = [];
  for (const g of d.insights.duplicates) insights.push({ key: `dup-${g.merchant}`, icon: 'alert', text: `${g.merchant} charged ${g.amount.formatted} twice within minutes.`, prompt: 'Check for duplicate charges' });
  for (const u of d.insights.unusual) insights.push({ key: `un-${u.transaction.id}`, icon: 'spark', text: `${u.transaction.merchant} ${u.transaction.amount.formatted} is unusually large for you.`, prompt: 'Show unusual spending this month' });
  if (d.insights.pendingCount) insights.push({ key: 'pending', icon: 'clock', text: `${d.insights.pendingCount} payment${d.insights.pendingCount > 1 ? 's are' : ' is'} still pending.`, prompt: 'Why is my payment pending?' });
  if (d.insights.openComplaints) insights.push({ key: 'cmp', icon: 'help', text: `${d.insights.openComplaints} open complaint${d.insights.openComplaints > 1 ? 's' : ''}.`, prompt: 'Track my complaints' });

  async function payBill(billId) {
    try {
      const res = await api('/actions', { method: 'POST', body: { type: 'bill_payment', params: { bill: billId } } });
      setModal({ title: 'Pay bill', action: res.action });
    } catch (e) {
      setModal({ title: 'Pay bill', error: e.message });
    }
  }

  return (
    <div className="page dashboard">
      <section className="band" aria-label="Balance summary">
        <div className="band-main">
          <p className="band-greeting">Good to see you, {d.user.firstName}</p>
          <p className="band-label">Total balance across {d.accounts.length} accounts</p>
          <p className="band-balance">{d.totalBalance.formatted}</p>
          <p className="band-sub">{d.totalAvailable.formatted} available to spend · as of {shortDate(d.asOf)}</p>
        </div>
        <dl className="band-month">
          <div><dt>Money in this month</dt><dd>{d.month.income.formatted}</dd></div>
          <div><dt>Spent this month</dt><dd>{d.month.spending.formatted}</dd></div>
          <div><dt>Kept so far</dt><dd>{d.month.net.formatted}{d.month.savingsRatePct != null && <small> {d.month.savingsRatePct}% of income</small>}</dd></div>
        </dl>
        <button className="band-ask" onClick={() => ask('How much can I safely save this month?')}><Icon name="chat" size={16} />Ask what I can save</button>
      </section>

      <div className="dash-grid">
        <div className="dash-col">
          <section className="panel">
            <header className="panel-head"><h2>Accounts</h2></header>
            <ul className="acct-list">
              {d.accounts.map((a) => (
                <li key={a.id}>
                  <span><strong>{a.nickname}</strong><small>{a.typeLabel} {a.maskedNumber}</small></span>
                  <span className="acct-money"><strong>{a.balance.formatted}</strong><small>{a.type === 'fixed_deposit' ? `${a.interestRatePct}% p.a. · matures ${shortDate(a.maturityDate)}` : a.holds.paise > 0 ? `${a.availableBalance.formatted} available, ${a.holds.formatted} on hold` : `${a.availableBalance.formatted} available`}</small></span>
                </li>
              ))}
            </ul>
          </section>

          <section className="panel">
            <header className="panel-head"><h2>Income and spending</h2><span className="muted small">Last 6 months</span></header>
            <TrendChart months={d.trend} />
          </section>

          <section className="panel">
            <header className="panel-head"><h2>Where your money went</h2><span className="muted small">{d.spending.range.label}</span></header>
            {d.spending.byCategory.length ? <CategoryBars items={d.spending.byCategory} limit={7} /> : <EmptyState title="No spending yet this month" />}
            <button className="link-btn" onClick={() => ask('Why did my expenses increase this month?')}>Ask why spending changed</button>
          </section>

          <section className="panel">
            <header className="panel-head"><h2>Recent transactions</h2><button className="link-btn" onClick={() => navigate('transactions')}>See all</button></header>
            <TransactionList items={d.recentTransactions} today={d.asOf} onSelect={(t) => navigate('transactions', { open: t.id })} />
          </section>
        </div>

        <div className="dash-col">
          {insights.length > 0 && (
            <section className="panel insights">
              <header className="panel-head"><h2>Worth a look</h2></header>
              <ul>
                {insights.map((i) => (
                  <li key={i.key}><Icon name={i.icon} size={16} /><span>{i.text}</span><button className="link-btn" onClick={() => ask(i.prompt)}>Ask</button></li>
                ))}
              </ul>
            </section>
          )}

          <section className="panel">
            <header className="panel-head"><h2>Budgets</h2><span className="muted small">{d.budgets.totalSpent.formatted} of {d.budgets.totalLimit.formatted}</span></header>
            {d.budgets.budgets.map((b) => <BudgetMeter key={b.id} budget={b} onEdit={readOnly ? null : setEditing} />)}
          </section>

          <section className="panel">
            <header className="panel-head"><h2>Coming up</h2><span className="muted small">Next 30 days · {d.upcoming.total.formatted}</span></header>
            {d.upcoming.items.length ? (
              <ul className="rec-list">
                {d.upcoming.items.slice(0, 7).map((u) => (
                  <li key={`${u.id}-${u.dueDate}`}>
                    <span><strong>{u.name}</strong><small>{u.kindLabel} · {shortDate(u.dueDate)}</small></span>
                    <span className="rec-side"><strong>{u.amount.formatted}</strong>{u.source === 'bill' && !readOnly && <button className="link-btn" onClick={() => payBill(u.id)}>Pay now</button>}</span>
                  </li>
                ))}
              </ul>
            ) : <EmptyState title="Nothing due in the next 30 days" />}
          </section>
        </div>
      </div>

      <Modal open={Boolean(modal)} onClose={() => { setModal(null); reload(); }} title={modal?.title}>
        {modal?.error && <ErrorState error={{ message: modal.error }} />}
        {modal?.action && <ConfirmationCard action={modal.action} onResolved={() => reload()} />}
      </Modal>
      <Modal open={Boolean(editing)} onClose={() => setEditing(null)} title={editing ? `${editing.category.label} budget` : ''}>
        {editing && <BudgetEditor budget={editing} onSaved={() => { setEditing(null); reload(); }} />}
      </Modal>
    </div>
  );
}

function BudgetEditor({ budget, onSaved }) {
  const [value, setValue] = useState(budget.limit.value.replace(/\.00$/, ''));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api(`/budgets/${budget.category.id}`, { method: 'PUT', body: { amount: value } });
      onSaved();
    } catch (err) {
      setError(Array.isArray(err.details) ? 'Enter an amount between ₹100 and ₹10,00,000.' : err.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="form" onSubmit={save}>
      <label>Monthly limit (₹)<input inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} pattern="\d+(\.\d{1,2})?" required autoFocus /></label>
      <p className="muted small">Spent so far this month: {budget.spent.formatted}</p>
      {error && <p className="inline-error" role="alert">{error}</p>}
      <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save budget'}</button>
    </form>
  );
}
