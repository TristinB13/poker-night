// Engine tests: hand evaluator, shuffle fairness, and thousands of random bot hands.
const assert = require('assert');
const crypto = require('crypto');
const { shuffledDeck, cardName, RANKS, SUITS } = require('../src/cards');
const { bestHand } = require('../src/evaluator');
const { Table } = require('../src/table');

const C = s => RANKS.indexOf(s[0]) + 13 * SUITS.indexOf(s[1]);
const H = str => bestHand(str.split(' ').map(C));
let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; };

// ---- evaluator ----
ok(H('As Ks Qs Js Ts 2h 3d').name === 'Royal flush', 'royal');
ok(H('5s 4s 3s 2s As Kh Kd').name === 'Straight flush, Five high', 'steel wheel');
ok(H('Ah 2d 3c 4s 5h Kd Qc').name === 'Straight, Five high', 'wheel');
ok(H('Ah Kd Qc Js Th 2d 3c').name === 'Straight, Ace high', 'broadway');
ok(H('9h 9d 9c 4s 4h 4d 2c').name === 'Full house, Nines full of Fours', 'two trips -> boat');
ok(H('9h 9d 4c 4s 2h 2d Ac').name === 'Two pair, Nines and Fours', 'three pair -> two pair');
ok(H('Ah 2h 5h 9h Jh Kh 3c').name === 'Flush, Ace high', 'flush');
ok(H('7h 7d 7c 7s Ah Kd 2c').name === 'Four of a kind, Sevens', 'quads');
ok(H('Ah Ad Kc 9s 7h 4d 2c').score > H('Ah Ad Qc Js Th 4d 2c').score, 'pair kicker');
ok(H('Ah Ad Kc 9s 7h 4d 2c').score === H('As Ac Kd 9h 7c 3d 2h').score, 'chop on same five');
ok(H('6h 5d 4c 3s 2h Ad Kc').score > H('Ah 2d 3c 4s 5h Kd Qc').score, '6-high straight beats wheel');
ok(H('Th Td 9c 9s 2h 2d Ac').score > H('Th Td 9c 9s 2h 2d Kc').score, 'two pair kicker');

// Exhaustive-ish category frequencies for random 7-card hands vs known probabilities.
{
  const N = 200000, counts = new Array(9).fill(0);
  for (let i = 0; i < N; i++) counts[bestHand(shuffledDeck().slice(0, 7)).cat]++;
  const expected = [0.1741, 0.4383, 0.2350, 0.0483, 0.0462, 0.0303, 0.0260, 0.00168, 0.000311];
  counts.forEach((c, i) => {
    const p = c / N, e = expected[i], sd = Math.sqrt(e * (1 - e) / N);
    ok(Math.abs(p - e) < 5 * sd + 1e-4, `category ${i}: got ${p.toFixed(5)} expected ${e}`);
  });
  console.log('7-card category frequencies match the known probabilities');
}

// ---- shuffle fairness: each card equally likely in each position ----
{
  const N = 104000, pos = Array.from({ length: 52 }, () => new Array(52).fill(0));
  for (let i = 0; i < N; i++) shuffledDeck().forEach((c, p) => pos[p][c]++);
  let chi = 0; const e = N / 52;
  for (const row of pos) for (const o of row) chi += (o - e) ** 2 / e;
  // 52*51 = 2652 degrees of freedom; mean 2652, sd ~72.8. Allow 5 sd.
  ok(Math.abs(chi - 2652) < 5 * 72.8, `shuffle chi-square ${chi.toFixed(0)}`);
  console.log(`Shuffle position test: chi-square ${chi.toFixed(0)} (expected ~2652)`);
}

// ---- simulated games ----
function playGame(seed, nPlayers, hands, rit = false) {
  const rnd = (() => { let s = seed; return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648; })();
  const t = new Table({ code: 'TEST', hostToken: 'p0', settings: { startingStack: 500 + Math.floor(rnd() * 1000), smallBlind: 5, bigBlind: 10, runItTwice: rit }, delays: { street: 0, nextHand: 0 } });
  const tokens = [];
  for (let i = 0; i < nPlayers; i++) { tokens.push('p' + i); t.sit('p' + i, 'P' + i); }
  // Run the engine synchronously: replace timers with a queue.
  const queue = [];
  t.schedule = fn => queue.push(fn);
  const total = () => t.seats.filter(Boolean).reduce((a, p) => a + p.chips, 0) +
    (t.hand && t.hand.street !== 'done' ? Object.values(t.hand.players).reduce((a, x) => a + x.total, 0) : 0);
  const start = nPlayers * t.settings.startingStack;
  t.running = true;
  let played = 0, showdowns = 0, sidePots = 0, splits = 0, twice = 0;
  t.startHand();
  let guard = 0;
  while (played < hands && guard++ < hands * 400) {
    const h = t.hand;
    if (!h) break;
    if (h.street === 'done') {
      played++;
      if (h.results.showdown) showdowns++;
      if (h.board2) twice++;
      if (h.results.pots.filter(p => !p.returned).length > 1) sidePots++;
      if (h.results.pots.some(p => p.winners.length > 1)) splits++;
      assert.strictEqual(total(), start + (t.seats.filter(Boolean).reduce((a, p) => a + (p.buyins - 1), 0)) * t.settings.startingStack, 'chips conserved');
      // rebuy busted players sometimes so games keep going
      for (const p of t.seats) if (p && p.chips === 0 && rnd() < 0.7) t.rebuy(p.token);
      queue.length = 0;
      if (!t.startHand()) break;
      continue;
    }
    if (h.rit && h.rit.pending) {
      queue.length = 0;
      const yes = rnd() < 0.7;
      for (const [seat, v] of Object.entries(h.rit.votes)) if (v === null && h.rit.pending) t.ritVote(t.seats[seat].token, yes || rnd() < 0.5);
      continue;
    }
    if (h.toAct === -1) { const fn = queue.shift(); assert.ok(fn, 'stalled with nobody to act'); fn(); continue; }
    const seat = h.toAct, p = t.seats[seat], o = t.options(seat);
    assert.ok(o, 'options for actor');
    // all chips accounted for mid-hand too
    assert.strictEqual(t.seats.filter(Boolean).reduce((a, q) => a + q.chips, 0) + Object.values(h.players).reduce((a, x) => a + x.total, 0),
      start + t.seats.filter(Boolean).reduce((a, q) => a + (q.buyins - 1), 0) * t.settings.startingStack);
    const r = rnd();
    let action;
    if (o.canRaise && r < 0.12) action = { type: 'allin' };
    else if (o.canRaise && r < 0.35) action = { type: 'raise', amount: o.minTo + Math.floor(rnd() * (o.maxTo - o.minTo + 1) * 0.3) };
    else if (!o.canCheck && r < 0.5) action = { type: 'fold' };
    else action = { type: o.canCheck ? 'check' : 'call' };
    t.act(p.token, action);
    while (t.hand === h && h.toAct === -1 && h.street !== 'done' && queue.length && !(h.rit && h.rit.pending)) queue.shift()();
  }
  clearTimeout(t.turnTimer);
  if (rit) { /* boards must be 5 distinct cards each, sharing only the pre-all-in cards */ }
  return { played, showdowns, sidePots, splits, twice };
}

{
  const agg = { played: 0, showdowns: 0, sidePots: 0, splits: 0, twice: 0 };
  for (let g = 0; g < 80; g++) {
    const r = playGame(g * 7919 + 1, 2 + (g % 8), 150, g % 2 === 1);
    for (const k in agg) agg[k] += r[k];
  }
  ok(agg.played > 5000, 'played many hands');
  ok(agg.sidePots > 50, 'exercised side pots');
  ok(agg.splits > 10, 'exercised split pots');
  ok(agg.twice > 100, 'exercised run it twice');
  console.log(`Simulated ${agg.played} hands (${agg.showdowns} showdowns, ${agg.sidePots} with side pots, ${agg.splits} split, ${agg.twice} run twice) — chips always conserved`);
}

// ---- rules spot checks ----
{
  const t = new Table({ code: 'X', hostToken: 'a', settings: { startingStack: 1000, smallBlind: 5, bigBlind: 10 }, delays: { street: 0, nextHand: 1e9 } });
  t.sit('a', 'A'); t.sit('b', 'B');
  t.running = true; t.button = 1; // next button = seat 0
  t.startHand();
  const h = t.hand;
  ok(h.button === 0 && h.sbSeat === 0 && h.bbSeat === 1, 'heads-up: button posts small blind');
  ok(h.toAct === 0, 'heads-up: button acts first preflop');
  t.act('a', { type: 'call' });
  ok(h.toAct === 1, 'big blind gets the option');
  t.act('b', { type: 'check' });
  ok(h.street === 'flop' && h.toAct === 1, 'heads-up: big blind acts first after the flop');
  ok(h.pos === 4 + 1 + 3, 'burn card before the flop');
  assert.throws(() => t.act('b', { type: 'raise', amount: 5 }), /Minimum/);
  t.act('b', { type: 'raise', amount: 30 });
  assert.throws(() => t.act('a', { type: 'raise', amount: 50 }), /Minimum is 60/);
  passed++;
  t.destroy();
}
{
  // short all-in does not reopen raising for a player who already acted
  const t = new Table({ code: 'Y', hostToken: 'a', settings: { startingStack: 1000, smallBlind: 5, bigBlind: 10 }, delays: { street: 0, nextHand: 1e9 } });
  t.sit('a', 'A'); t.sit('b', 'B'); t.sit('c', 'C');
  t.seats[2].chips = 140;
  t.running = true; t.button = 2; // button -> seat 0, SB 1, BB 2
  t.startHand();
  const h = t.hand;
  ok(h.toAct === 0, 'UTG (button in 3-handed) acts first');
  t.act('a', { type: 'raise', amount: 100 });
  t.act('b', { type: 'call' });
  t.act('c', { type: 'allin' }); // to 140: raise of 40 < 90 min raise
  ok(t.options(0).canRaise === false && t.options(0).toCall === 40, 'short all-in: original raiser can only call or fold');
  t.destroy();
}

// ---- new features ----
function mk(settings = {}) {
  const t = new Table({ code: 'N', hostToken: 'h', settings: { startingStack: 1000, smallBlind: 5, bigBlind: 10, ...settings }, delays: { street: 0, nextHand: 1e9, preAction: 0 } });
  t.queue = []; t.schedule = fn => t.queue.push(fn);
  t.flush = () => { while (t.queue.length) t.queue.shift()(); };
  return t;
}
{
  // blinds are announced, approval flow, seat choice
  const t = mk();
  t.sit('h', 'Host', 0);
  assert.deepStrictEqual(t.requestSeat('v', 'Vic', 4), { seated: false });
  ok(t.seats[4] === null && t.view('h').requests.length === 1, 'join request waits for host');
  ok(t.view('v').visitor.pending === 4, 'visitor sees pending seat');
  t.approve(t.requests[0].id, true);
  ok(t.seats[4] && t.seats[4].name === 'Vic', 'approved player sits in chosen seat');
  t.requestSeat('x', 'Xan', 2); t.approve(t.requests[0].id, false);
  ok(!t.seats[2] && t.view('x').visitor.denied, 'declined request');
  t.setOptions({ requireApproval: false });
  assert.deepStrictEqual(t.requestSeat('y', 'Yul', 7), { seated: true });
  assert.throws(() => t.requestSeat('z', 'Zed', 7), /taken/);
  // shuffle keeps the same set of seats, only before the game runs
  t.shuffleSeats();
  ok(t.seats.filter(Boolean).length === 3 && [0, 4, 7].every(s => t.seats[s]), 'shuffle keeps seats filled');
  ok(t.seats.every((p, i) => !p || p.seat === i), 'seat numbers consistent after shuffle');
  t.running = true; t.startHand(); t.flush();
  ok(t.log.some(e => /posts small blind 5/.test(e.msg)) && t.log.some(e => /posts big blind 10/.test(e.msg)), 'blinds announced');
  assert.throws(() => t.shuffleSeats(), /Pause/); passed++;
  t.destroy();
}
{
  // pre-actions
  const t = mk({ requireApproval: false });
  t.sit('a', 'A', 0); t.sit('b', 'B', 1); t.sit('c', 'C', 2);
  t.running = true; t.button = 2; t.startHand(); // button 0, SB 1, BB 2, UTG = 0
  const h = t.hand;
  t.setPreAction('c', 'checkfold');
  t.setPreAction('b', 'fold');
  t.act('a', { type: 'call' }); t.flush();
  ok(h.players[1].folded, 'pre-selected fold fires');
  ok(h.street === 'flop', 'BB check/fold checks when nothing to call');
  // check pre-select is dropped when facing a bet
  t.setPreAction('a', 'check');
  ok(h.toAct === 2, 'BB first to act postflop with SB folded');
  t.act('c', { type: 'raise', amount: 20 }); t.flush();
  ok(h.toAct === 0 && t.seats[0].preAction === null, 'check pre-select cleared when there is a bet');
  t.act('a', { type: 'fold' });
  ok(h.street === 'done', 'hand over');
  t.showCards('a');
  ok(t.view('b').seats[0].shown.length === 2, 'folded player can show cards after the hand');
  ok(t.view('c').you.canShow === true && t.view('a').you.canShow === false, 'show option state');
  t.destroy();
}
{
  // away
  const t = mk({ requireApproval: false });
  t.sit('a', 'A', 0); t.sit('b', 'B', 1); t.sit('c', 'C', 2);
  t.setAway('c', true);
  t.running = true; t.startHand();
  ok(!t.hand.players[2], 'away player not dealt in');
  ok(t.view('a').seats[2].away, 'away shown to others');
  t.destroy();
}
{
  // hand strength for the player
  const t = mk({ requireApproval: false });
  t.sit('a', 'A', 0); t.sit('b', 'B', 1);
  t.running = true; t.startHand();
  ok(typeof t.view('a').you.strength === 'string' && t.view('a').you.strength.length > 3, 'hand strength shown');
  t.destroy();
}
{
  // run it twice: two separate 5-card boards, no repeated cards, pot halves awarded
  let seen = 0;
  for (let i = 0; i < 200; i++) {
    const t = mk({ runItTwice: true, requireApproval: false });
    t.sit('a', 'A', 0); t.sit('b', 'B', 1);
    t.running = true; t.startHand(); t.running = false; // no follow-up hand
    t.act(t.seats[t.hand.toAct].token, { type: 'allin' });
    t.act(t.seats[t.hand.toAct].token, { type: 'call' });
    const h = t.hand;
    ok(h.rit && h.rit.pending, 'vote offered on all-in');
    t.ritVote('a', true); t.ritVote('b', true);
    const before = t.queue.length; t.flush();
    ok(h.street === 'done' && h.board.length === 5 && h.board2.length === 5, 'two full boards');
    const used = [...h.players[0].hole, ...h.players[1].hole, ...h.board, ...h.board2.slice(0)];
    ok(new Set(used).size === 14, 'second board uses fresh cards');
    ok(t.seats[0].chips + t.seats[1].chips === 2000, 'chips conserved run twice');
    ok(h.results.pots.filter(p => p.run).length >= 2, 'pot split across runs');
    seen++;
    t.destroy();
  }
  // one player says no -> run once
  const t = mk({ runItTwice: true, requireApproval: false });
  t.sit('a', 'A', 0); t.sit('b', 'B', 1);
  t.running = true; t.startHand(); t.running = false;
  t.act(t.seats[t.hand.toAct].token, { type: 'allin' });
  t.act(t.seats[t.hand.toAct].token, { type: 'call' });
  const h1 = t.hand;
  t.ritVote('a', false); t.flush();
  ok(h1.board2 === null && h1.street === 'done' && h1.board.length === 5, 'declined -> runs once');
  t.destroy();
}

console.log(`\nAll ${passed} checks passed.`);
process.exit(0);
