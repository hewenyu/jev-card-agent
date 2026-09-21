const tokenKey = 'jev.console.token';

export function getToken(): string {
  return sessionStorage.getItem(tokenKey) ?? '';
}

export function saveToken(value: string): void {
  if (value.trim()) sessionStorage.setItem(tokenKey, value.trim());
  else sessionStorage.removeItem(tokenKey);
}

export async function api<T>(path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401)
      throw new Error('Access requires a console token. Open Access settings to connect.');
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
