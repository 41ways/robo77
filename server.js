'use strict';
/**
 * 로보77 — 온라인 대전 서버
 *  - 정적 파일 서빙(public/) + WebSocket 게임 서버
 *  - 손패 · 합 · 판정 · 타이머 · 봇은 전부 서버가 쥔다(권위 서버).
 *    클라이언트는 "이 카드 낼래" 만 보내고 나머지는 서버가 정한다.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const R = require('./rules');
const { createHub } = require('./hub');

const PORT = process.env.PORT || 8790;
const PUBLIC = path.join(__dirname, 'public');

const MAX_PLAYERS = 6;
const MIN_PLAYERS = 2;
const TURN_LIMITS = [5000, 10000, 15000, 0];   // 0 = 무제한
// 테스트는 판을 빨리 돌려야 해서 ROBO_FAST=1 로 뜸을 들이지 않게 한다
const FAST = process.env.ROBO_FAST === '1';
const ROUND_PAUSE = FAST ? 60 : 3000;          // 라운드가 끝나고 다음 판이 열리기까지
const OVER_PAUSE = FAST ? 40 : 1200;           // 게임 끝났을 때 (아래 readMs 로 늘어난다)

/* 왜 졌는지 읽을 시간.
   한글 짧은 문구는 눈에 들어오는 데 0.8초 + 글자당 0.07초쯤 걸린다.
   상수로 박아 두면 이름이 길거나 문장이 길 때 모자라므로 글자 수를 세서 정한다. */
function readMs(text, floor) {
  if (FAST) return floor;
  const n = String(text || '').replace(/\s/g, '').length;
  return Math.max(floor, 800 + n * 70);
}
const notePause = (room, floor) =>
  readMs((room.note ? room.note.name + room.note.text : ''), floor);
const DC_GRACE = FAST ? 200 : 4000;            // 접속 끊긴 사람 차례를 넘기기까지

const BOT_NAMES = ['깐돌이', '알밤이', '토실이', '방울이', '뽀리', '멍구'];
// 봇이 너무 빨리 두면 "누구 차례인지 · 몇 장을 내야 하는지"가 읽히기 전에 바뀐다.
// 계측 결과 0.8초짜리 안내가 있어 하한을 1.2초로 올렸다. 사람이 생각하는 속도이기도 하다.
const BOT_THINK = FAST ? [5, 20] : [1200, 2200];

/* ─────────────────────────── 유틸 ─────────────────────────── */

const pick = a => a[Math.floor(Math.random() * a.length)];
const rnd = (min, max) => min + Math.random() * (max - min);
const clean = (s, max) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max);
const token = () => crypto.randomBytes(12).toString('hex');

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* ─────────────────────────── 방 ─────────────────────────── */

const rooms = new Map();

function makeCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 헷갈리는 글자 제외
  let code;
  do {
    code = Array.from({ length: 4 }, () => pick(alphabet.split(''))).join('');
  } while (rooms.has(code));
  return code;
}

function createRoom() {
  const room = {
    code: makeCode(),
    phase: 'lobby',            // lobby | playing | over
    hostId: null,
    players: [],
    nextId: 1,

    cfg: { showSum: true, turnLimit: 10000 },

    round: 0,
    sum: 0,
    dir: 1,                    // 1 = 자리 순서대로, -1 = 거꾸로
    turn: null,                // 지금 낼 차례인 player id
    due: 1,                    // 이번 차례에 남은 장수 (×2 를 받으면 2)
    pendingDue: 1,             // 다음 사람이 내야 할 장수
    firstOfRound: true,
    top: null,                 // 맨 위에 놓인 카드
    starter: null,             // 이번 라운드의 선
    deck: [],
    discard: [],

    turnEndsAt: 0,
    reveal: false,             // 라운드가 끝나 합을 까 보이는 중
    note: null,                // 지금 화면 가운데 띄울 안내
    winner: null,

    timers: { turn: null, round: null, bot: null, dc: null },
    lastActive: Date.now(),
  };
  rooms.set(room.code, room);
  return room;
}

function addPlayer(room, { name, bot }) {
  const p = {
    id: room.nextId++,
    token: token(),
    name: name || `플레이어 ${room.nextId - 1}`,
    bot: !!bot,
    ws: null,
    connected: !!bot,
    hand: [],
    hearts: R.START_HEARTS,
    out: false,
  };
  room.players.push(p);
  if (!p.bot && room.hostId == null) room.hostId = p.id;
  return p;
}

function removePlayer(room, id) {
  const i = room.players.findIndex(p => p.id === id);
  if (i < 0) return;
  const [gone] = room.players.splice(i, 1);
  if (gone.hand.length) room.discard.push(...gone.hand);

  if (room.hostId === gone.id) {
    const next = room.players.find(p => !p.bot && p.connected) || room.players.find(p => !p.bot);
    room.hostId = next ? next.id : null;
  }
  if (room.phase === 'playing') {
    if (room.turn === gone.id) {
      // 나간 사람 차례면 판이 멈추지 않게 다음으로 넘긴다
      room.turn = nextAlive(room, gone.id);
      room.due = 1; room.pendingDue = 1;
      startTurn(room);
    }
    if (alive(room).length < MIN_PLAYERS) finish(room);
  }
}

/* ─────────────────────────── 차례 ─────────────────────────── */

const alive = room => room.players.filter(p => !p.out);

/** fromId 기준으로 방향을 따라 다음 생존자 */
function nextAlive(room, fromId) {
  const n = room.players.length;
  if (!n) return null;
  let i = room.players.findIndex(p => p.id === fromId);
  if (i < 0) i = 0;
  for (let step = 1; step <= n; step++) {
    const j = ((i + room.dir * step) % n + n) % n;
    if (!room.players[j].out) return room.players[j].id;
  }
  return null;
}

const playerOf = (room, id) => room.players.find(p => p.id === id) || null;

/** 손패가 5장이 되게 채운다. 덱이 비면 버린 더미를 섞어 다시 쓴다. */
function refill(room, p) {
  while (p.hand.length < R.HAND_SIZE) {
    if (!room.deck.length) {
      if (!room.discard.length) break;
      room.deck = shuffle(room.discard.splice(0, room.discard.length));
    }
    p.hand.push(room.deck.pop());
  }
}

/** 지금 이 사람이 낼 수 있는 카드가 하나라도 있나 */
function hasPlayable(room, p) {
  const st = { sum: room.sum, firstOfRound: room.firstOfRound };
  return p.hand.some(c => R.playable(c, st));
}

function startTurn(room) {
  clearTimeout(room.timers.turn); room.timers.turn = null;
  clearTimeout(room.timers.bot); room.timers.bot = null;
  clearTimeout(room.timers.dc); room.timers.dc = null;

  const p = playerOf(room, room.turn);
  if (!p || p.out) { pushState(room); return; }

  // 낼 수 있는 카드가 하나도 없으면(라운드 첫 장인데 ×2·방향전환만 쥔 경우) 그대로 하트를 잃는다
  if (!hasPlayable(room, p)) {
    room.turnEndsAt = 0;
    pushState(room);
    setTimeout(() => { if (room.phase === 'playing' && room.turn === p.id) endRound(room, p, 'stuck'); }, 900);
    return;
  }

  room.turnEndsAt = room.cfg.turnLimit ? Date.now() + room.cfg.turnLimit : 0;
  pushState(room);

  if (room.cfg.turnLimit) {
    room.timers.turn = setTimeout(() => {
      if (room.phase === 'playing' && room.turn === p.id) endRound(room, p, 'time');
    }, room.cfg.turnLimit + 250);
  }

  if (p.bot) {
    room.timers.bot = setTimeout(() => botMove(room, p.id), rnd(BOT_THINK[0], BOT_THINK[1]));
  } else if (!p.connected) {
    room.timers.dc = setTimeout(() => {
      if (room.phase === 'playing' && room.turn === p.id) autoPlay(room, p);
    }, DC_GRACE);
  }
}

/* ─────────────────────────── 라운드 ─────────────────────────── */

function newRound(room, starterId) {
  room.round++;
  room.deck = shuffle(R.makeDeck());
  room.discard = [];
  room.sum = 0;
  room.dir = 1;
  room.due = 1;
  room.pendingDue = 1;
  room.firstOfRound = true;
  room.top = null;
  room.reveal = false;
  room.note = null;

  for (const p of room.players) { p.hand = []; if (!p.out) refill(room, p); }

  const living = alive(room);
  let s = playerOf(room, starterId);
  if (!s || s.out) s = living[0];
  room.starter = s ? s.id : null;
  room.turn = room.starter;
  startTurn(room);
}

const LOSS_TEXT = {
  bust:   sum => `합이 ${sum} — 77 이상이 됐다`,
  eleven: sum => `합이 ${sum} — 11의 배수를 밟았다`,
  time:   () => '시간 초과',
  stuck:  () => '낼 수 있는 카드가 없다',
};

/** 하트를 하나 잃고 라운드를 접는다. 하트가 없는 상태에서 잃으면 탈락. */
function endRound(room, p, reason) {
  clearTimeout(room.timers.turn); room.timers.turn = null;
  clearTimeout(room.timers.bot); room.timers.bot = null;
  clearTimeout(room.timers.dc); room.timers.dc = null;

  if (p.hearts > 0) p.hearts--;
  else p.out = true;

  room.reveal = true;   // 왜 죽었는지 보이도록 합을 깐다
  room.turn = null;     // 결과를 보는 동안은 아무의 차례도 아니다
  room.turnEndsAt = 0;
  room.note = { who: p.id, name: p.name, reason, text: LOSS_TEXT[reason](room.sum), out: p.out };
  ev(room, { kind: 'lose', by: p.id, reason, sum: room.sum, out: p.out });
  pushState(room);

  if (alive(room).length < MIN_PLAYERS) {
    // 마지막 라운드다. 여기서 결과 화면으로 서둘러 넘어가면
    // 왜 졌는지를 읽지 못한 채 판이 끝나 버린다.
    room.timers.round = setTimeout(() => finish(room), notePause(room, 2600));
    return;
  }

  // 다음 라운드의 선은 직전 선의 왼쪽 사람 (방향과 무관하게 자리 순서대로)
  const n = room.players.length;
  let i = room.players.findIndex(x => x.id === room.starter);
  if (i < 0) i = 0;
  let nextStarter = null;
  for (let step = 1; step <= n; step++) {
    const cand = room.players[(i + step) % n];
    if (!cand.out) { nextStarter = cand.id; break; }
  }
  room.timers.round = setTimeout(() => {
    if (room.phase === 'playing') newRound(room, nextStarter);
  }, notePause(room, ROUND_PAUSE));
}

function finish(room) {
  clearAll(room);
  room.phase = 'over';
  const left = alive(room);
  room.winner = left.length === 1 ? left[0].id : null;
  room.turn = null;
  room.turnEndsAt = 0;
  room.reveal = true;
  pushState(room);
}

/* ─────────────────────────── 카드 내기 ─────────────────────────── */

function playCard(room, p, cardId) {
  if (room.phase !== 'playing' || room.reveal) return;
  if (room.turn !== p.id) {
    // 내 차례가 아닌데 냈다 — 룰 2번
    if (!p.out) return send(p.ws, { t: 'err', msg: '아직 내 차례가 아니에요.' });
    return;
  }
  const i = p.hand.findIndex(c => c.id === cardId);
  if (i < 0) return;
  const card = p.hand[i];

  if (!R.playable(card, { sum: room.sum, firstOfRound: room.firstOfRound })) {
    return send(p.ws, {
      t: 'err',
      msg: card.tag === 's76' ? '76은 합이 0 이하일 때만 낼 수 있어요.'
                              : '×2와 방향전환은 라운드 첫 장으로 낼 수 없어요.',
    });
  }

  p.hand.splice(i, 1);
  room.discard.push(card);
  room.top = card;
  room.firstOfRound = false;

  const res = R.resolve(card, { sum: room.sum, dir: room.dir });
  room.sum = res.sum;
  room.dir = res.dir;
  if (res.nextDue === 2) room.pendingDue = 2;

  refill(room, p);
  ev(room, { kind: 'play', by: p.id, card, sum: room.sum });

  if (res.lost) return endRound(room, p, res.lost);

  room.due--;
  if (room.due > 0) {           // ×2 를 맞아 아직 더 내야 한다
    startTurn(room);
  } else {
    room.turn = nextAlive(room, p.id);
    room.due = room.pendingDue;
    room.pendingDue = 1;
    startTurn(room);
  }
}

/** 접속이 끊긴 사람 대신 가장 무난한 카드를 낸다 */
function autoPlay(room, p) {
  const choice = chooseCard(room, p);
  if (choice) playCard(room, p, choice.id);
  else endRound(room, p, 'stuck');
}

/* ─────────────────────────── 봇 ─────────────────────────── */

/**
 * 봇의 수 고르기.
 *  1) 죽지 않는 수만 추린다
 *  2) 없으면 어차피 죽으니 아무거나 (76 자폭 포함 — 그게 이 게임의 맛)
 *  3) 남는 수 중에서는 합을 낮게 유지하고 특수 카드를 아끼는 쪽
 */
function chooseCard(room, p) {
  const st = { sum: room.sum, firstOfRound: room.firstOfRound };
  const legal = p.hand.filter(c => R.playable(c, st));
  if (!legal.length) return null;

  const scored = legal.map(c => {
    const res = R.resolve(c, { sum: room.sum, dir: room.dir });
    let score = 0;
    if (res.lost) score -= 1000;
    score -= res.sum * 1.2;                                   // 합은 낮을수록 좋다
    if (c.t === 'x2' || c.t === 'rev') score -= 14;           // 특수 카드는 아껴 둔다
    if (c.tag === 'minus') score -= 6;
    if (c.tag === 'big' && room.sum < 40) score += 22;        // 큰 카드는 여유 있을 때 털어낸다
    if (c.tag === 's76') score -= 40;
    return { c, score: score + Math.random() * 6 };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0].c;
}

function botMove(room, id) {
  const p = playerOf(room, id);
  if (!p || room.phase !== 'playing' || room.turn !== id || room.reveal) return;
  const choice = chooseCard(room, p);
  if (choice) playCard(room, p, choice.id);
  else endRound(room, p, 'stuck');
}

/* ─────────────────────────── 통신 ─────────────────────────── */

function send(ws, obj) {
  if (ws && ws.readyState === 1) {
    try { ws.send(JSON.stringify(obj)); } catch (_) {}
  }
}

/** 합을 지금 보여줘도 되나 — 토글이 꺼져 있으면 라운드가 끝날 때만 깐다 */
const sumVisible = room => room.cfg.showSum || room.reveal || room.phase === 'over';

function stateFor(room, me) {
  const st = { sum: room.sum, firstOfRound: room.firstOfRound };
  return {
    t: 'state',
    code: room.code,
    phase: room.phase,
    hostId: room.hostId,
    cfg: room.cfg,
    max: MAX_PLAYERS,          // 인원 상한은 서버 값 하나만 쓴다 (화면 표기가 어긋나지 않게)
    min: MIN_PLAYERS,
    round: room.round,
    turn: room.turn,
    due: room.due,
    dir: room.dir,
    top: room.top,
    firstOfRound: room.firstOfRound,
    sum: sumVisible(room) ? room.sum : null,
    reveal: room.reveal,
    note: room.note,
    winner: room.winner,
    turnEndsAt: room.turnEndsAt,
    deck: room.deck.length,        // 화면에 덱을 그려 주려고 — 카드가 어디서 오는지 보이게
    discard: room.discard.length,
    now: Date.now(),
    you: me ? me.id : null,
    hand: me ? me.hand.map(c => Object.assign({ ok: R.playable(c, st) }, c)) : [],
    players: room.players.map(p => ({
      id: p.id, name: p.name, bot: p.bot, connected: p.connected,
      hearts: p.hearts, out: p.out, hand: p.hand.length,
    })),
  };
}

function pushState(room) {
  for (const p of room.players) if (!p.bot) send(p.ws, stateFor(room, p));
}
function broadcast(room, obj) {
  for (const p of room.players) if (!p.bot) send(p.ws, obj);
}
const ev = (room, obj) => broadcast(room, Object.assign({ t: 'ev' }, obj));

function clearAll(room) {
  clearTimeout(room.timers.turn); room.timers.turn = null;
  clearTimeout(room.timers.round); room.timers.round = null;
  clearTimeout(room.timers.bot); room.timers.bot = null;
  clearTimeout(room.timers.dc); room.timers.dc = null;
}

/* ─────────────────────────── 메시지 처리 ─────────────────────────── */

function attach(room, p, ws) {
  p.ws = ws; p.connected = true;
  ws.roomCode = room.code; ws.playerId = p.id;
  send(ws, { t: 'welcome', you: p.id, token: p.token, code: room.code });
  pushState(room);
}

function handle(ws, msg) {
  switch (msg.t) {
    case 'create': {
      const r = createRoom();
      const p = addPlayer(r, { name: clean(msg.name, 12) || '플레이어 1' });
      attach(r, p, ws);
      return;
    }
    case 'join': {
      const code = clean(msg.code, 8).toUpperCase();
      const r = rooms.get(code);
      if (!r) return send(ws, { t: 'err', msg: '그런 방이 없어요. 코드를 확인해 주세요.' });
      if (r.phase !== 'lobby') return send(ws, { t: 'err', msg: '이미 시작한 방이에요.' });
      if (r.players.length >= MAX_PLAYERS) return send(ws, { t: 'err', msg: '방이 가득 찼어요.' });
      const p = addPlayer(r, { name: clean(msg.name, 12) || `플레이어 ${r.players.length + 1}` });
      attach(r, p, ws);
      ev(r, { kind: 'joined', by: p.id });
      return;
    }
    case 'resume': {
      const r = rooms.get(clean(msg.code, 8).toUpperCase());
      if (!r) return send(ws, { t: 'err', msg: '방이 사라졌어요.', fatal: true });
      const p = r.players.find(x => x.token === msg.token);
      if (!p) return send(ws, { t: 'err', msg: '자리를 찾을 수 없어요.', fatal: true });
      if (p.ws && p.ws !== ws) { try { p.ws.close(); } catch (_) {} }
      attach(r, p, ws);
      if (r.phase === 'playing' && r.turn === p.id) startTurn(r);
      return;
    }
  }

  const room = rooms.get(ws.roomCode);
  if (!room) return;
  const me = playerOf(room, ws.playerId);
  if (!me) return;
  const isHost = room.hostId === me.id;
  room.lastActive = Date.now();

  switch (msg.t) {
    case 'name':
      me.name = clean(msg.name, 12) || me.name;
      pushState(room);
      break;

    case 'cfg': {
      if (!isHost || room.phase === 'playing') return;
      if (typeof msg.showSum === 'boolean') room.cfg.showSum = msg.showSum;
      if (TURN_LIMITS.includes(msg.turnLimit)) room.cfg.turnLimit = msg.turnLimit;
      pushState(room);
      break;
    }

    case 'addBot': {
      if (!isHost || room.phase === 'playing') return;
      if (room.players.length >= MAX_PLAYERS) return send(ws, { t: 'err', msg: '자리가 없어요.' });
      const used = new Set(room.players.map(p => p.name));
      const name = BOT_NAMES.find(n => !used.has(n)) || `봇 ${room.players.length + 1}`;
      addPlayer(room, { name, bot: true });
      pushState(room);
      break;
    }

    case 'kick': {
      if (!isHost || room.phase === 'playing') return;
      const target = playerOf(room, msg.id);
      if (!target || target.id === room.hostId) return;
      if (target.ws) send(target.ws, { t: 'err', msg: '방장이 내보냈어요.', fatal: true });
      removePlayer(room, target.id);
      pushState(room);
      break;
    }

    case 'start': {
      if (!isHost || room.phase === 'playing') return;
      if (room.players.length < MIN_PLAYERS) {
        return send(ws, { t: 'err', msg: '두 명은 있어야 시작할 수 있어요.' });
      }
      clearAll(room);
      room.phase = 'playing';
      room.round = 0;
      room.winner = null;
      for (const p of room.players) { p.hearts = R.START_HEARTS; p.out = false; p.hand = []; }
      newRound(room, room.players[0].id);
      break;
    }

    case 'play':
      playCard(room, me, msg.id | 0);
      break;

    // 같은 방 사람끼리 하는 잡담. 판정에는 아무 영향이 없고 서버는 저장하지 않는다.
    case 'chat': {
      const text = clean(msg.text, 200);
      if (!text) return;
      const now = Date.now();
      if (now - (me.lastChat || 0) < 400) return;      // 도배 막기
      me.lastChat = now;
      broadcast(room, { t: 'chat', from: me.id, name: me.name, text });
      break;
    }

    case 'again': {
      if (!isHost || room.phase !== 'over') return;
      clearAll(room);
      room.phase = 'lobby';
      room.winner = null;
      room.round = 0;
      room.top = null;
      room.reveal = false;
      room.note = null;
      room.turn = null;
      for (const p of room.players) { p.hearts = R.START_HEARTS; p.out = false; p.hand = []; }
      pushState(room);
      break;
    }

    case 'leave':
      removePlayer(room, me.id);
      ws.roomCode = null; ws.playerId = null;
      send(ws, { t: 'left' });
      pushState(room);
      break;
  }
}

/* ─────────────────────────── HTTP + WS ─────────────────────────── */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let file = decodeURIComponent(url.pathname);

  if (file === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, rooms: rooms.size, hub: hub.size(), rev: (process.env.RENDER_GIT_COMMIT || '').slice(0, 7) || null }));
  }

  if (file === '/') file = '/index.html';
  const full = path.join(PUBLIC, path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
  if (!full.startsWith(PUBLIC)) { res.writeHead(403).end('forbidden'); return; }

  fs.readFile(full, (err, buf) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('없는 페이지입니다'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(full)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(buf);
  });
});

const wss = new WebSocketServer({ noServer: true });
const hub = createHub();

// 한 서버에 소켓 두 갈래 — /hub 는 게임 모음 허브의 채팅, 나머지는 전부 로보77 판.
// 둘 다 server 에 직접 붙이면 서로 상대 경로를 400 으로 끊어 버린다. 그래서 여기서 갈라 준다.
server.on('upgrade', (req, socket, head) => {
  if (new URL(req.url, 'http://x').pathname === '/hub') return hub.handleUpgrade(req, socket, head);
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});

wss.on('connection', ws => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { return; }
    if (!msg || typeof msg.t !== 'string') return;
    try { handle(ws, msg); }
    catch (e) { console.error('handle error', e); }
  });

  ws.on('close', () => {
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    const p = playerOf(room, ws.playerId);
    if (!p) return;
    p.connected = false; p.ws = null;

    if (room.phase === 'lobby') {
      removePlayer(room, p.id);
    } else if (room.phase === 'playing' && room.turn === p.id) {
      clearTimeout(room.timers.dc);
      room.timers.dc = setTimeout(() => {
        if (room.phase === 'playing' && room.turn === p.id) autoPlay(room, p);
      }, DC_GRACE);
    }
    pushState(room);
  });
});

// 끊긴 소켓 정리 + 빈 방 청소
setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch (_) {}
  });
  const now = Date.now();
  for (const [code, room] of rooms) {
    const humans = room.players.filter(p => !p.bot && p.connected).length;
    if (humans === 0 && now - room.lastActive > 90_000) {
      clearAll(room);
      rooms.delete(code);
    }
  }
}, 30_000);

/** 덱 구성이 어긋나면 게임 도중이 아니라 켤 때 바로 터지게 한다 */
function selfCheck() {
  const deck = R.makeDeck();
  if (deck.length !== 56) throw new Error(`덱이 ${deck.length}장입니다 (56장이어야 함)`);
  const by = {};
  for (const c of deck) by[c.tag] = (by[c.tag] || 0) + 1;
  const want = { plain: 32, zero: 4, big: 6, s76: 1, minus: 4, x2: 4, rev: 5 };
  for (const k of Object.keys(want)) {
    if (by[k] !== want[k]) throw new Error(`${k} 카드가 ${by[k] || 0}장입니다 (${want[k]}장이어야 함)`);
  }
  if (MAX_PLAYERS * R.HAND_SIZE > deck.length) throw new Error('최대 인원의 손패가 덱보다 많습니다');
  console.log(`  카드 ${deck.length}장 · 최대 ${MAX_PLAYERS}인 · 하트 ${R.START_HEARTS}개`);
}

server.listen(PORT, () => {
  selfCheck();
  console.log(`로보77 서버 → http://localhost:${PORT}`);
});
