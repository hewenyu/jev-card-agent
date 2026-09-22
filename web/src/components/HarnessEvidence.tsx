import { JsonDetails } from './JsonDetails';
import { number } from '../api';
import { asRecord, cards, finite, text } from './analysis-data';
import './harness-evidence.css';

function chips(value: unknown): string {
  const amount = finite(value);
  return amount === null ? 'Unknown' : `${number(amount)} chips`;
}
function percent(value: unknown): string {
  const amount = finite(value);
  return amount === null ? 'Not available' : `${number(amount * 100)}%`;
}
function rankName(rank: number): string {
  return (
    ({ 14: 'A', 13: 'K', 12: 'Q', 11: 'J', 10: 'T' } as Record<number, string>)[rank] ??
    String(rank)
  );
}

export function HarnessEvidence({ context }: { context: Record<string, unknown> }) {
  const harness = asRecord(context.harness);
  if (!Object.keys(harness).length) return null;
  const cardFacts = asRecord(harness.cards);
  const hand = asRecord(cardFacts.madeHand);
  const hole = asRecord(cardFacts.hole);
  const board = asRecord(cardFacts.board);
  const draws = asRecord(cardFacts.draws);
  const bestFive = asRecord(cardFacts.bestFive);
  const betting = asRecord(harness.betting);
  const position = asRecord(harness.position);
  const estimate = asRecord(harness.uniformShowdownReference);
  const hasEstimate = finite(estimate.equity) !== null;
  const hasMemory = context.opponentMemory !== undefined && context.opponentMemory !== null;
  const ranks = Array.isArray(hand.ranks)
    ? hand.ranks
        .filter((rank): rank is number => finite(rank) !== null)
        .map(rankName)
        .join(' · ')
    : '';
  const holeRanks = Array.isArray(hole.ranks)
    ? hole.ranks
        .filter((rank): rank is number => finite(rank) !== null)
        .map(rankName)
        .join(' ')
    : '';
  const handLabel =
    text(hand.name)?.replaceAll('_', ' ') ??
    (holeRanks
      ? `${holeRanks} · ${hole.pair === true ? 'pair' : hole.suited === true ? 'suited' : 'offsuit'}`
      : 'Not recorded');
  const boardLabel =
    finite(board.maximumSameSuit) === null
      ? 'Unknown'
      : `${board.paired === true ? 'Paired' : 'Unpaired'} · ${number(Number(board.maximumSameSuit))} same suit`;
  return (
    <section className="harness-evidence" aria-label="Poker harness evidence">
      <p className="eyebrow">POKER FACTS · {text(harness.version) ?? 'VERSION UNKNOWN'}</p>
      <h5>Calculated poker facts</h5>
      <p className="annotation">
        Local tools calculate these facts from information visible at this turn. They are separate
        from provider analysis; Jev selects the final action. The random-range audit reference below
        is excluded from Jev input.
      </p>
      <dl className="harness-facts">
        <div>
          <dt>Hand at this turn</dt>
          <dd>
            {handLabel}
            {ranks && <small>Rank / kickers: {ranks}</small>}
            {bestFive.playsBoard === true && <small>Best five can play the board.</small>}
          </dd>
        </div>
        <div>
          <dt>Position</dt>
          <dd>{text(position.hero) ?? 'Unknown'}</dd>
        </div>
        <div>
          <dt>Stack available</dt>
          <dd>{chips(betting.heroStackChips)}</dd>
        </div>
        <div>
          <dt>Already bet this street</dt>
          <dd>{chips(betting.heroStreetBetChips)}</dd>
        </div>
        <div>
          <dt>Additional call cost</dt>
          <dd>{chips(betting.callChips)}</dd>
        </div>
        <div>
          <dt>Contestable pot before call</dt>
          <dd>{chips(betting.contestablePotBeforeCallChips)}</dd>
        </div>
        <div>
          <dt>Break-even showdown share for call</dt>
          <dd>
            {finite(betting.callChips) === 0
              ? 'No call cost'
              : percent(betting.requiredEquityToCall)}
          </dd>
        </div>
        <div>
          <dt>Active opponents</dt>
          <dd>
            {finite(betting.activeOpponents) === null
              ? 'Unknown'
              : number(Number(betting.activeOpponents))}
          </dd>
        </div>
      </dl>
      {text(betting.priceQualification) && (
        <p className="annotation">{text(betting.priceQualification)}</p>
      )}
      {(finite(betting.inaccessibleCurrentWagersChips) ?? 0) > 0 && (
        <p className="annotation">
          Current wagers beyond this stack’s coverage:{' '}
          {chips(betting.inaccessibleCurrentWagersChips)}.
        </p>
      )}
      <details className="analysis-evidence-details">
        <summary>Board texture and one-card completions</summary>
        <p>{boardLabel}</p>
        <p>
          Straight completions: {cards(draws.straightCompletionCards).join(', ') || 'None recorded'}
          .
        </p>
        <p>Flush completions: {cards(draws.flushCompletionCards).join(', ') || 'None recorded'}.</p>
        <p className="annotation">
          {text(draws.caveat) ?? 'Completion cards are not guaranteed winning outs.'}
        </p>
      </details>
      {hasEstimate && (
        <div className="harness-reference" aria-label="Uniform random range reference">
          <h5>Audit reference · excluded from Jev input</h5>
          {hasEstimate ? (
            <>
              <p>
                <strong>{percent(estimate.equity)}</strong> estimated pot share against{' '}
                {number(finite(estimate.opponents) ?? 0)} random opponents.
              </p>
              <p className="annotation">
                {number(finite(estimate.samples) ?? 0)} sampled deals
                {finite(estimate.standardError) !== null &&
                  ` · standard error ${percent(estimate.standardError)}`}
                .
              </p>
            </>
          ) : (
            <p className="analysis-empty">No random-range reference was recorded for this turn.</p>
          )}
          <p className="annotation">
            Retained for replay only. Assumes uniformly random legal opponent cards. This is not the
            actual win probability against these opponents or the expected profit of a call.
            {text(estimate.caveat) && ` ${text(estimate.caveat)}`}
          </p>
        </div>
      )}
      <JsonDetails
        className="analysis-evidence-details"
        title="Inspect calculated evidence and opponent guidance"
        value={harness}
      />
      {hasMemory && (
        <JsonDetails
          className="analysis-evidence-details"
          title="Opponent memory available at this turn"
          value={context.opponentMemory}
        >
          <p className="annotation">
            Only observations available before this decision are eligible. Sample sizes and missing
            information remain part of the evidence.
          </p>
        </JsonDetails>
      )}
    </section>
  );
}
