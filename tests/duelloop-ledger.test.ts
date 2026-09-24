import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FixtureDecisionModel } from 'duelloop';
import { appendLedger } from '../src/duelloop/ledger.js';
import { AuditedDecisionModel } from '../src/duelloop/model.js';

vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return {
    ...actual,
    appendFileSync: vi.fn(actual.appendFileSync),
    fsyncSync: vi.fn(actual.fsyncSync),
    closeSync: vi.fn(actual.closeSync),
  };
});
const directories: string[] = [];
beforeEach(async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  vi.mocked(fs.appendFileSync).mockReset().mockImplementation(actual.appendFileSync);
  vi.mocked(fs.fsyncSync).mockReset().mockImplementation(actual.fsyncSync);
  vi.mocked(fs.closeSync).mockReset().mockImplementation(actual.closeSync);
});
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function filename() {
  const directory = mkdtempSync(join(tmpdir(), 'duelloop-ledger-'));
  directories.push(directory);
  return join(directory, 'requests.jsonl');
}
describe('attempt flush boundary', () => {
  it('appends complete ordered JSON records with an OS file flush and directory sync', () => {
    const path = filename();
    appendLedger(path, { requestId: 'one' });
    appendLedger(path, { requestId: 'two' });
    expect(
      readFileSync(path, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    ).toEqual([{ requestId: 'one' }, { requestId: 'two' }]);
    expect(fs.appendFileSync).toHaveBeenCalledWith(path, expect.any(String), {
      mode: 0o600,
      flush: true,
    });
    expect(fs.fsyncSync).toHaveBeenCalledTimes(2);
    expect(fs.closeSync).toHaveBeenCalledTimes(2);
  });
  it.each(['file', 'directory'])(
    'never sends a model request after %s flush fails',
    async (which) => {
      const path = filename();
      if (which === 'file')
        vi.mocked(fs.appendFileSync).mockImplementationOnce(() => {
          throw new Error('flush failed');
        });
      else
        vi.mocked(fs.fsyncSync).mockImplementationOnce(() => {
          throw new Error('flush failed');
        });
      const inner = new FixtureDecisionModel('local', () => ({
        score: 0,
        confidence: 1,
        probabilities: { '0': 1, '1': 0 },
      }));
      const call = vi.spyOn(inner, 'score');
      const model = new AuditedDecisionModel(inner, () => {}, {
        onStart: (start) => appendLedger(path, start),
      });
      await expect(
        model.score({
          state: {},
          questions: [
            {
              id: 'q',
              actionId: 'check',
              dimensionId: 'd',
              instructions: 'Test',
              criteria: ['low', 'high'],
            },
          ],
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({ code: 'STORAGE_FAILURE' });
      expect(call).not.toHaveBeenCalled();
      if (which === 'directory') expect(fs.closeSync).toHaveBeenCalled();
    },
  );
});
