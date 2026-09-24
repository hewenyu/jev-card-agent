import { appendFileSync, closeSync, fsyncSync, openSync } from 'node:fs';
import { dirname } from 'node:path';

/** Request the OS to flush the record and its directory entry before returning. */
export function appendLedger(path: string, value: unknown): void {
  appendFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600, flush: true });
  const directory = openSync(dirname(path), 'r');
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}
