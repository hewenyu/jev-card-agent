import { z } from 'zod';

/** Provider prose never enters repair instructions; only trusted validator categories do. */
export function repairResearchInput(originalInput: string, error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  let category = 'structured_contract_invalid';
  if (
    message === 'Guidance exceeds live advice character limit' ||
    (error instanceof z.ZodError && error.issues.some((issue) => issue.code === 'too_big'))
  )
    category = 'live_card_too_long';
  else if (/Small-sample guidance|Pooled player-count/.test(message))
    category = 'sample_caveat_missing';
  else if (/scope lacks|street scope lacks/.test(message))
    category = 'scope_not_supported_by_evidence';
  else if (/counterexample hand/.test(message))
    category = 'counterexample_from_another_hand_required';
  else if (/Numeric claims/.test(message)) category = 'unverified_numerical_prose';
  else if (/Unknown research publication recipe/.test(message)) category = 'unsupported_recipe';
  else if (/Unknown evidence|opponent mismatch|evidence or policy mismatch/.test(message))
    category = 'evidence_reference_mismatch';
  else if (/Unconditional|certainty|Prohibited instruction/.test(message))
    category = 'unsupported_or_unconditional_instruction';
  else if (/decision condition/.test(message)) category = 'explicit_decision_condition_required';
  const original = JSON.parse(originalInput) as Record<string, unknown> & {
    batch?: { taskType?: string };
  };
  const opponent = original.batch?.taskType === 'opponent_brief';
  return JSON.stringify({
    ...original,
    validationFeedback: {
      category,
      instruction:
        'The previous answer was rejected, not published. Return ONLY a complete JSON object: no Markdown, code fences or surrounding prose. Use the unchanged frozen evidence and schema. Do not repeat unsupported claims or invent numbers. ' +
        (opponent
          ? 'For guidance, shorten your wording rather than omit verified evidence. Use one street metric and only its street; keep players broad with pooled-player caveat unless fully stratified evidence is available. A counterexample must come from a different hand. No unconditional action.'
          : 'For global leak_review, use the existing global/outcome metric and example identifiers supplied in this batch. Do not invent street metrics or request an opponent-guidance recipe. Propose a testable hypothesis for independent review, or return insufficient_evidence.'),
      ...(opponent
        ? {
            liveCardCharacterBudget: 300,
            suggestedMaximumCharacters: {
              hypothesis: 40,
              suggestedGuidance: 90,
              limitationsCombined: 40,
            },
            accounting:
              'The budget includes hypothesis, guidance, every limitation, and rendered metric names/counts. Normally cite one metric. Keep analysis out of the card.',
          }
        : {}),
    },
  });
}
