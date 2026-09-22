import type { DatabaseSync } from 'node:sqlite';

/** Detect writes on this connection and committed writes on other connections, without reading rows. */
export function connectionRevision(db: DatabaseSync): string {
  const local = db.prepare('SELECT total_changes() AS n').get()!.n;
  const external = db.prepare('PRAGMA data_version').get()!.data_version;
  return `${external}:${local}`;
}
