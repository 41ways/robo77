'use strict';
/** 규칙이 어긋나면 바로 알 수 있게 — node test/rules.js */

const assert = require('assert');
const R = require('../rules');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ✓ ' + name); };

const card = (tag, v, type) => ({ id: 1, t: type || 'num', v: v || 0, tag });
const st = (sum, first) => ({ sum, firstOfRound: !!first });

console.log('\n덱');

t('56장이다', () => {
  assert.strictEqual(R.makeDeck().length, 56);
});

t('장수 분포가 규칙과 같다', () => {
  const by = {};
  for (const c of R.makeDeck()) by[c.tag] = (by[c.tag] || 0) + 1;
  assert.deepStrictEqual(by, { plain: 32, zero: 4, big: 6, s76: 1, minus: 4, x2: 4, rev: 5 });
});

t('2~9는 각 3장, 10은 8장', () => {
  const deck = R.makeDeck().filter(c => c.tag === 'plain');
  for (let v = 2; v <= 9; v++) {
    assert.strictEqual(deck.filter(c => c.v === v).length, 3, `${v} 카드`);
  }
  assert.strictEqual(deck.filter(c => c.v === 10).length, 8);
});

t('11의 배수 카드는 종류별로 한 장씩', () => {
  const big = R.makeDeck().filter(c => c.tag === 'big').map(c => c.v).sort((a, b) => a - b);
  assert.deepStrictEqual(big, [11, 22, 33, 44, 55, 66]);
});

console.log('\n낼 수 있는가');

t('76은 언제나 낼 수 있다 (터지는 것은 두는 사람 몫)', () => {
  const c = card('s76', 76);
  assert.ok(R.playable(c, st(0)));
  assert.ok(R.playable(c, st(-4)));
  assert.ok(R.playable(c, st(1)));
  assert.ok(R.playable(c, st(50)));
  // 합이 높을 때 내면 스스로 터진다 — 막지 않을 뿐 안전하지는 않다
  assert.strictEqual(R.resolve(c, { sum: 50, dir: 1 }).lost, 'bust');
});

t('×2와 방향전환은 라운드 첫 장으로 못 낸다', () => {
  for (const c of [card('x2', 0, 'x2'), card('rev', 0, 'rev')]) {
    assert.ok(!R.playable(c, st(0, true)));
    assert.ok(R.playable(c, st(0, false)));
  }
});

t('보통 숫자 카드는 언제나 낼 수 있다', () => {
  for (const c of [card('plain', 10), card('zero', 0), card('big', 33), card('minus', -10)]) {
    assert.ok(R.playable(c, st(0, true)));
    assert.ok(R.playable(c, st(70, false)));
  }
});

console.log('\n판정');

t('77 이상이면 터진다', () => {
  assert.strictEqual(R.resolve(card('plain', 10), { sum: 67, dir: 1 }).lost, 'bust');
  assert.strictEqual(R.resolve(card('plain', 9), { sum: 67, dir: 1 }).lost, null);
  assert.strictEqual(R.resolve(card('s76', 76), { sum: 0, dir: 1 }).lost, null); // 76은 아직 살아 있다
});

t('11의 배수는 하트를 잃는다', () => {
  for (const s of [11, 22, 33, 44, 55, 66]) {
    assert.strictEqual(R.resolve(card('plain', 0), { sum: s, dir: 1 }).lost, 'eleven', `합 ${s}`);
  }
});

t('합 0은 11의 배수로 치지 않는다', () => {
  assert.strictEqual(R.resolve(card('zero', 0), { sum: 0, dir: 1 }).lost, null);
  assert.strictEqual(R.resolve(card('minus', -10), { sum: 10, dir: 1 }).lost, null);
});

t('0 카드도 계산을 거치므로 11의 배수에서 내면 죽는다', () => {
  const r = R.resolve(card('zero', 0), { sum: 22, dir: 1 });
  assert.strictEqual(r.sum, 22);
  assert.strictEqual(r.lost, 'eleven');
});

t('방향전환은 계산을 거치지 않아 11의 배수에서도 안전하다', () => {
  const r = R.resolve(card('rev', 0, 'rev'), { sum: 33, dir: 1 });
  assert.strictEqual(r.sum, 33);
  assert.strictEqual(r.dir, -1);
  assert.strictEqual(r.lost, null);
});

t('×2도 합을 건드리지 않고 다음 사람에게 2장을 넘긴다', () => {
  const r = R.resolve(card('x2', 0, 'x2'), { sum: 55, dir: 1 });
  assert.strictEqual(r.sum, 55);
  assert.strictEqual(r.dir, 1);
  assert.strictEqual(r.nextDue, 2);
  assert.strictEqual(r.lost, null);
});

t('-10은 합을 음수로 내릴 수 있다', () => {
  const r = R.resolve(card('minus', -10), { sum: 4, dir: 1 });
  assert.strictEqual(r.sum, -6);
  assert.strictEqual(r.lost, null);
});

t('음수 쪽 11의 배수도 하트를 잃는다', () => {
  assert.strictEqual(R.resolve(card('minus', -10), { sum: -1, dir: 1 }).lost, 'eleven');
});

t('76을 낸 다음 사람은 0 · ×2 · 방향전환이 아니면 죽는다', () => {
  const after = { sum: 76, dir: 1 };
  assert.strictEqual(R.resolve(card('zero', 0), after).lost, null);          // 76은 11의 배수가 아니다
  assert.strictEqual(R.resolve(card('x2', 0, 'x2'), after).lost, null);
  assert.strictEqual(R.resolve(card('rev', 0, 'rev'), after).lost, null);
  for (let v = 2; v <= 10; v++) {
    assert.strictEqual(R.resolve(card('plain', v), after).lost, 'bust', `${v} 카드`);
  }
  // -10 도 살길이 아니다 — 76-10 = 66 이라 11의 배수로 죽는다
  const minus = R.resolve(card('minus', -10), after);
  assert.strictEqual(minus.sum, 66);
  assert.strictEqual(minus.lost, 'eleven');
});

console.log(`\n${n}개 통과\n`);
