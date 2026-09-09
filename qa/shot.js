/* 실제 시간을 기다렸다가 화면을 찍는다.
   서버가 실시간으로 도는 게임은 --virtual-time-budget 으로는 로비까지밖에 못 간다.
   그래서 크롬을 디버깅 포트로 띄우고, 판이 벌어질 만큼 기다린 뒤 캡처한다.
     node qa/shot.js <주소> <저장경로> <기다릴ms> [가로] [세로] */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const WebSocket = require('ws');

const [url, out, waitMs, W = '1440', H = '900'] = process.argv.slice(2);
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const port = 9300 + Math.floor(Math.random() * 400);
const profile = '/tmp/chrome-shot-' + port;

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--mute-audio',
  '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + port, '--window-size=' + W + ',' + H,
  '--user-data-dir=' + profile, url,
], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const getJson = path => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port, path }, r => {
    let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
  }).on('error', rej);
});

(async () => {
  let page = null;
  for (let i = 0; i < 80 && !page; i++) {
    try {
      const list = await getJson('/json');
      page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
    } catch (e) {}
    if (!page) await sleep(250);
  }
  if (!page) { console.error('크롬 탭을 못 찾음'); chrome.kill(); process.exit(1); }

  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
  await new Promise(r => ws.on('open', r));
  let id = 0;
  const send = (method, params) => new Promise(res => {
    const myId = ++id;
    const onMsg = m => { const j = JSON.parse(m); if (j.id === myId) { ws.off('message', onMsg); res(j.result); } };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ id: myId, method, params }));
  });

  await sleep(Number(waitMs));                       // 판이 벌어질 때까지 실제로 기다린다
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(out, Buffer.from(r.data, 'base64'));
  console.log('찍음:', out);
  ws.close(); chrome.kill();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  process.exit(0);
})();
