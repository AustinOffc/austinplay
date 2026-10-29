#!/bin/bash
# Startup wrapper Pterodactyl: jalankan cloudflared (opsional) di background, lalu Node di foreground.
# Startup Command egg: bash start.sh
set -e

CLOUDFLARED_BIN="./cloudflared"
ENABLE_TUNNEL="${ENABLE_CF_TUNNEL:-false}"
TUNNEL_TOKEN="${CF_TOKEN:-}"

if [ "$ENABLE_TUNNEL" != "true" ] && [ "$ENABLE_TUNNEL" != "1" ]; then
  echo "[start.sh] ENABLE_CF_TUNNEL tidak aktif. Backend jalan di HTTP lokal tanpa tunnel."
elif [ -z "$TUNNEL_TOKEN" ]; then
  echo "[start.sh] WARNING: ENABLE_CF_TUNNEL=true tapi CF_TOKEN kosong. Tunnel tidak dijalankan."
else
  if [ ! -x "$CLOUDFLARED_BIN" ]; then
    echo "[start.sh] Mengunduh cloudflared..."
    curl -fsSL -o "$CLOUDFLARED_BIN" \
      https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
    chmod +x "$CLOUDFLARED_BIN"
  fi
  echo "[start.sh] Menjalankan cloudflared tunnel di background..."
  "$CLOUDFLARED_BIN" tunnel run --token "$TUNNEL_TOKEN" > cloudflared.log 2>&1 &
  CLOUDFLARED_PID=$!
  trap "kill $CLOUDFLARED_PID 2>/dev/null || true" EXIT
fi

echo "[start.sh] Menjalankan backend Node.js..."
exec node index.js
