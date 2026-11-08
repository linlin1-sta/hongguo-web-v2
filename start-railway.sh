#!/bin/bash
# v2 单服务启动：同容器 bridge(8787 仅内网, 只用 home/series) + v2 后端($PORT 对外)
set -e
cd "$(dirname "$0")"
WEB_PORT="${PORT:-8899}"
export BRIDGE_ORIGIN="http://127.0.0.1:8787"
export VIDEO_CACHE_DIR="${VIDEO_CACHE_DIR:-/tmp/video-cache-v2}"
mkdir -p "$VIDEO_CACHE_DIR"
echo "[v2] starting bridge on 127.0.0.1:8787"
PORT=8787 BRIDGE_HOST=127.0.0.1 node hongguoTV/server/index.mjs &
BRIDGE_PID=$!
trap 'kill $BRIDGE_PID 2>/dev/null || true' EXIT
for i in $(seq 1 30); do
  if node -e "fetch('http://127.0.0.1:8787/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))" 2>/dev/null; then
    echo "[v2] bridge ready"; break
  fi
  kill -0 $BRIDGE_PID 2>/dev/null || { echo "[v2] bridge exited early" >&2; exit 1; }
  sleep 1
done
echo "[v2] starting web on port $WEB_PORT"
PORT="$WEB_PORT" exec node server.js
