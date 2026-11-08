/* Poker Night client */
const $ = id => document.getElementById(id);
const socket = io();
let state = null;
let clockOffset = 0;
let actionKey = '';
let raiseTo = 0;

function store(k, v) { try { v === undefined ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} }
function load(k) { try { return localStorage.getItem(k); } catch { return null; } }
function token() {
  let t = load('pn_token');
  if (!t) { t = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join(''); store('pn_token', t); }
  return t;
}

function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('show'), 2600);
}
function emit(ev, data = {}) {
  return new Promise(res => socket.emit(ev, data, r => { if (!r.ok) toast(r.error); res(r); }));
}
const fmt = n => Number(n).toLocaleString();
const now = () => Date.now() + clockOffset;
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function button(text, cls, fn) {
  const b = el('button', cls, text);
  if (fn) b.onclick = fn;
  return b;
}

// ---------- lobby ----------
$('name').value = load('pn_name') || '';
const params = new URLSearchParams(location.search);
if (params.get('t')) $('code').value = params.get('t').toUpperCase();

async function enter(ev, payload) {
  const name = $('name').value.trim();
  if (!name) { $('lobbyErr').textContent = 'Enter your name first.'; $('name').focus(); return; }
  store('pn_name', name);
  $('lobbyErr').textContent = '';
  const r = await new Promise(res => socket.emit(ev, { ...payload, name, token: token() }, res));
  if (!r.ok) { $('lobbyErr').textContent = r.error; return; }
  store('pn_table', r.code);
  history.replaceState(null, '', '?t=' + r.code);
  showGame(true);
}
$('joinBtn').onclick = () => enter('join', { code: $('code').value });
$('code').onkeydown = e => { if (e.key === 'Enter') $('joinBtn').click(); };
$('createBtn').onclick = () => enter('create', {
  startingStack: $('stack').value, smallBlind: $('sb').value, bigBlind: $('bb').value, turnSeconds: $('turn').value,
  requireApproval: $('approval').checked, runItTwice: $('rit').checked,
});

function showGame(on) {
  $('lobby').classList.toggle('hidden', on);
  $('game').classList.toggle('hidden', !on);
}

// Rejoin automatically after a refresh or a dropped connection.
socket.on('connect', async () => {
  const code = load('pn_table');
  if (!code) return;
  const r = await new Promise(res => socket.emit('join', { code, token: token(), name: load('pn_name') || '' }, res));
  if (r.ok) showGame(true);
  else { store('pn_table'); showGame(false); }
});

socket.on('state', s => {
  const prev = state;
  state = s;
  clockOffset = s.now - Date.now();
  playSounds(prev, s);
  render();
});

// ---------- table ----------
function cardEl(name, extra = '') {
  const d = el('div');
  if (!name) { d.className = 'c back ' + extra; return d; }
  const r = name[0] === 'T' ? '10' : name[0];
  const s = { s: '♠', h: '♥', d: '♦', c: '♣' }[name[1]];
  d.className = 'c ' + (name[1] === 'h' || name[1] === 'd' ? 'red ' : '') + extra;
  d.innerHTML = `<span class="r">${r}</span><span class="s">${s}</span>`;
  return d;
}

// Seated players: spread everyone evenly, in seat order, with you at the bottom.
// Visitors: show all 9 seats so they can pick an open one.
function seatPos(seat) {
  let i, n;
  if (state.you) {
    const taken = state.seats.map((p, k) => p ? k : -1).filter(k => k >= 0);
    n = Math.max(taken.length, 2);
    i = (taken.indexOf(seat) - taken.indexOf(state.you.seat) + n) % n;
  } else { n = 9; i = seat; }
  const a = Math.PI / 2 + i * 2 * Math.PI / n;
  return { x: 50 + 50 * Math.cos(a), y: 50 + 50 * Math.sin(a), bx: 50 + 30 * Math.cos(a), by: 50 + 27 * Math.sin(a) };
}

// Cards animate in only the first time they appear, one after another like a dealer.
const seenCards = new Set();
let dealStagger = 0;
function dealIn(node, key, step = 0.22) {
  if (seenCards.has(key)) return node;
  seenCards.add(key);
  node.classList.add('new');
  node.style.animationDelay = dealStagger + 's';
  dealStagger += step;
  return node;
}
function renderBoard(id, cards, winList) {
  const box = $(id); box.innerHTML = '';
  const win = new Set(winList || []);
  const hn = state.hand ? state.hand.number : 0;
  for (let i = 0; i < 5; i++) {
    const c = cards && cards[i];
    box.appendChild(c ? dealIn(cardEl(c, win.size ? (win.has(c) ? 'win' : 'dim') : ''), `${hn}:${id}:${i}:${c}`) : el('div', 'c slot'));
  }
}

function render() {
  const s = state, h = s.hand, you = s.you;
  dealStagger = 0;
  $('tableCode').textContent = s.code;
  const pb = s.pendingBlinds ? ` → ${s.pendingBlinds.smallBlind}/${s.pendingBlinds.bigBlind} next hand` : '';
  $('blindsInfo').textContent = `Blinds ${s.settings.smallBlind}/${s.settings.bigBlind}${pb}` + (h ? ` · Hand #${h.number}` : '');

  // board(s) + pot
  const wc = h && h.results ? h.results.winCards : [[], []];
  renderBoard('board', h && h.board, wc[0]);
  $('board2').classList.toggle('hidden', !(h && h.board2));
  if (h && h.board2) renderBoard('board2', h.board2, wc[1]);
  $('pot').textContent = h && h.pot ? `Pot ${fmt(h.pot)}` : '';
  $('status').textContent = statusText();

  // seats
  const wrap = $('seats'); wrap.innerHTML = '';
  const winners = new Set(h && h.results ? h.results.winners : []);
  const winAll = new Set([...(wc[0] || []), ...(wc[1] || [])]);
  s.seats.forEach((p, i) => {
    const pos = seatPos(i);
    if (!p) {
      if (you) return;
      const v = s.visitor || {};
      const b = button(v.pending === i ? 'Requested' : 'Sit here', 'open-seat' + (v.pending === i ? ' mine' : ''), () => emit('sit', { seat: i }));
      b.style.left = pos.x + '%'; b.style.top = pos.y + '%';
      wrap.appendChild(b);
      return;
    }
    const isMe = you && you.seat === i;
    const seat = el('div', 'seat' + (isMe ? ' me' : '') + (h && h.toAct === i ? ' turn' : '') + (p.folded ? ' folded' : '') +
      (p.away ? ' away' : !p.connected ? ' offline' : '') + (winners.has(i) ? ' winner' : ''));
    seat.style.left = pos.x + '%'; seat.style.top = pos.y + '%';

    const hole = el('div', 'hole');
    const done = h && h.street === 'done';
    if (isMe && you.hole.length && !(done && p.folded && !p.shown)) {
      you.hole.forEach((c, k) => hole.appendChild(dealIn(cardEl(c, winAll.size ? (winAll.has(c) ? 'win' : 'dim') : (you.folded ? 'dim' : '')), `${h ? h.number : 0}:hole:${i}:${k}`, 0.12)));
    } else if (p.shown) {
      p.shown.forEach(c => hole.appendChild(cardEl(c, winAll.has(c) ? 'win' : winAll.size ? 'dim' : '')));
    } else if (p.hasCards) {
      [0, 1].forEach(k => hole.appendChild(dealIn(cardEl(null), `${h ? h.number : 0}:hole:${i}:${k}`, 0.12)));
    }
    seat.appendChild(hole);

    const plate = el('div', 'plate');
    plate.appendChild(el('div', 'nm', p.name + (isMe ? ' (you)' : '')));
    const ch = el('div', 'ch', fmt(p.chips));
    if (p.allIn && h && !done) ch.appendChild(el('span', 'allin-badge', 'ALL-IN'));
    plate.appendChild(ch);
    if (p.handName) plate.appendChild(el('div', 'hn', p.handName));
    else if (isMe && you.strength) plate.appendChild(el('div', 'str', you.strength));
    if (h && h.toAct === i) { const t = el('div', 'timer'); t.dataset.timer = '1'; plate.appendChild(t); }
    seat.appendChild(plate);
    if (p.isButton) seat.appendChild(el('div', 'tag d', 'D'));
    if (h && !done && (p.isSB || p.isBB)) seat.appendChild(el('div', 'tag blind', p.isBB ? 'BB' : 'SB'));
    wrap.appendChild(seat);

    if (p.bet > 0 && h && !done) {
      const b = el('div', 'bet');
      b.style.left = pos.bx + '%'; b.style.top = pos.by + '%';
      b.innerHTML = `<span class="chip"></span>${fmt(p.bet)}`;
      wrap.appendChild(b);
    }
  });

  renderActions();
  renderHost();
  renderLog();
  renderStandings();
  $('awayBtn').classList.toggle('hidden', !you);
  if (you) $('awayBtn').textContent = you.away ? "I'm back" : 'Go away (sit out)';
}

function statusText() {
  const s = state, h = s.hand;
  if (h && h.rit && h.rit.pending) {
    const yes = Object.entries(h.rit.votes).filter(([, v]) => v).map(([seat]) => s.seats[seat] && s.seats[seat].name);
    return 'All-in! Run it twice?' + (yes.length ? ` (${yes.join(', ')} said yes)` : '');
  }
  if (!s.running && (!h || h.street === 'done')) {
    const n = s.seats.filter(Boolean).length;
    if (!s.you) return '';
    if (n < 2) return 'Share the table code — waiting for players to join.';
    return s.you.isHost ? 'Press Start when everyone is in.' : 'Waiting for the host to start.';
  }
  if (!h) return 'Waiting for at least 2 players with chips.';
  if (h.street === 'done' && h.results) {
    return h.results.pots.filter(p => !p.returned).map(p => {
      const names = p.winners.map(w => s.seats[w] ? s.seats[w].name : 'Player').join(' & ');
      return `${p.run ? `Run ${p.run}: ` : ''}${names} ${p.winners.length > 1 ? 'split' : 'wins'} ${fmt(p.amount)}${p.hand ? ' — ' + p.hand : ''}`;
    }).join(' · ');
  }
  if (h.toAct >= 0 && s.seats[h.toAct]) return s.you && s.you.seat === h.toAct ? 'Your turn' : `${s.seats[h.toAct].name} to act`;
  return h.runs === 2 ? 'Running it twice…' : '';
}

// ---------- action bar ----------
function renderActions() {
  const s = state, h = s.hand, you = s.you, bar = $('actions');
  const me = you && s.seats[you.seat];
  const o = you && you.options;
  const ritMine = !!(you && h && h.rit && h.rit.pending && h.rit.votes[you.seat] === null);
  const key = JSON.stringify(o
    ? ['turn', h.number, h.street, h.toAct, h.currentBet, me.chips]
    : [ritMine, you && you.away, you && you.canShow, you && you.preAction, you && you.rebuyPending, you && you.rebuyDenied, me && [me.inHand, me.folded, me.allIn, me.chips],
       h && [h.number, h.street], s.visitor, s.running]);
  if (key === actionKey) return;
  actionKey = key;
  bar.innerHTML = '';

  // Visitors: pick a seat, then wait for the host.
  if (!you) {
    const v = s.visitor || {};
    const box = el('div', 'prompt');
    if (v.pending !== null && v.pending !== undefined) {
      box.appendChild(el('div', 'q', 'Waiting for the host to let you in…'));
      box.appendChild(button('Cancel request', 'btn', () => emit('cancelRequest')));
    } else {
      box.appendChild(el('div', 'q', v.denied ? 'The host declined your request. You can pick a seat and ask again.' : 'Tap an open seat to sit down.'));
    }
    bar.appendChild(box);
    return;
  }

  if (ritMine) {
    const box = el('div', 'prompt');
    const q = el('div', 'q', 'All-in — run it twice?');
    q.dataset.rit = '1';
    box.appendChild(q);
    box.appendChild(el('div', 'pre-label', 'Each player has to agree. Each board wins half the pot.'));
    const row = el('div', 'row');
    row.append(button('Run it twice', 'btn gold', () => emit('rit', { yes: true })), button('Once', 'btn', () => emit('rit', { yes: false })));
    box.appendChild(row);
    bar.appendChild(box);
    return;
  }

  if (o) return renderTurn(bar, o, h, me);

  const box = el('div', 'prompt');
  const active = h && h.street !== 'done';
  if (you.away) {
    box.appendChild(el('div', 'q', "You're away — you won't be dealt in."));
    box.appendChild(button("I'm back", 'btn primary', () => emit('away', { on: false })));
  } else if (active && me.inHand && !me.folded && !me.allIn) {
    // Pre-select what to do when the action gets to you.
    box.appendChild(el('div', 'pre-label', 'Waiting… pre-select your move'));
    const row = el('div', 'pre-row');
    for (const [type, label] of [['fold', 'Fold'], ['check', 'Check'], ['checkfold', 'Check / Fold']]) {
      const on = you.preAction === type;
      row.appendChild(button(label, 'btn' + (on ? ' on' : ''), () => emit('pre', { type: on ? null : type })));
    }
    box.appendChild(row);
  } else {
    if (h && h.street === 'done' && you.canShow) box.appendChild(button('Show my cards', 'btn', () => emit('show')));
    if (me.chips === 0 && !(active && me.inHand)) {
      if (you.rebuyPending) {
        box.appendChild(el('div', 'q', 'Waiting for the host to approve your rebuy…'));
        box.appendChild(button('Cancel', 'btn', () => emit('cancelRequest', { type: 'rebuy' })));
      } else {
        if (you.rebuyDenied) box.appendChild(el('div', 'pre-label', 'The host declined your rebuy.'));
        box.appendChild(button((you.isHost ? 'Rebuy for ' : 'Ask to rebuy for ') + fmt(s.settings.startingStack), 'btn gold', () => emit('rebuy')));
      }
    }
    else if (active && !me.inHand) box.appendChild(el('div', 'pre-label', "You'll be dealt in next hand."));
    else if (active && me.allIn) box.appendChild(el('div', 'pre-label', "You're all-in."));
  }
  bar.appendChild(box);
}

function renderTurn(bar, o, h, me) {
  const s = state;
  const allBets = s.seats.reduce((a, p) => a + (p ? p.bet : 0), 0);
  const potAfterCall = h.pot + allBets + o.toCall;
  raiseTo = o.minTo;
  let raiseBtn = null;
  if (o.canRaise) {
    const box = el('div', 'raise-box');
    const presets = el('div', 'presets');
    const clamp = v => Math.max(o.minTo, Math.min(o.maxTo, Math.round(v)));
    const opts = [['Min', o.minTo], ['½ Pot', h.currentBet + potAfterCall / 2], ['¾ Pot', h.currentBet + potAfterCall * .75], ['Pot', h.currentBet + potAfterCall], ['All-in', o.maxTo]];
    const range = Object.assign(el('input'), { type: 'range', min: o.minTo, max: o.maxTo, step: 1, value: o.minTo });
    const num = Object.assign(el('input'), { type: 'number', min: o.minTo, max: o.maxTo, value: o.minTo, inputMode: 'numeric' });
    raiseBtn = button('', 'btn raise');
    const setTo = v => { raiseTo = clamp(v); range.value = raiseTo; num.value = raiseTo; raiseBtn.textContent = (raiseTo === o.maxTo ? 'All-in ' : (o.isBet ? 'Bet ' : 'Raise to ')) + fmt(raiseTo); };
    opts.forEach(([label, v]) => presets.appendChild(button(label, 'btn', () => setTo(v))));
    range.oninput = () => setTo(Number(range.value));
    num.onchange = () => setTo(Number(num.value));
    const row = el('div', 'slider-row');
    row.append(range, num);
    box.append(presets, row);
    bar.appendChild(box);
    raiseBtn.onclick = () => emit('action', { type: 'raise', amount: raiseTo });
    setTo(o.minTo);
  }
  const row = el('div', 'act-row');
  row.appendChild(button('Fold', 'btn fold', () => emit('action', { type: 'fold' })));
  if (o.canCheck) row.appendChild(button('Check', 'btn call', () => emit('action', { type: 'check' })));
  else row.appendChild(button(`Call ${fmt(o.toCall)}${o.toCall >= me.chips ? ' (all-in)' : ''}`, 'btn call', () => emit('action', { type: 'call' })));
  row.appendChild(raiseBtn || Object.assign(button('—', 'btn'), { disabled: true }));
  bar.appendChild(row);
}

// ---------- host ----------
function renderHost() {
  const s = state, bar = $('hostBar'), box = $('hostControls');
  const isHost = s.you && s.you.isHost;
  bar.innerHTML = ''; box.innerHTML = '';
  if (!isHost) { bar.classList.add('hidden'); return; }

  // join requests always show on the host's screen
  if (s.requests.length) {
    const list = el('div', 'requests');
    for (const r of s.requests) {
      const row = el('div', 'req' + (r.type === 'rebuy' ? ' rebuy' : ''));
      row.appendChild(el('span', '', r.type === 'rebuy'
        ? `${r.name} wants to rebuy for ${fmt(s.settings.startingStack)}`
        : `${r.name} wants to join (seat ${r.seat + 1})`));
      row.append(button(r.type === 'rebuy' ? 'Approve' : 'Let in', 'btn primary', () => emit('host', { type: 'approve', id: r.id, ok: true })),
        button('Decline', 'btn', () => emit('host', { type: 'approve', id: r.id, ok: false })));
      list.appendChild(row);
    }
    bar.appendChild(list);
  }
  if (!s.running) {
    const b = button('Start game', 'btn gold', () => emit('host', { type: 'start' }));
    b.disabled = s.seats.filter(p => p && p.chips > 0 && !p.away).length < 2;
    const row = el('div', 'row');
    row.appendChild(b);
    if (!s.started) row.appendChild(button('Shuffle seats', 'btn', () => emit('host', { type: 'shuffle' })));
    bar.appendChild(row);
  }
  bar.classList.toggle('hidden', !bar.children.length);

  const hb = el('div', 'host-box');
  hb.appendChild(el('h3', '', 'Host controls'));
  hb.appendChild(s.running
    ? button('Pause after this hand', 'btn wide', () => emit('host', { type: 'pause' }))
    : button('Start game', 'btn gold wide', () => emit('host', { type: 'start' })));
  const shuffle = button('Shuffle seats', 'btn wide', () => emit('host', { type: 'shuffle' }));
  shuffle.disabled = s.running || !!(s.hand && s.hand.street !== 'done');
  hb.appendChild(shuffle);
  const row = el('div', 'row');
  const sb = Object.assign(el('input'), { type: 'number', value: s.settings.smallBlind, placeholder: 'SB' });
  const bb = Object.assign(el('input'), { type: 'number', value: s.settings.bigBlind, placeholder: 'BB' });
  row.append(sb, bb, button('Set blinds', 'btn', () => emit('host', { type: 'blinds', smallBlind: sb.value, bigBlind: bb.value })));
  hb.appendChild(row);
  for (const [key, label] of [['requireApproval', 'Approve new players'], ['runItTwice', 'Offer run it twice on all-ins']]) {
    const lab = el('label', 'check');
    const cb = Object.assign(el('input'), { type: 'checkbox', checked: !!s.settings[key] });
    cb.onchange = () => emit('host', { type: 'options', [key]: cb.checked });
    lab.append(cb, document.createTextNode(label));
    hb.appendChild(lab);
  }
  box.appendChild(hb);
}

function renderLog() {
  const ol = $('log'); ol.innerHTML = '';
  for (const e of state.log) {
    const li = el('li', e.msg.startsWith('—') ? 'hdr' : '', e.msg);
    ol.appendChild(li);
  }
  ol.parentElement.scrollTop = ol.parentElement.scrollHeight;
}

function renderStandings() {
  const tb = $('standings'); tb.innerHTML = '';
  const rows = state.seats.filter(Boolean).sort((a, b) => b.net - a.net);
  for (const p of rows) {
    const tr = el('tr');
    const cls = p.net > 0 ? 'pos' : p.net < 0 ? 'neg' : '';
    tr.innerHTML = `<td></td><td>${fmt(p.chips)}</td><td class="${cls}">${p.net > 0 ? '+' : ''}${fmt(p.net)}</td>`;
    tr.firstChild.textContent = p.name;
    tb.appendChild(tr);
  }
}

// turn timer bar + run-it-twice countdown
function tick() {
  const h = state && state.hand;
  const bar = document.querySelector('[data-timer]');
  if (bar && h && h.deadline) {
    const left = h.deadline - now();
    const pct = Math.max(0, Math.min(1, left / (state.settings.turnSeconds * 1000)));
    bar.style.width = (pct * 100) + '%';
    bar.style.background = pct < .25 ? 'var(--red)' : '';
    const secs = Math.ceil(left / 1000);
    if (state.you && h.toAct === state.you.seat && secs <= 5 && secs > 0 && secs !== tick.last) { tick.last = secs; sfx.tick(); }
  }
  const q = document.querySelector('[data-rit]');
  if (q && h && h.rit && h.rit.pending) q.textContent = `All-in — run it twice? (${Math.max(0, Math.ceil((h.rit.deadline - now()) / 1000))}s)`;
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// drawers + buttons
function toggle(id) {
  for (const d of ['logPanel', 'menuPanel']) if (d !== id) $(d).classList.add('hidden');
  $(id).classList.toggle('hidden');
}
$('logBtn').onclick = () => toggle('logPanel');
$('menuBtn').onclick = () => toggle('menuPanel');
$('felt').onclick = e => { if (!e.target.closest('.open-seat')) { $('logPanel').classList.add('hidden'); $('menuPanel').classList.add('hidden'); } };
async function copyInvite() {
  const url = `${location.origin}/?t=${state.code}`;
  try { await navigator.clipboard.writeText(url); toast('Invite link copied'); }
  catch { prompt('Copy this link:', url); }
}
$('codePill').onclick = copyInvite;
$('copyBtn').onclick = copyInvite;
$('awayBtn').onclick = () => { emit('away', { on: !(state.you && state.you.away) }); $('menuPanel').classList.add('hidden'); };
$('leaveBtn').onclick = async () => {
  if (state && state.you && !confirm("Leave the table? You'll give up your seat and chips.")) return;
  await emit('leave');
  store('pn_table');
  state = null; actionKey = '';
  history.replaceState(null, '', '/');
  $('menuPanel').classList.add('hidden');
  showGame(false);
};

// ---------- sounds (generated in the browser, no files needed) ----------
const sfx = (() => {
  let ctx = null;
  let on = load('pn_sound') !== 'off';
  const unlock = () => {
    try {
      if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (ctx.state === 'suspended') ctx.resume();
    } catch {}
  };
  window.addEventListener('pointerdown', unlock, { capture: true });
  window.addEventListener('keydown', unlock, { capture: true });
  const ready = () => on && ctx && ctx.state === 'running';

  function tone(freq, dur, { type = 'sine', vol = 0.12, at = 0, to = null } = {}) {
    if (!ready()) return;
    const t0 = ctx.currentTime + at;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (to) o.frequency.exponentialRampToValueAtTime(to, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(ctx.destination);
    o.start(t0); o.stop(t0 + dur + 0.02);
  }
  function noise(dur, { vol = 0.15, at = 0, freq = 2500, q = 0.8, to = null } = {}) {
    if (!ready()) return;
    const t0 = ctx.currentTime + at;
    const len = Math.ceil(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource(); src.buffer = buf;
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = q;
    f.frequency.setValueAtTime(freq, t0);
    if (to) f.frequency.exponentialRampToValueAtTime(to, t0 + dur);
    const g = ctx.createGain(); g.gain.value = vol;
    src.connect(f).connect(g).connect(ctx.destination);
    src.start(t0);
  }
  return {
    get on() { return on; },
    toggle() { on = !on; store('pn_sound', on ? 'on' : 'off'); unlock(); return on; },
    deal(at = 0) { noise(0.07, { vol: 0.35, at, freq: 3200, q: 1.2 }); },
    chips(at = 0) { tone(2400, 0.06, { type: 'triangle', vol: 0.07, at }); tone(3100, 0.07, { type: 'triangle', vol: 0.06, at: at + 0.05 }); tone(2700, 0.08, { type: 'triangle', vol: 0.05, at: at + 0.1 }); },
    check() { tone(180, 0.07, { vol: 0.25 }); tone(170, 0.07, { vol: 0.22, at: 0.12 }); },
    fold() { noise(0.22, { vol: 0.18, freq: 1800, to: 500 }); },
    turn() { tone(660, 0.18, { vol: 0.12 }); tone(880, 0.3, { vol: 0.12, at: 0.14 }); },
    win() { [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.25, { type: 'triangle', vol: 0.1, at: i * 0.09 })); },
    allin() { for (let i = 0; i < 5; i++) this.chips(i * 0.07); },
    tick() { tone(1200, 0.04, { type: 'square', vol: 0.04 }); },
    ding() { tone(988, 0.35, { vol: 0.1 }); tone(1319, 0.4, { vol: 0.07, at: 0.08 }); },
  };
})();

const heardLog = new Set();
function playSounds(prev, s) {
  const fresh = s.log.filter(e => !heardLog.has(e.t + '|' + e.msg));
  for (const e of s.log) heardLog.add(e.t + '|' + e.msg);
  if (!prev) return; // don't replay history when you first open the table
  const h = s.hand, ph = prev.hand;

  // new hand: the deal
  if (h && (!ph || ph.number !== h.number)) {
    const n = Object.keys(s.seats.filter(p => p && p.inHand)).length * 2;
    for (let i = 0; i < Math.min(n, 12); i++) sfx.deal(i * 0.09);
  }
  // board cards
  const pb = ph && h && ph.number === h.number ? ph.board.length + (ph.board2 ? ph.board2.length : 0) : 0;
  const nb = h ? h.board.length + (h.board2 ? h.board2.length : 0) : 0;
  for (let i = 0; i < Math.max(0, nb - pb); i++) sfx.deal(i * 0.22);

  let won = false;
  for (const e of fresh) {
    const m = e.msg;
    if (/all-in\)/.test(m) && /calls|raises|bets/.test(m)) sfx.allin();
    else if (/ (calls|bets|raises to|posts) /.test(m)) sfx.chips();
    else if (/ checks\./.test(m)) sfx.check();
    else if (/ folds\./.test(m)) sfx.fold();
    else if (/ (wins|split) /.test(m)) won = true;
  }
  if (won) sfx.win();

  // your turn
  const mine = s.you && h && h.toAct === s.you.seat;
  const wasMine = !!(h && prev.you && ph && ph.toAct === prev.you.seat && ph.number === h.number && ph.street === h.street);
  if (mine && !wasMine) sfx.turn();
  // run-it-twice vote, join and rebuy requests
  if (s.you && h && h.rit && h.rit.pending && !(ph && ph.rit && ph.rit.pending)) sfx.ding();
  if (s.requests.length > (prev.requests ? prev.requests.length : 0)) sfx.ding();
}

$('soundBtn').textContent = sfx.on ? '🔊' : '🔇';
$('soundBtn').classList.toggle('muted', !sfx.on);
$('soundBtn').onclick = () => {
  const on = sfx.toggle();
  $('soundBtn').textContent = on ? '🔊' : '🔇';
  $('soundBtn').classList.toggle('muted', !on);
  toast(on ? 'Sound on' : 'Sound off');
};
