/** Small shared UI primitives. */

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Icon } from './Icon.jsx';

export function useAsync(fn, deps = []) {
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const run = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await fn();
      setState({ loading: false, error: null, data });
    } catch (error) {
      setState({ loading: false, error, data: null });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { run(); }, [run]);
  return { ...state, reload: run };
}

export function Skeleton({ lines = 3, height = 14 }) {
  return (
    <div className="skeleton" role="status" aria-busy="true" aria-label="Loading">
      {Array.from({ length: lines }, (_, i) => <span key={i} style={{ height, width: `${92 - i * 14}%` }} />)}
    </div>
  );
}

export function ErrorState({ error, onRetry }) {
  return (
    <div className="state state-error" role="alert">
      <Icon name="alert" />
      <div>
        <p>{error?.message ?? 'Something went wrong.'}</p>
        {onRetry && <button className="btn btn-quiet btn-sm" onClick={onRetry}><Icon name="refresh" size={15} />Try again</button>}
      </div>
    </div>
  );
}

export function EmptyState({ title, children, action }) {
  return (
    <div className="state state-empty">
      <p className="state-title">{title}</p>
      {children && <p className="state-body">{children}</p>}
      {action}
    </div>
  );
}

const STATUS_TONE = { success: 'good', completed: 'good', active: 'good', resolved: 'good', on_track: 'good', pending: 'warning', in_progress: 'warning', open: 'warning', near_limit: 'warning', at_risk: 'warning', temporarily_blocked: 'warning', failed: 'critical', exceeded: 'critical', blocked: 'critical', escalated: 'serious', expired: 'neutral', cancelled: 'neutral', closed: 'neutral' };
const STATUS_ICON = { good: 'check', warning: 'clock', critical: 'alert', serious: 'alert', neutral: 'x' };

export function StatusBadge({ status, label }) {
  const tone = STATUS_TONE[status] ?? 'neutral';
  const text = label ?? status.replaceAll('_', ' ');
  return <span className={`badge badge-${tone}`}><Icon name={STATUS_ICON[tone]} size={12} />{text.charAt(0).toUpperCase() + text.slice(1)}</span>;
}

export function SimulatedTag() {
  return <span className="sim-tag" title="Northstar is a demo bank. No real money moves.">Simulated</span>;
}

export function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="icon-btn"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          setCopied(false);
        }
      }}
      aria-label={copied ? 'Copied' : 'Copy response'}
      title={copied ? 'Copied' : 'Copy response'}
    >
      <Icon name={copied ? 'check' : 'copy'} size={15} />
    </button>
  );
}

/** Native <dialog> modal with focus management and Escape to close. */
export function Modal({ open, onClose, title, children }) {
  const ref = useRef(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className="modal" onClose={onClose} onClick={(e) => { if (e.target === ref.current) onClose(); }} aria-labelledby={titleId}>
      {open && (
        <div className="modal-body">
          <div className="modal-head">
            <h2 id={titleId}>{title}</h2>
            <button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
          </div>
          {children}
        </div>
      )}
    </dialog>
  );
}

/** Safe, tiny markdown subset: paragraphs, "- " bullets, **bold**. Never injects HTML. */
export function RichText({ text }) {
  const blocks = [];
  let list = null;
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trimEnd();
    const bullet = /^\s*(?:[-*•]|\d+\.)\s+(.*)$/.exec(line);
    if (bullet) {
      if (!list) { list = []; blocks.push({ type: 'ul', items: list }); }
      list.push(bullet[1]);
    } else {
      list = null;
      if (line.trim()) blocks.push({ type: 'p', text: line });
    }
  }
  const inline = (s) => s.split(/(\*\*[^*]+\*\*)/g).map((part, i) => (part.startsWith('**') && part.endsWith('**') && part.length > 4 ? <strong key={i}>{part.slice(2, -2)}</strong> : part.replace(/^#+\s*/, '')));
  return (
    <div className="rich">
      {blocks.map((b, i) => (b.type === 'ul'
        ? <ul key={i}>{b.items.map((item, j) => <li key={j}>{inline(item)}</li>)}</ul>
        : <p key={i}>{inline(b.text)}</p>))}
    </div>
  );
}
