#!/bin/sh
# Serve ChessLocal on http://localhost:8080 and open it in Chrome.
cd "$(dirname "$0")"
PORT=${PORT:-8080}
python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 &
PID=$!
sleep 0.5
(google-chrome "http://localhost:$PORT" || chromium "http://localhost:$PORT" || xdg-open "http://localhost:$PORT") >/dev/null 2>&1 &
echo "ChessLocal running at http://localhost:$PORT  (Ctrl+C to stop)"
trap 'kill $PID' INT TERM
wait $PID
