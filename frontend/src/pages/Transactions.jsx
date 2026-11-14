import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { TransactionList } from '../components/TransactionList.jsx';
import { Block } from '../components/Blocks.jsx';
import { EmptyState, ErrorState, Modal, Skeleton } from '../components/ui.jsx';
import { CATEGORY_OPTIONS } from '../format.js';

const PERIODS = [['', 'Any time'], ['this_month', 'This month'], ['last_month', 'Last month'], ['last_30_days', 'Last 30 days'], ['last_90_days', 'Last 90 days'], ['this_year', 'This year']];
const PAGE = 25;

export function Transactions({ today, ask, openId }) {
  const [filters, setFilters] = useState({ q: '', category: '', status: '', direction: '', period: '', sort: 'date_desc' });
  const [query, setQuery] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState(null);

  useEffect(() => {
    const t = setTimeout(() => setFilters((f) => ({ ...f, q: query })), 300);
    return () => clearTimeout(t);
  }, [query]);

  async function load(offset = 0) {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams(Object.entries({ ...filters, limit: PAGE, offset }).filter(([, v]) => v !== '' && v != null));
      const r = await api(`/transactions?${params}`);
      setResult((prev) => (offset && prev ? { ...r, items: [...prev.items, ...r.items] } : r));
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(0); }, [filters]);

  async function openDetail(id) {
    setDetail({ loading: true });
    try {
      setDetail({ data: await api(`/transactions/${id}`) });
    } catch (e) {
      setDetail({ error: e });
    }
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (openId) openDetail(openId); }, [openId]);

  const set = (k) => (e) => setFilters((f) => ({ ...f, [k]: e.target.value }));
  const active = Object.entries(filters).some(([k, v]) => k !== 'sort' && v);

  return (
    <div className="page">
      <header className="page-head"><h1>Transactions</h1>{result && <p className="muted">{result.total} transactions{result.range ? `, ${result.range.label}` : ''}</p>}</header>
      <div className="filters" role="search">
        <label className="filter-search"><span className="sr-only">Search</span><input type="search" placeholder="Search merchant, description or reference" value={query} onChange={(e) => setQuery(e.target.value)} maxLength={60} /></label>
        <label><span className="sr-only">Period</span><select value={filters.period} onChange={set('period')}>{PERIODS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
        <label><span className="sr-only">Category</span><select value={filters.category} onChange={set('category')}><option value="">All categories</option>{CATEGORY_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
        <label><span className="sr-only">Status</span><select value={filters.status} onChange={set('status')}><option value="">Any status</option><option value="success">Completed</option><option value="pending">Pending</option><option value="failed">Failed</option></select></label>
        <label><span className="sr-only">Direction</span><select value={filters.direction} onChange={set('direction')}><option value="">Money in and out</option><option value="debit">Money out</option><option value="credit">Money in</option></select></label>
        <label><span className="sr-only">Sort</span><select value={filters.sort} onChange={set('sort')}><option value="date_desc">Newest first</option><option value="date_asc">Oldest first</option><option value="amount_desc">Largest first</option><option value="amount_asc">Smallest first</option></select></label>
        {active && <button className="link-btn" onClick={() => { setQuery(''); setFilters({ q: '', category: '', status: '', direction: '', period: '', sort: 'date_desc' }); }}>Clear filters</button>}
      </div>
      {result && (filters.period || filters.category || filters.q) && (
        <p className="totals">Money out {result.totals.successfulDebits.formatted} · Money in {result.totals.successfulCredits.formatted} <span className="muted">(completed only)</span></p>
      )}
      <section className="panel">
        {error && <ErrorState error={error} onRetry={() => load(0)} />}
        {!error && !result && <Skeleton lines={8} />}
        {result && result.items.length === 0 && <EmptyState title="No transactions match these filters" action={<button className="btn btn-quiet" onClick={() => { setQuery(''); setFilters({ q: '', category: '', status: '', direction: '', period: '', sort: 'date_desc' }); }}>Clear filters</button>} />}
        {result && result.items.length > 0 && <TransactionList items={result.items} today={today} onSelect={(t) => openDetail(t.id)} />}
        {result?.hasMore && <button className="btn btn-quiet btn-block" onClick={() => load(result.items.length)} disabled={loading}>{loading ? 'Loading…' : 'Load more'}</button>}
      </section>

      <Modal open={Boolean(detail)} onClose={() => setDetail(null)} title="Transaction details">
        {detail?.loading && <Skeleton />}
        {detail?.error && <ErrorState error={detail.error} />}
        {detail?.data && (
          <>
            <Block block={{ type: 'transaction_detail', ...detail.data }} ctx={{ today, onSend: ask }} />
            <p className="muted small">{detail.data.statusExplanation}</p>
            <div className="modal-actions">
              <button className="btn btn-quiet" onClick={() => ask(`Explain transaction ${detail.data.transaction.id}`)}>Ask the assistant</button>
              <button className="btn btn-quiet" onClick={() => ask(`I have a problem with transaction ${detail.data.transaction.id} (${detail.data.transaction.merchant}, ${detail.data.transaction.amount.formatted}). What can I do?`)}>Report a problem</button>
            </div>
          </>
        )}
      </Modal>
    </div>
  );
}
