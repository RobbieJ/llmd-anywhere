#!/usr/bin/env bash
# One-time: install vLLM with the official Metal backend for Apple Silicon —
# https://github.com/vllm-project/vllm-metal (MLX-based hardware plugin,
# GPU-accelerated, and it runs the real vLLM engine, so the llm-d EPP gets
# the full vLLM /metrics surface to schedule on).
#
# Requirements: Apple Silicon, native arm64 Python 3.12, Xcode CLT.
# The official installer builds vllm core from source (takes a while) and
# installs everything into ~/.venv-vllm-metal (override: VENV_HINT below).
set -euo pipefail

VENV="${VLLM_METAL_VENV:-$HOME/.venv-vllm-metal}"

if [[ -x "$VENV/bin/vllm" ]]; then
  echo "vllm-metal already installed at $VENV — nothing to do"
  exit 0
fi

echo ">>> Running the official vllm-metal installer (this builds vllm core — go get coffee)..."
curl -fsSL https://raw.githubusercontent.com/vllm-project/vllm-metal/main/install.sh | bash

echo ">>> Sanity check..."
"$VENV/bin/python" -c "import vllm; print('vllm', vllm.__version__)"
echo ">>> Done. Start the worker with: $(dirname "${BASH_SOURCE[0]}")/start.sh"
