/* 연출 속도 재기 — ?qa=pace 로 들어오면 방을 만들고 봇을 채워 한 판을 끝까지 둔다.
   내 자리는 사람처럼 잠깐 뜸을 들였다가 낼 수 있는 카드를 낸다.
   서버가 실제 시간으로 돌리므로 여기서 잰 값은 사람이 실제로 겪는 시간이다.
   평소에는 index.html 의 한 줄이 이 파일을 아예 부르지 않는다. */
(function () {
  var q = new URLSearchParams(location.search);
  if (q.get('qa') !== 'pace') return;

  var out = { game: '로보77', n: q.get('n') || '2', ev: [], errs: [], done: false };
  window.onerror = function (m, s, l) { out.errs.push(m + ' @' + l); };

  var pre = document.createElement('pre');
  pre.id = 'qaout'; pre.style.display = 'none';
  document.body.appendChild(pre);

  var T0 = performance.now();
  function at() { return Math.round(performance.now() - T0); }
  function span(k, w, on, mine) {
    out.ev.push({ t: at(), k: k, w: w, on: on ? 1 : 0, mine: mine ? 1 : 0 });
  }
  function finish(why) {
    if (out.done) return;
    out.done = true; out.why = why;
    pre.textContent = JSON.stringify(out);
    document.title = 'QA DONE';
  }

  function el(id) { return document.getElementById(id); }
  function ready(fn) { el('bBegin') ? fn() : setTimeout(function () { ready(fn); }, 30); }

  ready(function () {
    el('bBegin').click();
    el('gName').value = '민수';
    el('bCreate').click();

    setTimeout(function () {
      var bots = Math.max(1, parseInt(out.n, 10) - 1);
      for (var i = 0; i < bots; i++) el('bBot').click();
      setTimeout(function () { el('bStart').click(); watch(); }, 700);
    }, 1200);
  });

  function watch() {
    var st = { hint: '', note: '', turn: '' };
    var lastPlay = 0;

    // 시간은 MutationObserver 로 잰다.
    // setInterval 은 배경 탭에서 1초로 묶이지만 관찰자는 바뀌는 즉시 불린다.
    function sample() {
      var S = window.__S && window.__S();
      var mineTurn = !!(S && S.turn === window.__me && !S.reveal);

      var hEl = el('gHint');
      var h = hEl ? hEl.textContent.trim() : '';
      if (h !== st.hint) {
        if (st.hint) span('hint', st.hint, 0, st.hintMine);
        st.hint = h; st.hintMine = mineTurn;
        if (h) span('hint', h, 1, mineTurn);
      }

      var noteEl = el('gNote');
      var shown = noteEl && !noteEl.classList.contains('hidden');
      var noteTxt = shown ? noteEl.textContent.trim().replace(/\s+/g, ' ') : '';
      if (noteTxt !== st.note) {
        if (st.note) span('note', st.note, 0, 0);
        st.note = noteTxt;
        if (noteTxt) span('note', noteTxt, 1, 0);
      }

      if (!S) return;
      var tk = S.phase + '/' + S.round + '/' + S.turn;
      if (tk !== st.turn) { st.turn = tk; span('turn', tk, 1, 0); }
      if (S.phase === 'over') { finish('판 종료'); }
    }

    var mo = new MutationObserver(sample);
    mo.observe(document.getElementById('game'),
               { subtree: true, childList: true, characterData: true, attributes: true });
    sample();

    // 내 차례면 사람처럼 잠깐 있다가 낸다 (이 주기는 정밀할 필요가 없다)
    window.__qaPlay = setInterval(function () {
      if (out.done) { clearInterval(window.__qaPlay); mo.disconnect(); return; }
      var S = window.__S && window.__S();
      if (!S || S.turn !== window.__me || S.reveal) return;
      if (Date.now() - lastPlay < 600) return;
      var ok = [].slice.call(document.querySelectorAll('#gHand .card'))
                 .filter(function (c) { return !c.disabled; });
      if (ok.length) { lastPlay = Date.now(); ok[0].click(); }
    }, 500);
  }

})();
