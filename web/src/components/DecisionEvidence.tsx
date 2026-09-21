import { number, signed, time } from '../api';
import { Cards } from './UI';
import { asRecord, asRecords, cards, finite, text } from './analysis-data';

function observedRate(count: unknown, opportunities: unknown): string {
  const numerator = finite(count);
  const denominator = finite(opportunities);
  if (
    numerator === null ||
    denominator === null ||
    denominator <= 0 ||
    numerator < 0 ||
    numerator > denominator
  )
    return 'Not observed';
  return `${number((numerator / denominator) * 100)}% · ${number(numerator)}/${number(denominator)}`;
}
function chips(value: unknown): string {
  const amount = finite(value);
  return amount === null ? 'Not recorded' : `${number(amount)} chips`;
}
function actionText(value: Record<string, unknown>): string {
  const structured = asRecord(value.action);
  if (text(structured.kind)) {
    const amount = finite(structured.raiseToChips);
    return `${String(structured.kind).replaceAll('_', ' ')}${amount === null ? '' : ` to ${number(amount)}`}`;
  }
  const action = text(value.action)?.replaceAll('_', ' ') ?? 'Action not recorded';
  const amount = finite(value.amount);
  return `${action}${amount === null ? '' : ` ${number(amount)}`}`;
}

export function DecisionEvidence({ context }: { context: Record<string, unknown> }) {
  const opponents = asRecords(context.opponents);
  const outcomes = asRecords(context.recentOutcomes);
  const history = asRecords(context.history);
  const session = asRecord(context.session);
  const previousTurns = asRecords(session.previousTurns);
  return (
    <section className="analysis-evidence" aria-label="Decision input evidence">
      <div className="analysis-section-heading">
        <p className="eyebrow">INFORMATION AVAILABLE AT THIS TURN</p>
        <h4>The evidence behind the choice</h4>
        <p className="annotation">
          {text(context.asOf) ? `Frozen ${time(String(context.asOf))}. ` : ''}
          These are the recorded inputs, including the samples behind each opponent statistic.
        </p>
      </div>
      <div className="analysis-state-grid">
        <div>
          <span>Agent’s cards</span>
          <Cards cards={cards(context.holeCards)} size="small" />
        </div>
        <div>
          <span>Board at decision</span>
          <Cards cards={cards(context.board)} size="small" />
        </div>
        <div>
          <span>Pot</span>
          <strong>{chips(context.pot)}</strong>
        </div>
        <div>
          <span>To call</span>
          <strong>{chips(context.toCall)}</strong>
        </div>
      </div>
      <h5>Opponent observations</h5>
      {!opponents.length ? (
        <p className="analysis-empty">No opponent samples were recorded in this input.</p>
      ) : (
        <div className="analysis-opponents" role="list" aria-label="Opponent statistics">
          {opponents.map((opponent, index) => (
            <article
              className="analysis-opponent"
              role="listitem"
              key={`${text(opponent.name) ?? 'opponent'}-${index}`}
            >
              <div>
                <strong>{text(opponent.name) ?? 'Unnamed opponent'}</strong>
                <span>{number(finite(opponent.hands) ?? 0)} observed preflop hands</span>
              </div>
              <dl>
                <div>
                  <dt>VPIP</dt>
                  <dd>{observedRate(opponent.vpip, opponent.hands)}</dd>
                </div>
                <div>
                  <dt>PFR</dt>
                  <dd>{observedRate(opponent.pfr, opponent.hands)}</dd>
                </div>
                <div>
                  <dt>Fold when facing a bet</dt>
                  <dd>{observedRate(opponent.foldedToBet, opponent.facedBet)}</dd>
                </div>
              </dl>
            </article>
          ))}
        </div>
      )}
      <p className="annotation">
        VPIP counts voluntary preflop participation; PFR counts preflop raises. Denominators are
        observed opportunities, not all dealt hands. Small samples describe observations, not a
        reliable playing style.
      </p>
      <details className="analysis-evidence-details">
        <summary>Current hand action history · {history.length} recorded</summary>
        {!history.length ? (
          <p className="analysis-empty">No earlier actions were recorded.</p>
        ) : (
          <ol className="analysis-history-list">
            {history.slice(-12).map((action, index) => (
              <li key={text(action.actionId) ?? `${index}`}>
                <span>{text(action.street) ?? 'Street unknown'}</span>
                <strong>
                  {text(action.name) ??
                    (finite(action.seat) === null
                      ? 'Unknown player'
                      : `Seat ${Number(action.seat) + 1}`)}
                </strong>
                <span>{actionText(action)}</span>
              </li>
            ))}
          </ol>
        )}
        {history.length > 12 && (
          <p className="annotation">
            Showing the last 12 actions. Full frozen input is available below.
          </p>
        )}
        {context.historyIncomplete === true && (
          <p className="warning-notice">Earlier events are missing from this hand’s record.</p>
        )}
      </details>
      <details className="analysis-evidence-details">
        <summary>Earlier turns in this session · {previousTurns.length} included</summary>
        {!previousTurns.length ? (
          <p className="analysis-empty">No earlier turn analysis is included in this input.</p>
        ) : (
          <ol className="analysis-prior-turns">
            {previousTurns.map((turn, index) => (
              <li key={text(turn.decisionId) ?? String(index)}>
                <strong>
                  {text(turn.street) ?? 'Earlier turn'} · {actionText(turn)} ·{' '}
                  {text(turn.status) ?? 'Status unknown'}
                </strong>
                <p className="analysis-prose">
                  {text(turn.analysis) ??
                    'No provider analysis was recorded for this earlier turn.'}
                </p>
                {turn.analysisTruncated === true && (
                  <small>Earlier analysis was truncated in the recorded input.</small>
                )}
              </li>
            ))}
          </ol>
        )}
        {session.truncated === true && (
          <p className="annotation">Earlier session context was truncated before this decision.</p>
        )}
      </details>
      <details className="analysis-evidence-details">
        <summary>Verified historical outcomes · {outcomes.length} included</summary>
        {!outcomes.length ? (
          <p className="analysis-empty">No verified earlier outcomes were included.</p>
        ) : (
          <ul className="analysis-outcomes">
            {outcomes.map((outcome, index) => (
              <li key={`${text(outcome.handId) ?? 'hand'}-${index}`}>
                <div>
                  <strong>{text(outcome.handId) ?? 'Earlier hand'}</strong>
                  <span>
                    {finite(outcome.profitBb) === null
                      ? 'Result unknown'
                      : `${signed(Number(outcome.profitBb))} bb`}
                  </span>
                </div>
                <p>
                  {asRecords(outcome.decisions)
                    .map(
                      (choice) =>
                        `${text(choice.street) ?? 'unknown street'}: ${actionText(choice)}`,
                    )
                    .join(' → ') || 'No verified decision sequence retained.'}
                </p>
                {outcome.decisionsTruncated === true && <small>Decision sequence truncated.</small>}
              </li>
            ))}
          </ul>
        )}
        <p className="annotation">
          These are past results known at the cutoff, not a score for the current choice.
        </p>
      </details>
    </section>
  );
}
