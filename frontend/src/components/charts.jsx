/**
 * Charts (hand-rolled SVG/HTML, no chart library).
 * Colours: validated two-series palette (blue/orange) for income vs spending;
 * single-hue bars for category magnitude; reserved status colours for budgets
 * (always paired with an icon + text label).
 */

import { useEffect, useRef, useState } from 'react';
import { compactINR } from '../format.js';
import { Icon } from './Icon.jsx';

function useWidth() {
  const ref = useRef(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!ref.current) return undefined;
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

function niceMax(v) {
  if (v <= 0) return 100;
  const mag = 10 ** Math.floor(Math.log10(v));
  const step = [1, 2, 2.5, 5, 10].find((s) => s * mag >= v / 4) * mag;
  return Math.ceil(v / step) * step;
}

/** Rounded-top bar path anchored to the baseline (4px data-end radius). */
function barPath(x, y, w, h, r = 4) {
  if (h <= 0) return '';
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

/** Month-by-month income vs spending, grouped bars with hover tooltip and a table view. */
export function TrendChart({ months, height = 220 }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState(null);
  const [asTable, setAsTable] = useState(false);
  const series = [
    { key: 'income', label: 'Income', cls: 's1' },
    { key: 'spending', label: 'Spending', cls: 's2' }
  ];
  const max = niceMax(Math.max(...months.flatMap((m) => series.map((s) => m[s.key].paise))));
  const pad = { top: 12, right: 8, bottom: 28, left: 48 };
  const innerW = Math.max(0, width - pad.left - pad.right);
  const innerH = height - pad.top - pad.bottom;
  const group = months.length ? innerW / months.length : 0;
  const barW = Math.max(6, Math.min(22, (group - 18) / 2));
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * max);
  const y = (v) => pad.top + innerH - (v / max) * innerH;

  return (
    <figure className="chart">
      <div className="chart-head">
        <div className="legend">
          {series.map((s) => <span key={s.key}><i className={`swatch ${s.cls}`} />{s.label}</span>)}
        </div>
        <button className="link-btn" onClick={() => setAsTable((v) => !v)}>{asTable ? 'Show chart' : 'Show table'}</button>
      </div>
      {asTable ? (
        <table className="data-table">
          <thead><tr><th>Month</th><th>Income</th><th>Spending</th><th>Net</th></tr></thead>
          <tbody>{months.map((m) => <tr key={m.month}><td>{m.label}{m.isCurrent ? ' (to date)' : ''}</td><td>{m.income.formatted}</td><td>{m.spending.formatted}</td><td>{m.net.formatted}</td></tr>)}</tbody>
        </table>
      ) : (
        <div ref={ref} className="chart-canvas" style={{ height }}>
          {width > 0 && (
            <svg width={width} height={height} role="group" aria-label="Monthly income and spending. Focus a month for its figures, or use Show table.">
              {ticks.map((t) => (
                <g key={t} aria-hidden="true">
                  <line className="grid" x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} />
                  <text className="axis" x={pad.left - 8} y={y(t)} dy="0.32em" textAnchor="end">{compactINR(t)}</text>
                </g>
              ))}
              {months.map((m, i) => {
                const cx = pad.left + group * i + group / 2;
                return (
                  <g key={m.month}>
                    {series.map((s, j) => {
                      const v = m[s.key].paise;
                      const x = cx - barW - 1 + j * (barW + 2);
                      return <path key={s.key} aria-hidden="true" className={`bar ${s.cls} ${hover != null && hover !== i ? 'dim' : ''}`} d={barPath(x, y(v), barW, pad.top + innerH - y(v))} />;
                    })}
                    <text aria-hidden="true" className={`axis ${m.isCurrent ? 'axis-strong' : ''}`} x={cx} y={height - 8} textAnchor="middle">{m.label.split(' ')[0]}{m.isCurrent ? '*' : ''}</text>
                    <rect className="hit" role="img" x={pad.left + group * i} y={pad.top} width={group} height={innerH} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} tabIndex={0} aria-label={`${m.label}: income ${m.income.formatted}, spending ${m.spending.formatted}`} />
                  </g>
                );
              })}
            </svg>
          )}
          {hover != null && width > 0 && (
            <div className="tooltip" style={{ left: Math.min(Math.max(pad.left + group * hover + group / 2, 90), width - 90), top: 4 }}>
              <strong>{months[hover].label}{months[hover].isCurrent ? ' (to date)' : ''}</strong>
              <span><i className="swatch s1" />Income <b>{months[hover].income.formatted}</b></span>
              <span><i className="swatch s2" />Spending <b>{months[hover].spending.formatted}</b></span>
              <span className="muted">Net after investments and transfers <b>{months[hover].net.formatted}</b></span>
            </div>
          )}
        </div>
      )}
      {!asTable && months.some((m) => m.isCurrent) && <figcaption>* Current month, to date.</figcaption>}
    </figure>
  );
}

/** Category magnitudes as single-hue horizontal bars with direct labels. */
export function CategoryBars({ items, limit = 6 }) {
  const shown = items.slice(0, limit);
  const rest = items.slice(limit);
  const max = Math.max(1, ...items.map((i) => i.total.paise));
  return (
    <ul className="hbars">
      {shown.map((c) => (
        <li key={c.category.id} title={`${c.count} transaction${c.count === 1 ? '' : 's'}`}>
          <span className="hbar-label">{c.category.label}</span>
          <span className="hbar-track"><span className="hbar-fill" style={{ width: `${(c.total.paise / max) * 100}%` }} /></span>
          <span className="hbar-value">{c.total.formatted}<small>{c.sharePct}%</small></span>
        </li>
      ))}
      {rest.length > 0 && (
        <li className="hbar-other"><span className="hbar-label">{rest.length} more {rest.length === 1 ? 'category' : 'categories'}</span><span /><span className="hbar-value"><small>{rest.reduce((a, r) => a + (r.sharePct ?? 0), 0)}%</small></span></li>
      )}
    </ul>
  );
}

/** Current vs previous per category (two thin bars, legend + direct values). */
export function CompareBars({ rows, currentLabel, previousLabel }) {
  const max = Math.max(1, ...rows.flatMap((r) => [r.current.paise, r.previous.paise]));
  return (
    <div className="compare">
      <div className="legend"><span><i className="swatch s1" />{currentLabel}</span><span><i className="swatch s2" />{previousLabel}</span></div>
      <ul>
        {rows.map((r) => (
          <li key={r.category.id}>
            <div className="compare-top">
              <span>{r.category.label}</span>
              <span className={r.change.paise > 0 ? 'delta-up' : r.change.paise < 0 ? 'delta-down' : 'muted'}>
                {r.change.paise > 0 ? '+' : ''}{r.change.formatted}
              </span>
            </div>
            <span className="cbar s1" style={{ width: `${(r.current.paise / max) * 100}%` }} title={`${currentLabel}: ${r.current.formatted}`} />
            <span className="cbar s2" style={{ width: `${(r.previous.paise / max) * 100}%` }} title={`${previousLabel}: ${r.previous.formatted}`} />
          </li>
        ))}
      </ul>
    </div>
  );
}

const BUDGET_STATUS = {
  on_track: { tone: 'good', icon: 'check', label: 'On track' },
  at_risk: { tone: 'serious', icon: 'clock', label: 'May overspend' },
  near_limit: { tone: 'warning', icon: 'alert', label: 'Near limit' },
  exceeded: { tone: 'critical', icon: 'alert', label: 'Over budget' }
};

export function BudgetMeter({ budget, onEdit }) {
  const s = BUDGET_STATUS[budget.status];
  return (
    <div className="budget">
      <div className="budget-top">
        <span className="budget-name">{budget.category.label}</span>
        <span className="budget-figures">{budget.spent.formatted} <span className="muted">of {budget.limit.formatted}</span></span>
      </div>
      <div className="meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, budget.percentUsed)} aria-label={`${budget.category.label} budget used`}>
        <span className={`meter-fill tone-${s.tone}`} style={{ width: `${Math.min(100, budget.percentUsed)}%` }} />
      </div>
      <div className="budget-foot">
        <span className={`status-text tone-${s.tone}`}><Icon name={s.icon} size={13} />{s.label}</span>
        <span className="muted">{budget.overBy ? `Over by ${budget.overBy.formatted}` : `${budget.remaining.formatted} left`}</span>
        {onEdit && <button className="link-btn" onClick={() => onEdit(budget)}>Edit</button>}
      </div>
    </div>
  );
}
