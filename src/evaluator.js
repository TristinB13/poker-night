// Texas Hold'em hand evaluator: best 5-card hand out of 5-7 cards.
const { cardRank, cardSuit, RANKS } = require('./cards');

const CATEGORY = ['High card', 'Pair', 'Two pair', 'Three of a kind', 'Straight',
  'Flush', 'Full house', 'Four of a kind', 'Straight flush'];
const RANK_WORD = ['Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Jack', 'Queen', 'King', 'Ace'];
const PLURAL = ['Twos', 'Threes', 'Fours', 'Fives', 'Sixes', 'Sevens', 'Eights', 'Nines', 'Tens',
  'Jacks', 'Queens', 'Kings', 'Aces'];

// Score a 5-card hand. Higher score = better hand. Ties are exact chops.
function eval5(cards) {
  const ranks = cards.map(cardRank).sort((a, b) => b - a);
  const flush = cards.every(c => cardSuit(c) === cardSuit(cards[0]));

  const uniq = [...new Set(ranks)];
  let straightHigh = -1;
  if (uniq.length === 5) {
    if (uniq[0] - uniq[4] === 4) straightHigh = uniq[0];
    else if (uniq[0] === 12 && uniq[1] === 3) straightHigh = 3; // A-2-3-4-5 wheel
  }

  // Group by count, then by rank: e.g. full house -> [trips rank, pair rank]
  const counts = {};
  for (const r of ranks) counts[r] = (counts[r] || 0) + 1;
  const groups = Object.entries(counts)
    .map(([r, n]) => [Number(r), n])
    .sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const shape = groups.map(g => g[1]).join('');
  const ordered = groups.map(g => g[0]);

  let cat, kick;
  if (straightHigh >= 0 && flush) { cat = 8; kick = [straightHigh]; }
  else if (shape === '41') { cat = 7; kick = ordered; }
  else if (shape === '32') { cat = 6; kick = ordered; }
  else if (flush) { cat = 5; kick = ranks; }
  else if (straightHigh >= 0) { cat = 4; kick = [straightHigh]; }
  else if (shape === '311') { cat = 3; kick = ordered; }
  else if (shape === '221') { cat = 2; kick = ordered; }
  else if (shape === '2111') { cat = 1; kick = ordered; }
  else { cat = 0; kick = ranks; }

  let score = cat;
  for (let i = 0; i < 5; i++) score = score * 13 + (kick[i] ?? 0);
  return { score, cat, kick };
}

function describe(cat, kick) {
  switch (cat) {
    case 8: return kick[0] === 12 ? 'Royal flush' : `Straight flush, ${RANK_WORD[kick[0]]} high`;
    case 7: return `Four of a kind, ${PLURAL[kick[0]]}`;
    case 6: return `Full house, ${PLURAL[kick[0]]} full of ${PLURAL[kick[1]]}`;
    case 5: return `Flush, ${RANK_WORD[kick[0]]} high`;
    case 4: return `Straight, ${RANK_WORD[kick[0]]} high`;
    case 3: return `Three of a kind, ${PLURAL[kick[0]]}`;
    case 2: return `Two pair, ${PLURAL[kick[0]]} and ${PLURAL[kick[1]]}`;
    case 1: return `Pair of ${PLURAL[kick[0]]}`;
    default: return `${RANK_WORD[kick[0]]} high`;
  }
}

// Best hand from 5-7 cards (checks every 5-card combination: 21 for 7 cards).
function bestHand(cards) {
  let best = null;
  const n = cards.length;
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) for (let c = b + 1; c < n; c++)
    for (let d = c + 1; d < n; d++) for (let e = d + 1; e < n; e++) {
      const five = [cards[a], cards[b], cards[c], cards[d], cards[e]];
      const r = eval5(five);
      if (!best || r.score > best.score) best = { ...r, cards: five };
    }
  best.name = describe(best.cat, best.kick);
  best.category = CATEGORY[best.cat];
  return best;
}

module.exports = { eval5, bestHand, CATEGORY, RANKS };
