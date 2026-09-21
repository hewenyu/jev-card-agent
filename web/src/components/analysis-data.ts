export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function asRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(asRecord).filter((item) => Object.keys(item).length) : [];
}
export function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}
export function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
export function cards(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

export function retryLabel(
  retryIndex: number | undefined,
  maxRetries: number | undefined,
): string | null {
  if (retryIndex === undefined || !Number.isSafeInteger(retryIndex) || retryIndex < 0) return null;
  if (retryIndex === 0) return 'Initial attempt';
  const knownLimit =
    maxRetries !== undefined && Number.isSafeInteger(maxRetries) && maxRetries >= retryIndex;
  return `Retry ${retryIndex}${knownLimit ? ` of ${maxRetries}` : ''}`;
}
