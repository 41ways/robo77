/* 실제 시간으로 한 판을 끝까지 두고 기록을 받아 온다.
   --dump-dom 은 페이지가 뜨자마자 DOM 을 쏟아내고 끝나서, 서버가 실시간으로 도는 이 게임은
   판이 시작도 하기 전에 빈 기록을 돌려준다. 그래서 크롬을 디버깅 포트로 띄워 두고
   scene.js 가 판을 끝내고 #qaout 을 채울 때까지 기다렸다가 꺼내 온다.
     node qa/pace-run.js <주소> <저장경로> [최대 기다릴 ms] */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const WebSocket = require('ws');

const [url, out, maxMs = '900000'] = process.argv.slice(2);
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const port = 9300 + Math.floor(Math.random() * 400);
const profile = '/tmp/chrome-pace-' + port;

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--mute-audio',
  '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + port, '--window-size=1100,860',
  '--user-data-dir=' + profile, url,
], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const getJson = path => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port, path }, r => {
    let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
  }).on('error', rej);
});
function bye(code) {
  chrome.kill();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  process.exit(code);
}

(async () => {
  let page = null;
  for (let i = 0; i < 80 && !page; i++) {
    try {
      const list = await getJson('/json');
      page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
    } catch (e) {}
    if (!page) await sleep(250);
  }
  if (!page) { console.error('크롬 탭을 못 찾음'); bye(1); }

  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
  await new Promise(r => ws.on('open', r));
  let id = 0;
  const send = (method, params) => new Promise(res => {
    const myId = ++id;
    const onMsg = m => { const j = JSON.parse(m); if (j.id === myId) { ws.off('message', onMsg); res(j.result); } };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ id: myId, method, params }));
  });
  const read = async () => {
    const r = await send('Runtime.evaluate', {
      expression: "(document.getElementById('qaout') || {}).textContent || ''", returnByValue: true,
    });
    return (r && r.result && r.result.value) || '';
  };

  const end = Date.now() + Number(maxMs);
  let text = '';
  while (!text && Date.now() < end) { await sleep(3000); text = await read(); }
  if (!text) {
    // 판이 안 끝났어도 여태 모은 것은 돌려준다 — 어디서 멈췄는지 알 수 있게
    const r = await send('Runtime.evaluate', { expression: 'JSON.stringify({game:"로보77",ev:[],errs:["시간 안에 판이 끝나지 않음"],done:false})', returnByValue: true });
    text = r.result.value;
  }
  fs.writeFileSync(out, text);
  ws.close();
  bye(0);
})();
