#!/usr/bin/env bash
# Run on the MAC, with the full stack up. A narrated CLI demo of what the
# webapp shows visually: where the Endpoint Picker routes requests and why.
#
# Usage: ./demo-routing.sh [gateway-url]
set -euo pipefail

GATEWAY="${1:-${GATEWAY_URL:-http://localhost:8080}}"
MODEL="${MODEL:-${SERVED_NAME:-llmd-demo}}"   # the pool-wide served-model alias
N="${N:-8}"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }

served_by() { # POST one chat completion, print which backend Envoy used
  local prompt="$1"
  curl -s -o /dev/null -D - "$GATEWAY/v1/chat/completions" \
    -H 'Content-Type: application/json' \
    -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":$(printf '%s' "$prompt" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')}],\"max_tokens\":32,\"temperature\":0}" \
    | tr -d '\r' | awk -F': ' 'tolower($1)=="x-llmd-served-by"{print $2}'
}

bold "== llm-d routing demo (gateway: $GATEWAY) =="
echo
bold "[1/2] $N CONCURRENT requests with unique prompts — load-aware scoring spreads them out"
tmp=$(mktemp -d)
for i in $(seq 1 "$N"); do
  ( served_by "Request $RANDOM-$i: write one sentence about the number $i." > "$tmp/$i" ) &
done
wait
for i in $(seq 1 "$N"); do
  printf '    request %-2s -> %s\n' "$i" "$(cat "$tmp/$i" 2>/dev/null || echo unknown)"
done
rm -rf "$tmp"
echo
bold "[2/2] $N requests sharing one LONG PREFIX — prefix-cache affinity converges on one backend"
PREFIX="You are a meticulous assistant for the Acme Rocket Company. Policy manual, section 1: always answer concisely. Section 2: cite the policy section. Section 3: never speculate about launch dates."
for i in $(seq 1 "$N"); do
  who=$(served_by "$PREFIX Question $i: what does section $((1 + i % 3)) say?")
  printf '    request %-2s -> %s\n' "$i" "${who:-unknown}"
done
echo
bold "Same pool, same gateway — the EPP chose differently because the second batch's"
bold "KV-cache prefix was already hot on one instance. That's llm-d, no Kubernetes."
