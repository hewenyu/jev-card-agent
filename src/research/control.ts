import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type ResearchMode = 'off' | 'shadow' | 'live';
export interface ResearchControl {
  mode: ResearchMode;
  actor: string;
  note: string;
  changedAt: string;
  liveConfirmed: boolean;
}

/** Configuration is an upper bound. A previous live approval cannot activate an off upgrade. */
export function effectiveResearchMode(
  configured: ResearchMode,
  control?: ResearchControl | null,
): ResearchMode {
  if (configured === 'off' || control?.mode === 'off') return 'off';
  if (configured === 'shadow') return 'shadow';
  return control?.mode === 'live' && control.liveConfirmed ? 'live' : 'shadow';
}

/** Private CLI-only controls. Research recovery never edits the runtime decision block. */
export class AsyncControlStore {
  private readonly db: DatabaseSync;
  constructor(filename: string) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    if (filename !== ':memory:') chmodSync(filename, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1000;
      CREATE TABLE IF NOT EXISTS research_controls (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL
      );`);
  }
  get(): ResearchControl | null {
    const row = this.db
      .prepare('SELECT payload FROM research_controls ORDER BY seq DESC LIMIT 1')
      .get();
    if (!row) return null;
    const value = JSON.parse(String(row.payload)) as ResearchControl;
    if (!['off', 'shadow', 'live'].includes(value.mode) || typeof value.liveConfirmed !== 'boolean')
      throw new Error('Invalid persisted research control');
    return value;
  }
  setMode(
    mode: ResearchMode,
    input: { actor: string; note: string; confirmLive?: boolean },
  ): ResearchControl {
    if (!['off', 'shadow', 'live'].includes(mode)) throw new Error('Invalid research mode');
    if (
      !input.actor.trim() ||
      input.actor.length > 100 ||
      !input.note.trim() ||
      input.note.length > 1000
    )
      throw new Error('Research control requires a bounded operator identity and note');
    if (mode === 'live' && !input.confirmLive)
      throw new Error('Live advice requires explicit confirmation');
    const value: ResearchControl = {
      mode,
      actor: input.actor,
      note: input.note,
      changedAt: new Date().toISOString(),
      liveConfirmed: mode === 'live' && input.confirmLive === true,
    };
    this.db.prepare('INSERT INTO research_controls(payload) VALUES(?)').run(JSON.stringify(value));
    return value;
  }
  close(): void {
    this.db.close();
  }
}
