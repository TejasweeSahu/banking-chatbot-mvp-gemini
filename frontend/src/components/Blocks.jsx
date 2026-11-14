/**
 * Renders structured blocks emitted by backend tools. These cards are built
 * from verified service data, never from model-generated text.
 */

import { BudgetMeter, CategoryBars, CompareBars, TrendChart } from './charts.jsx';
import { ConfirmationCard } from './ConfirmationCard.jsx';
import { AddBeneficiaryForm } from './AddBeneficiaryForm.jsx';
import { TransactionList } from './TransactionList.jsx';
import { Icon } from './Icon.jsx';
import { StatusBadge } from './ui.jsx';
import { shortDate } from '../format.js';

function Panel({ title, meta, children, className = '' }) {
  return (
    <section className={`block ${className}`}>
      {(title || meta) && <header className="block-head"><h4>{title}</h4>{meta && <span className="muted small">{meta}</span>}</header>}
      {children}
    </section>
  );
}

function Stat({ label, value, sub }) {
  return <div className="stat"><span className="stat-label">{label}</span><span className="stat-value">{value}</span>{sub && <span className="stat-sub">{sub}</span>}</div>;
}

export function Block({ block, ctx }) {
  switch (block.type) {
    case 'accounts':
      return (
        <Panel title="Your accounts" meta={`Total ${block.totalBalance.formatted}`}>
          <ul className="acct-list">
            {block.accounts.map((a) => (
              <li key={a.id}>
                <span><strong>{a.nickname}</strong><small>{a.typeLabel} {a.maskedNumber}</small></span>
                <span className="acct-money">
                  <strong>{a.balance.formatted}</strong>
                  <small>{a.type === 'fixed_deposit' ? `${a.interestRatePct}% p.a. · matures ${shortDate(a.maturityDate)}` : a.holds.paise > 0 ? `${a.availableBalance.formatted} available · ${a.holds.formatted} on hold` : `${a.availableBalance.formatted} available`}</small>
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      );
    case 'transactions':
      return (
        <Panel title={block.title} meta={block.total > block.items.length ? `${block.items.length} of ${block.total}` : `${block.items.length} shown`}>
          {block.items.length ? <TransactionList items={block.items} today={ctx.today} ranked={block.ranked} onSelect={(t) => ctx.onSend(`Explain transaction ${t.id}`)} /> : <p className="muted">No matching transactions.</p>}
        </Panel>
      );
    case 'transaction_detail': {
      const t = block.transaction;
      return (
        <Panel title={`${t.merchant} · ${t.amount.formatted}`} meta={shortDate(t.date)}>
          <dl className="kv-list">
            <div className="kv"><dt>Status</dt><dd><StatusBadge status={t.status} /></dd></div>
            <div className="kv"><dt>Reference</dt><dd className="mono-ref">{t.reference}</dd></div>
            <div className="kv"><dt>Account</dt><dd>{t.account.nickname} {t.account.maskedNumber}</dd></div>
            {block.merchantHistory.averageAmount && <div className="kv"><dt>Usual amount here</dt><dd>{block.merchantHistory.averageAmount.formatted}<small>{block.merchantHistory.previousCount180d} payments in 6 months</small></dd></div>}
            {block.failureReason && <div className="kv"><dt>Reason</dt><dd>{block.failureReason}</dd></div>}
            {block.existingComplaint && <div className="kv"><dt>Complaint</dt><dd>{block.existingComplaint.reference} ({block.existingComplaint.status.replace('_', ' ')})</dd></div>}
          </dl>
          {block.possibleDuplicate && <p className="inline-warning"><Icon name="alert" size={15} />Looks like a duplicate charge.</p>}
        </Panel>
      );
    }
    case 'spending':
      return (
        <Panel title={block.category ? `${block.category.label} spending` : 'Spending'} meta={block.range.label}>
          <div className="stat-row">
            <Stat label="Total spent" value={block.total.formatted} sub={`${block.transactionCount} transactions`} />
            <Stat label="Per day" value={block.dailyAverage.formatted} />
            {block.pendingDebits.paise > 0 && <Stat label="Pending" value={block.pendingDebits.formatted} sub="not counted yet" />}
          </div>
          {!block.category && block.byCategory.length > 0 && <CategoryBars items={block.byCategory} />}
          <p className="fine">{block.definition}</p>
        </Panel>
      );
    case 'comparison':
      return (
        <Panel title="Spending comparison" meta={`${block.current.range.label} vs ${block.previous.range.label}`}>
          <div className="stat-row">
            <Stat label={block.current.range.label} value={block.current.total.formatted} />
            <Stat label={block.previous.range.label} value={block.previous.total.formatted} />
            <Stat label="Change" value={`${block.change.paise > 0 ? '+' : ''}${block.change.formatted}`} sub={block.changePct != null ? `${block.changePct > 0 ? '+' : ''}${block.changePct}%` : null} />
          </div>
          {block.likeForLike && <p className="callout">Same days last month: <strong>{block.likeForLike.total.formatted}</strong> ({block.likeForLike.changePct > 0 ? '+' : ''}{block.likeForLike.changePct}%).</p>}
          <CompareBars rows={block.byCategory.filter((r) => r.current.paise || r.previous.paise).slice(0, 8)} currentLabel={block.current.range.label} previousLabel={block.previous.range.label} />
        </Panel>
      );
    case 'trend':
      return <Panel title="Income and spending by month"><TrendChart months={block.months} height={200} /></Panel>;
    case 'duplicates':
      return (
        <Panel title="Possible duplicate charges">
          {block.groups.length ? block.groups.map((g) => (
            <div key={g.transactions[0].id} className="dup-group">
              <p><strong>{g.merchant}</strong> charged {g.amount.formatted} {g.count} times within minutes. Possible overcharge: {g.potentialOvercharge.formatted}.</p>
              <TransactionList items={g.transactions} today={ctx.today} />
              <button className="btn btn-quiet btn-sm" onClick={() => ctx.onSend(`Raise a duplicate charge complaint for transaction ${g.transactions.at(-1).id}`)}>Raise a complaint</button>
            </div>
          )) : <p className="muted">No duplicate-looking charges found.</p>}
        </Panel>
      );
    case 'unusual':
      return (
        <Panel title="Unusual spending" meta={block.range.label}>
          {block.largeTransactions.length === 0 && block.categorySpikes.length === 0 && <p className="muted">Nothing unusual stands out.</p>}
          {block.largeTransactions.map((l) => (
            <div key={l.transaction.id} className="flag">
              <TransactionList items={[l.transaction]} today={ctx.today} />
              <p className="small muted">{l.reasons.join('; ')}.</p>
            </div>
          ))}
          {block.categorySpikes.length > 0 && (
            <ul className="plain-list">
              {block.categorySpikes.map((c) => <li key={c.category.id}><strong>{c.category.label}</strong>: {c.total.formatted} vs a typical {c.typicalForPeriod.formatted}</li>)}
            </ul>
          )}
        </Panel>
      );
    case 'recurring':
      return (
        <Panel title="Subscriptions and recurring payments" meta={`Subscriptions ${block.subscriptionMonthlyTotal.formatted}/month`}>
          <ul className="rec-list">
            {block.scheduled.map((r) => (
              <li key={r.id}>
                <span><strong>{r.name}</strong><small>{r.kindLabel}{block.newThisMonth.includes(r.name) ? ' · new this month' : ''}</small></span>
                <span className="rec-side"><strong>{r.amount.formatted}</strong><small>next {shortDate(r.nextDueDate)}</small></span>
              </li>
            ))}
          </ul>
          <p className="fine">All monthly commitments: {block.monthlyCommitted.formatted}.</p>
        </Panel>
      );
    case 'upcoming':
      return (
        <Panel title="Upcoming payments" meta={`${block.total.formatted} by ${shortDate(block.untilDate)}`}>
          {block.items.length ? (
            <ul className="rec-list">
              {block.items.map((u) => (
                <li key={`${u.id}-${u.dueDate}`}>
                  <span><strong>{u.name}</strong><small>{u.kindLabel}</small></span>
                  <span className="rec-side"><strong>{u.amount.formatted}</strong><small>{shortDate(u.dueDate)}</small></span>
                </li>
              ))}
            </ul>
          ) : <p className="muted">Nothing due in this period.</p>}
        </Panel>
      );
    case 'savings': {
      const b = block.breakdown;
      return (
        <Panel title="What you can safely save" meta={`${block.remainingDays} days left this month`}>
          <div className="savings-hero">{block.safeToSave.formatted}</div>
          <dl className="ledger">
            <div><dt>Income received</dt><dd>{b.incomeReceived.formatted}</dd></div>
            <div><dt>Spent so far</dt><dd>−{b.spentSoFar.formatted}</dd></div>
            <div><dt>Bills and subscriptions still due</dt><dd>−{b.committedUpcoming.formatted}</dd></div>
            <div><dt>Expected day-to-day spending</dt><dd>−{b.projectedDiscretionary.formatted}</dd></div>
            <div><dt>Safety buffer (10%)</dt><dd>−{b.safetyBuffer.formatted}</dd></div>
          </dl>
          <details className="fine"><summary>How this is calculated</summary><ul>{block.assumptions.map((a) => <li key={a}>{a}</li>)}</ul></details>
        </Panel>
      );
    }
    case 'budgets':
      return <Panel title="Budgets" meta={block.range?.label}>{block.budgets.map((b) => <BudgetMeter key={b.id} budget={b} />)}</Panel>;
    case 'beneficiaries':
      return (
        <Panel title="Saved beneficiaries">
          <ul className="rec-list">
            {block.items.map((b) => (
              <li key={b.id}>
                <span><strong>{b.name}{b.nickname ? ` (${b.nickname})` : ''}</strong><small>{b.bankName} {b.maskedAccount}{b.upiEnabled ? ' · UPI' : ''}</small></span>
                <button className="btn btn-quiet btn-sm" onClick={() => ctx.onSend(`Send money to ${b.name}`)}>Pay</button>
              </li>
            ))}
          </ul>
        </Panel>
      );
    case 'bills':
      return (
        <Panel title="Bills">
          <ul className="rec-list">
            {block.items.map((b) => (
              <li key={b.id}>
                <span><strong>{b.biller}</strong><small>{b.period} · due {shortDate(b.dueDate)}</small></span>
                <span className="rec-side"><strong>{b.amount.formatted}</strong>{b.status === 'due' ? <button className="link-btn" onClick={() => ctx.onSend(`Pay my ${b.biller} bill`)}>Pay</button> : <StatusBadge status="completed" label="Paid" />}</span>
              </li>
            ))}
          </ul>
        </Panel>
      );
    case 'cards':
      return (
        <Panel title="Your cards">
          <ul className="rec-list">
            {block.items.map((c) => (
              <li key={c.id}>
                <span><strong>{c.variant}</strong><small>{c.maskedNumber} · {c.linkedAccount.nickname}</small></span>
                <StatusBadge status={c.status} label={c.statusLabel} />
              </li>
            ))}
          </ul>
        </Panel>
      );
    case 'confirmation':
      return <ConfirmationCard action={block.action} onResolved={ctx.onActionResolved} readOnly={ctx.readOnly} />;
    case 'receipt':
      return <ConfirmationCard action={block.action} />;
    case 'choices':
      return (
        <div className="choices" role="group" aria-label={block.message}>
          {block.options.map((o) => <button key={o.value} className="choice" onClick={() => ctx.onSend(o.message ?? o.label)} disabled={ctx.busy}>{o.label}</button>)}
        </div>
      );
    case 'notice':
      return <div className={`notice notice-${block.tone}`} role="status"><Icon name={block.tone === 'warning' ? 'alert' : 'info'} size={16} /><div><strong>{block.title}</strong><p>{block.message}</p></div></div>;
    case 'complaint': {
      const c = block.complaint;
      return (
        <Panel title={`Complaint ${c.reference}`} meta={c.categoryLabel}>
          <div className="complaint-top"><StatusBadge status={c.status} />{c.overdue ? <span className="status-text tone-critical"><Icon name="alert" size={13} />Past target date</span> : <span className="muted small">Target {shortDate(c.slaDueDate)}</span>}</div>
          <ol className="timeline">{c.timeline?.map((e, i) => <li key={i}><strong>{e.status.replace('_', ' ')}</strong> <span className="muted small">{shortDate(e.created_at.slice(0, 10))}</span><p>{e.note}</p></li>)}</ol>
          {block.escalation && <p className="callout">Helpline {block.escalation.helpline} · {block.escalation.email}</p>}
        </Panel>
      );
    }
    case 'complaints':
      return (
        <Panel title="Your complaints">
          {block.items.length ? (
            <ul className="rec-list">
              {block.items.map((c) => (
                <li key={c.id}>
                  <span><strong>{c.reference}</strong><small>{c.categoryLabel} · target {shortDate(c.slaDueDate)}</small></span>
                  <StatusBadge status={c.status} />
                </li>
              ))}
            </ul>
          ) : <p className="muted">No complaints on record.</p>}
        </Panel>
      );
    case 'help':
      return <p className="sources"><Icon name="info" size={14} />From the help centre: {block.articles.map((a) => a.title).join('; ')}</p>;
    case 'form':
      return <Panel title="Add a beneficiary"><AddBeneficiaryForm prefillName={block.prefill?.name} onDone={ctx.onActionResolved} /></Panel>;
    default:
      return null;
  }
}
