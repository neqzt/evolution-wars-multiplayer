// Evolution Wars: schlanker WebSocket-Server für private Lobbys und Lockstep.
// Start: npm run server  (optional: PORT=8787 npm run server)
import { WebSocketServer } from 'ws';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

const port = Number(process.env.PORT || 8787);
const MULTIPLAYER_PROTOCOL = 'ew-2026-07-23-sync-v11';
const SYNC_PARTS = ['core', 'teams', 'units', 'buildings', 'projectiles', 'world', 'timers'];
// Ein normaler HTTP-Endpunkt ist wichtig für Cloud-Hosts: Er dient als
// Health-Check, die WebSocket-Verbindungen werden auf demselben Port erweitert.
const httpServer = createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify({ service: 'Evolution Wars Multiplayer', status: 'online' }));
});
const wss = new WebSocketServer({ server: httpServer, maxPayload: 32 * 1024 });
const rooms = new Map();
const code = () => randomBytes(4).toString('hex').toUpperCase();
const COMMAND_TYPES = new Set(['move', 'explore', 'gather', 'mine', 'build', 'placeBuilding', 'produce', 'setRally', 'trade',
  'specialize', 'research', 'attack', 'attackBuilding', 'garrison', 'garrisonTower', 'militia', 'ungarrison',
  'advanceAge', 'chooseAgeReward', 'chooseStartReward', 'setBuildOrderMode', 'deployTowerWagon', 'deployHutWagon',
  'setVillageReward', 'claimTreasure', 'repair', 'demolish', 'mapPing', 'aiGrant', 'aiResetUnits']);
const AI_ONLY_COMMANDS = new Set(['aiGrant', 'aiResetUnits']);
function validCommand(command) {
  if (!command || typeof command !== 'object' || !COMMAND_TYPES.has(command.type)) return false;
  for (const key of ['ids', 'builderIds', 'workerIds']) {
    if (command[key] !== undefined && (!Array.isArray(command[key]) || command[key].length > 256 ||
        command[key].some((id) => !Number.isInteger(id) || id < 0))) return false;
  }
  return JSON.stringify(command).length <= 12_000;
}
const send = (ws, message) => {
  if (!ws || ws.readyState !== 1) return false;
  ws.send(JSON.stringify(message));
  return true;
};
const broadcast = (room, message) => room.players.forEach((p) => send(p.ws, message));
const resetReady = (room) => room.players.forEach((p) => { p.ready = false; });
const modeCounts = (mode) => /^([1-4])v([1-4])$/.test(mode) ? mode.split('v').map(Number) : [1, 1];
const teamCount = (mode) => modeCounts(mode).reduce((sum, count) => sum + count, 0);
const defaultColors = (mode) => {
  const [left, right] = modeCounts(mode);
  return [1, 6, 7, 3].slice(0, left).concat([0, 4, 5, 2].slice(0, right));
};
const publicPlayer = (p) => ({ id: p.id, name: p.name, side: p.side, color: p.color, ready: p.ready, host: p.id === p.room.host });
function visibleAi(room) {
  return room.ais || [];
}
function normalizeLobby(room) {
  assignSides(room);
  const capacities = modeCounts(room.config.mode), humanCounts = [0, 0];
  for (const player of room.players) humanCounts[player.side]++;
  const aiTargets = capacities.map((capacity, side) => capacity - humanCounts[side]);
  room.ais ||= [];
  room.aiSeq ||= 1;
  while (room.ais.length > aiTargets[0] + aiTargets[1]) {
    const aiCounts = [0, 0]; room.ais.forEach((ai) => aiCounts[ai.side]++);
    const excessSide = aiCounts[0] > aiTargets[0] ? 0 : aiCounts[1] > aiTargets[1] ? 1 : room.ais.at(-1).side;
    const index = room.ais.findLastIndex((ai) => ai.side === excessSide);
    room.ais.splice(index, 1);
  }
  while (room.ais.length < aiTargets[0] + aiTargets[1]) {
    const aiCounts = [0, 0]; room.ais.forEach((ai) => aiCounts[ai.side]++);
    const side = aiCounts[0] < aiTargets[0] ? 0 : 1;
    room.ais.push({ id: `ai-${room.aiSeq++}`, side, color: -1, name: `KI ${room.aiSeq - 1}` });
  }
  for (let side = 0; side < 2; side++) {
    while (room.ais.filter((ai) => ai.side === side).length > aiTargets[side]) {
      const ai = room.ais.findLast((entry) => entry.side === side);
      ai.side = 1 - side;
    }
  }
  const used = new Set();
  for (const player of room.players) {
    if (!Number.isInteger(player.color) || player.color < 0 || player.color > 7 || used.has(player.color)) {
      player.color = Array.from({ length: 8 }, (_, color) => color).find((color) => !used.has(color)) ?? 0;
    }
    used.add(player.color);
  }
  const preferred = defaultColors(room.config.mode);
  for (const ai of room.ais) {
    if (!Number.isInteger(ai.color) || ai.color < 0 || ai.color > 7 || used.has(ai.color)) {
      ai.color = preferred.find((color) => !used.has(color)) ?? Array.from({ length: 8 }, (_, color) => color).find((color) => !used.has(color)) ?? 0;
    }
    used.add(ai.color);
  }
  const colors = [];
  for (let side = 0; side < 2; side++) {
    for (const human of room.players.filter((entry) => entry.side === side)) colors.push(human.color);
    for (const ai of room.ais.filter((entry) => entry.side === side)) colors.push(ai.color);
  }
  room.config.colors = colors;
}
function lobbyState(room) {
  normalizeLobby(room);
  return { type: 'lobby', code: room.code, host: room.host, config: room.config,
    players: room.players.map(publicPlayer), ais: visibleAi(room), running: room.running };
}
function update(room) { broadcast(room, lobbyState(room)); }
function applyRoomConfig(room, input) {
  const mode = String(input?.mode || room.config.mode);
  if (!/^([1-4])v([1-4])$/.test(mode)) return { ok: false };
  if (teamCount(mode) < room.players.length) return { ok: false, message: 'Dieser Modus hat zu wenige Plätze für die aktuelle Lobby.' };
  room.config = {
    mode,
    map: ['river-split', 'western-mountain', 'winterland', 'jungle-swamp', 'the-island'].includes(input?.map) ? input.map : room.config.map,
    difficulty: ['easy', 'medium', 'hard', 'extreme'].includes(input?.difficulty) ? input.difficulty : room.config.difficulty,
    colors: Array.isArray(input?.colors) ? input.colors.slice(0, teamCount(mode)) : room.config.colors,
    fog: !!input?.fog,
  };
  normalizeLobby(room);
  resetReady(room);
  return { ok: true };
}
function leave(player) {
  const room = player?.room;
  if (!room) return;
  console.log(`[leave] ${player.name} left lobby ${room.code}`);
  room.players = room.players.filter((p) => p !== player);
  if (!room.players.length) {
    if (room.timer) clearInterval(room.timer);
    rooms.delete(room.code);
    console.log(`[lobby] ${room.code} closed`);
    if (process.env.EW_TEST_ONCE === '1') {
      setTimeout(() => httpServer.close(() => process.exit(0)), 0);
    }
    return;
  }
  if (room.host === player.id) room.host = room.players[0].id;
  assignSides(room);
  update(room);
}
function assignSides(room) {
  const capacities = modeCounts(room.config.mode);
  const counts = [0, 0];
  for (const player of room.players) {
    let side = player.side === 1 ? 1 : 0;
    if (counts[side] >= capacities[side] && counts[1 - side] < capacities[1 - side]) side = 1 - side;
    player.side = side;
    counts[side]++;
  }
}
function assignMatchSlots(room) {
  assignSides(room);
  const [left] = modeCounts(room.config.mode);
  const nextSlot = [0, left];
  return room.players.map((player) => ({
    id: player.id,
    team: nextSlot[player.side]++,
    side: player.side,
    color: player.color,
    name: player.name,
  }));
}
function buildMatchColors(room, assigned) {
  const total = teamCount(room.config.mode);
  normalizeLobby(room);
  const colors = room.config.colors.slice(0, total);
  for (const entry of assigned) colors[entry.team] = entry.color;
  return colors;
}
function beginTicks(room) {
  if (!room.running || room.timer || room.startBlocked) return;
  room.timer = setInterval(() => {
    const commands = room.commands.splice(0);
    const tick = { type: 'tick', seq: ++room.tickSeq, commands };
    room.tickHistory.push(tick);
    if (room.tickHistory.length > 2400) room.tickHistory.shift();
    broadcast(room, tick);
  }, 50);
  broadcast(room, { type: 'match-ready', seq: 0 });
}
function start(room) {
  const assigned = assignMatchSlots(room);
  for (const slot of assigned) {
    const owner = room.players.find((entry) => entry.id === slot.id);
    if (owner) owner.matchTeam = slot.team;
  }
  room.config.colors = buildMatchColors(room, assigned);
  room.running = true;
  room.tickSeq = 0;
  room.tickHistory = [];
  room.syncReports = new Map();
  room.startBlocked = false;
  room.seed = Math.floor(Math.random() * 1_000_000_000);
  console.log(`[match] ${room.code} started with ${room.players.length} human player(s), ${room.config.mode}`);
  broadcast(room, { type: 'match-start', config: room.config, seed: room.seed, players: assigned, host: room.host });
}

wss.on('connection', (ws) => {
  let player = { id: randomBytes(8).toString('hex'), token: randomBytes(24).toString('hex'), name: 'Spieler', side: 0, color: 0, ready: false, room: null, ws };
  console.log(`[connect] player ${player.id} connected`);
  send(ws, { type: 'welcome', id: player.id, token: player.token, protocol: MULTIPLAYER_PROTOCOL });
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (['create', 'join', 'resume'].includes(msg.type) && msg.protocol !== MULTIPLAYER_PROTOCOL) {
      return send(ws, { type: 'error', code: 'version-mismatch', message: 'Andere Spielversion erkannt. Alle Spieler müssen dieselbe aktuelle Evolution-Wars-HTML verwenden.' });
    }
    if (msg.type === 'resume') {
      const room = rooms.get(String(msg.code || '').trim().toUpperCase());
      const existing = room?.players.find((entry) => entry.token === msg.token);
      if (!room?.running || !existing) return send(ws, { type: 'resume-failed' });
      player = existing; player.ws = ws; player.disconnectedAt = null;
      const lastTick = Math.max(0, Number(msg.lastTick) || 0);
      const firstAvailable = room.tickHistory[0]?.seq ?? room.tickSeq;
      if (lastTick < firstAvailable - 1) return send(ws, { type: 'resync-required' });
      send(ws, { type: 'resumed', id: player.id, team: player.matchTeam, currentTick: room.tickSeq });
      for (const tick of room.tickHistory) if (tick.seq > lastTick) send(ws, tick);
      return;
    }
    if (msg.type === 'create') {
      if (player.room) leave(player);
      let roomCode; do { roomCode = code(); } while (rooms.has(roomCode));
      const room = { code: roomCode, host: player.id, players: [player], ais: [], aiSeq: 1, commands: [], running: false, timer: null,
        config: { mode: '1v1', map: 'river-split', difficulty: 'medium', colors: [1, 0], fog: false } };
      player.name = String(msg.name || 'Spieler').slice(0, 20); player.side = 0; player.color = 1; player.room = room;
      rooms.set(roomCode, room); console.log(`[lobby] ${player.name} created ${roomCode}`); update(room); return;
    }
    if (msg.type === 'join') {
      const room = rooms.get(String(msg.code || '').trim().toUpperCase());
      if (!room || room.running || room.players.length >= teamCount(room?.config?.mode || '1v1')) return send(ws, { type: 'error', message: 'Lobby nicht gefunden, bereits gestartet oder für diesen Modus voll.' });
      if (player.room) leave(player);
      player.name = String(msg.name || 'Spieler').slice(0, 20); player.room = room;
      player.side = room.players.filter((entry) => entry.side === 0).length < modeCounts(room.config.mode)[0] ? 0 : 1;
      player.color = -1; room.players.push(player); normalizeLobby(room);
      normalizeLobby(room); console.log(`[lobby] ${player.name} joined ${room.code}`); update(room); return;
    }
    const room = player.room;
    if (!room) return;
    if (msg.type === 'config' && player.id === room.host && !room.running) {
      const result = applyRoomConfig(room, msg.config);
      if (!result.ok) return result.message ? send(ws, { type: 'error', message: result.message }) : undefined;
      update(room); return;
    }
    if (msg.type === 'config-hint' && player.id === room.host && !room.running) {
      const map = String(msg.map || '');
      if (['river-split', 'western-mountain', 'winterland', 'jungle-swamp', 'the-island'].includes(map)) {
        broadcast(room, { type: 'config-hint', playerId: player.id, map });
      }
      return;
    }
    if ((msg.type === 'set-side' || msg.type === 'set-team') && !room.running) {
      const target = room.players.find((p) => p.id === msg.playerId);
      const side = Number(msg.side ?? msg.team);
      const capacities = modeCounts(room.config.mode);
      const occupied = room.players.filter((entry) => entry !== target && entry.side === side).length;
      if (target && (player.id === room.host || player.id === target.id) && (side === 0 || side === 1) && occupied < capacities[side]) {
        target.side = side; resetReady(room); normalizeLobby(room); update(room);
      } else if (target && player.id === target.id) {
        send(ws, { type: 'error', message: `${side === 0 ? 'Team 1' : 'Team 2'} ist bereits voll.` }); update(room);
      }
      return;
    }
    if (msg.type === 'set-color' && !room.running) {
      const color = Number(msg.color);
      if (Number.isInteger(color) && color >= 0 && color <= 7) {
        const other = room.players.find((entry) => entry !== player && entry.color === color);
        if (other) { send(ws, { type: 'error', message: 'Diese Farbe wird bereits von einem anderen Spieler verwendet.' }); update(room); return; }
        const ai = visibleAi(room).find((entry) => entry.color === color);
        if (ai) ai.color = player.color;
        player.color = color;
        resetReady(room);
        normalizeLobby(room); update(room);
      }
      return;
    }
    if (msg.type === 'set-ai-color' && player.id === room.host && !room.running) {
      const color = Number(msg.color);
      const ai = visibleAi(room).find((entry) => entry.id === msg.aiId || entry.id === `ai-${msg.slot}`);
      if (!ai || !Number.isInteger(color) || color < 0 || color > 7) return;
      if (room.players.some((entry) => entry.color === color)) {
        send(ws, { type: 'error', message: 'Diese Farbe gehört bereits einem Spieler.' }); update(room); return;
      }
      const otherAi = visibleAi(room).find((entry) => entry.id !== ai.id && entry.color === color);
      if (otherAi) otherAi.color = ai.color;
      ai.color = color; resetReady(room); normalizeLobby(room); update(room); return;
    }
    if (msg.type === 'set-ai-side' && player.id === room.host && !room.running) {
      const side = Number(msg.side);
      const ai = visibleAi(room).find((entry) => entry.id === msg.aiId || entry.id === `ai-${msg.slot}`);
      if (!ai || (side !== 0 && side !== 1) || ai.side === side) return update(room);
      const swap = visibleAi(room).find((entry) => entry.side === side);
      if (!swap) { send(ws, { type: 'error', message: `${side === 0 ? 'Team 1' : 'Team 2'} hat keinen freien KI-Platz.` }); update(room); return; }
      swap.side = ai.side; ai.side = side; resetReady(room); normalizeLobby(room); update(room); return;
    }
    if (msg.type === 'ready' && !room.running) {
      player.ready = !!msg.ready;
      update(room);
      if (player.ready && room.players.length > 0 && room.players.every((p) => p.ready)) start(room);
      return;
    }
    if (msg.type === 'start' && player.id === room.host && !room.running) {
      const result = applyRoomConfig(room, msg.config || room.config);
      if (!result.ok) return result.message ? send(ws, { type: 'error', message: result.message }) : undefined;
      start(room); return;
    }
    if (msg.type === 'command' && room.running && !AI_ONLY_COMMANDS.has(msg.command?.type) && validCommand(msg.command) && Number.isInteger(player.matchTeam)) {
      room.commands.push({ playerId: player.id, team: player.matchTeam, command: msg.command }); return;
    }
    if (msg.type === 'ai-command' && room.running && player.id === room.host && validCommand(msg.command)) {
      const aiTeam = Number(msg.command.team);
      const humanOwnsTeam = room.players.some((entry) => entry.matchTeam === aiTeam);
      if (Number.isInteger(aiTeam) && aiTeam >= 0 && aiTeam < teamCount(room.config.mode) && !humanOwnsTeam) {
        room.commands.push({ playerId: player.id, team: aiTeam, command: msg.command });
      }
      return;
    }
    if (msg.type === 'replay' && room.running) {
      const now = Date.now();
      if (now - (player.lastReplayAt || 0) < 400) return;
      player.lastReplayAt = now;
      const lastTick = Math.max(0, Math.min(room.tickSeq, Number(msg.lastTick) || 0));
      const firstAvailable = room.tickHistory[0]?.seq ?? room.tickSeq;
      if (lastTick < firstAvailable - 1) return send(ws, { type: 'resync-required' });
      for (const tick of room.tickHistory) if (tick.seq > lastTick) send(ws, tick);
      return;
    }
    if (msg.type === 'sync-state' && room.running) {
      const seq = Number(msg.seq);
      const hash = typeof msg.hash === 'string' ? msg.hash.slice(0, 16) : '';
      if (!Number.isInteger(seq) || seq < Math.max(0, room.tickSeq - 600) || seq > room.tickSeq || !/^[0-9a-f]{8,16}$/i.test(hash)) return;
      const parts = {};
      for (const key of SYNC_PARTS) {
        const value = msg.parts?.[key];
        if (typeof value === 'string' && /^[0-9a-f]{8,16}$/i.test(value)) parts[key] = value;
      }
      let reports = room.syncReports.get(seq);
      if (!reports) { reports = new Map(); room.syncReports.set(seq, reports); }
      reports.set(player.id, { hash, parts });
      // Vor Tick 1 müssen ausnahmslos alle gestarteten Spieler verbunden sein
      // und dieselbe fertig aufgebaute Welt melden.
      const participants = seq === 0
        ? room.players
        : room.players.filter((entry) => entry.ws && entry.ws.readyState === 1);
      if (participants.length > 1 && participants.every((entry) => reports.has(entry.id))) {
        const hashes = new Set(participants.map((entry) => reports.get(entry.id).hash));
        if (hashes.size > 1) {
          console.error(`[desync] ${room.code} at tick ${seq}`);
          const differingParts = SYNC_PARTS.filter((key) =>
            new Set(participants.map((entry) => reports.get(entry.id).parts[key]).filter(Boolean)).size > 1);
          const detail = differingParts.length ? ` Abweichend: ${differingParts.join(', ')}.` : '';
          room.startBlocked = true;
          if (room.timer) { clearInterval(room.timer); room.timer = null; }
          broadcast(room, { type: 'sync-error', seq, message: seq === 0
            ? `Unterschiedliche Ausgangswelten erkannt.${detail} Die Partie wurde vor Tick 1 angehalten. Alle Spieler müssen die aktuelle HTML neu öffnen.`
            : `Synchronisationsfehler bei Tick ${seq}.${detail} Die Partie wurde angehalten, damit niemand einen anderen Spielverlauf sieht.` });
        } else if (seq === 0) {
          beginTicks(room);
        }
        room.syncReports.delete(seq);
      }
      for (const oldSeq of room.syncReports.keys()) if (oldSeq < room.tickSeq - 600) room.syncReports.delete(oldSeq);
      return;
    }
    if (msg.type === 'chat' && typeof msg.text === 'string') broadcast(room, { type: 'chat', name: player.name, text: msg.text.slice(0, 160) });
  });
  ws.on('error', (error) => console.error(`[socket] ${player.name} error: ${error.message}`));
  ws.on('close', (statusCode) => {
    console.log(`[disconnect] ${player.name} closed (${statusCode})`);
    if (player.ws !== ws) return;
    if (player.room?.running) {
      player.ws = null;
      player.disconnectedAt = Date.now();
    } else leave(player);
  });
});

// Tote WebSocket-Verbindungen früh erkennen. Der Browser verbindet danach mit
// seinem Token neu und lässt alle fehlenden Lockstep-Ticks erneut abspielen.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 15_000);
wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
});
httpServer.on('close', () => clearInterval(heartbeat));

httpServer.listen(port, () => console.log(`Evolution Wars Multiplayer-Server läuft auf ws://localhost:${port}`));
