#!/usr/bin/env bash
# Start ONE Metal vLLM worker on this Mac (Apple GPU via the vllm-metal plugin).
# Safe to run several times with different PORTs to put multiple workers on one
# machine — set FRACTION so the sum across workers stays well under ~0.5.
#
# Usage:
#   ./start.sh                              # auto model by RAM, :8001, fraction 0.25
#   PORT=8002 FRACTION=0.12 ./start.sh      # second worker on the same Mac
#   MODEL=mlx-community/Qwen2.5-7B-Instruct-4bit ./start.sh
#
# SAFETY — read before raising FRACTION: with paged attention, vllm-metal's
# default memory fraction ("auto") is 0.90 of unified memory, and the KV pool
# is allocated EAGERLY at startup. On a busy Mac that wires more memory than
# is free, freezing the whole machine until the hardware watchdog reboots it
# (observed live). This script therefore always sets an explicit fraction and
# refuses to start when the budget exceeds free memory.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV="${VLLM_METAL_VENV:-$HOME/.venv-vllm-metal}"

SERVED_NAME="${SERVED_NAME:-llmd-demo}"   # must match the rest of the pool
PORT="${PORT:-8001}"
MAX_MODEL_LEN="${MAX_MODEL_LEN:-8192}"
FRACTION="${FRACTION:-0.25}"
# OFFLOAD_GB: spill KV blocks evicted from the GPU cache into a CPU-side
# buffer of this many GiB (vLLM's native offloading connector) instead of
# dropping them — returning prefixes reload from RAM rather than recompute.
OFFLOAD_GB="${OFFLOAD_GB:-}"

# Pick a default model by RAM: small machines get the 1.5B, 32GB+ the 7B.
if [[ -z "${MODEL:-}" ]]; then
  mem_gb=$(( $(sysctl -n hw.memsize) / 1073741824 ))
  if (( mem_gb >= 32 )); then MODEL="mlx-community/Qwen2.5-7B-Instruct-4bit"
  else MODEL="mlx-community/Qwen2.5-1.5B-Instruct-4bit"; fi
fi

log="$DIR/vllm-$PORT.log"
pidfile="$DIR/vllm-$PORT.pid"

if curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
  echo "something already serving on :$PORT — nothing to do"
  exit 0
fi
[[ -x "$VENV/bin/vllm" ]] || { echo "no vllm-metal install found at $VENV — run $DIR/setup.sh first"; exit 1; }

# Preflight: planned budget (FRACTION of ~75% of RAM) must fit in free memory
# with room to spare, or we refuse rather than risk a system freeze.
free_pct=$(memory_pressure 2>/dev/null | awk -F': ' '/free percentage/{gsub(/%/,"",$2); print int($2)}')
mem_gb=$(( $(sysctl -n hw.memsize) / 1073741824 ))
budget_gb=$(python3 -c "print(round($mem_gb * 0.75 * $FRACTION, 1))")
free_gb=$(( mem_gb * ${free_pct:-0} / 100 ))
if (( $(python3 -c "print(1 if $budget_gb > $free_gb * 0.6 else 0)") )); then
  echo "!!! refusing to start: planned Metal budget ~${budget_gb}GB (FRACTION=$FRACTION) vs ~${free_gb}GB free."
  echo "    Free up memory or lower FRACTION. An over-committed Metal worker can freeze the whole Mac."
  exit 1
fi

echo ">>> Starting Metal vLLM ($MODEL as '$SERVED_NAME') on :$PORT (memory fraction $FRACTION ≈ ${budget_gb}GB)"
offload_args=()
[[ -n "$OFFLOAD_GB" ]] && offload_args=(--kv-offloading-backend native --kv-offloading-size "$OFFLOAD_GB")

nohup env VLLM_METAL_MEMORY_FRACTION="$FRACTION" "$VENV/bin/vllm" serve "$MODEL" \
  --served-model-name "$SERVED_NAME" \
  --host 0.0.0.0 \
  --port "$PORT" \
  --max-model-len "$MAX_MODEL_LEN" \
  --enable-prefix-caching \
  ${offload_args[@]+"${offload_args[@]}"} \
  > "$log" 2>&1 &
echo $! > "$pidfile"

echo ">>> Waiting for health (first run downloads the model; API startup can take"
echo "    several minutes even after the engine loads — that is normal)..."
until curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; do
  if ! kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    echo "!!! vLLM died — last log lines:"; tail -n 20 "$log"; exit 1
  fi
  sleep 3
done

device=$(sysctl -n machdep.cpu.brand_string 2>/dev/null || echo "Apple Silicon")
ip=$(ipconfig getifaddr en0 2>/dev/null || echo "<this-mac-ip>")
echo ">>> Healthy on :$PORT. Join it to the pool from the hub machine:"
echo "    ./demo pool add $ip:$PORT \"$device · Metal\""
