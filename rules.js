'use strict';
/**
 * 로보77 — 규칙만 담은 순수 모듈.
 * 서버와 테스트가 같은 판정을 쓰도록 여기 한 곳에만 둔다. 상태를 직접 바꾸지 않는다.
 */

const START_HEARTS = 3;   // 시작 하트
const HAND_SIZE    = 5;   // 손에 늘 유지하는 장수
const BUST         = 77;  // 이 값 이상이면 터진다

/* 카드 한 장 = { id, t, v, tag }
     t   … 'num' 합에 더한다 · 'x2' 다음 사람이 2장 · 'rev' 방향전환
     v   … 더할 값 (x2 · rev 는 계산을 거치지 않으므로 0)
     tag … 화면 표시와 규칙 예외를 가르는 이름                            */
function makeDeck() {
  const deck = [];
  let id = 0;
  const put = (copies, card) => {
    for (let i = 0; i < copies; i++) deck.push(Object.assign({ id: ++id }, card));
  };

  for (let v = 2; v <= 9; v++) put(3, { t: 'num', v, tag: 'plain' }); // 2~9 각 3장
  put(8, { t: 'num', v: 10, tag: 'plain' });                          // 10 은 8장
  put(4, { t: 'num', v: 0,  tag: 'zero'  });                          // 0
  for (const v of [11, 22, 33, 44, 55, 66]) put(1, { t: 'num', v, tag: 'big' });
  put(1, { t: 'num', v: 76,  tag: 's76'   });                         // 76
  put(4, { t: 'num', v: -10, tag: 'minus' });                         // -10
  put(4, { t: 'x2',  v: 0,   tag: 'x2'    });                         // ×2
  put(5, { t: 'rev', v: 0,   tag: 'rev'   });                         // 방향전환
  return deck;
}

/** 합이 11의 배수인가 — 0 은 판의 출발점이라 세지 않는다 */
const isEleven = sum => sum !== 0 && sum % 11 === 0;
/** 77 이상인가 */
const isBust = sum => sum >= BUST;

/**
 * 지금 이 카드를 낼 수 있나.
 * '낼 수 있다' 는 규칙상 허용된다는 뜻일 뿐, 안전하다는 뜻이 아니다.
 *   76        … 합이 0 이하일 때만
 *   ×2 · 방향전환 … 라운드의 첫 카드로는 못 낸다
 */
function playable(card, { sum, firstOfRound }) {
  // 76 은 평범한 숫자 카드다. 합이 높을 때 내면 제 손으로 터지지만,
  // 그건 못 내게 막을 일이 아니라 두는 사람이 판단할 일이다.
  // (예전에는 "합이 0 이하일 때만" 으로 막아 두었는데 그건 원작 규칙이 아니었다)
  if (card.t === 'x2' || card.t === 'rev') return !firstOfRound;
  return true;
}

/**
 * 카드 한 장을 냈을 때 판이 어떻게 되는지만 계산한다.
 *   state … { sum, dir }
 *   반환   … { sum, dir, nextDue, lost }  lost 는 null | 'bust' | 'eleven'
 */
function resolve(card, state) {
  if (card.t === 'rev') return { sum: state.sum, dir: -state.dir, nextDue: 1, lost: null };
  if (card.t === 'x2')  return { sum: state.sum, dir:  state.dir, nextDue: 2, lost: null };

  const sum = state.sum + card.v;
  let lost = null;
  if (isBust(sum)) lost = 'bust';
  else if (isEleven(sum)) lost = 'eleven';
  return { sum, dir: state.dir, nextDue: 1, lost };
}

module.exports = { START_HEARTS, HAND_SIZE, BUST, makeDeck, playable, resolve, isEleven, isBust };
