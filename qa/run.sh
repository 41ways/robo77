#!/bin/sh
# 연출 속도를 잰다 — 서버가 실제 시간으로 돌리므로 한 판에 몇 분 걸린다.
#   sh qa/run.sh [인원]
# 서버를 먼저 띄워 두어야 한다:  node server.js   (PORT 로 다른 서버 주소도 줄 수 있다)
# --dump-dom 은 페이지가 뜨자마자 끝나서 판이 벌어지기 전의 빈 기록만 받는다.
# 그래서 qa/pace-run.js 가 크롬을 띄워 두고 판이 끝날 때까지 기다렸다가 기록을 꺼내 온다.
PORT=${PORT:-8790}
N=${1:-3}
OUT=/tmp/robo77-pace-$N.json
nice -n 10 node qa/pace-run.js "http://localhost:$PORT/?qa=pace&n=$N" "$OUT" 900000
python3 qa/pace.py "$OUT"
