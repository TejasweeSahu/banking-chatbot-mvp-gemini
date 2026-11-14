import { CHANNEL_LABELS, dayLabel, time } from '../format.js';
import { StatusBadge } from './ui.jsx';

export function TransactionRow({ txn, today, onSelect, rank }) {
  const credit = txn.direction === 'credit';
  const content = (
    <>
      {rank != null && <span className="txn-rank">{rank}</span>}
      <span className="txn-avatar" aria-hidden="true">{txn.merchant.slice(0, 1).toUpperCase()}</span>
      <span className="txn-main">
        <span className="txn-title">{txn.merchant}</span>
        <span className="txn-sub">{txn.category.label} · {CHANNEL_LABELS[txn.channel] ?? txn.channel} · {dayLabel(txn.date, today)}, {time(txn.postedAt)}</span>
      </span>
      <span className="txn-side">
        <span className={`txn-amount ${credit ? 'credit' : ''} ${txn.status === 'failed' ? 'struck' : ''}`}>{credit ? '+' : '−'}{txn.amount.formatted}</span>
        {txn.status !== 'success' && <StatusBadge status={txn.status} />}
      </span>
    </>
  );
  return (
    <li className="txn">
      {onSelect ? <button className="txn-btn" onClick={() => onSelect(txn)}>{content}</button> : <div className="txn-btn">{content}</div>}
    </li>
  );
}

export function TransactionList({ items, today, onSelect, ranked = false }) {
  return (
    <ul className="txn-list">
      {items.map((t, i) => <TransactionRow key={t.id} txn={t} today={today} onSelect={onSelect} rank={ranked ? i + 1 : null} />)}
    </ul>
  );
}
