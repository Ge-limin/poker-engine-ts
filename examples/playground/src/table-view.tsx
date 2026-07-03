// Presentational pieces shared by the tabs. Everything rendered here is read
// straight off a TableSnapshot or the event envelopes; the format subpath of
// the package does the wording for the timeline.
import { buildTimelineEntries } from 'poker-engine-ts/format';
import type { TableSnapshot, TurnEventEnvelope } from 'poker-engine-ts';
import { boardCards, foldedPlayers } from './engine-helpers';

const SUIT_GLYPH: Record<string, string> = { c: '♣', d: '♦', h: '♥', s: '♠' };

export function Card({ card }: { card: string }) {
  const rank = card.slice(0, -1);
  const suit = card.slice(-1);
  const red = suit === 'd' || suit === 'h';
  return (
    <span className={`card ${red ? 'card-red' : 'card-black'}`}>
      <span className="card-rank">{rank === 'T' ? '10' : rank}</span>
      <span className="card-suit">{SUIT_GLYPH[suit] ?? suit}</span>
    </span>
  );
}

export function CardRow({ cards, hidden }: { cards: readonly string[]; hidden?: boolean }) {
  if (hidden) {
    return (
      <span className="card-row">
        <span className="card card-back" />
        <span className="card card-back" />
      </span>
    );
  }
  return (
    <span className="card-row">
      {cards.map((card, index) => (
        <Card key={`${card}-${index}`} card={card} />
      ))}
    </span>
  );
}

export function Board({ snapshot }: { snapshot: TableSnapshot }) {
  const cards = boardCards(snapshot);
  return (
    <div className="board-area">
      <div className="board-label">Board</div>
      <div className="board">
        {cards.length === 0 ? (
          <span className="muted">preflop, nothing dealt yet</span>
        ) : (
          cards.map((card, index) => <Card key={`${card}-${index}`} card={card} />)
        )}
      </div>
      <div className="stage-pill">stage: {snapshot.hand.stage}</div>
    </div>
  );
}

export interface SeatsViewProps {
  readonly snapshot: TableSnapshot;
  readonly names: Record<string, string>;
  readonly heroId?: string;
  readonly revealAll?: boolean;
}

export function SeatsView({ snapshot, names, heroId, revealAll }: SeatsViewProps) {
  const settled = snapshot.hand.stage === 'settled';
  const folded = foldedPlayers(snapshot);
  const actor = snapshot.clock.currentActor;
  const buckets = [snapshot.pots.main, ...snapshot.pots.sides];
  const wonBy = new Map<string, number>();
  for (const entry of snapshot.hand.payouts?.entries ?? []) {
    wonBy.set(entry.playerId, (wonBy.get(entry.playerId) ?? 0) + entry.amount);
  }
  const ranks = new Map<string, string>();
  for (const hand of snapshot.hand.showdown?.evaluatedHands ?? []) {
    ranks.set(hand.playerId, hand.rankClass);
  }
  return (
    <section className="players">
      {snapshot.seating.seats
        .filter((seat) => seat.occupant)
        .map((seat) => {
          const id = seat.occupant!.playerId;
          const committed = buckets.reduce((sum, bucket) => sum + (bucket.contributions[id] ?? 0), 0);
          const hasFolded = folded.has(id);
          const isAllIn = seat.stack === 0 && !hasFolded && !settled;
          const won = settled ? wonBy.get(id) : undefined;
          const cards = snapshot.cards.holeCards[id] ?? [];
          const faceUp = revealAll || settled || id === heroId;
          return (
            <div
              key={id}
              className={`player ${id === actor ? 'actor' : ''} ${isAllIn ? 'all-in' : ''} ${
                hasFolded || (settled && !won) ? 'loser' : ''
              } ${settled && won ? 'winner' : ''}`}
            >
              <div className="player-top">
                <span className="player-name">{names[id] ?? id}</span>
                {id === actor && <span className="tag tag-actor">to act</span>}
              </div>
              {cards.length > 0 && <CardRow cards={cards} hidden={!faceUp && !hasFolded} />}
              <div className="player-stats">
                <span>
                  stack <strong>{seat.stack}</strong>
                </span>
                <span>
                  in pot <strong>{committed}</strong>
                </span>
                {hasFolded && <span className="tag tag-lose">folded</span>}
                {isAllIn && <span className="tag tag-allin">all in</span>}
                {won ? <span className="tag tag-win">+{won}</span> : null}
              </div>
              {settled && ranks.has(id) && !hasFolded && (
                <div className="hand-class">{ranks.get(id)}</div>
              )}
            </div>
          );
        })}
    </section>
  );
}

export function PotsView({ snapshot, names }: { snapshot: TableSnapshot; names: Record<string, string> }) {
  const buckets = [snapshot.pots.main, ...snapshot.pots.sides].filter((bucket) => bucket.amount > 0);
  const settled = snapshot.hand.stage === 'settled';
  const payouts = snapshot.hand.payouts?.entries ?? [];
  return (
    <section className="pots">
      <h2>Pots</h2>
      {buckets.length === 0 && !settled && <p className="muted small">no chips committed yet</p>}
      {buckets.map((bucket, index) => (
        <div key={bucket.id} className={`pot ${index === 0 ? 'pot-main' : 'pot-side'}`}>
          <div className="pot-head">
            <span className="pot-label">{index === 0 ? 'Main pot' : `Side pot ${index}`}</span>
            <span className="pot-amount">{bucket.amount}</span>
          </div>
          <div className="pot-eligible">
            eligible: {bucket.eligiblePlayers.map((id) => names[id] ?? id).join(', ')}
          </div>
        </div>
      ))}
      {settled && payouts.length > 0 && (
        <div className="payouts">
          <h3>Payouts, as the engine reports them</h3>
          {payouts.map((entry) => (
            <div key={entry.playerId} className="payout-row">
              <span className="ev-actor">{names[entry.playerId] ?? entry.playerId}</span>
              <span className="tag tag-win">+{entry.amount}</span>
              <span className="muted small">{entry.potIds.join(', ')}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export interface TimelineViewProps {
  readonly events: readonly TurnEventEnvelope[];
  readonly names: Record<string, string>;
  readonly highlightUpTo?: number;
  readonly onPick?: (index: number) => void;
}

// The log records burn cards next to the dealt ones (they matter for replay
// fidelity), but reading "flop: 3h" for a burn is confusing on screen. Hide
// burns from the rendered line only; the envelopes themselves are untouched.
function withoutBurnReveals(envelope: TurnEventEnvelope): TurnEventEnvelope {
  const reveals = envelope.event.metadata?.cardReveals;
  if (!reveals?.community?.some((entry) => entry.reason === 'burn')) return envelope;
  const community = reveals.community.filter((entry) => entry.reason !== 'burn');
  return {
    ...envelope,
    event: {
      ...envelope.event,
      metadata: {
        ...envelope.event.metadata!,
        cardReveals: { ...reveals, community },
      },
    },
  };
}

export function TimelineView({ events, names, highlightUpTo, onPick }: TimelineViewProps) {
  const nameMap = new Map(Object.entries(names));
  const entries = buildTimelineEntries(events.map(withoutBurnReveals), nameMap);
  return (
    <ol className="events timeline">
      {entries.length === 0 && <li className="muted">no actions yet</li>}
      {entries.map((entry, index) => {
        const applied = highlightUpTo === undefined || index < highlightUpTo;
        return (
          <li
            key={entry.id}
            className={`${applied ? '' : 'timeline-future'} ${onPick ? 'timeline-clickable' : ''}`}
            onClick={onPick ? () => onPick(index + 1) : undefined}
          >
            <span className="ev-label">{entry.label}</span> {entry.details}
          </li>
        );
      })}
    </ol>
  );
}
