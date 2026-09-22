// Retire credentials saved by older versions of the management console.
try {
  sessionStorage.removeItem('jev.console.token');
} catch {
  // Reading public data also works when browser storage is unavailable.
}

export async function api<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: 'GET',
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
      : AbortSignal.timeout(15_000),
    credentials: 'omit',
    headers: { Accept: 'application/json' },
  });
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401)
      throw new Error('Public data is temporarily unavailable. Please retry the connection.');
    const detail =
      data && typeof data === 'object' && 'error' in data
        ? String(data.error)
        : `Request failed (${response.status})`;
    throw new Error(detail);
  }
  return data as T;
}

export const message = (error: unknown): string =>
  error instanceof Error ? error.message : 'Something went wrong. Please try again.';
export const number = (value: number): string =>
  new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(value);
export const signed = (value: number): string => `${value > 0 ? '+' : ''}${number(value)}`;
export const dollars = (value: number): string =>
  `$${value.toFixed(value > 0 && value < 0.01 ? 5 : 2)}`;
export const time = (value: string): string =>
  new Date(value).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

export const policyLabel = (strategy: string): string =>
  strategy === 'jev-reasoning'
    ? 'Jev + reasoning'
    : strategy === 'jev'
      ? 'Jev Choice'
      : 'Rule baseline';
