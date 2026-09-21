import type { ReactNode } from 'react';

export function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, ReactNode> = {
    overview: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1.5" />
        <rect x="14" y="3" width="7" height="11" rx="1.5" />
        <rect x="3" y="14" width="7" height="7" rx="1.5" />
        <rect x="14" y="18" width="7" height="3" rx="1" />
      </>
    ),
    live: (
      <>
        <path d="M8 5a9 9 0 0 0 0 14M16 5a9 9 0 0 1 0 14M10 8a5 5 0 0 0 0 8M14 8a5 5 0 0 1 0 8" />
        <circle cx="12" cy="12" r="1" />
      </>
    ),
    replay: (
      <>
        <path d="M4 8V3M4 8h5M4 8a9 9 0 1 1-1 8" />
        <path d="m10 8 6 4-6 4Z" />
      </>
    ),
    experiments: (
      <>
        <path d="M9 3h6M10 3v6l-6 10a1 1 0 0 0 1 2h14a1 1 0 0 0 1-2L14 9V3M7 15h10" />
      </>
    ),
    arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
    external: (
      <>
        <path d="M14 3h7v7m0-7L10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5" />
      </>
    ),
    lock: (
      <>
        <rect x="5" y="10" width="14" height="11" rx="2" />
        <path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" />
      </>
    ),
    chevron: <path d="m9 5 7 7-7 7" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    refresh: (
      <>
        <path d="M20 8V3m0 5h-5M4 16v5m0-5h5M20 8A9 9 0 0 0 4 6M4 16a9 9 0 0 0 16 2" />
      </>
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] ?? paths.overview}
    </svg>
  );
}

export function SourceBadge({ mode, active = false }: { mode: string; active?: boolean }) {
  const label =
    mode === 'demo'
      ? 'Demo'
      : mode === 'live' && active
        ? 'Live Arena'
        : mode === 'evaluation'
          ? 'Evaluation'
          : 'Recorded';
  return (
    <span className={`badge source-${mode}`}>
      <span className={active ? 'dot pulse' : 'dot'} />
      {label}
    </span>
  );
}

export function Status({ children }: { children: ReactNode }) {
  return <span className="status-pill">{children}</span>;
}

export function Panel({
  title,
  eyebrow,
  action,
  children,
  className = '',
}: {
  title?: string;
  eyebrow?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      {(title || action) && (
        <header className="panel-header">
          <div>
            {eyebrow && <p className="eyebrow">{eyebrow}</p>}
            {title && <h2>{title}</h2>}
          </div>
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <span className="empty-mark">♠</span>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
    </div>
  );
}

export function ErrorNotice({ error }: { error: string | null }) {
  return error ? (
    <div role="alert" className="error-notice">
      {error}
    </div>
  ) : null;
}

export function Cards({
  cards,
  size = 'normal',
  placeholders = 0,
}: {
  cards: string[];
  size?: 'small' | 'normal';
  placeholders?: number;
}) {
  const suits: Record<string, string> = { s: '♠', h: '♥', d: '♦', c: '♣' };
  return (
    <div
      className={`cards cards-${size}`}
      aria-label={cards.length ? cards.join(', ') : 'No cards revealed'}
    >
      {cards.map((card, index) => {
        const suit = card.slice(-1).toLowerCase();
        return (
          <span
            className={`playing-card ${suit === 'h' || suit === 'd' ? 'red' : ''}`}
            key={`${card}-${index}`}
          >
            <span>{card.slice(0, -1)}</span>
            <span>{suits[suit] ?? suit}</span>
          </span>
        );
      })}
      {Array.from({ length: Math.max(0, placeholders - cards.length) }, (_, i) => (
        <span className="playing-card card-back" key={`back-${i}`}>
          ·
        </span>
      ))}
    </div>
  );
}
