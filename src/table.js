// No-limit Texas Hold'em table: seating, dealing, betting rounds, side pots, showdown.
const crypto = require('crypto');
const { shuffledDeck, cardName } = require('./cards');
const { bestHand } = require('./evaluator');

const MAX_SEATS = 9;

class Table {
  constructor({ code, hostToken, settings, delays = {}, onUpdate = () => {} }) {
    this.code = code;
    this.hostToken = hostToken;
    this.settings = { smallBlind: 5, bigBlind: 10, startingStack: 1000, turnSeconds: 30, ...settings };
    this.pendingBlinds = null;
    this.delays = { street: 900, nextHand: 4000, ...delays };
    this.onUpdate = onUpdate;
    this.seats = new Array(MAX_SEATS).fill(null);
    this.running = false;
    this.button = -1;
    this.hand = null;
    this.handCount = 0;
    this.log = [];
    this.timers = new Set();
    this.turnTimer = null;
  }

  // ---------- helpers ----------
  schedule(fn, ms) {
    const t = setTimeout(() => { this.timers.delete(t); fn(); }, ms);
    this.timers.add(t);
    return t;
  }
  destroy() {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    clearTimeout(this.turnTimer);
  }
  say(msg) {
    this.log.push({ t: Date.now(), msg });
    if (this.log.length > 60) this.log.shift();
  }
  changed() { this.onUpdate(this); }

  playerByToken(token) { return this.seats.find(p => p && p.token === token) || null; }
  nextSeat(from, pred) {
    for (let i = 1; i <= MAX_SEATS; i++) {
      const s = (from + i) % MAX_SEATS;
      if (pred(s)) return s;
    }
    return -1;
  }
  get bb() { return this.settings.bigBlind; }

  // ---------- seating ----------
  sit(token, name) {
    const existing = this.playerByToken(token);
    if (existing) { existing.name = name || existing.name; existing.connected = true; return existing; }
    const seat = this.seats.findIndex(s => s === null);
    if (seat === -1) throw new Error('Table is full (9 players).');
    const p = {
      id: crypto.randomBytes(6).toString('hex'),
      token, name: String(name).slice(0, 18), seat,
      chips: this.settings.startingStack, buyins: 1,
      connected: true, leaving: false,
    };
    this.seats[seat] = p;
    this.say(`${p.name} sat down with ${p.chips}.`);
    return p;
  }

  leave(token) {
    const p = this.playerByToken(token);
    if (!p) return;
    const hp = this.hand && this.hand.players[p.seat];
    if (hp && this.hand.street !== 'done' && this.hand.street !== 'showdown') {
      // Still in a hand: fold now if it's their turn, otherwise when action reaches them.
      // The seat is cleared when the next hand starts.
      p.leaving = true;
      if (!hp.folded && this.hand.toAct === p.seat) this.act(token, { type: 'fold' });
      this.say(`${p.name} is leaving after this hand.`);
      return;
    }
    this.removePlayer(p);
  }
  removePlayer(p) {
    this.seats[p.seat] = null;
    this.say(`${p.name} left the table.`);
    if (this.seatedCount() < 2 && !this.hand) this.running = false;
  }
  seatedCount() { return this.seats.filter(Boolean).length; }

  rebuy(token) {
    const p = this.playerByToken(token);
    if (!p) throw new Error('Not seated.');
    if (p.chips > 0) throw new Error('You still have chips.');
    if (this.hand && this.hand.players[p.seat] && this.hand.street !== 'done') throw new Error('Wait for the hand to finish.');
    p.chips = this.settings.startingStack;
    p.buyins += 1;
    this.say(`${p.name} rebought for ${p.chips}.`);
    if (this.running && !this.hand) this.schedule(() => this.startHand(), 500);
  }

  // ---------- host controls ----------
  setRunning(on) {
    this.running = on;
    this.say(on ? 'Game started.' : 'Game will pause after this hand.');
    if (on && (!this.hand || this.hand.street === 'done')) this.startHand();
  }
  setBlinds(sb, bb) {
    sb = Math.floor(sb); bb = Math.floor(bb);
    if (!(sb > 0 && bb >= sb)) throw new Error('Big blind must be at least the small blind.');
    this.pendingBlinds = { smallBlind: sb, bigBlind: bb };
    this.say(`Blinds will be ${sb}/${bb} starting next hand.`);
    if (!this.hand || this.hand.street === 'done') this.applyPendingBlinds();
  }
  applyPendingBlinds() {
    if (this.pendingBlinds) Object.assign(this.settings, this.pendingBlinds);
    this.pendingBlinds = null;
  }

  // ---------- hand flow ----------
  eligible(s) { const p = this.seats[s]; return !!p && p.chips > 0 && !p.leaving; }

  startHand() {
    if (this.hand && this.hand.street !== 'done') return false;
    // clear players who left during the last hand
    for (const p of this.seats) if (p && p.leaving) this.removePlayer(p);
    this.applyPendingBlinds();
    if (!this.running) { this.hand = null; this.changed(); return false; }
    const ready = [...Array(MAX_SEATS).keys()].filter(s => this.eligible(s));
    if (ready.length < 2) { this.hand = null; this.say('Waiting for at least 2 players with chips.'); this.changed(); return false; }

    // First hand: draw for the button at random. After that it moves one seat left.
    this.button = this.button < 0 ? ready[crypto.randomInt(ready.length)] : this.nextSeat(this.button, s => this.eligible(s));
    const headsUp = ready.length === 2;
    const sbSeat = headsUp ? this.button : this.nextSeat(this.button, s => this.eligible(s));
    const bbSeat = this.nextSeat(sbSeat, s => this.eligible(s));

    const h = {
      number: ++this.handCount,
      deck: shuffledDeck(), pos: 0,
      board: [], street: 'preflop',
      players: {}, button: this.button, sbSeat, bbSeat,
      currentBet: 0, minRaise: this.bb,
      toAct: -1, deadline: 0, results: null,
    };
    for (const s of ready) {
      h.players[s] = { hole: [], bet: 0, total: 0, folded: false, allIn: false, acted: false, locked: false };
    }
    this.hand = h;
    this.say(`— Hand #${h.number} — blinds ${this.settings.smallBlind}/${this.bb}`);

    this.post(sbSeat, this.settings.smallBlind);
    this.post(bbSeat, this.bb);
    h.currentBet = this.bb;

    // Deal one card at a time, starting left of the button, like a real dealer.
    const order = [];
    let s = this.button;
    for (let i = 0; i < ready.length; i++) { s = this.nextSeat(s, x => h.players[x]); order.push(s); }
    for (let round = 0; round < 2; round++) for (const seat of order) h.players[seat].hole.push(this.draw());

    h.toAct = bbSeat; // proceed() moves action to the first player who needs to act after the BB
    this.proceed(true);
    return true;
  }

  draw() { return this.hand.deck[this.hand.pos++]; }
  post(seat, amount) {
    const p = this.seats[seat], hp = this.hand.players[seat];
    const amt = Math.min(amount, p.chips);
    p.chips -= amt; hp.bet += amt; hp.total += amt;
    if (p.chips === 0) hp.allIn = true;
    return amt;
  }

  canAct(seat) { const hp = this.hand.players[seat]; return hp && !hp.folded && !hp.allIn; }

  options(seat) {
    const h = this.hand;
    if (!h || h.toAct !== seat || h.street === 'done' || h.street === 'showdown') return null;
    const p = this.seats[seat], hp = h.players[seat];
    const toCall = Math.max(0, h.currentBet - hp.bet);
    const maxTo = hp.bet + p.chips;
    const minTo = Math.min(h.currentBet + h.minRaise, maxTo);
    return {
      toCall: Math.min(toCall, p.chips),
      canCheck: toCall === 0,
      canRaise: !hp.locked && maxTo > h.currentBet && this.othersCanCall(seat),
      minTo, maxTo,
      isBet: h.currentBet === 0,
    };
  }
  othersCanCall(seat) {
    return Object.keys(this.hand.players).some(s => Number(s) !== seat && this.canAct(Number(s)));
  }

  act(token, { type, amount }) {
    const h = this.hand;
    const p = this.playerByToken(token);
    if (!h || !p || h.toAct !== p.seat) throw new Error("It's not your turn.");
    const opt = this.options(p.seat);
    if (!opt) throw new Error("It's not your turn.");
    const hp = h.players[p.seat];

    if (type === 'allin') {
      type = opt.canRaise ? 'raise' : 'call';
      amount = opt.maxTo;
      if (type === 'call' && opt.toCall === 0) type = 'check';
    }

    switch (type) {
      case 'fold':
        hp.folded = true;
        this.say(`${p.name} folds.`);
        break;
      case 'check':
        if (!opt.canCheck) throw new Error('You must call, raise, or fold.');
        this.say(`${p.name} checks.`);
        break;
      case 'call': {
        if (opt.canCheck) throw new Error('Nothing to call — check instead.');
        const put = this.post(p.seat, opt.toCall);
        this.say(`${p.name} calls ${put}${hp.allIn ? ' (all-in)' : ''}.`);
        break;
      }
      case 'raise': {
        if (!opt.canRaise) throw new Error("You can't raise right now.");
        let to = Math.floor(Number(amount));
        if (!Number.isFinite(to)) throw new Error('Enter an amount.');
        if (to >= opt.maxTo) to = opt.maxTo;
        if (to < opt.minTo) throw new Error(`Minimum is ${opt.minTo}.`);
        const prevBet = h.currentBet;
        this.post(p.seat, to - hp.bet);
        const raiseSize = to - prevBet;
        const full = raiseSize >= h.minRaise;
        for (const [s, other] of Object.entries(this.hand.players)) {
          if (Number(s) === p.seat || other.folded || other.allIn) continue;
          // A full raise reopens the betting. A short all-in only lets players who already acted call or fold.
          if (full) other.locked = false;
          else if (other.acted) other.locked = true;
          other.acted = false;
        }
        if (full) h.minRaise = raiseSize;
        h.currentBet = to;
        const verb = prevBet === 0 ? 'bets' : 'raises to';
        this.say(`${p.name} ${verb} ${to}${hp.allIn ? ' (all-in)' : ''}.`);
        break;
      }
      default:
        throw new Error('Unknown action.');
    }
    hp.acted = true;
    hp.locked = false;
    this.proceed();
  }

  // Decide what happens next after any change in the hand.
  proceed(fromStart = false) {
    const h = this.hand;
    clearTimeout(this.turnTimer);
    const live = Object.keys(h.players).map(Number).filter(s => !h.players[s].folded);

    if (live.length === 1) return this.finish(live, false);

    const actors = live.filter(s => this.canAct(s));
    const needs = s => !h.players[s].acted || h.players[s].bet < h.currentBet;
    const roundDone = actors.length === 0 ||
      (actors.length === 1 && h.players[actors[0]].bet >= h.currentBet) ||
      actors.every(s => !needs(s));

    if (!roundDone) {
      const next = this.nextSeat(h.toAct, s => actors.includes(s) && needs(s));
      h.toAct = next;
      const p = this.seats[next];
      // Disconnected or leaving players get a short clock so the game doesn't stall.
      const limit = p.leaving ? 0 : p.connected ? this.settings.turnSeconds * 1000 : 5000;
      h.deadline = Date.now() + limit;
      const handNo = h.number, street = h.street;
      this.turnTimer = setTimeout(() => this.timeout(next, handNo, street), limit);
      this.changed();
      return;
    }
    h.toAct = -1;
    this.changed();
    if (actors.length < 2 && h.street !== 'river') {
      // Everyone left is all-in: run the board out with a short pause per street.
      this.schedule(() => this.nextStreet(), this.delays.street);
    } else {
      this.nextStreet();
    }
  }

  timeout(seat, handNo, street) {
    const h = this.hand;
    if (!h || h.number !== handNo || h.street !== street || h.toAct !== seat) return;
    const p = this.seats[seat];
    const opt = this.options(seat);
    if (!p.leaving) this.say(`${p.name} ran out of time.`);
    this.act(p.token, { type: opt.canCheck && !p.leaving ? 'check' : 'fold' });
  }

  nextStreet() {
    const h = this.hand;
    if (!h || h.street === 'done') return;
    for (const hp of Object.values(h.players)) { hp.bet = 0; hp.acted = false; hp.locked = false; }
    h.currentBet = 0;
    h.minRaise = this.bb;

    if (h.street === 'river') return this.finish(Object.keys(h.players).map(Number).filter(s => !h.players[s].folded), true);

    this.draw(); // burn a card before each street, same as live dealing
    if (h.street === 'preflop') { h.board.push(this.draw(), this.draw(), this.draw()); h.street = 'flop'; }
    else if (h.street === 'flop') { h.board.push(this.draw()); h.street = 'turn'; }
    else { h.board.push(this.draw()); h.street = 'river'; }
    this.say(`${h.street[0].toUpperCase() + h.street.slice(1)}: ${h.board.map(cardName).join(' ')}`);

    h.toAct = h.button; // action starts with the first live player left of the button
    this.proceed();
  }

  // Award the pot(s). Builds side pots from each player's total contribution.
  finish(live, showdown) {
    const h = this.hand;
    clearTimeout(this.turnTimer);
    h.toAct = -1;
    const all = Object.entries(h.players).map(([s, hp]) => ({ seat: Number(s), hp }));
    const results = { showdown, pots: [], shown: {}, hands: {} };

    if (!showdown) {
      const total = all.reduce((a, x) => a + x.hp.total, 0);
      this.seats[live[0]].chips += total;
      results.pots.push({ amount: total, winners: [live[0]], hand: null });
      this.say(`${this.seats[live[0]].name} wins ${total}.`);
    } else {
      h.street = 'showdown';
      const evals = {};
      for (const s of live) {
        evals[s] = bestHand([...h.players[s].hole, ...h.board]);
        results.shown[s] = h.players[s].hole.map(cardName);
        results.hands[s] = { name: evals[s].name, cards: evals[s].cards.map(cardName) };
      }
      const levels = [...new Set(live.map(s => h.players[s].total))].sort((a, b) => a - b);
      let prev = 0;
      levels.forEach((level, i) => {
        let amount = 0;
        for (const { hp } of all) amount += Math.max(0, Math.min(hp.total, level) - prev);
        if (i === levels.length - 1) for (const { hp } of all) amount += Math.max(0, hp.total - level); // dead money above the top level
        const eligible = live.filter(s => h.players[s].total >= level);
        prev = level;
        if (amount === 0) return;
        if (eligible.length === 1) {
          // Only one player put this much in: it's an uncalled bet, so it simply goes back.
          this.seats[eligible[0]].chips += amount;
          results.pots.push({ amount, winners: eligible, hand: null, returned: true });
          this.say(`${this.seats[eligible[0]].name} gets back ${amount} (uncalled).`);
          return;
        }
        const best = Math.max(...eligible.map(s => evals[s].score));
        const winners = eligible.filter(s => evals[s].score === best);
        const share = Math.floor(amount / winners.length);
        let odd = amount - share * winners.length;
        // odd chips go to the first winner(s) left of the button
        const ordered = [];
        let s = h.button;
        for (let k = 0; k < MAX_SEATS; k++) { s = (s + 1) % MAX_SEATS; if (winners.includes(s)) ordered.push(s); }
        for (const w of ordered) { this.seats[w].chips += share + (odd > 0 ? 1 : 0); odd--; }
        const pot = { amount, winners, hand: evals[winners[0]].name, side: i > 0 };
        results.pots.push(pot);
        const contested = levels.filter(L => live.filter(s => h.players[s].total >= L).length > 1).length;
        const label = contested > 1 ? (i === 0 ? 'the main pot' : `side pot ${i}`) : 'the pot';
        this.say(`${winners.map(w => this.seats[w].name).join(' & ')} ${winners.length > 1 ? 'split' : 'wins'} ${label} (${amount}) with ${pot.hand}.`);
      });
    }
    h.results = results;
    h.street = 'done';
    for (const p of this.seats) if (p && p.chips === 0 && h.players[p.seat]) this.say(`${p.name} is out of chips.`);
    this.changed();
    this.schedule(() => this.startHand(), this.delays.nextHand);
  }

  // ---------- views ----------
  view(token) {
    const h = this.hand;
    const me = this.playerByToken(token);
    const seats = this.seats.map((p, s) => {
      if (!p) return null;
      const hp = h && h.players[s];
      const shown = h && h.results && h.results.shown[s];
      return {
        seat: s, id: p.id, name: p.name, chips: p.chips, connected: p.connected,
        net: p.chips + (hp ? hp.total : 0) * (h && h.street !== 'done' ? 1 : 0) - p.buyins * this.settings.startingStack,
        inHand: !!hp, folded: hp ? hp.folded : false, allIn: hp ? hp.allIn : false,
        bet: hp ? hp.bet : 0,
        hasCards: !!hp && !hp.folded && h.street !== 'done' || !!shown,
        shown: shown || null,
        handName: h && h.results && h.results.hands[s] ? h.results.hands[s].name : null,
        isButton: h ? h.button === s : false,
        isSB: h ? h.sbSeat === s : false,
        isBB: h ? h.bbSeat === s : false,
        isHost: p.token === this.hostToken,
      };
    });
    let hand = null;
    if (h) {
      const pot = Object.values(h.players).reduce((a, x) => a + x.total - (h.street === 'done' ? 0 : x.bet), 0);
      hand = {
        number: h.number, street: h.street, board: h.board.map(cardName),
        pot, currentBet: h.currentBet, toAct: h.toAct, deadline: h.deadline,
        results: h.results ? {
          showdown: h.results.showdown,
          pots: h.results.pots,
          winners: [...new Set(h.results.pots.filter(x => !x.returned).flatMap(x => x.winners))],
        } : null,
        winningCards: h.results && h.results.showdown
          ? [...new Set(h.results.pots.filter(x => !x.returned).flatMap(x => x.winners.flatMap(w => h.results.hands[w].cards)))]
          : [],
      };
    }
    const myHp = me && h && h.players[me.seat];
    return {
      code: this.code,
      running: this.running,
      settings: this.settings,
      pendingBlinds: this.pendingBlinds,
      seats, hand,
      log: this.log.slice(-40),
      you: me ? {
        id: me.id, seat: me.seat, isHost: me.token === this.hostToken,
        hole: myHp ? myHp.hole.map(cardName) : [],
        folded: myHp ? myHp.folded : false,
        options: this.options(me.seat),
      } : null,
      now: Date.now(),
    };
  }
}

module.exports = { Table, MAX_SEATS };
