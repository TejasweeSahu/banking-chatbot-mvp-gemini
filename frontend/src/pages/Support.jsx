import { api } from '../api.js';
import { Block } from '../components/Blocks.jsx';
import { Icon } from '../components/Icon.jsx';
import { EmptyState, ErrorState, Skeleton, useAsync } from '../components/ui.jsx';

const TOPICS = [
  ['A UPI payment failed but money was deducted', 'My UPI payment failed but money was deducted. What should I do?'],
  ['A payment is stuck as pending', 'Why is my payment pending?'],
  ['I was charged twice', 'I think I was charged twice. Can you check for duplicate charges?'],
  ['My refund has not arrived', 'My refund has not arrived yet. How long do refunds take?'],
  ['I want to dispute a card payment', 'How do I dispute a card transaction?'],
  ['My card is lost or stolen', 'My card is lost. Please block it.']
];

export function Support({ ask }) {
  const complaints = useAsync(() => api('/complaints'), []);
  return (
    <div className="page">
      <header className="page-head"><h1>Help and complaints</h1><p className="muted">Get answers, raise a complaint or track one you've already raised.</p></header>
      <div className="dash-grid">
        <section className="panel">
          <header className="panel-head"><h2>What's the problem?</h2></header>
          <ul className="topic-list">
            {TOPICS.map(([label, prompt]) => (
              <li key={label}><button className="topic" onClick={() => ask(prompt)}><span>{label}</span><Icon name="chevron" size={16} /></button></li>
            ))}
          </ul>
          <div className="callout">
            <p><strong>Need a person?</strong> Call the 24×7 helpline at 1800-000-0000 (simulated) or ask the assistant to escalate a complaint to a senior grievance officer.</p>
          </div>
        </section>
        <section className="panel">
          <header className="panel-head"><h2>Your complaints</h2></header>
          {complaints.error && <ErrorState error={complaints.error} onRetry={complaints.reload} />}
          {complaints.loading && !complaints.data && <Skeleton />}
          {complaints.data && (complaints.data.items.length
            ? complaints.data.items.map((c) => (
              <div key={c.id} className="complaint-wrap">
                <Block block={{ type: 'complaint', complaint: c }} ctx={{ onSend: ask }} />
                {!['resolved', 'closed', 'escalated'].includes(c.status) && <button className="link-btn" onClick={() => ask(`Escalate complaint ${c.reference}`)}>Escalate this complaint</button>}
              </div>
            ))
            : <EmptyState title="No complaints" >Anything you raise will appear here with its progress.</EmptyState>)}
        </section>
      </div>
    </div>
  );
}
