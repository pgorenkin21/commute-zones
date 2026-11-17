#!/bin/zsh
# Double-click to open Commute Zones in your browser. Close this window to stop it.
cd "$(dirname "$0")"
PORT=8765
PY=$(command -v python3 || echo /opt/homebrew/bin/python3)

if ! curl -s -o /dev/null "http://localhost:$PORT/"; then
  "$PY" -m http.server $PORT &
  SERVER=$!
  for i in {1..50}; do
    curl -s -o /dev/null "http://localhost:$PORT/" && break
    sleep 0.2
  done
fi

open "http://localhost:$PORT"
echo "Commute Zones is running at http://localhost:$PORT. Close this window to stop it."
[[ -n "$SERVER" ]] && wait $SERVER
