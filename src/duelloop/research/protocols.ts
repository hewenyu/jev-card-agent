import { readFileSync } from 'node:fs';
import type { DuelLoopStore, EvaluationProtocol } from 'duelloop';
import { validatePokerProtocols } from '../../evaluation/poker/protocol.js';
import type { DuelLoopResearchConfig } from './config.js';

/** An authenticated protocol update survives restarts independently of config files. */
export function loadResearchProtocols(
  store: DuelLoopStore,
  scopeId: string,
  config: DuelLoopResearchConfig,
) {
  const pointer = store.latestEvent(scopeId, 'research.application_protocols', {
    allowPrivate: true,
  })?.data as { artifact?: string } | undefined;
  const restored = pointer?.artifact
    ? store.getArtifact<{ protocol: EvaluationProtocol; developmentProtocol: EvaluationProtocol }>(
        pointer.artifact,
        { allowPrivate: true },
      )
    : null;
  const read = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as EvaluationProtocol;
  const protocol = restored?.protocol ?? read(config.finalProtocolPath);
  const developmentProtocol = restored?.developmentProtocol ?? read(config.developmentProtocolPath);
  validatePokerProtocols(developmentProtocol, protocol);
  return { protocol, developmentProtocol };
}
