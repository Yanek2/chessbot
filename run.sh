#!/bin/bash
# ChessBot: opens ChessLocal in Chrome (starting its server if needed) + the overlay.
cd "$(dirname "$0")"
if curl -s -o /dev/null localhost:8080; then
  (google-chrome http://localhost:8080 >/dev/null 2>&1 &)
else
  (cd ~/chess && nohup ./play.sh >/dev/null 2>&1 &)
fi
pgrep -f "[.]venv/bin/python app.py" >/dev/null && exit 0   # overlay already open
sleep 2
exec .venv/bin/python app.py
