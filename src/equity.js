// Win chances for all-in hands. Exact when 1–2 cards are still to come, otherwise a large random sample.
// Uses a fast 7-card evaluator whose scores match evaluator.js bestHand() exactly.

function straightHigh(mask) {
  for (let h = 12; h >= 4; h--) {
    const need = 0x1f << (h - 4);
    if ((mask & need) === need) return h;
  }
  return (mask & 0x100f) === 0x100f ? 3 : -1; // A-2-3-4-5
}
function enc(cat, k) {
  let s = cat;
  for (let i = 0; i < 5; i++) s = s * 13 + (k[i] === undefined ? 0 : k[i]);
  return s;
}
function topRanks(rc, n, skip) {
  const out = [];
  for (let r = 12; r >= 0 && out.length < n; r--) if (rc[r] && !skip.includes(r)) out.push(r);
  return out;
}

function eval7(cards) {
  const rc = new Array(13).fill(0), sm = [0, 0, 0, 0], sc = [0, 0, 0, 0];
  let mask = 0;
  for (const c of cards) {
    const r = c % 13, s = (c / 13) | 0;
    rc[r]++; sm[s] |= 1 << r; sc[s]++; mask |= 1 << r;
  }
  let flushSuit = -1;
  for (let s = 0; s < 4; s++) if (sc[s] >= 5) {
    flushSuit = s;
    const h = straightHigh(sm[s]);
    if (h >= 0) return enc(8, [h]);
  }
  const trips = [], pairs = [];
  for (let r = 12; r >= 0; r--) {
    if (rc[r] === 4) return enc(7, [r, ...topRanks(rc, 1, [r])]);
    if (rc[r] === 3) trips.push(r);
    else if (rc[r] === 2) pairs.push(r);
  }
  if (trips.length && (trips.length > 1 || pairs.length)) {
    return enc(6, [trips[0], Math.max(trips[1] ?? -1, pairs[0] ?? -1)]);
  }
  if (flushSuit >= 0) {
    const fr = [];
    for (let r = 12; r >= 0 && fr.length < 5; r--) if (sm[flushSuit] & (1 << r)) fr.push(r);
    return enc(5, fr);
  }
  const sh = straightHigh(mask);
  if (sh >= 0) return enc(4, [sh]);
  if (trips.length) return enc(3, [trips[0], ...topRanks(rc, 2, [trips[0]])]);
  if (pairs.length >= 2) return enc(2, [pairs[0], pairs[1], ...topRanks(rc, 1, [pairs[0], pairs[1]])]);
  if (pairs.length === 1) return enc(1, [pairs[0], ...topRanks(rc, 3, [pairs[0]])]);
  return enc(0, topRanks(rc, 5, []));
}

// holes: { seat: [c1, c2] }, board: 0–5 cards, dead: other cards known to be out of the deck.
// Returns { seat: percent } where a tie counts as a share of the win.
function equity(holes, board, dead = [], samples = 6000) {
  const seats = Object.keys(holes);
  const used = new Set([...board, ...dead, ...seats.flatMap(s => holes[s])]);
  const deck = [];
  for (let c = 0; c < 52; c++) if (!used.has(c)) deck.push(c);
  const need = 5 - board.length;
  const wins = Object.fromEntries(seats.map(s => [s, 0]));
  let total = 0;
  const score = full => {
    let best = -1, winners = [];
    for (const s of seats) {
      const v = eval7([...holes[s], ...full]);
      if (v > best) { best = v; winners = [s]; } else if (v === best) winners.push(s);
    }
    for (const w of winners) wins[w] += 1 / winners.length;
    total++;
  };
  if (need === 0) score(board);
  else if (need === 1) for (const a of deck) score([...board, a]);
  else if (need === 2) {
    for (let i = 0; i < deck.length; i++) for (let j = i + 1; j < deck.length; j++) score([...board, deck[i], deck[j]]);
  } else {
    const d = deck.slice();
    for (let n = 0; n < samples; n++) {
      // partial Fisher-Yates: draw `need` random cards
      for (let k = 0; k < need; k++) {
        const j = k + Math.floor(Math.random() * (d.length - k));
        const t = d[k]; d[k] = d[j]; d[j] = t;
      }
      score([...board, ...d.slice(0, need)]);
    }
  }
  return Object.fromEntries(seats.map(s => [s, Math.round((wins[s] / total) * 1000) / 10]));
}

module.exports = { eval7, equity };
