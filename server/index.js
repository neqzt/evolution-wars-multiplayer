// Evolution Wars: schlanker WebSocket-Server für private Lobbys und Lockstep.
import { WebSocketServer } from 'ws';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

const port = Number(process.env.PORT || 8787);
const httpServer = createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify({ service: 'Evolution Wars Multiplayer', status: 'online' }));
});
const wss = new WebSocketServer({ server: httpServer });
const rooms = new Map();
const code = () => randomBytes(4).toString('hex').toUpperCase();
const send = (ws, message) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(message));
const broadcast = (room, message) => room.players.forEach((p) => send(p.ws, message));
const teamCount = (mode) => /^([1-4])v([1-4])$/.test(mode) ? mode.split('v').reduce((a, n) => a + Number(n), 0) : 2;
const publicPlayer = (p) => ({ id: p.id, name: p.name, team: p.team, ready: p.ready, host: p.id === p.room.host });
function lobbyState(room) {
  return { type: 'lobby', code: room.code, host: room.host, config: room.config,
    players: room.players.map(publicPlayer), running: room.running };
}
function update(room) { broadcast(room, lobbyState(room)); }
function leave(player) {
  const room = player?.room;
  if (!room) return;
  console.log(`[leave] ${player.name} left lobby ${room.code}`);
  room.players = room.players.filter((p) => p !== player);
  if (!room.players.length) {
    if (room.timer) clearInterval(room.timer);
    rooms.delete(room.code);
    console.log(`[lobby] ${room.code} closed`);
    return;
  }
  if (room.host === player.id) room.host = room.players[0].id;
  for (const p of room.players) if (p.team !== null && p.team >= teamCount(room.config.mode)) p.team = null;
  update(room);
}
function assignDefaults(room) {
  const total = teamCount(room.config.mode);
  const used = new Set(room.players.map((p) => p.team).filter((t) => t !== null));
  for (const p of room.players) {
    if (p.team === null || p.team >= total) {
      p.team = Array.from({ length: total }, (_, i) => i).find((t) => !used.has(t));
      used.add(p.team);
    }
  }
}
function start(room) {
  assignDefaults(room);
  const assigned = room.players.map((p) => ({ id: p.id, team: p.team, name: p.name }));
  room.running = true;
  room.seed = Math.floor(Math.random() * 1_000_000_000);
  console.log(`[match] ${room.code} started with ${room.players.length} human player(s), ${room.config.mode}`);
  broadcast(room, { type: 'match-start', config: room.config, seed: room.seed, players: assigned, startsAt: Date.now() + 1800 });
  setTimeout(() => {
    if (!room.running) return;
    room.timer = setInterval(() => {
      const commands = room.commands.splice(0);
      broadcast(room, { type: 'tick', commands });
    }, 50);
  }, 1800);
}

wss.on('connection', (ws) => {
  const player = { id: randomBytes(8).toString('hex'), name: 'Spieler', team: null, ready: false, room: null, ws };
  console.log(`[connect] player ${player.id} connected`);
  send(ws, { type: 'welcome', id: player.id });
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'create') {
      if (player.room) leave(player);
      let roomCode; do { roomCode = code(); } while (rooms.has(roomCode));
      const room = { code: roomCode, host: player.id, players: [player], commands: [], running: false, timer: null,
        config: { mode: '1v1', map: 'river-split', difficulty: 'medium', colors: [1, 0] } };
      player.name = String(msg.name || 'Spieler').slice(0, 20); player.team = 0; player.room = room;
      rooms.set(roomCode, room); console.log(`[lobby] ${player.name} created ${roomCode}`); update(room); return;
    }
    if (msg.type === 'join') {
      const room = rooms.get(String(msg.code || '').trim().toUpperCase());
      if (!room || room.running || room.players.length >= 8) return send(ws, { type: 'error', message: 'Lobby nicht gefunden, bereits gestartet oder voll.' });
      if (player.room) leave(player);
      player.name = String(msg.name || 'Spieler').slice(0, 20); player.room = room; player.team = null;
      room.players.push(player); assignDefaults(room); console.log(`[lobby] ${player.name} joined ${room.code}`); update(room); return;
    }
    const room = player.room;
    if (!room) return;
    if (msg.type === 'config' && player.id === room.host && !room.running) {
      const mode = String(msg.config?.mode || room.config.mode);
      if (!/^([1-4])v([1-4])$/.test(mode)) return;
      room.config = { mode, map: ['river-split', 'western-mountain', 'jungle-swamp'].includes(msg.config?.map) ? msg.config.map : room.config.map,
        difficulty: ['easy', 'medium', 'hard', 'extreme'].includes(msg.config?.difficulty) ? msg.config.difficulty : room.config.difficulty,
        colors: Array.isArray(msg.config?.colors) ? msg.config.colors.slice(0, teamCount(mode)) : room.config.colors };
      for (const p of room.players) if (p.team >= teamCount(mode)) p.team = null;
      assignDefaults(room); update(room); return;
    }
    if (msg.type === 'set-team' && player.id === room.host && !room.running) {
      const target = room.players.find((p) => p.id === msg.playerId);
      const team = Number(msg.team);
      if (target && Number.isInteger(team) && team >= 0 && team < teamCount(room.config.mode) && !room.players.some((p) => p !== target && p.team === team)) {
        target.team = team; update(room);
      }
      return;
    }
    if (msg.type === 'ready' && !room.running) { player.ready = !!msg.ready; update(room); return; }
    if (msg.type === 'start' && player.id === room.host && !room.running) { start(room); return; }
    if (msg.type === 'command' && room.running && msg.command && typeof msg.command === 'object') {
      room.commands.push({ playerId: player.id, command: msg.command }); return;
    }
    if (msg.type === 'chat' && typeof msg.text === 'string') broadcast(room, { type: 'chat', name: player.name, text: msg.text.slice(0, 160) });
  });
  ws.on('error', (error) => console.error(`[socket] ${player.name} error: ${error.message}`));
  ws.on('close', (statusCode) => {
    console.log(`[disconnect] ${player.name} closed (${statusCode})`);
    leave(player);
  });
});

httpServer.listen(port, () => console.log(`Evolution Wars server on ${port}`));
