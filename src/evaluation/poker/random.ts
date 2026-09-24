import { createHash } from 'node:crypto';

/** Counter-based namespaces prevent one branch/actor consuming another stream. */
export function pokerRandom(...identity: (string | number)[]): () => number {
  let counter = 0;
  return () => {
    const bytes = createHash('sha256')
      .update(JSON.stringify([...identity, counter++]))
      .digest();
    return bytes.readUInt32BE(0) / 0x100000000;
  };
}

export const POKER_DECK = [...'23456789TJQKA'].flatMap((rank) =>
  [...'cdhs'].map((suit) => rank + suit),
);

export function shuffleDeck(seed: number, hand: number): string[] {
  const deck = [...POKER_DECK];
  const random = pokerRandom('poker-evaluation-v1', seed, hand, 'deck');
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [deck[i], deck[j]] = [deck[j]!, deck[i]!];
  }
  return deck;
}
