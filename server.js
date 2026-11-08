const path = require('path');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { Table } = require('./src/table');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.send('ok'));

const tables = new Map(); // code -> Table

function newCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  do code = Array.from({ length: 5 }, () => letters[crypto.randomInt(letters.length)]).join('');
  while (tables.has(code));
  return code;
}

// Send each socket its own view: public table state plus only its own hole cards.
function broadcast(table) {
  const room = io.sockets.adapter.rooms.get(table.code);
  if (!room) return;
  for (const id of room) {
    const sock = io.sockets.sockets.get(id);
    if (sock) sock.emit('state', table.view(sock.data.token));
  }
}

function num(v, lo, hi, fallback) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

io.on('connection', (socket) => {
  const reply = (cb, fn) => {
    try { const r = fn(); if (typeof cb === 'function') cb({ ok: true, ...r }); }
    catch (e) { if (typeof cb === 'function') cb({ ok: false, error: e.message }); }
  };
  const current = () => {
    const t = tables.get(socket.data.code);
    if (!t) throw new Error('Table not found — it may have closed.');
    return t;
  };

  socket.on('create', (data, cb) => reply(cb, () => {
    const name = String(data.name || '').trim();
    if (!name) throw new Error('Enter your name.');
    const token = String(data.token || crypto.randomBytes(16).toString('hex'));
    const code = newCode();
    const bb = num(data.bigBlind, 2, 1e6, 10);
    const settings = {
      startingStack: num(data.startingStack, 20, 1e9, 1000),
      bigBlind: bb,
      smallBlind: num(data.smallBlind, 1, bb, Math.floor(bb / 2)),
      turnSeconds: num(data.turnSeconds, 10, 300, 30),
      runItTwice: !!data.runItTwice,
      requireApproval: data.requireApproval !== false,
    };
    const table = new Table({ code, hostToken: token, settings, onUpdate: broadcast });
    tables.set(code, table);
    table.sit(token, name, 0);
    socket.data = { code, token, name };
    socket.join(code);
    broadcast(table);
    return { code, token };
  }));

  // Joining opens the table view. Seated players go straight back to their seat;
  // everyone else picks an empty seat, which the host may need to approve.
  socket.on('join', (data, cb) => reply(cb, () => {
    const code = String(data.code || '').trim().toUpperCase();
    const table = tables.get(code);
    if (!table) throw new Error('No table with that code.');
    const token = String(data.token || crypto.randomBytes(16).toString('hex'));
    const name = String(data.name || '').trim().slice(0, 18);
    const seated = table.playerByToken(token);
    if (!seated && !name) throw new Error('Enter your name.');
    if (seated) seated.connected = true;
    socket.data = { code, token, name: name || (seated && seated.name) };
    socket.join(code);
    broadcast(table);
    return { code, token, seated: !!seated };
  }));

  socket.on('sit', (data, cb) => reply(cb, () => {
    const t = current();
    const r = t.requestSeat(socket.data.token, socket.data.name, data.seat);
    broadcast(t);
    return r;
  }));
  socket.on('cancelRequest', (data, cb) => reply(cb, () => { const t = current(); t.cancelRequest(socket.data.token, data && data.type === 'rebuy' ? 'rebuy' : 'seat'); broadcast(t); }));

  socket.on('action', (data, cb) => reply(cb, () => {
    current().act(socket.data.token, { type: data.type, amount: data.amount });
  }));
  socket.on('pre', (data, cb) => reply(cb, () => { const t = current(); t.setPreAction(socket.data.token, data.type); broadcast(t); }));
  socket.on('away', (data, cb) => reply(cb, () => { const t = current(); t.setAway(socket.data.token, data.on); broadcast(t); }));
  socket.on('show', (_d, cb) => reply(cb, () => { const t = current(); t.showCards(socket.data.token); broadcast(t); }));
  socket.on('rit', (data, cb) => reply(cb, () => { const t = current(); t.ritVote(socket.data.token, data.yes); broadcast(t); }));
  socket.on('rebuy', (_d, cb) => reply(cb, () => { const t = current(); const r = t.rebuy(socket.data.token); broadcast(t); return r; }));

  socket.on('leave', (_d, cb) => reply(cb, () => {
    const t = current();
    t.leave(socket.data.token);
    socket.leave(t.code);
    socket.data = {};
    broadcast(t);
  }));

  socket.on('host', (data, cb) => reply(cb, () => {
    const t = current();
    if (socket.data.token !== t.hostToken) throw new Error('Only the host can do that.');
    if (data.type === 'start') t.setRunning(true);
    else if (data.type === 'pause') t.setRunning(false);
    else if (data.type === 'blinds') t.setBlinds(data.smallBlind, data.bigBlind);
    else if (data.type === 'approve') t.approve(data.id, !!data.ok);
    else if (data.type === 'shuffle') t.shuffleSeats();
    else if (data.type === 'options') t.setOptions({ runItTwice: data.runItTwice, requireApproval: data.requireApproval });
    broadcast(t);
  }));

  socket.on('disconnect', () => {
    const t = tables.get(socket.data && socket.data.code);
    if (!t) return;
    const p = t.playerByToken(socket.data.token);
    // only mark offline if no other tab for this player is still connected
    const room = io.sockets.adapter.rooms.get(t.code);
    const stillHere = room && [...room].some(id => io.sockets.sockets.get(id)?.data.token === socket.data.token);
    if (p && !stillHere) { p.connected = false; broadcast(t); }
  });
});

// Close tables nobody has been connected to for 6 hours.
setInterval(() => {
  for (const [code, t] of tables) {
    const anyone = t.seats.some(p => p && p.connected);
    if (anyone) t.lastSeen = Date.now();
    else if (Date.now() - (t.lastSeen || Date.now()) > 6 * 3600e3) { t.destroy(); tables.delete(code); }
  }
}, 60e3).unref();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Poker Night running on http://localhost:${PORT}`));
