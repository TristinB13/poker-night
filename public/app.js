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
  state = s;
  clockOffset = s.now - Date.now();
  render();
});

// ---------- table ----------
function cardEl(name, extra = '') {
  const d = document.createElement('div');
  if (!name) { d.className = 'c back ' + extra; return d; }
  const r = name[0] === 'T' ? '10' : name[0];
  const s = { s: '♠', h: '♥', d: '♦', c: '♣' }[name[1]];
  d.className = 'c ' + (name[1] === 'h' || name[1] === 'd' ? 'red ' : '') + extra;
  d.innerHTML = `<span class="r">${r}</span><span class="s">${s}</span>`;
  return d;
}

// Spread the seated players evenly around the table, in seat order, with you at the bottom.
function seatPos(seat) {
  const taken = state.seats.map((p, i) => p ? i : -1).filter(i => i >= 0);
  const n = Math.max(taken.length, 2);
  const mine = state.you ? taken.indexOf(state.you.seat) : 0;
  const i = (taken.indexOf(seat) - Math.max(mine, 0) + n) % n;
  const a = Math.PI / 2 + i * 2 * Math.PI / n;
  return { x: 50 + 50 * Math.cos(a), y: 50 + 50 * Math.sin(a), bx: 50 + 30 * Math.cos(a), by: 50 + 27 * Math.sin(a) };
}

function render() {
  const s = state, h = s.hand, you = s.you;
  $('tableCode').textContent = s.code;
  const pb = s.pendingBlinds ? ` → ${s.pendingBlinds.smallBlind}/${s.pendingBlinds.bigBlind} next hand` : '';
  $('blindsInfo').textContent = `Blinds ${s.settings.smallBlind}/${s.settings.bigBlind}${pb}` + (h ? ` · Hand #${h.number}` : '');

  // board + pot
  const board = $('board'); board.innerHTML = '';
  const win = new Set(h ? h.winningCards : []);
  for (let i = 0; i < 5; i++) {
    const c = h && h.board[i];
    board.appendChild(c ? cardEl(c, win.size ? (win.has(c) ? 'win' : 'dim') : '') : Object.assign(document.createElement('div'), { className: 'c slot' }));
  }
  $('pot').textContent = h && h.pot ? `Pot ${fmt(h.pot)}` : '';
  $('status').textContent = statusText();

  // seats
  const wrap = $('seats'); wrap.innerHTML = '';
  const winners = new Set(h && h.results ? h.results.winners : []);
  s.seats.forEach((p, i) => {
    if (!p) return;
    const pos = seatPos(i);
    const isMe = you && you.seat === i;
    const el = document.createElement('div');
    el.className = 'seat' + (isMe ? ' me' : '') + (h && h.toAct === i ? ' turn' : '') + (p.folded ? ' folded' : '') +
      (!p.connected ? ' offline' : '') + (winners.has(i) ? ' winner' : '');
    el.style.left = pos.x + '%'; el.style.top = pos.y + '%';

    const hole = document.createElement('div'); hole.className = 'hole';
    if (isMe && you.hole.length && !(h && h.street === 'done' && p.folded)) {
      you.hole.forEach(c => hole.appendChild(cardEl(c, win.size ? (win.has(c) ? 'win' : 'dim') : (you.folded ? 'dim' : ''))));
    } else if (p.shown) {
      p.shown.forEach(c => hole.appendChild(cardEl(c, win.has(c) ? 'win' : 'dim')));
    } else if (p.hasCards) {
      hole.appendChild(cardEl(null)); hole.appendChild(cardEl(null));
    }
    el.appendChild(hole);

    const plate = document.createElement('div'); plate.className = 'plate';
    plate.innerHTML = `<div class="nm"></div><div class="ch">${fmt(p.chips)}${p.allIn && h && h.street !== 'done' ? '<span class="allin-badge">ALL-IN</span>' : ''}</div>` +
      (p.handName ? `<div class="hn">${p.handName}</div>` : '') +
      (h && h.toAct === i ? '<div class="timer" data-timer></div>' : '');
    plate.querySelector('.nm').textContent = p.name + (isMe ? ' (you)' : '');
    el.appendChild(plate);
    if (p.isButton) { const t = document.createElement('div'); t.className = 'tag d'; t.textContent = 'D'; el.appendChild(t); }
    wrap.appendChild(el);

    if (p.bet > 0 && h && h.street !== 'done') {
      const b = document.createElement('div'); b.className = 'bet';
      b.style.left = pos.bx + '%'; b.style.top = pos.by + '%';
      b.innerHTML = `<span class="chip"></span>${fmt(p.bet)}`;
      wrap.appendChild(b);
    }
  });

  renderActions();
  renderHost();
  renderLog();
  renderStandings();
}

function statusText() {
  const s = state, h = s.hand;
  if (!s.running && (!h || h.street === 'done')) {
    const n = s.seats.filter(Boolean).length;
    if (n < 2) return 'Share the table code — waiting for players to join.';
    return s.you && s.you.isHost ? 'Press Start when everyone is in.' : 'Waiting for the host to start.';
  }
  if (!h) return 'Waiting for at least 2 players with chips.';
  if (h.street === 'done' && h.results) {
    return h.results.pots.filter(p => !p.returned).map(p => {
      const names = p.winners.map(w => s.seats[w] ? s.seats[w].name : 'Player').join(' & ');
      return `${names} ${p.winners.length > 1 ? 'split' : 'wins'} ${fmt(p.amount)}${p.hand ? ' — ' + p.hand : ''}`;
    }).join(' · ');
  }
  if (h.toAct >= 0 && s.seats[h.toAct]) return s.you && s.you.seat === h.toAct ? 'Your turn' : `${s.seats[h.toAct].name} to act`;
  return '';
}

// ---------- actions ----------
function renderActions() {
  const s = state, h = s.hand, you = s.you, bar = $('actions');
  const me = you && s.seats[you.seat];
  const o = you && you.options;
  const key = o ? [h.number, h.street, h.toAct, h.currentBet, me.chips].join('|') : 'idle|' + (me ? me.chips : '') + '|' + (h ? h.number + h.street : '');
  if (key === actionKey) return;
  actionKey = key;
  bar.innerHTML = '';

  if (!o) {
    const msg = document.createElement('div'); msg.className = 'msg';
    if (me && me.chips === 0 && !(h && h.street !== 'done' && me.inHand)) {
      const b = button('Rebuy for ' + fmt(s.settings.startingStack), 'btn gold', () => emit('rebuy'));
      msg.appendChild(b);
    } else if (h && me && me.inHand && !me.folded && h.street !== 'done') msg.textContent = 'Waiting for your turn…';
    else if (h && h.street !== 'done' && me && !me.inHand) msg.textContent = "You'll be dealt in next hand.";
    else msg.textContent = '';
    bar.appendChild(msg);
    return;
  }

  const allBets = s.seats.reduce((a, p) => a + (p ? p.bet : 0), 0);
  const potAfterCall = h.pot + allBets + o.toCall;
  raiseTo = o.minTo;

  if (o.canRaise) {
    const box = document.createElement('div'); box.className = 'raise-box';
    const presets = document.createElement('div'); presets.className = 'presets';
    const clamp = v => Math.max(o.minTo, Math.min(o.maxTo, Math.round(v)));
    const opts = [['Min', o.minTo], ['½ Pot', h.currentBet + potAfterCall / 2], ['¾ Pot', h.currentBet + potAfterCall * .75], ['Pot', h.currentBet + potAfterCall], ['All-in', o.maxTo]];
    const range = Object.assign(document.createElement('input'), { type: 'range', min: o.minTo, max: o.maxTo, step: 1, value: o.minTo });
    const num = Object.assign(document.createElement('input'), { type: 'number', min: o.minTo, max: o.maxTo, value: o.minTo, inputMode: 'numeric' });
    const raiseBtn = button('', 'btn raise');
    const setTo = v => { raiseTo = clamp(v); range.value = raiseTo; num.value = raiseTo; raiseBtn.textContent = (raiseTo === o.maxTo ? 'All-in ' : (o.isBet ? 'Bet ' : 'Raise to ')) + fmt(raiseTo); };
    opts.forEach(([label, v]) => presets.appendChild(button(label, 'btn', () => setTo(v))));
    range.oninput = () => setTo(Number(range.value));
    num.onchange = () => setTo(Number(num.value));
    const row = document.createElement('div'); row.className = 'slider-row';
    row.append(range, num);
    box.append(presets, row);
    bar.appendChild(box);
    raiseBtn.onclick = () => emit('action', { type: 'raise', amount: raiseTo });
    setTo(o.minTo);
    bar.appendChild(actRow(o, raiseBtn));
  } else {
    bar.appendChild(actRow(o, null));
  }
}
function actRow(o, raiseBtn) {
  const row = document.createElement('div'); row.className = 'act-row';
  row.appendChild(button('Fold', 'btn fold', () => emit('action', { type: 'fold' })));
  if (o.canCheck) row.appendChild(button('Check', 'btn call', () => emit('action', { type: 'check' })));
  else row.appendChild(button(`Call ${fmt(o.toCall)}${o.toCall >= state.seats[state.you.seat].chips ? ' (all-in)' : ''}`, 'btn call', () => emit('action', { type: 'call' })));
  row.appendChild(raiseBtn || Object.assign(button('—', 'btn'), { disabled: true }));
  return row;
}
function button(text, cls, fn) {
  const b = document.createElement('button'); b.className = cls; b.textContent = text;
  if (fn) b.onclick = fn;
  return b;
}

// ---------- host / menus ----------
function renderHost() {
  const s = state, bar = $('hostBar'), box = $('hostControls');
  const isHost = s.you && s.you.isHost;
  bar.innerHTML = ''; box.innerHTML = '';
  if (!isHost) { bar.classList.add('hidden'); return; }
  if (!s.running) {
    bar.classList.remove('hidden');
    const b = button('Start game', 'btn gold', () => emit('host', { type: 'start' }));
    b.disabled = s.seats.filter(p => p && p.chips > 0).length < 2;
    bar.appendChild(b);
  } else bar.classList.add('hidden');

  const hb = document.createElement('div'); hb.className = 'host-box';
  hb.innerHTML = '<h3>Host controls</h3>';
  hb.appendChild(s.running
    ? button('Pause after this hand', 'btn wide', () => emit('host', { type: 'pause' }))
    : button('Start game', 'btn gold wide', () => emit('host', { type: 'start' })));
  const row = document.createElement('div'); row.className = 'row';
  const sb = Object.assign(document.createElement('input'), { type: 'number', value: s.settings.smallBlind, placeholder: 'SB' });
  const bb = Object.assign(document.createElement('input'), { type: 'number', value: s.settings.bigBlind, placeholder: 'BB' });
  row.append(sb, bb, button('Set blinds', 'btn', () => emit('host', { type: 'blinds', smallBlind: sb.value, bigBlind: bb.value })));
  hb.appendChild(row);
  box.appendChild(hb);
}

function renderLog() {
  const ol = $('log'); ol.innerHTML = '';
  for (const e of state.log) {
    const li = document.createElement('li'); li.textContent = e.msg;
    if (e.msg.startsWith('—')) li.className = 'hdr';
    ol.appendChild(li);
  }
  ol.parentElement.scrollTop = ol.parentElement.scrollHeight;
}

function renderStandings() {
  const tb = $('standings'); tb.innerHTML = '';
  const rows = state.seats.filter(Boolean).sort((a, b) => b.net - a.net);
  for (const p of rows) {
    const tr = document.createElement('tr');
    const cls = p.net > 0 ? 'pos' : p.net < 0 ? 'neg' : '';
    tr.innerHTML = `<td></td><td>${fmt(p.chips)}</td><td class="${cls}">${p.net > 0 ? '+' : ''}${fmt(p.net)}</td>`;
    tr.firstChild.textContent = p.name;
    tb.appendChild(tr);
  }
}

// turn timer bar
function tick() {
  const el = document.querySelector('[data-timer]');
  if (el && state && state.hand && state.hand.deadline) {
    const left = state.hand.deadline - (Date.now() + clockOffset);
    const pct = Math.max(0, Math.min(1, left / (state.settings.turnSeconds * 1000)));
    el.style.width = (pct * 100) + '%';
    el.style.background = pct < .25 ? 'var(--red)' : '';
  }
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
$('felt').onclick = () => { $('logPanel').classList.add('hidden'); $('menuPanel').classList.add('hidden'); };
async function copyInvite() {
  const url = `${location.origin}/?t=${state.code}`;
  try { await navigator.clipboard.writeText(url); toast('Invite link copied'); }
  catch { prompt('Copy this link:', url); }
}
$('codePill').onclick = copyInvite;
$('copyBtn').onclick = copyInvite;
$('leaveBtn').onclick = async () => {
  if (!confirm("Leave the table? You'll give up your seat and chips.")) return;
  await emit('leave');
  store('pn_table');
  state = null; actionKey = '';
  history.replaceState(null, '', '/');
  $('menuPanel').classList.add('hidden');
  showGame(false);
};
