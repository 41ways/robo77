#!/bin/sh
# 연출 속도를 잰다 — 서버가 실제 시간으로 돌리므로 한 판에 몇 분 걸린다.
#   sh qa/run.sh [인원]
# 서버를 먼저 띄워 두어야 한다:  node server.js
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PORT=${PORT:-8790}
N=${1:-3}
OUT=/tmp/robo77-pace-$N.json
nice -n 10 "$CHROME" --headless --disable-gpu --hide-scrollbars --window-size=1100,860 \
  --dump-dom "http://localhost:$PORT/?qa=pace&n=$N" 2>/dev/null \
| python3 -c "
import sys, re, html
m = re.search(r'<pre id=\"qaout\"[^>]*>(.*?)</pre>', sys.stdin.read(), re.S)
print(html.unescape(m.group(1)) if m else '{\"game\":\"?\",\"n\":\"?\",\"ev\":[],\"errs\":[\"qaout 을 못 찾음\"]}')
" > "$OUT"
python3 qa/pace.py "$OUT"
