// Cards are integers 0..51. rank = c % 13 (0 = deuce ... 12 = ace), suit = floor(c / 13).
const crypto = require('crypto');

const RANKS = '23456789TJQKA';
const SUITS = 'shdc'; // spades, hearts, diamonds, clubs

function cardRank(c) { return c % 13; }
function cardSuit(c) { return Math.floor(c / 13); }
function cardName(c) { return RANKS[cardRank(c)] + SUITS[cardSuit(c)]; }

// Fisher-Yates shuffle driven by the OS cryptographic RNG.
// crypto.randomInt is rejection-sampled (no modulo bias), so all 52! orders are equally likely —
// the same distribution as a perfectly shuffled physical deck.
function shuffledDeck() {
  const deck = Array.from({ length: 52 }, (_, i) => i);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

module.exports = { RANKS, SUITS, cardRank, cardSuit, cardName, shuffledDeck };
