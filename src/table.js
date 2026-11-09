// No-limit Texas Hold'em table: seating, dealing, betting rounds, side pots, showdown.
const crypto = require('crypto');
const { shuffledDeck, cardName } = require('./cards');
const { bestHand, currentHandName } = require('./evaluator');
const { equity } = require('./equity');

const MAX_SEATS = 9;
const RIT_SECONDS = 15;

class Table {
  constructor({ code, hostToken, settings, delays = {}, onUpdate = () => {} }) {
    this.code = code;
    this.hostToken = hostToken;
    this.settings = {
      smallBlind: 5, bigBlind: 10, startingStack: 1000, turnSeconds: 30,
      maxRuns: 1, requireApproval: true, ...settings,
    };
    // older setting name: "run it twice" on/off
    if (settings && settings.runItTwice !== undefined && settings.maxRuns === undefined) this.settings.maxRuns = settings.runItTwice ? 2 : 1;
    delete this.settings.runItTwice;
    this.pendingBlinds = null;
    // Pauses so the game feels like a live dealer: before each new street, between streets on an all-in runout, and between hands.
    this.delays = { street: 1600, runout: 2800, laterRun: 2000, nextHand: 6500, preAction: 350, ...delays };
    this.onUpdate = onUpdate;
    this.seats = new Array(MAX_SEATS).fill(null);
    this.requests = [];          // seat requests waiting for host approval
    this.denied = new Set();     // tokens whose last request was declined
    this.running = false;
    this.button = -1;
    this.hand = null;
    this.handCount = 0;
    this.log = [];
    this.chat = [];            // table chat, newest last
    this.chatId = 0;
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
  // Table chat: seated players only, short messages, with a simple flood limit.
  addChat(token, text) {
    const p = this.playerByToken(token);
    if (!p) throw new Error('Sit down to chat.');
    text = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!text) throw new Error('Type a message.');
    const now = Date.now();
    p.chatTimes = (p.chatTimes || []).filter(t => now - t < 10000);
    if (p.chatTimes.length >= 6) throw new Error('Slow down a little.');
    p.chatTimes.push(now);
    this.chat.push({ id: ++this.chatId, t: now, pid: p.id, seat: p.seat, name: p.name, text });
    if (this.chat.length > 100) this.chat.shift();
  }

  say(msg) {
    this.log.push({ t: Date.now(), msg });
    if (this.log.length > 80) this.log.shift();
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
  handActive() { return !!this.hand && this.hand.street !== 'done'; }
  isHost(token) { return token === this.hostToken; }

  // ---------- seating ----------
  sit(token, name, seat = null, buyIn = null) {
    const existing = this.playerByToken(token);
    if (existing) { existing.name = name || existing.name; existing.connected = true; return existing; }
    if (seat === null || seat === undefined || this.seats[seat]) {
      if (seat !== null && seat !== undefined && this.seats[seat]) throw new Error('That seat was just taken — pick another.');
      seat = this.seats.findIndex(s => s === null);
    }
    if (seat < 0 || seat >= MAX_SEATS) throw new Error('Table is full (9 players).');
    const p = {
      id: crypto.randomBytes(6).toString('hex'),
      token, name: String(name).slice(0, 18), seat,
      chips: buyIn || this.settings.startingStack, buyins: 1, invested: buyIn || this.settings.startingStack,
      connected: true, leaving: false, away: false, preAction: null,
    };
    this.seats[seat] = p;
    this.requests = this.requests.filter(r => r.token !== token);
    this.say(`${p.name} sat down with ${p.chips}.`);
    if (this.running && !this.hand) this.schedule(() => this.startHand(), 300);
    return p;
  }

  // A visitor picks a seat. Goes straight in for the host, or when approval is off.
  // Buy-ins (and rebuys) can be any amount from one big blind up to 10x the starting stack.
  checkBuyIn(amount) {
    const { min, max } = this.rebuyLimits();
    amount = amount === undefined || amount === null || amount === '' ? this.settings.startingStack : Math.floor(Number(amount));
    if (!Number.isFinite(amount) || amount < min || amount > max) throw new Error(`Buy-in must be between ${min.toLocaleString()} and ${max.toLocaleString()}.`);
    return amount;
  }

  requestSeat(token, name, seat, buyIn) {
    if (this.playerByToken(token)) throw new Error("You're already seated.");
    buyIn = this.checkBuyIn(buyIn);
    seat = Math.floor(Number(seat));
    if (!(seat >= 0 && seat < MAX_SEATS)) throw new Error('Pick a seat.');
    if (this.seats[seat]) throw new Error('That seat is taken.');
    name = String(name || '').trim().slice(0, 18);
    if (!name) throw new Error('Enter your name.');
    this.denied.delete(token);
    if (!this.settings.requireApproval || this.isHost(token)) {
      this.sit(token, name, seat, buyIn);
      return { seated: true };
    }
    const prev = this.requests.find(r => r.token === token && r.type !== 'rebuy');
    if (prev) { prev.seat = seat; prev.amount = buyIn; }
    else {
      this.requests.push({ id: crypto.randomBytes(6).toString('hex'), token, name, seat, amount: buyIn, t: Date.now() });
      this.say(`${name} asked to join with ${buyIn}.`);
    }
    return { seated: false };
  }
  cancelRequest(token, type = 'seat') { this.requests = this.requests.filter(r => !(r.token === token && (r.type || 'seat') === type)); }

  approve(id, ok) {
    const r = this.requests.find(x => x.id === id);
    if (!r) throw new Error('That request is gone.');
    this.requests = this.requests.filter(x => x !== r);
    if (r.type === 'rebuy') {
      const p = this.playerByToken(r.token);
      if (!p) return;
      if (ok) this.doRebuy(p, r.amount);
      else { p.rebuyDenied = true; this.say(`Host declined ${p.name}'s rebuy.`); }
      return;
    }
    if (!ok) { this.denied.add(r.token); this.say(`Host declined ${r.name}.`); return; }
    const seat = this.seats[r.seat] ? this.seats.findIndex(s => s === null) : r.seat;
    if (seat < 0) throw new Error('Table is full.');
    this.sit(r.token, r.name, seat, r.amount);
  }

  leave(token) {
    const p = this.playerByToken(token);
    if (!p) { this.cancelRequest(token); return; }
    const hp = this.hand && this.hand.players[p.seat];
    if (hp && this.handActive()) {
      // Still in a hand: fold now if it's their turn, otherwise when action reaches them.
      p.leaving = true;
      if (!hp.folded && this.hand.toAct === p.seat) this.act(token, { type: 'fold' });
      else if (this.hand.rit && this.hand.rit.pending && p.seat in this.hand.rit.votes) this.ritVote(token, false);
      this.say(`${p.name} is leaving after this hand.`);
      return;
    }
    this.removePlayer(p);
  }
  removePlayer(p) {
    this.seats[p.seat] = null;
    this.requests = this.requests.filter(r => r.token !== p.token);
    this.say(`${p.name} left the table.`);
    if (this.seatedCount() < 2 && !this.hand) this.running = false;
  }
  seatedCount() { return this.seats.filter(Boolean).length; }

  // Rebuys can be any amount from one big blind up to 10x the starting stack.
  rebuyLimits() { return { min: this.bb, max: this.settings.startingStack * 10 }; }

  // Players ask to rebuy for an amount they choose; the host approves (the host's own rebuys go straight through).
  rebuy(token, amount) {
    const p = this.playerByToken(token);
    if (!p) throw new Error('Not seated.');
    amount = this.checkBuyIn(amount);
    if (p.chips > 0) throw new Error('You still have chips.');
    if (this.handActive() && this.hand.players[p.seat]) throw new Error('Wait for the hand to finish.');
    p.rebuyDenied = false;
    if (!this.isHost(token)) {
      if (!this.requests.some(r => r.token === token && r.type === 'rebuy')) {
        this.requests.push({ id: crypto.randomBytes(6).toString('hex'), type: 'rebuy', token, name: p.name, amount, t: Date.now() });
        this.say(`${p.name} asked to rebuy for ${amount}.`);
      }
      return { pending: true };
    }
    this.doRebuy(p, amount);
    return { pending: false };
  }
  doRebuy(p, amount = this.settings.startingStack) {
    if (p.chips > 0) return;
    p.chips = amount;
    p.buyins += 1;
    p.invested += amount;
    this.say(`${p.name} rebought for ${p.chips}.`);
    if (this.running && !this.hand) this.schedule(() => this.startHand(), 500);
  }

  // Away: not dealt into new hands. If away mid-hand, they check when possible, otherwise fold.
  setAway(token, on) {
    const p = this.playerByToken(token);
    if (!p) throw new Error('Not seated.');
    p.away = !!on;
    this.say(on ? `${p.name} is away.` : `${p.name} is back.`);
    if (on && this.handActive()) {
      const h = this.hand;
      if (h.toAct === p.seat) this.schedule(() => this.timeout(p.seat, h.number, h.street), 300);
      if (h.rit && h.rit.pending && p.seat in h.rit.votes && h.rit.votes[p.seat] === null) this.ritVote(token, false);
    }
    if (!on && this.running && !this.hand) this.schedule(() => this.startHand(), 300);
  }

  // Pre-select an action for when it's your turn: 'fold', 'check', 'checkfold', or null to clear.
  setPreAction(token, type) {
    const p = this.playerByToken(token);
    if (!p) throw new Error('Not seated.');
    if (type === null || type === undefined || type === '') { p.preAction = null; return; }
    if (!['fold', 'check', 'checkfold'].includes(type)) throw new Error('Unknown pre-action.');
    const h = this.hand;
    if (!this.handActive() || !h.players[p.seat] || h.players[p.seat].folded) throw new Error("You're not in this hand.");
    if (h.toAct === p.seat) throw new Error("It's your turn — just act.");
    p.preAction = { type, street: h.street, hand: h.number };
  }

  // After a hand, anyone who was dealt in can show their cards.
  showCards(token) {
    const p = this.playerByToken(token);
    const h = this.hand;
    if (!p || !h || h.street !== 'done' || !h.players[p.seat]) throw new Error('Nothing to show right now.');
    if (h.results.shown[p.seat]) return;
    h.results.shown[p.seat] = h.players[p.seat].hole.map(cardName);
    this.say(`${p.name} shows ${h.results.shown[p.seat].join(' ')}.`);
  }

  // ---------- host controls ----------
  setRunning(on) {
    this.running = on;
    this.say(on ? 'Game started.' : 'Game will pause after this hand.');
    if (on && !this.handActive()) this.startHand();
  }
  setBlinds(sb, bb) {
    sb = Math.floor(sb); bb = Math.floor(bb);
    if (!(sb > 0 && bb >= sb)) throw new Error('Big blind must be at least the small blind.');
    this.pendingBlinds = { smallBlind: sb, bigBlind: bb };
    this.say(`Blinds will be ${sb}/${bb} starting next hand.`);
    if (!this.handActive()) this.applyPendingBlinds();
  }
  applyPendingBlinds() {
    if (this.pendingBlinds) Object.assign(this.settings, this.pendingBlinds);
    this.pendingBlinds = null;
  }
  setOptions({ runItTwice, maxRuns, requireApproval, turnSeconds }) {
    if (runItTwice !== undefined && maxRuns === undefined) maxRuns = runItTwice ? 2 : 1;
    if (maxRuns !== undefined) {
      const v = Math.floor(Number(maxRuns));
      if (![1, 2, 3].includes(v)) throw new Error('Run it can be once, twice, or 3 times.');
      this.settings.maxRuns = v;
      this.say(v === 1 ? 'All-ins are run once.' : `All-ins can be run up to ${v === 2 ? 'twice' : '3 times'}.`);
    }
    if (turnSeconds !== undefined) {
      const v = Math.floor(Number(turnSeconds));
      if (!(v >= 5 && v <= 300)) throw new Error('Turn time must be 5–300 seconds.');
      this.settings.turnSeconds = v;
      this.say(`Turn time is now ${v} seconds (starts with the next turn).`);
    }
    if (requireApproval !== undefined) {
      this.settings.requireApproval = !!requireApproval;
      this.say(requireApproval ? 'New players need host approval.' : 'Anyone with the link can sit down.');
    }
  }
  shuffleSeats() {
    if (this.running || this.handActive()) throw new Error('Pause the game first.');
    const players = this.seats.filter(Boolean);
    const spots = players.map(p => p.seat).sort((a, b) => a - b);
    for (let i = players.length - 1; i > 0; i--) {
      const j = crypto.randomInt(i + 1);
      [players[i], players[j]] = [players[j], players[i]];
    }
    this.seats.fill(null);
    players.forEach((p, i) => { p.seat = spots[i]; this.seats[p.seat] = p; });
    this.button = -1; // re-draw for the button
    this.hand = null;
    this.say('Host shuffled the seats.');
  }

  // ---------- hand flow ----------
  eligible(s) { const p = this.seats[s]; return !!p && p.chips > 0 && !p.leaving && !p.away; }

  startHand() {
    if (this.handActive()) return false;
    for (const p of this.seats) if (p && p.leaving) this.removePlayer(p);
    this.applyPendingBlinds();
    if (!this.running) { this.hand = null; this.changed(); return false; }
    const ready = [...Array(MAX_SEATS).keys()].filter(s => this.eligible(s));
    if (ready.length < 2) { this.hand = null; this.say('Waiting for at least 2 players with chips.'); this.changed(); return false; }

    // First hand: draw for the button at random. After that it moves one seat left.
    this.button = this.button < 0
      ? ready[crypto.randomInt(ready.length)]
      : this.nextSeat(this.button, s => this.eligible(s));
    const headsUp = ready.length === 2;
    const sbSeat = headsUp ? this.button : this.nextSeat(this.button, s => this.eligible(s));
    const bbSeat = this.nextSeat(sbSeat, s => this.eligible(s));

    const h = {
      number: ++this.handCount,
      deck: shuffledDeck(), pos: 0,
      board: [], boards: [], street: 'preflop',
      players: {}, button: this.button, sbSeat, bbSeat,
      currentBet: 0, minRaise: this.bb,
      toAct: -1, deadline: 0, results: null,
      rit: null, runs: null, ritBase: null, runIdx: 0, allInShow: false, equity: null,
    };
    for (const s of ready) {
      h.players[s] = { hole: [], bet: 0, total: 0, folded: false, allIn: false, acted: false, locked: false };
      this.seats[s].preAction = null;
    }
    this.hand = h;
    this.say(`— Hand #${h.number} — blinds ${this.settings.smallBlind}/${this.bb}`);
    const sbAmt = this.post(sbSeat, this.settings.smallBlind);
    this.say(`${this.seats[sbSeat].name} posts small blind ${sbAmt}${h.players[sbSeat].allIn ? ' (all-in)' : ''}.`);
    const bbAmt = this.post(bbSeat, this.bb);
    this.say(`${this.seats[bbSeat].name} posts big blind ${bbAmt}${h.players[bbSeat].allIn ? ' (all-in)' : ''}.`);
    h.currentBet = this.bb;

    // Deal one card at a time, starting left of the button, like a real dealer.
    const order = [];
    let s = this.button;
    for (let i = 0; i < ready.length; i++) { s = this.nextSeat(s, x => h.players[x]); order.push(s); }
    for (let round = 0; round < 2; round++) for (const seat of order) h.players[seat].hole.push(this.draw());

    h.toAct = bbSeat; // proceed() moves action to the first player who needs to act after the BB
    this.proceed();
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
    p.preAction = null;
    this.proceed();
  }

  // Decide what happens next after any change in the hand.
  proceed() {
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
      const turnId = h.turnId = (h.turnId || 0) + 1;
      const p = this.seats[next];
      const handNo = h.number, street = h.street;

      // A pre-selected action fires right away (a "check" pre-select is dropped if there's now a bet).
      const pre = p.preAction;
      if (pre && pre.hand === handNo && pre.street === street) {
        const canCheck = h.currentBet - h.players[next].bet <= 0;
        if (pre.type === 'fold' || pre.type === 'checkfold' || (pre.type === 'check' && canCheck)) {
          h.deadline = Date.now() + this.delays.preAction;
          this.schedule(() => {
            if (this.hand !== h || h.turnId !== turnId) return;
            const type = pre.type === 'fold' ? 'fold' : canCheck ? 'check' : 'fold';
            this.act(p.token, { type });
          }, this.delays.preAction);
          this.changed();
          return;
        }
      }
      p.preAction = null;

      // Leaving, away, or disconnected players get a short clock so the game doesn't stall.
      const limit = p.leaving ? 0 : p.away ? 1500 : p.connected ? this.settings.turnSeconds * 1000 : 5000;
      h.deadline = Date.now() + limit;
      this.turnTimer = setTimeout(() => { if (h.turnId === turnId) this.timeout(next, handNo, street); }, limit);
      this.changed();
      return;
    }
    h.toAct = -1;
    this.changed();
    if (actors.length < 2 && h.street !== 'river') {
      // Everyone left is all-in: show the hands, then run the board out.
      return this.startAllIn(live);
    } else {
      this.schedule(() => this.nextStreet(), this.delays.street);
    }
  }

  timeout(seat, handNo, street) {
    const h = this.hand;
    if (!h || h.number !== handNo || h.street !== street || h.toAct !== seat) return;
    const p = this.seats[seat];
    const opt = this.options(seat);
    if (!p.leaving && !p.away) this.say(`${p.name} ran out of time.`);
    this.act(p.token, { type: opt.canCheck && !p.leaving ? 'check' : 'fold' });
  }

  // ---------- all-ins: show hands, win chances, run it 1-3 times ----------
  startAllIn(live) {
    const h = this.hand;
    if (h.allInShow) return;
    // pull the bets into the pot
    for (const hp of Object.values(h.players)) { hp.bet = 0; hp.acted = false; hp.locked = false; }
    for (const p of this.seats) if (p) p.preAction = null;
    h.currentBet = 0;
    h.toAct = -1;
    h.allInShow = true;
    this.say(`All in! ${live.map(s => `${this.seats[s].name} shows ${h.players[s].hole.map(cardName).join(' ')}`).join(' · ')}`);
    this.updateEquity();
    if (this.settings.maxRuns > 1) return this.startRitVote(live);
    this.beginRunout(1);
  }

  // Win chances on the board being dealt right now.
  updateEquity() {
    const h = this.hand;
    const live = Object.keys(h.players).map(Number).filter(s => !h.players[s].folded);
    const board = h.runIdx === 0 ? h.board : h.boards[h.runIdx - 1];
    const holes = Object.fromEntries(live.map(s => [s, h.players[s].hole]));
    const dead = [...h.board, ...h.boards.flat()].filter(c => !board.includes(c));
    h.equity = equity(holes, board, dead);
  }

  startRitVote(live) {
    const h = this.hand;
    const max = this.settings.maxRuns;
    h.rit = { pending: true, votes: {}, max, deadline: Date.now() + RIT_SECONDS * 1000 };
    for (const s of live) {
      const p = this.seats[s];
      h.rit.votes[s] = p.away || p.leaving ? 1 : null;
    }
    if (Object.values(h.rit.votes).includes(1)) return this.resolveRit(1);
    const handNo = h.number;
    this.schedule(() => { if (this.hand === h && h.rit.pending && h.number === handNo) this.resolveRit(1); }, RIT_SECONDS * 1000);
    this.changed();
  }
  // Each player picks once, twice or 3 times. The table runs it the fewest times anyone picked.
  ritVote(token, choice) {
    const h = this.hand;
    const p = this.playerByToken(token);
    if (!h || !h.rit || !h.rit.pending || !p || !(p.seat in h.rit.votes)) throw new Error('No vote right now.');
    if (h.rit.votes[p.seat] !== null) return;
    let n = choice === true ? 2 : choice === false ? 1 : Math.floor(Number(choice));
    if (!(n >= 1)) n = 1;
    n = Math.min(n, h.rit.max);
    h.rit.votes[p.seat] = n;
    if (n === 1) return this.resolveRit(1);
    const votes = Object.values(h.rit.votes);
    if (votes.every(v => v !== null)) return this.resolveRit(Math.min(...votes));
    this.changed();
  }
  resolveRit(runs) {
    const h = this.hand;
    h.rit.pending = false;
    h.rit.runs = runs;
    this.say(runs === 1 ? 'Running it once.' : `Everyone agreed — running it ${runs === 2 ? 'twice' : '3 times'}.`);
    this.beginRunout(runs);
  }

  beginRunout(runs) {
    const h = this.hand;
    h.runs = runs;
    h.ritBase = h.board.slice();
    h.boards = [];
    h.runIdx = 0;
    this.changed();
    this.schedule(() => this.runoutStep(), this.delays.runout);
  }
  // Deal the next street of the current run. Every run comes off the same deck (with burns), one after another.
  runoutStep() {
    const h = this.hand;
    if (!h || h.street === 'done') return;
    const board = h.runIdx === 0 ? h.board : h.boards[h.runIdx - 1];
    this.draw(); // burn
    if (board.length === 0) board.push(this.draw(), this.draw(), this.draw());
    else board.push(this.draw());
    const label = board.length === 3 ? 'Flop' : board.length === 4 ? 'Turn' : 'River';
    if (h.runIdx === 0) h.street = label.toLowerCase();
    this.say(`${h.runs > 1 ? `Run ${h.runIdx + 1} — ` : ''}${label}: ${board.map(cardName).join(' ')}`);
    this.updateEquity();
    this.changed();
    const pace = h.runIdx === 0 ? this.delays.runout : this.delays.laterRun;
    if (board.length < 5) return this.schedule(() => this.runoutStep(), pace);
    if (h.runIdx + 1 < h.runs) {
      return this.schedule(() => {
        if (this.hand !== h) return;
        h.runIdx++;
        h.boards.push(h.ritBase.slice());
        this.updateEquity();
        this.changed();
        this.schedule(() => this.runoutStep(), this.delays.laterRun);
      }, pace);
    }
    const live = Object.keys(h.players).map(Number).filter(s => !h.players[s].folded);
    this.schedule(() => this.finish(live, true), pace);
  }

  nextStreet() {
    const h = this.hand;
    if (!h || h.street === 'done') return;
    for (const hp of Object.values(h.players)) { hp.bet = 0; hp.acted = false; hp.locked = false; }
    for (const p of this.seats) if (p) p.preAction = null;
    h.currentBet = 0;
    h.minRaise = this.bb;

    if (h.street === 'river') {
      const live = Object.keys(h.players).map(Number).filter(s => !h.players[s].folded);
      return this.finish(live, true);
    }

    this.draw(); // burn a card before each street, same as live dealing
    if (h.street === 'preflop') { h.board.push(this.draw(), this.draw(), this.draw()); h.street = 'flop'; }
    else if (h.street === 'flop') { h.board.push(this.draw()); h.street = 'turn'; }
    else { h.board.push(this.draw()); h.street = 'river'; }
    const label = h.street[0].toUpperCase() + h.street.slice(1);
    this.say(`${label}: ${h.board.map(cardName).join(' ')}`);

    h.toAct = h.button; // action starts with the first live player left of the button
    this.proceed();
  }

  // Award the pot(s). Builds side pots from each player's total contribution.
  // When run more than once, each pot is split evenly between the runs and each part goes to the best hand on that board.
  finish(live, showdown) {
    const h = this.hand;
    clearTimeout(this.turnTimer);
    h.toAct = -1;
    const all = Object.entries(h.players).map(([s, hp]) => ({ seat: Number(s), hp }));
    const boards = [h.board, ...h.boards];
    const results = { showdown, pots: [], shown: {}, handsByRun: boards.map(() => ({})), winCards: boards.map(() => []) };

    if (!showdown) {
      const total = all.reduce((a, x) => a + x.hp.total, 0);
      this.seats[live[0]].chips += total;
      results.pots.push({ amount: total, winners: [live[0]], hand: null });
      this.say(`${this.seats[live[0]].name} wins ${total}.`);
    } else {
      h.street = 'showdown';
      const evals = boards.map(() => ({}));
      for (const s of live) {
        results.shown[s] = h.players[s].hole.map(cardName);
        boards.forEach((board, r) => {
          const e = bestHand([...h.players[s].hole, ...board]);
          evals[r][s] = e;
          results.handsByRun[r][s] = { name: e.name, cards: e.cards.map(cardName) };
        });
      }
      const levels = [...new Set(live.map(s => h.players[s].total))].sort((a, b) => a - b);
      const contested = levels.filter(L => live.filter(s => h.players[s].total >= L).length > 1).length;
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
        const label = contested > 1 ? (i === 0 ? 'the main pot' : `side pot ${i}`) : 'the pot';
        const n = boards.length, base = Math.floor(amount / n);
        const parts = boards.map((_, r) => base + (r < amount - base * n ? 1 : 0));
        parts.forEach((part, r) => {
          if (part === 0) return;
          const best = Math.max(...eligible.map(s => evals[r][s].score));
          const winners = eligible.filter(s => evals[r][s].score === best);
          const share = Math.floor(part / winners.length);
          let odd = part - share * winners.length;
          // odd chips go to the first winner(s) left of the button
          let s = h.button;
          for (let k = 0; k < MAX_SEATS; k++) {
            s = (s + 1) % MAX_SEATS;
            if (!winners.includes(s)) continue;
            this.seats[s].chips += share + (odd > 0 ? 1 : 0); odd--;
          }
          for (const w of winners) for (const c of evals[r][w].cards) results.winCards[r].push(cardName(c));
          const pot = { amount: part, winners, hand: evals[r][winners[0]].name, side: i > 0, run: n > 1 ? r + 1 : null };
          results.pots.push(pot);
          const runLabel = pot.run ? ` on run ${pot.run}` : '';
          const what = n === 2 ? `half of ${label}` : n === 3 ? `a third of ${label}` : label;
          this.say(`${winners.map(w => this.seats[w].name).join(' & ')} ${winners.length > 1 ? 'split' : 'wins'} ${what} (${part})${runLabel} with ${pot.hand}.`);
        });
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
    const done = h && h.street === 'done';
    const seats = this.seats.map((p, s) => {
      if (!p) return null;
      const hp = h && h.players[s];
      const shown = h && h.results && h.results.shown[s];
      const names = h && h.results && h.results.handsByRun.map(run => run[s]).filter(Boolean).map(x => x.name);
      const allInCards = h && h.allInShow && hp && !hp.folded && !done ? hp.hole.map(cardName) : null;
      return {
        seat: s, id: p.id, name: p.name, chips: p.chips, connected: p.connected, away: p.away,
        net: p.chips + (hp && !done ? hp.total : 0) - p.invested,
        inHand: !!hp, folded: hp ? hp.folded : false, allIn: hp ? hp.allIn : false,
        bet: hp ? hp.bet : 0,
        hasCards: (!!hp && !hp.folded && !done) || !!shown,
        shown: shown || allInCards || null,
        equity: h && h.allInShow && !done && h.equity && hp && !hp.folded ? h.equity[s] : null,
        handName: names && names.length ? names.join(' · ') : null,
        isButton: h ? h.button === s : false,
        isSB: h ? h.sbSeat === s : false,
        isBB: h ? h.bbSeat === s : false,
        isHost: p.token === this.hostToken,
      };
    });
    let hand = null;
    if (h) {
      const pot = Object.values(h.players).reduce((a, x) => a + x.total - (done ? 0 : x.bet), 0);
      hand = {
        number: h.number, street: h.street,
        board: h.board.map(cardName),
        boards: [h.board, ...h.boards].map(b => b.map(cardName)),
        runs: h.runs, runIdx: h.runIdx, allIn: h.allInShow,
        rit: h.rit ? { pending: h.rit.pending, votes: h.rit.votes, max: h.rit.max, deadline: h.rit.deadline, runs: h.rit.runs || null } : null,
        pot, currentBet: h.currentBet, toAct: h.toAct, deadline: h.deadline,
        results: h.results ? {
          showdown: h.results.showdown,
          pots: h.results.pots,
          winners: [...new Set(h.results.pots.filter(x => !x.returned).flatMap(x => x.winners))],
          winCards: h.results.winCards.map(list => [...new Set(list)]),
        } : null,
      };
    }
    const myHp = me && h && h.players[me.seat];
    let strength = null;
    if (myHp && !myHp.folded && !done) strength = currentHandName([...myHp.hole, ...h.board]);
    const request = !me && this.requests.find(r => r.token === token && r.type !== 'rebuy');
    return {
      code: this.code,
      running: this.running,
      started: this.handCount > 0,
      settings: this.settings,
      pendingBlinds: this.pendingBlinds,
      seats, hand,
      log: this.log.slice(-50),
      chat: this.chat.slice(-60),
      requests: me && this.isHost(token) ? this.requests.map(r => ({ id: r.id, type: r.type || 'seat', name: r.name, seat: r.seat, amount: r.amount })) : [],
      you: me ? {
        id: me.id, seat: me.seat, isHost: this.isHost(token), away: me.away,
        hole: myHp ? myHp.hole.map(cardName) : [],
        folded: myHp ? myHp.folded : false,
        strength,
        preAction: me.preAction ? me.preAction.type : null,
        rebuyPending: this.requests.some(r => r.token === token && r.type === 'rebuy'),
        rebuyLimits: this.rebuyLimits(),
        rebuyDenied: !!me.rebuyDenied,
        canShow: !!(done && myHp && h.results && !h.results.shown[me.seat]),
        options: this.options(me.seat),
      } : null,
      visitor: me ? null : {
        pending: request ? request.seat : null,
        denied: this.denied.has(token),
        isHost: this.isHost(token),
        buyIn: request ? request.amount : null,
        limits: this.rebuyLimits(),
      },
      now: Date.now(),
    };
  }
}

module.exports = { Table, MAX_SEATS };
