#!/usr/bin/env bash
# Stop this Mac's Metal vLLM worker(s). Usage: ./stop.sh [port]
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
shopt -s nullglob
if [[ -n "${1:-}" ]]; then
  pidfiles=("$DIR/vllm-$1.pid")
else
  pidfiles=("$DIR"/vllm-*.pid "$DIR/vllm.pid")
fi
stopped=0
for pidfile in "${pidfiles[@]}"; do
  [[ -f "$pidfile" ]] || continue
  pid=$(cat "$pidfile")
  kill -0 "$pid" 2>/dev/null && { echo "stopping mac vllm (pid $pid, $(basename "$pidfile"))"; kill "$pid"; stopped=1; }
  rm -f "$pidfile"
done
[[ $stopped = 1 ]] || echo "nothing to stop"
