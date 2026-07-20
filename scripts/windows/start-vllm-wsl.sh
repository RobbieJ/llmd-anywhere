#!/usr/bin/env bash
# Run INSIDE WSL2 (Ubuntu) on the Windows gaming PC. Starts one vLLM instance
# of the same model the Spark serves, so the RTX 5090 joins the llm-d pool.
#
# One-time install (inside WSL — the Windows NVIDIA driver provides the GPU;
# do NOT install a Linux driver in WSL):
#   curl -LsSf https://astral.sh/uv/install.sh | sh
#   uv venv ~/vllm-env --python 3.12 && source ~/vllm-env/bin/activate
#   uv pip install vllm     # cu128+ wheels — supports the 5090 (sm_120)
#   nvidia-smi              # should show the RTX 5090
#
# Usage:
#   ./start-vllm-wsl.sh                 # port 8002, 85% of the 32 GB card
#   PORT=8003 GPU_FRAC=0.4 ./start-vllm-wsl.sh
set -euo pipefail

MODEL="${MODEL:-Qwen/Qwen2.5-1.5B-Instruct}"
SERVED_NAME="${SERVED_NAME:-llmd-demo}"   # must match the rest of the pool
PORT="${PORT:-8002}"
GPU_FRAC="${GPU_FRAC:-0.85}"
MAX_MODEL_LEN="${MAX_MODEL_LEN:-8192}"
RUN_DIR="${RUN_DIR:-$HOME/.llmd-demo}"

mkdir -p "$RUN_DIR"
log="$RUN_DIR/vllm-$PORT.log"
pidfile="$RUN_DIR/vllm-$PORT.pid"

if curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
  echo "something already serving on :$PORT — nothing to do"
  exit 0
fi

echo ">>> Starting vLLM ($MODEL as '$SERVED_NAME') on :$PORT"
nohup vllm serve "$MODEL" \
  --served-model-name "$SERVED_NAME" \
  --host 0.0.0.0 \
  --port "$PORT" \
  --gpu-memory-utilization "$GPU_FRAC" \
  --max-model-len "$MAX_MODEL_LEN" \
  --enable-prefix-caching \
  > "$log" 2>&1 &
echo $! > "$pidfile"

echo ">>> Waiting for health (model load can take a minute)..."
until curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; do
  if ! kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    echo "!!! vLLM died — last log lines:"; tail -n 20 "$log"; exit 1
  fi
  sleep 2
done

echo ">>> Healthy on :$PORT."
echo "    If you haven't yet, run scripts/windows/setup.ps1 in elevated PowerShell"
echo "    on the Windows side so the LAN can reach this port, then on the Mac:"
echo "      ./demo pool add <this-pc-lan-ip>:$PORT \"NVIDIA RTX (WSL2)\""
