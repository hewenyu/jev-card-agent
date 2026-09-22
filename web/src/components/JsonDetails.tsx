import { useMemo, useState, type ReactNode } from 'react';

export function JsonDetails({
  title,
  value,
  children,
  className = 'context-details',
}: {
  title: string;
  value: unknown;
  children?: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const text = useMemo(() => (open ? JSON.stringify(value, null, 2) : ''), [open, value]);
  return (
    <details className={className} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{title}</summary>
      {children}
      {open && <pre>{text}</pre>}
    </details>
  );
}
