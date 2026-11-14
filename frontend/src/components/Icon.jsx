/** Inline SVG icon set (stroke icons, currentColor). */

const PATHS = {
  home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z',
  chat: 'M4 5h16v11H8l-4 4z',
  list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
  card: 'M3 6h18v12H3zM3 10h18M7 15h4',
  send: 'M4 12 20 4l-6 16-3-7z',
  pay: 'M12 3v18M17 7.5c0-1.9-2.2-3-5-3s-5 1.1-5 3 2 2.6 5 3.2 5 1.4 5 3.3-2.2 3-5 3-5-1.1-5-3',
  help: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17.5h.01',
  logout: 'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10',
  copy: 'M8 8h12v12H8zM4 16V4h12',
  check: 'M5 12.5 10 17l9-10',
  x: 'M6 6l12 12M18 6 6 18',
  alert: 'M12 4 2.5 20h19zM12 10v4M12 17h.01',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v6M12 7.5h.01',
  arrowUp: 'M12 19V5M6 11l6-6 6 6',
  chevron: 'M9 6l6 6-6 6',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4',
  plus: 'M12 5v14M5 12h14',
  shield: 'M12 3 4 6v6c0 4.5 3.4 8 8 9 4.6-1 8-4.5 8-9V6z',
  stop: 'M7 7h10v10H7z',
  menu: 'M4 7h16M4 12h16M4 17h16',
  trash: 'M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13',
  lock: 'M6 11h12v9H6zM9 11V8a3 3 0 0 1 6 0v3',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  spark: 'M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6',
  star: 'M12 2.5l2.2 6.8h7.1l-5.8 4.2 2.2 6.8L12 16.1l-5.8 4.2 2.2-6.8-5.8-4.2h7.1z'
};

export function Icon({ name, size = 18, className = '', label }) {
  return (
    <svg className={`icon ${className}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden={label ? undefined : true} role={label ? 'img' : undefined} aria-label={label}>
      <path d={PATHS[name]} />
    </svg>
  );
}

/** Northstar mark: a four-point star. */
export function Mark({ size = 30 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className="mark">
      <rect width="32" height="32" rx="9" fill="var(--brand)" />
      <path d="M16 5l2.4 8.6L27 16l-8.6 2.4L16 27l-2.4-8.6L5 16l8.6-2.4z" fill="var(--brass-on-brand)" />
    </svg>
  );
}
