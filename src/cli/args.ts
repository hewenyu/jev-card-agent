import { parseArgs } from 'node:util';
export function argumentsFor(
  extra: Record<string, { type: 'boolean' | 'string'; default?: string | boolean }> = {},
) {
  return parseArgs({ options: { ...extra }, strict: true, allowPositionals: false }).values;
}
export function numberArg(
  value: string | boolean | undefined,
  fallback: number,
  name: string,
): number {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(result) || result < 0) throw new Error(`Invalid --${name}`);
  return result;
}
export function fail(error: unknown): void {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
