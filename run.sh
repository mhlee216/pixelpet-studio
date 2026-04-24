#!/bin/bash
cd "$(dirname "$0")"

# env.config 파일이 있으면 로드 (공백 포함 경로 안전)
if [ -f env.config ]; then
  set -a; source env.config; set +a
fi

echo "================================"
echo "  PixelPet Launcher"
echo "================================"
echo ""
echo "  1) 로컬 서버 (localhost:8000)"
echo "  2) 공개 서버 (서버 + ngrok)"
echo "  q) 종료"
echo ""
read -rp "  선택: " choice

case "$choice" in
    1)
        echo ""
        echo ">> 로컬 서버 시작: http://localhost:8000"
        python3 server.py
        ;;
    2)
        echo ""
        python3 server.py &
        SERVER_PID=$!
        sleep 2
        echo "================================"
        echo "  PixelPet Studio 공개 서버"
        echo "================================"
        echo ""
        echo "  URL: https://${NGROK_DOMAIN}"
        echo "  Ctrl+C로 종료"
        echo ""
        "${NGROK_PATH:-ngrok}" http 8000 --url="https://${NGROK_DOMAIN}" --log=stdout 2>&1 | tee ngrok.log
        kill "$SERVER_PID" 2>/dev/null
        ;;
    q|Q)
        echo "종료"
        exit 0
        ;;
    *)
        echo "잘못된 입력입니다."
        exit 1
        ;;
esac
