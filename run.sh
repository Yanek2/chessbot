#!/bin/bash
# ChessBot overlay. Starts the local chess site too if it isn't running.
cd "$(dirname "$0")"
curl -s -o /dev/null localhost:8080 || (cd ~/chess && nohup ./play.sh >/dev/null 2>&1 &)
exec .venv/bin/python app.py
