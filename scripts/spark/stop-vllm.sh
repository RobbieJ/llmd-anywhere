#!/usr/bin/env bash
# Run on the DGX Spark. Stops all vLLM instances started by start-vllm.sh.
set -euo pipefail
RUN_DIR="${RUN_DIR:-$HOME/.llmd-demo}"
for pidfile in "$RUN_DIR"/vllm-*.pid; do
  [[ -e "$pidfile" ]] || { echo "nothing to stop"; exit 0; }
  pid=$(cat "$pidfile")
  if kill -0 "$pid" 2>/dev/null; then
    echo "stopping $(basename "$pidfile" .pid) (pid $pid)"
    kill "$pid"
  fi
  rm -f "$pidfile"
done
