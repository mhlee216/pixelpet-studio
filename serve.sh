#!/bin/bash
cd "$(dirname "$0")"

# env.config 파일 로드 (공백 포함 경로 안전)
if [ -f env.config ]; then
  set -a; source env.config; set +a
fi

# 서버 시작
python3 server.py &
SERVER_PID=$!
sleep 2

# ngrok 터널 — 에러 디버깅용으로 로그는 ngrok.log에 남김
"${NGROK_PATH:-ngrok}" http 8000 --url="https://${NGROK_DOMAIN}" --log=stdout > ngrok.log 2>&1 &
NGROK_PID=$!

echo "================================"
echo "  PixelPet Studio Server"
echo "================================"
echo "  URL: https://${NGROK_DOMAIN}"
echo "  Server PID: ${SERVER_PID}"
echo "  Ngrok PID: ${NGROK_PID}"
echo "  Stop: kill ${SERVER_PID} ${NGROK_PID}"
echo "================================"

# 종료 시 둘 다 정리
trap "kill $SERVER_PID $NGROK_PID 2>/dev/null; exit" INT TERM
wait
