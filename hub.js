'use strict';
/**
 * 게임 모음 허브(41ways.github.io/norara)의 채팅 — 같이 할 사람을 찾는 곳.
 *
 * 로보77 서버에 얹혀 있을 뿐, 게임 방·판과는 아무것도 나누지 않는다. 경로도 /hub 로 따로 받는다.
 * 어디에도 저장하지 않는다. 막 들어온 사람이 조금 전의 "로보77 같이 하실 분?" 을 볼 수 있게
 * 최근 말 몇 개만 메모리에 들고 있다가, 서버가 다시 켜지면 그대로 사라진다.
 */
const { WebSocketServer } = require('ws');

const KEEP = 40;                    // 새로 들어온 사람에게 보여 줄 최근 말 수
const KEEP_MS = 6 * 60 * 60 * 1000; // 이보다 오래된 말은 보여 주지 않는다
const GAP_MS = 800;                 // 한 사람이 연달아 칠 수 있는 간격
const MAX_TEXT = 200;
const MAX_NAME = 12;
const MAX_PER_IP = 6;               // 한 곳에서 여는 연결 수 — 탭 몇 개는 되고 도배용 대량 연결은 막힌다
const MAX_CLIENTS = 300;

// 허브 페이지와 로컬 개발에서만 받는다. 남의 페이지가 이 채팅을 퍼 가서 쓰지 못하게.
const ORIGINS = [
  /^https:\/\/41ways\.github\.io$/,
  /^http:\/\/localhost(:\d+)?$/,
  /^http:\/\/127\.0\.0\.1(:\d+)?$/,
];

/** 제어 문자와 겹친 공백을 걷어내고 길이를 자른다 */
function clean(s, n) {
  return String(s == null ? '' : s)
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, n);
}

function ipOf(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.socket.remoteAddress || '?';
}

function createHub() {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 });
  const log = [];
  const perIp = new Map();
  let seq = 0;
  let onlineTimer = null;

  const send = (ws, obj) => {
    if (ws.readyState !== 1 || ws.bufferedAmount > 256 * 1024) return;
    ws.send(JSON.stringify(obj));
  };
  const greeted = () => [...wss.clients].filter(c => c.readyState === 1 && c.greeted);

  // 보낸 사람 표시는 받는 사람마다 따로 계산한다. 연결 열쇠를 남에게 흘리지 않기 위해서다.
  const view = (m, ws) => ({ id: m.id, name: m.name, text: m.text, at: m.at, mine: !!m.key && m.key === ws.key });

  function recent() {
    const cut = Date.now() - KEEP_MS;
    while (log.length && log[0].at < cut) log.shift();
    return log;
  }

  // 사람이 들고 날 때마다 쏘면 여러 명이 한꺼번에 들어올 때 쓸데없이 여러 번 간다. 한 번으로 모은다.
  function pushOnline() {
    if (onlineTimer) return;
    onlineTimer = setTimeout(() => {
      onlineTimer = null;
      const list = greeted();
      for (const c of list) send(c, { t: 'online', n: list.length });
    }, 400);
  }

  function handle(ws, msg) {
    if (msg.t === 'hello') {
      ws.key = clean(msg.key, 40) || null;
      if (ws.greeted) return;
      ws.greeted = true;
      send(ws, { t: 'hist', list: recent().map(m => view(m, ws)), online: greeted().length });
      pushOnline();
      return;
    }
    if (msg.t === 'say') {
      if (!ws.greeted) return;
      const now = Date.now();
      if (now - ws.last < GAP_MS) { send(ws, { t: 'slow' }); return; }
      const text = clean(msg.text, MAX_TEXT);
      if (!text) return;
      ws.last = now;
      const m = { id: ++seq, name: clean(msg.name, MAX_NAME) || '손님', text, at: now, key: ws.key };
      log.push(m);
      while (log.length > KEEP) log.shift();
      for (const c of greeted()) send(c, { t: 'msg', m: view(m, c) });
    }
  }

  wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws.last = 0;
    ws.ip = ipOf(req);
    perIp.set(ws.ip, (perIp.get(ws.ip) || 0) + 1);
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', raw => {
      let msg;
      try { msg = JSON.parse(raw); } catch (_) { return; }
      if (!msg || typeof msg.t !== 'string') return;
      try { handle(ws, msg); } catch (e) { console.error('hub error', e); }
    });
    ws.on('close', () => {
      const n = (perIp.get(ws.ip) || 1) - 1;
      if (n > 0) perIp.set(ws.ip, n); else perIp.delete(ws.ip);
      pushOnline();
    });
  });

  // 끊긴 연결 정리
  const beat = setInterval(() => {
    wss.clients.forEach(ws => {
      if (ws.isAlive === false) return ws.terminate();
      ws.isAlive = false;
      try { ws.ping(); } catch (_) {}
    });
  }, 30_000);
  beat.unref();

  /** 서버의 upgrade 에서 /hub 요청을 넘겨받는다 */
  function handleUpgrade(req, socket, head) {
    const origin = String(req.headers.origin || '');
    const refuse = code => { socket.write(`HTTP/1.1 ${code}\r\n\r\n`); socket.destroy(); };
    if (!ORIGINS.some(re => re.test(origin))) return refuse('403 Forbidden');
    if (wss.clients.size >= MAX_CLIENTS) return refuse('503 Service Unavailable');
    if ((perIp.get(ipOf(req)) || 0) >= MAX_PER_IP) return refuse('429 Too Many Requests');
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  }

  return { handleUpgrade, wss, size: () => greeted().length };
}

module.exports = { createHub, clean };
