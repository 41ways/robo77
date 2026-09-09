'use strict';
/**
 * 로보77 — 클라이언트
 * 판정은 전부 서버가 한다. 여기서는 화면을 그리고 "이 카드 낼래" 만 보낸다.
 */

const $  = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));

/* ─────────────────────────── 상태 ─────────────────────────── */

let ws = null;
let me = null;            // 내 player id
let S = null;             // 마지막으로 받은 state
let lastSum = 0;
let skew = 0;             // 서버 시계와의 차이
const store = window.sessionStorage;

/* 계측 도구(qa/scene.js)가 상태를 들여다볼 수 있게 최소한만 내놓는다 */
window.__S = () => S;
Object.defineProperty(window, '__me', { get: () => me });

/* ─────────────────────────── 접속 ─────────────────────────── */

function connect(onOpen) {
  if (ws && ws.readyState === 1) { onOpen && onOpen(); return; }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);

  ws.onopen = () => onOpen && onOpen();
  ws.onmessage = e => {
    let m; try { m = JSON.parse(e.data); } catch (_) { return; }
    handle(m);
  };
  ws.onclose = () => {
    if (store.getItem('code') && store.getItem('token')) {
      toast('연결이 끊겼어요. 다시 붙는 중…');
      setTimeout(() => connect(() => send({
        t: 'resume', code: store.getItem('code'), token: store.getItem('token'),
      })), 1200);
    } else {
      show('title');
    }
  };
}

const send = obj => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); };

function handle(m) {
  switch (m.t) {
    case 'welcome':
      me = m.you;
      store.setItem('code', m.code);
      store.setItem('token', m.token);
      history.replaceState(null, '', `?r=${m.code}`);
      break;

    case 'state':
      if (S && (S.round !== m.round || S.phase !== m.phase)) handEls.clear();
      S = m;
      me = m.you != null ? m.you : me;
      if (m.now) skew = m.now - Date.now();   // 서버 시계에 맞춰 남은 시간을 센다
      render();
      break;

    case 'ev':
      if (m.kind === 'joined' && m.by !== me) toast('누가 들어왔어요');
      break;

    case 'err':
      toast(m.msg);
      if (m.fatal) { store.removeItem('code'); store.removeItem('token'); show('title'); }
      break;

    case 'left':
      store.removeItem('code'); store.removeItem('token');
      history.replaceState(null, '', location.pathname);
      show('title');
      break;
  }
}

/* ─────────────────────────── 화면 ─────────────────────────── */

function show(id) {
  $$('.screen').forEach(s => s.classList.toggle('on', s.id === id));
}

let toastT = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('on'), 2400);
}

/* 카드 한 장의 겉모습 */
function cardFace(c) {
  if (c.t === 'x2')  return { cls: 'x2',  v: '×2', n: '다음 2장' };
  if (c.t === 'rev') return { cls: 'rev', v: '↺',  n: '방향전환' };
  if (c.tag === 'minus') return { cls: 'minus', v: '-10', n: '빼기' };
  if (c.tag === 's76')   return { cls: 's76',   v: '76',  n: '합 0 이하' };
  if (c.tag === 'big')   return { cls: 'big',   v: String(c.v), n: '11의 배수' };
  if (c.tag === 'zero')  return { cls: 'zero',  v: '0',   n: '그대로' };
  return { cls: 'plain', v: String(c.v), n: '' };
}

function cardEl(c, { button = false, disabled = false } = {}) {
  const f = cardFace(c);
  const el = document.createElement(button ? 'button' : 'div');
  el.className = `card ${f.cls}`;
  if (button) { el.disabled = disabled; el.dataset.id = c.id; }
  el.innerHTML = `<span class="v">${f.v}</span>${f.n ? `<span class="n">${f.n}</span>` : ''}`;
  return el;
}

const heartsHTML = h => {
  let s = '';
  for (let i = 0; i < 3; i++) s += `<span class="${i < h ? 'on' : 'off'}">♥</span>`;
  return s;
};

/* ─────────────────────────── 그리기 ─────────────────────────── */

function render() {
  if (!S) return;
  if (S.phase === 'lobby') { show('lobby'); renderLobby(); }
  else if (S.phase === 'playing') { show('game'); renderGame(); }
  else if (S.phase === 'over') { show('over'); renderOver(); }
}

function renderLobby() {
  $('#lCode').textContent = S.code;
  $('#lCount').textContent = `${S.players.length} / ${S.max}명`;
  const isHost = S.hostId === me;

  const ul = $('#lPlayers');
  ul.innerHTML = '';
  for (const p of S.players) {
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="av">${(p.name || '?').slice(0, 1)}</span>
      <span class="nm">${esc(p.name)}</span>
      ${p.id === S.hostId ? '<span class="badge host">방장</span>' : ''}
      ${p.bot ? '<span class="badge">봇</span>' : ''}
      ${p.id === me ? '<span class="badge">나</span>' : ''}`;
    if (isHost && p.id !== S.hostId) {
      const x = document.createElement('button');
      x.className = 'x'; x.textContent = '✕'; x.title = '내보내기';
      x.onclick = () => send({ t: 'kick', id: p.id });
      li.appendChild(x);
    }
    ul.appendChild(li);
  }

  $('#lHostBox').classList.toggle('hidden', !isHost);
  $('#lWait').classList.toggle('hidden', isHost);

  $('#tSum').setAttribute('aria-checked', String(S.cfg.showSum));
  $('#sumDesc').textContent = S.cfg.showSum
    ? '합이 화면에 뜬다. 처음이라면 켜 두는 쪽.'
    : '합이 안 보인다. 나온 카드를 보고 직접 세야 한다.';
  $$('#segTime button').forEach(b => b.classList.toggle('on', Number(b.dataset.ms) === S.cfg.turnLimit));

  $('#bStart').disabled = S.players.length < S.min;
  $('#bBot').disabled = S.players.length >= S.max;
}

/* ── 카드가 오가는 모습 ──
   손패를 통째로 다시 그리면 낸 카드도 뽑은 카드도 그냥 "생겨난다".
   id 로 맞춰서 남아 있는 카드는 그대로 두고, 나간 카드는 더미로 날려 보내고,
   새로 들어온 카드는 덱에서 뽑혀 오게 한다. */

const handEls = new Map();     // 카드 id -> 화면 요소
let landAt = 0;                // 날아가는 카드가 더미에 닿는 시각
let topTimer = null;

function renderTop() {
  const top = $('#gTop');
  const draw = () => {
    top.innerHTML = '';
    // 빈 더미를 카드 뒷면으로 그리면 옆의 덱과 똑같이 보여 헷갈린다.
    top.appendChild(S.top ? cardEl(S.top) : Object.assign(document.createElement('div'), {
      className: 'slot-empty', textContent: '아직 없음',
    }));
  };
  clearTimeout(topTimer);
  const wait = landAt - Date.now();
  // 날아가는 카드와 더미 위의 카드가 동시에 보이면 같은 장이 둘로 보인다.
  if (wait > 0) topTimer = setTimeout(draw, wait);
  else draw();
}

function renderHand(myTurn) {
  const wrap = $('#gHand');
  wrap.classList.toggle('off', !myTurn);

  // 손에 카드가 없을 때 — 탈락했거나 라운드 사이다.
  // 자리를 통째로 비워 두면 화면 아래가 허전하니, 남은 사람들의 손패를 뒷면으로 보여 준다.
  if (!S.hand.length) {
    handEls.clear();
    const alive = S.players.filter(p => !p.out);
    wrap.innerHTML =
      '<div class="watch">' +
      alive.map(p =>
        '<div class="watch-p' + (p.id === S.turn ? ' now' : '') + '">' +
        '<p class="watch-n">' + esc(p.name) + '</p>' +
        '<div class="watch-c">' + '<i></i>'.repeat(Math.min(p.hand, 8)) + '</div>' +
        '</div>').join('') +
      '</div>';
    return;
  }
  if (wrap.querySelector('.watch')) wrap.innerHTML = '';

  const now = new Set(S.hand.map(c => c.id));
  for (const [id, el] of Array.from(handEls)) {
    if (now.has(id)) continue;
    handEls.delete(id);
    flyToPile(el);
  }

  let fresh = 0;
  for (const c of S.hand) {
    let el = handEls.get(c.id);
    if (!el) {
      el = cardEl(c, { button: true });
      el.onclick = () => { if (!el.disabled) send({ t: 'play', id: c.id }); };
      el.classList.add('dealt');
      el.style.setProperty('--dl', (fresh++ * 70) + 'ms');
      // 연출이 끝나면 표시를 지운다 — 남겨 두면 상태가 지저분해진다
      el.addEventListener('animationend', () => el.classList.remove('dealt'), { once: true });
      handEls.set(c.id, el);
    }
    el.disabled = !myTurn || !c.ok;
    wrap.appendChild(el);                 // 이미 있으면 자리만 옮긴다
  }

  // 라운드가 바뀌어 기억을 비웠을 때 남아 있던 낱장을 치운다
  const keep = new Set(handEls.values());
  for (const child of Array.from(wrap.children)) if (!keep.has(child)) child.remove();
}

function flyToPile(el) {
  const from = el.getBoundingClientRect();
  const slot = $('#gTop').getBoundingClientRect();
  el.remove();
  if (!from.width || !slot.width) return;

  const g = el.cloneNode(true);
  g.classList.remove('dealt');
  g.classList.add('flying');
  g.disabled = true;
  g.style.cssText = 'position:fixed;margin:0;left:' + from.left + 'px;top:' + from.top +
                    'px;width:' + from.width + 'px;height:' + from.height + 'px';
  document.body.appendChild(g);

  const dx = (slot.left + slot.width / 2) - (from.left + from.width / 2);
  const dy = (slot.top + slot.height / 2) - (from.top + from.height / 2);
  const sc = slot.width / from.width;
  const MS = 380;
  landAt = Date.now() + MS - 40;          // 도착 직전에 더미를 바꾼다
  requestAnimationFrame(() => {
    g.style.transform = 'translate(' + dx + 'px,' + dy + 'px) scale(' + sc + ') rotate(5deg)';
  });
  setTimeout(() => g.remove(), MS + 40);
}

function renderGame() {
  $('#gRound').textContent = `${S.round}라운드`;
  $('#gDir').textContent = S.dir === 1 ? '↻ 정방향' : '↺ 역방향';

  // 자리 — 나를 맨 앞으로 돌려서 순서를 읽기 쉽게 한다
  const list = S.players.slice();
  const i = list.findIndex(p => p.id === me);
  const ordered = i >= 0 ? list.slice(i).concat(list.slice(0, i)) : list;

  const seats = $('#seats');
  seats.innerHTML = '';
  for (const p of ordered) {
    const el = document.createElement('div');
    el.className = 'seat'
      + (p.id === S.turn ? ' turn' : '')
      + (p.out ? ' out' : '')
      + (p.id === me ? ' me' : '');
    el.innerHTML = `
      <span class="av">${(p.name || '?').slice(0, 1)}</span>
      <div class="col">
        <p class="nm">${esc(p.name)}${p.id === me ? ' (나)' : ''}</p>
        <p class="hearts">${p.out ? '<span class="off">탈락</span>' : heartsHTML(p.hearts)}</p>
        <p class="mini-hand" title="손패 ${p.hand}장">${'<i></i>'.repeat(p.hand)}</p>
        ${!p.bot && !p.connected && !p.out ? '<p class="dc">접속 끊김</p>' : ''}
      </div>`;
    seats.appendChild(el);
  }

  // 합
  const sumEl = $('#gSum');
  if (S.sum == null) {
    sumEl.textContent = '?';
    sumEl.className = 'sum hide';
  } else {
    sumEl.textContent = String(S.sum);
    sumEl.className = 'sum' + (S.sum >= 67 ? ' danger' : '');
    if (S.sum !== lastSum) { sumEl.classList.add('pop'); setTimeout(() => sumEl.classList.remove('pop'), 320); }
    lastSum = S.sum;
  }

  // 덱 — 카드가 어디서 오는지 보이게
  const deckEl = $('#gDeck');
  if (deckEl) {
    deckEl.querySelector('.deck-n').textContent = S.deck != null ? S.deck : '';
    deckEl.classList.toggle('empty', S.deck === 0);
  }

  // 손패를 먼저 그린다.
  // 여기서 낸 카드가 날아가기 시작해야, 그 다음 renderTop 이 도착 시각을 알고 기다린다.
  // 순서가 반대면 더미에 카드가 먼저 뜨고 같은 장이 공중에도 떠 있어 둘로 보인다.
  const mine = S.players.find(p => p.id === me);
  const myTurn = S.turn === me && !S.reveal;
  renderHand(myTurn);

  // 맨 위 카드 — 날아가는 카드가 도착한 뒤에 바꾼다
  renderTop();

  // 안내 한 줄
  const cur = S.players.find(p => p.id === S.turn);
  let hint;
  if (mine && mine.out) hint = '탈락했어요. 남은 판을 구경하는 중.';
  else if (myTurn) {
    hint = S.due > 1 ? `<b>내 차례</b> — ×2를 받아서 ${S.due}장을 내야 해요`
                     : '<b>내 차례</b> — 카드를 한 장 고르세요';
    if (S.firstOfRound) hint += ' · 라운드 첫 장이라 ×2·방향전환은 못 내요';
  } else if (cur) {
    hint = `${esc(cur.name)} 차례` + (S.due > 1 ? ` — ${S.due}장을 내야 해요` : '');
  } else hint = '';
  $('#gHint').innerHTML = hint;

  // 라운드 결과
  const note = $('#gNote');
  if (S.note && S.reveal) {
    note.classList.remove('hidden');
    note.querySelector('.note-title').textContent =
      `${S.note.name} ${S.note.out ? '탈락!' : '하트 -1'}`;
    note.querySelector('.note-sub').textContent =
      S.note.text + (S.note.out ? '' : ' · 곧 새 라운드가 시작돼요');
  } else {
    note.classList.add('hidden');
  }
}

function renderOver() {
  $('#gNote').classList.add('hidden');
  const w = S.players.find(p => p.id === S.winner);
  $('#oWinner').textContent = w ? `${w.name} 승리` : '게임 끝';
  $('#oSub').textContent = w && w.id === me ? '끝까지 살아남았어요.' : `${S.round}라운드까지 갔어요.`;
  $('#bAgain').classList.toggle('hidden', S.hostId !== me);
}

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ─────────────────────────── 타이머 링 ─────────────────────────── */

const RING = 2 * Math.PI * 54;

function tick() {
  requestAnimationFrame(tick);
  const fg = $('.ring-fg');
  if (!S || S.phase !== 'playing' || !S.turnEndsAt || S.reveal) {
    fg.style.opacity = '0';   // 무제한이면 링 자체를 지운다 (끝점 점이 남지 않게)
    return;
  }
  fg.style.opacity = '1';
  const total = S.cfg.turnLimit || 1;
  const left = Math.max(0, S.turnEndsAt - (Date.now() + skew));
  const p = Math.min(1, left / total);
  fg.style.strokeDashoffset = String(RING * (1 - p));
  fg.classList.toggle('warn', p <= .5 && p > .25);
  fg.classList.toggle('hot', p <= .25);
}
requestAnimationFrame(tick);

/* ─────────────────────────── 테마 ─────────────────────────── */

/** 라이트가 기본. 고른 값은 다음에 와도 그대로 남는다. */
function setTheme(t) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('theme', t); } catch (_) {}
  const light = t !== 'dark';
  $('#tTheme').setAttribute('aria-checked', String(light));
  $$('[data-theme-toggle]').forEach(b => { b.textContent = light ? '☾' : '☀'; });
}
const curTheme = () => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
const flipTheme = () => setTheme(curTheme() === 'dark' ? 'light' : 'dark');

$('#tTheme').onclick = flipTheme;
$$('[data-theme-toggle]').forEach(b => { b.onclick = flipTheme; });

/* ─────────────────────────── 조작 ─────────────────────────── */

const myName = () => ($('#gName').value || '').trim().slice(0, 12);

$('#bBegin').onclick = () => {
  show('setup');
  setTimeout(() => $('#gName').focus(), 60);
};
$('#bBack').onclick = () => show('title');

$('#bCreate').onclick = () => {
  store.removeItem('code'); store.removeItem('token');
  localStorage.setItem('name', myName());
  connect(() => send({ t: 'create', name: myName() }));
};

function doJoin() {
  const code = ($('#gCode').value || '').trim().toUpperCase();
  if (code.length !== 4) return toast('네 글자 코드를 넣어 주세요.');
  store.removeItem('code'); store.removeItem('token');
  localStorage.setItem('name', myName());
  connect(() => send({ t: 'join', code, name: myName() }));
}
$('#bJoin').onclick = doJoin;
$('#gCode').onkeydown = e => { if (e.key === 'Enter') doJoin(); };
$('#gName').onkeydown = e => { if (e.key === 'Enter') $('#bCreate').click(); };

$('#bCopy').onclick = async () => {
  const url = `${location.origin}${location.pathname}?r=${S.code}`;
  try { await navigator.clipboard.writeText(url); toast('링크를 복사했어요'); }
  catch (_) { toast(url); }
};

$('#tSum').onclick = () => send({ t: 'cfg', showSum: S.cfg.showSum !== true });
$$('#segTime button').forEach(b => {
  b.onclick = () => send({ t: 'cfg', turnLimit: Number(b.dataset.ms) });
});
$('#bBot').onclick = () => send({ t: 'addBot' });
$('#bStart').onclick = () => send({ t: 'start' });
$('#bAgain').onclick = () => send({ t: 'again' });

const leave = () => {
  send({ t: 'leave' });
  store.removeItem('code'); store.removeItem('token');
  history.replaceState(null, '', location.pathname);
  show('title');
};
$('#bLeave1').onclick = leave;
$('#bLeave2').onclick = () => { if (confirm('정말 나갈까요?')) leave(); };
$('#bLeave3').onclick = leave;

/* 도움말 */
const openHelp = () => $('#help').classList.remove('hidden');
$$('[data-help]').forEach(b => b.onclick = openHelp);
$('#bHelpX').onclick = () => $('#help').classList.add('hidden');
$('#help').onclick = e => { if (e.target.id === 'help') $('#help').classList.add('hidden'); };
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') $('#help').classList.add('hidden');
  if (e.key === '?' || (e.key === '/' && e.shiftKey)) openHelp();
});
$$('#helpTabs button').forEach(b => {
  b.onclick = () => {
    $$('#helpTabs button').forEach(x => x.classList.toggle('on', x === b));
    $$('.tabpage').forEach(p => p.classList.toggle('on', p.dataset.page === b.dataset.tab));
  };
});

/* 숫자키로도 카드를 낼 수 있게 */
document.addEventListener('keydown', e => {
  if (!S || S.phase !== 'playing' || S.turn !== me || S.reveal) return;
  if (e.target.tagName === 'INPUT') return;
  const n = Number(e.key);
  if (!n || n < 1 || n > S.hand.length) return;
  const c = S.hand[n - 1];
  if (c && c.ok) send({ t: 'play', id: c.id });
});

/* ─────────────────────────── 시작 ─────────────────────────── */

setTheme(localStorage.getItem('theme') || 'light');
$('#gName').value = localStorage.getItem('name') || '';

const invited = new URLSearchParams(location.search).get('r');
if (invited) $('#gCode').value = invited.toUpperCase().slice(0, 4);

// 새로고침해도 자리를 지킨다
if (store.getItem('code') && store.getItem('token')) {
  connect(() => send({ t: 'resume', code: store.getItem('code'), token: store.getItem('token') }));
} else if (invited) {
  show('setup');   // 초대 링크로 왔으면 코드가 채워진 채로 바로 방 고르기
} else {
  show('title');
}
