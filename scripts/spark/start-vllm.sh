#!/usr/bin/env bash
# Run on a CUDA box (written on a DGX Spark). Starts N vLLM instances of a
# small model, bound to 0.0.0.0 so the routing plane on the hub can reach them.
#
# Usage:
#   ./start-vllm.sh            # 2 instances on ports 8001, 8002
#   NUM_INSTANCES=3 ./start-vllm.sh
#   MODEL=Qwen/Qwen2.5-1.5B-Instruct ./start-vllm.sh
#
# Requires: `vllm` on PATH (e.g. `uv pip install vllm` in a venv, or run
# inside an NVIDIA vLLM container).
set -euo pipefail

MODEL="${MODEL:-Qwen/Qwen2.5-1.5B-Instruct}"
SERVED_NAME="${SERVED_NAME:-llmd-demo}"
NUM_INSTANCES="${NUM_INSTANCES:-2}"
BASE_PORT="${BASE_PORT:-8001}"   # same first-port convention as the Mac workers
# Fraction of GPU memory EACH instance may claim. The GB10's memory is unified
# (128 GB shared with the CPU), so keep the total comfortably below 1.0.
GPU_FRAC="${GPU_FRAC:-0.30}"
MAX_MODEL_LEN="${MAX_MODEL_LEN:-8192}"
RUN_DIR="${RUN_DIR:-$HOME/.llmd-demo}"
# KV offloading (the dashboard's Overflow beat). OFFLOAD_GB spills evicted KV
# blocks to a CPU-side buffer (vLLM native connector, CUDA only); NUM_GPU_BLOCKS
# shrinks the fast tier (× 16 tokens/block) so eviction actually happens on
# stage. E.g. OFFLOAD_GB=16 NUM_GPU_BLOCKS=2048 → 32K-token fast tier.
OFFLOAD_GB="${OFFLOAD_GB:-}"
NUM_GPU_BLOCKS="${NUM_GPU_BLOCKS:-}"

extra_args=()
[[ -n "$OFFLOAD_GB" ]] && extra_args+=(--kv-offloading-backend native --kv-offloading-size "$OFFLOAD_GB")
[[ -n "$NUM_GPU_BLOCKS" ]] && extra_args+=(--num-gpu-blocks-override "$NUM_GPU_BLOCKS")

mkdir -p "$RUN_DIR"

echo ">>> Starting $NUM_INSTANCES vLLM instance(s) of $MODEL"
for i in $(seq 0 $((NUM_INSTANCES - 1))); do
  port=$((BASE_PORT + i))
  log="$RUN_DIR/vllm-$i.log"
  pidfile="$RUN_DIR/vllm-$i.pid"

  if [[ -f "$pidfile" ]] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    echo "    vllm-$i already running (pid $(cat "$pidfile"), port $port) — skipping"
    continue
  fi
  if curl -sf "http://127.0.0.1:$port/health" > /dev/null 2>&1; then
    echo "    something already serving on :$port (not started by this script) — leaving it in place"
    continue
  fi

  # --enable-prefix-caching is the default in vLLM v1; passed explicitly so the
  # prefix-cache-affinity part of the demo doesn't silently degrade on older builds.
  nohup vllm serve "$MODEL" \
    --served-model-name "$SERVED_NAME" \
    --host 0.0.0.0 \
    --port "$port" \
    --gpu-memory-utilization "$GPU_FRAC" \
    --max-model-len "$MAX_MODEL_LEN" \
    --enable-prefix-caching \
    "${extra_args[@]}" \
    > "$log" 2>&1 &
  echo $! > "$pidfile"
  echo "    vllm-$i -> port $port (pid $(cat "$pidfile"), log $log)"
done

echo ">>> Waiting for instances to come up (model load can take a minute)..."
for i in $(seq 0 $((NUM_INSTANCES - 1))); do
  port=$((BASE_PORT + i))
  until curl -sf "http://127.0.0.1:$port/health" > /dev/null 2>&1; do
    if ! kill -0 "$(cat "$RUN_DIR/vllm-$i.pid")" 2>/dev/null; then
      echo "!!! vllm-$i died — last log lines:"; tail -n 20 "$RUN_DIR/vllm-$i.log"; exit 1
    fi
    sleep 2
  done
  echo "    vllm-$i healthy on :$port"
done

ip_hint=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "<this-ip>")
gpu_hint=$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1 || echo "NVIDIA GPU")
echo ""
echo ">>> All instances up. Join them to the pool from the hub machine:"
for i in $(seq 0 $((NUM_INSTANCES - 1))); do
  echo "    ./demo pool add $ip_hint:$((BASE_PORT + i)) \"$gpu_hint\""
done
