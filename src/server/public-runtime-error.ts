const decisionFailures = new Map<string, string>([
  ['decision_state_changed', 'Bot paused: the decision state changed before submission.'],
  [
    'pending_decision_state_changed',
    'Bot paused: the decision state changed before a pending action could be resent.',
  ],
  ['decision_deadline_elapsed', 'Bot paused: the action deadline elapsed before submission.'],
  ['candidate_no_longer_legal', 'Bot paused: the selected action was no longer legal.'],
]);

/** Only fixed messages leave the server; provider errors may contain credentials or payloads. */
export function publicRuntimeError(error: string | null): string | null {
  if (!error) return null;
  const prefix = 'Model decision failed; bot paused: ';
  const code = error.startsWith(prefix) ? error.slice(prefix.length) : error;
  return (
    decisionFailures.get(code) ?? 'Runtime error. Diagnostic details are available to the operator.'
  );
}
