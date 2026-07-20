"""llm-d local demo dashboard — FastAPI backend.

Proxies three things for the frontend:
  * per-instance vLLM /metrics (scraped directly from each endpoint)
  * EPP scheduler metrics
  * chat/load-gen traffic sent through the llm-d gateway (Envoy), capturing
    which backend the Endpoint Picker routed each request to.

Runs on the hub machine, next to the Envoy + EPP containers.
"""

import asyncio
import json
import os
import re
import time
import uuid
from collections import deque
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
import yaml
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

BASE_DIR = Path(__file__).resolve().parent
REPO_DIR = BASE_DIR.parent

GATEWAY_URL = os.environ.get("GATEWAY_URL", "http://localhost:8080")
ENDPOINTS_FILE = Path(os.environ.get("ENDPOINTS_FILE", REPO_DIR / "config" / "endpoints.yaml"))
EPP_CONFIG_FILE = Path(os.environ.get("EPP_CONFIG_FILE", REPO_DIR / "config" / "epp-config.yaml"))
EPP_METRICS_URL = os.environ.get("EPP_METRICS_URL", "http://localhost:9090/metrics")
MODEL_NAME = os.environ.get("MODEL_NAME", "llmd-demo")

# Device names (the heterogeneous-pool story) come from endpoints.yaml labels
# (llm-d.ai/device), written when a worker joins the pool — see ./demo pool.
DEVICE_LABEL = "llm-d.ai/device"

# Response header Envoy is configured to echo back with the upstream picked by
# the EPP (see config/envoy.yaml).
ROUTING_HEADER = "x-llmd-served-by"

# MOCK=1: simulate the whole pool (no vLLM, no Docker) — see mock.py.
MOCK = os.environ.get("MOCK") == "1"
if MOCK:
    import mock

@asynccontextmanager
async def _lifespan(app):
    global http_client
    http_client = httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=3.0))
    yield
    await http_client.aclose()


app = FastAPI(title="llm-d local demo", lifespan=_lifespan)

# Ring buffer of recent routing decisions shown in the dashboard feed.
decisions: deque = deque(maxlen=200)

# Latest per-endpoint scheduling signals (queue/kv/prefix) from the last
# /api/state scrape — snapshotted onto each decision so the UI can answer
# "why did the EPP pick that worker?" with the inputs it scored on.
last_signals: dict[str, dict] = {}
# Full scraped endpoint list from the last /api/state (for offload targeting).
last_scraped: list[dict] = []
# Counterfactual round-robin cursor — "who would a cache-blind balancer pick?"
_rr_seq = 0

http_client: httpx.AsyncClient | None = None


def scorer_weights() -> list[dict]:
    """Scorer names + weights from the EPP config's first scheduling profile."""
    try:
        cfg = yaml.safe_load(EPP_CONFIG_FILE.read_text()) or {}
        profile = (cfg.get("schedulingProfiles") or [{}])[0]
        return [
            {"name": p.get("pluginRef"), "weight": p.get("weight", 1)}
            for p in profile.get("plugins", [])
            if p.get("pluginRef")
        ]
    except Exception:
        return []


def load_endpoints() -> list[dict]:
    try:
        data = yaml.safe_load(ENDPOINTS_FILE.read_text()) or {}
    except FileNotFoundError:
        return []
    eps = []
    for ep in data.get("endpoints", []):
        eps.append({
            "name": ep.get("name"),
            "address": ep.get("address"),
            "port": str(ep.get("port")),
            "labels": ep.get("labels") or {},
        })
    return eps


# vLLM metric names vary slightly across versions (gpu_cache_usage_perc vs
# kv_cache_usage_perc, gpu_prefix_cache_* vs prefix_cache_*); match loosely.
_METRIC_PATTERNS = {
    "running": re.compile(r'^vllm:num_requests_running(?:\{[^}]*\})?\s+([0-9.eE+-]+)', re.M),
    "waiting": re.compile(r'^vllm:num_requests_waiting(?:\{[^}]*\})?\s+([0-9.eE+-]+)', re.M),
    "kv_cache_usage": re.compile(r'^vllm:(?:gpu_cache|kv_cache)_usage_perc(?:\{[^}]*\})?\s+([0-9.eE+-]+)', re.M),
    "prompt_tokens": re.compile(r'^vllm:prompt_tokens_total(?:\{[^}]*\})?\s+([0-9.eE+-]+)', re.M),
    "generation_tokens": re.compile(r'^vllm:generation_tokens_total(?:\{[^}]*\})?\s+([0-9.eE+-]+)', re.M),
    "prefix_hits": re.compile(r'^vllm:(?:gpu_)?prefix_cache_hits(?:_total)?(?:\{[^}]*\})?\s+([0-9.eE+-]+)', re.M),
    "prefix_queries": re.compile(r'^vllm:(?:gpu_)?prefix_cache_queries(?:_total)?(?:\{[^}]*\})?\s+([0-9.eE+-]+)', re.M),
}

_CACHE_CONFIG_RE = re.compile(r'^vllm:cache_config_info\{([^}]*)\}', re.M)
_LABEL_RE = re.compile(r'(\w+)="([^"]*)"')

# Prompt tokens served from KV cache vs recomputed — the routing payoff number.
# Label values observed: source="local_cache_hit" | "local_compute" | "external_kv_transfer".
_BY_SOURCE_RE = re.compile(r'^vllm:prompt_tokens_by_source_total\{([^}]*)\}\s+([0-9.eE+-]+)', re.M)


def parse_token_sources(text: str) -> dict:
    cached = restored = computed = 0.0
    for m in _BY_SOURCE_RE.finditer(text):
        labels = dict(_LABEL_RE.findall(m.group(1)))
        src = labels.get("source", "")
        if "transfer" in src:          # restored via the KV offloading connector
            restored += float(m.group(2))
        elif "cache" in src:           # hit in the GPU-tier prefix cache
            cached += float(m.group(2))
        else:
            computed += float(m.group(2))
    if not (cached or restored or computed):
        return {}
    return {"prompt_cached": cached, "prompt_restored": restored, "prompt_computed": computed}


def parse_cache_config(text: str) -> dict:
    """KV-cache spec labels (capacity in tokens, dtype) for the instance card."""
    m = _CACHE_CONFIG_RE.search(text)
    if not m:
        return {}
    labels = dict(_LABEL_RE.findall(m.group(1)))
    out = {}
    if labels.get("kv_cache_size_tokens", "").replace(".", "").isdigit():
        out["kv_tokens"] = int(float(labels["kv_cache_size_tokens"]))
    if labels.get("cache_dtype") not in (None, "", "None"):
        out["dtype"] = labels["cache_dtype"]
    try:
        out["offload_gb"] = float(labels.get("kv_offloading_size", "None"))
    except ValueError:
        pass
    return out


def parse_vllm_metrics(text: str) -> dict:
    out = {}
    for key, pat in _METRIC_PATTERNS.items():
        matches = pat.findall(text)
        if matches:
            out[key] = sum(float(m) for m in matches)
    return out


# Underlying model per endpoint (from /v1/models `root` — the real weights,
# even when served under a pool-wide alias). Cached; it never changes mid-run.
_model_ids: dict[str, str] = {}


async def fetch_model_id(ep: dict, base: str) -> str | None:
    key = f"{ep['address']}:{ep['port']}"
    if key in _model_ids:
        return _model_ids[key]
    try:
        r = await http_client.get(f"{base}/v1/models", timeout=2.0)
        data = (r.json().get("data") or [{}])[0]
        model_id = data.get("root") or data.get("id")
        if model_id:
            _model_ids[key] = model_id
        return model_id
    except Exception:
        return None


async def scrape_endpoint(ep: dict) -> dict:
    """vLLM workers expose /metrics; other OpenAI-compatible engines (e.g.
    Ollama) don't — they count as healthy-but-unmetered if /v1/models answers.
    """
    base = f"http://{ep['address']}:{ep['port']}"
    result = {**ep, "healthy": False, "engine": "vllm", "metrics": {},
              "device": (ep.get("labels") or {}).get(DEVICE_LABEL)}
    try:
        r = await http_client.get(f"{base}/metrics", timeout=2.0)
        if r.status_code == 200:
            result["healthy"] = True
            result["metrics"] = parse_vllm_metrics(r.text)
            result["metrics"].update(parse_token_sources(r.text))
            result["cache"] = parse_cache_config(r.text)
            result["model_id"] = await fetch_model_id(ep, base)
            return result
    except Exception:
        pass
    try:
        r = await http_client.get(f"{base}/v1/models", timeout=2.0)
        if r.status_code == 200:
            result["healthy"] = True
            result["engine"] = "no metrics"
            result["model_id"] = await fetch_model_id(ep, base)
    except Exception:
        pass
    return result


async def gateway_reachable() -> bool:
    """Any HTTP response from Envoy counts — we only care that it's up."""
    try:
        await http_client.get(f"{GATEWAY_URL}/v1/models", timeout=2.0)
        return True
    except Exception:
        return False


@app.get("/api/state")
async def state():
    if MOCK:
        return mock.state()
    eps = load_endpoints()
    results = await asyncio.gather(gateway_reachable(), *(scrape_endpoint(ep) for ep in eps))
    scraped = list(results[1:])
    last_scraped[:] = scraped

    last_signals.clear()
    for ep in scraped:
        m = ep.get("metrics") or {}
        hit = None
        if m.get("prefix_queries"):
            hit = round(100 * m.get("prefix_hits", 0) / m["prefix_queries"], 1)
        last_signals[ep["name"]] = {
            "queue": m.get("waiting"),
            "kv_pct": round(100 * m["kv_cache_usage"], 1) if m.get("kv_cache_usage") is not None else None,
            "prefix_hit_pct": hit,
            "healthy": ep["healthy"],
        }

    try:
        pool_file = {"raw": ENDPOINTS_FILE.read_text(), "mtime": ENDPOINTS_FILE.stat().st_mtime}
    except OSError:
        pool_file = {"raw": "", "mtime": None}

    return {
        "ts": time.time(),
        "model": MODEL_NAME,
        "gateway": GATEWAY_URL,
        "gateway_healthy": results[0],
        "endpoints": scraped,
        "pool_file": pool_file,
    }


# llm_d_epp_* metric lines we surface: per-endpoint decision counters, the
# e2e scheduling-latency histogram, per-plugin latency, pool gauges, build info.
_EPP_LINE = re.compile(r'^(llm_d_epp_[a-z0-9_]+)(?:\{([^}]*)\})?\s+([0-9.eE+-]+)', re.M)


@app.get("/api/epp")
async def epp_metrics():
    """The EPP's own view of its scheduling: decision counts per endpoint,
    scheduling overhead, prefix-index size, scorer weights, version."""
    if MOCK:
        return mock.epp(scorer_weights())
    out = {
        "healthy": False,
        "attempts": {},          # endpoint name -> lifetime routing decisions
        "sched_avg_us": None,    # avg e2e scheduling latency per decision
        "plugin_avg_us": {},     # plugin name -> avg latency
        "ready_endpoints": None,
        "prefix_index_size": None,
        "version": None,
        "weights": scorer_weights(),
    }
    try:
        r = await http_client.get(EPP_METRICS_URL, timeout=2.0)
        if r.status_code != 200:
            return out
    except Exception:
        return out

    out["healthy"] = True
    e2e = {"sum": 0.0, "count": 0.0}
    plugins: dict[str, dict] = {}
    for m in _EPP_LINE.finditer(r.text):
        name, raw_labels, val = m.group(1), m.group(2) or "", float(m.group(3))
        labels = dict(_LABEL_RE.findall(raw_labels))
        if name == "llm_d_epp_scheduler_attempts_total" and labels.get("status") == "success":
            ep = labels.get("endpoint_name", "?")
            out["attempts"][ep] = out["attempts"].get(ep, 0) + val
        elif name == "llm_d_epp_scheduler_e2e_duration_seconds_sum":
            e2e["sum"] += val
        elif name == "llm_d_epp_scheduler_e2e_duration_seconds_count":
            e2e["count"] += val
        elif name == "llm_d_epp_plugin_duration_seconds_sum":
            plugins.setdefault(labels.get("plugin_name", "?"), {"sum": 0.0, "count": 0.0})["sum"] += val
        elif name == "llm_d_epp_plugin_duration_seconds_count":
            plugins.setdefault(labels.get("plugin_name", "?"), {"sum": 0.0, "count": 0.0})["count"] += val
        elif name == "llm_d_epp_ready_endpoints":
            out["ready_endpoints"] = int(val)
        elif name == "llm_d_epp_prefix_indexer_size":
            out["prefix_index_size"] = int(val)
        elif name == "llm_d_epp_info":
            out["version"] = labels.get("build_ref")

    if e2e["count"]:
        out["sched_avg_us"] = round(1e6 * e2e["sum"] / e2e["count"], 1)
    out["plugin_avg_us"] = {
        name: round(1e6 * p["sum"] / p["count"], 1)
        for name, p in plugins.items() if p["count"]
    }
    return out


@app.get("/api/decisions")
async def get_decisions():
    return {"decisions": list(decisions)}


def _record(kind: str, tag: str, served_by: str | None, latency_ms: float, ok: bool,
            ttft_ms: float | None = None, signals: dict | None = None,
            prompt_tokens: int | None = None):
    global _rr_seq
    # counterfactual: the worker a blind round-robin balancer would have used
    # (fall back to the caller's signals so MOCK mode gets a counterfactual too)
    rr_pick = None
    pool = last_signals or signals or {}
    if kind in ("chat", "loadgen") and pool:
        names = list(pool.keys())
        rr_pick = names[_rr_seq % len(names)]
        _rr_seq += 1
    decisions.append({
        "id": uuid.uuid4().hex[:8],
        "ts": time.time(),
        "kind": kind,
        "tag": tag,
        "served_by": served_by or "unknown",
        "rr_pick": rr_pick,
        "latency_ms": round(latency_ms, 1),
        "ttft_ms": round(ttft_ms, 1) if ttft_ms is not None else None,
        "ok": ok,
        # prompt size the worker reported (usage.prompt_tokens) — None if unknown
        "prompt_tokens": prompt_tokens,
        # what the EPP scored on, as of the last dashboard scrape (~1.5s old)
        "signals": signals if signals is not None else {k: dict(v) for k, v in last_signals.items()},
    })


# Every real deployment carries a system prompt; ours also makes the routing
# story work — it pads each conversation's prefix past the EPP prefix
# indexer's 256-byte block size, so the prefix scorer can pin a conversation
# to the worker holding its history from turn 2 onward. The session id keeps
# separate conversations from sharing a prefix (clearing memory = new session
# = pin released).
CHAT_SYSTEM_PROMPT = (
    "You are the assistant behind the llm-d demo dashboard. Answer concisely — "
    "a few sentences at most — in plain language, and stay on whatever topic "
    "the user raises. You are served by a pool of heterogeneous machines "
    "behind one gateway; which machine answers is decided per request by the "
    "llm-d Endpoint Picker based on live queue depth, KV-cache utilization "
    "and prefix-cache affinity. You may mention this if asked how you work. "
    "Formatting rules: no markdown tables, no headings, no code blocks unless "
    "the user asks for code; prefer complete sentences over bullet lists.\n"
)


@app.post("/api/chat")
async def chat(req: Request):
    """Stream a chat completion through the llm-d gateway.

    Emits SSE: first a `routing` event naming the backend that served the
    request, then the raw OpenAI-format chunks, then `done`.
    """
    body = await req.json()
    if MOCK:
        tag = _chat_tag({"messages": body.get("messages", [])})
        return StreamingResponse(mock.chat_stream(tag, _record), media_type="text/event-stream")
    messages = body.get("messages", [])
    if not (messages and messages[0].get("role") == "system"):
        session = body.get("session", "default")
        messages = [{"role": "system", "content": CHAT_SYSTEM_PROMPT + f"Session: {session}"}] + messages
    payload = {
        "model": body.get("model", MODEL_NAME),
        "messages": messages,
        # generous default: reasoning models spend tokens thinking before the
        # visible answer — too small a budget gets consumed entirely by
        # reasoning and `content` never arrives
        "max_tokens": body.get("max_tokens", 2048),
        "temperature": body.get("temperature", 0.7),
        "stream": True,
        # ask for a final usage chunk so the routing-dividend estimate can
        # price this conversation's prompt (vLLM supports include_usage)
        "stream_options": {"include_usage": True},
    }

    async def gen():
        start = time.time()
        ttft = None
        served = None
        prompt_toks = None
        try:
            async with http_client.stream(
                "POST", f"{GATEWAY_URL}/v1/chat/completions", json=payload
            ) as r:
                served = r.headers.get(ROUTING_HEADER)
                yield f"event: routing\ndata: {json.dumps({'served_by': served or 'unknown'})}\n\n"
                async for line in r.aiter_lines():
                    if not line:
                        continue
                    if ttft is None:
                        ttft = (time.time() - start) * 1000
                    if '"usage"' in line and line.startswith("data:"):
                        try:
                            usage = json.loads(line[5:]).get("usage") or {}
                            prompt_toks = usage.get("prompt_tokens") or prompt_toks
                        except Exception:
                            pass
                    yield line + "\n\n"
            _record("chat", _chat_tag(payload), served, (time.time() - start) * 1000, True, ttft,
                    prompt_tokens=prompt_toks)
            yield "event: done\ndata: {}\n\n"
        except Exception as e:
            _record("chat", _chat_tag(payload), served, (time.time() - start) * 1000, False, ttft,
                    prompt_tokens=prompt_toks)
            yield f"event: error\ndata: {json.dumps({'error': str(e)})}\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream")


def _chat_tag(payload: dict) -> str:
    for m in reversed(payload.get("messages", [])):
        if m.get("role") == "user":
            return (m.get("content") or "")[:40]
    return "chat"


# The EPP's approximate prefix indexer matches in 256-byte blocks — a shared
# prefix shorter than one block scores 0 for every worker and affinity never
# engages (observed live: a ~230-char prefix split 6/6 even sequentially).
# Keep this comfortably multi-block, like a real production system prompt.
SHARED_PREFIX = (
    "You are a meticulous assistant for the Acme Rocket Company and you answer "
    "strictly from the policy manual below.\n\n"
    "POLICY MANUAL (rev 7, unabridged)\n"
    "Section 1 — Tone and format: always answer concisely, in complete "
    "sentences, and never use more than three sentences per answer. Bullet "
    "lists are reserved for enumerating hardware part numbers.\n"
    "Section 2 — Citations: every answer must cite the policy section it "
    "relies on, in parentheses at the end of the sentence.\n"
    "Section 3 — Launch dates: never speculate about launch dates; if asked, "
    "state that launch windows are announced only by the flight director.\n"
    "Section 4 — Propellant handling: cryogenic propellant questions are "
    "answered only with reference to the safety datasheet, and any question "
    "about loading procedures must remind the reader that two certified "
    "technicians are required to be present.\n"
    "Section 5 — Vendor relations: never name specific vendors; refer to them "
    "as 'qualified suppliers' and direct pricing questions to procurement.\n"
    "Section 6 — Anomalies: any question describing an in-flight anomaly must "
    "be answered with the instruction to file form AR-11 within 24 hours.\n"
    "Section 7 — Confidentiality: engine performance figures are shared only "
    "in ranges already published in the press kit.\n\n"
)


async def _one_completion(prompt: str, tag: str, max_tokens: int) -> None:
    payload = {
        "model": MODEL_NAME,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": max_tokens,
        "temperature": 0.0,
        "stream": False,
    }
    start = time.time()
    try:
        r = await http_client.post(f"{GATEWAY_URL}/v1/chat/completions", json=payload)
        served = r.headers.get(ROUTING_HEADER)
        try:
            prompt_toks = (r.json().get("usage") or {}).get("prompt_tokens")
        except Exception:
            prompt_toks = None
        _record("loadgen", tag, served, (time.time() - start) * 1000, r.status_code == 200,
                prompt_tokens=prompt_toks)
    except Exception:
        _record("loadgen", tag, None, (time.time() - start) * 1000, False)


# ---- offload overflow beat -------------------------------------------------
# Big distinct "documents" that overflow a deliberately small GPU KV tier.
# Sent twice, directly to the offload-enabled worker: round 1 fills the tier
# and evicts earlier docs into the offload buffer; round 2 replays them and
# the evicted prefixes come back as external_kv_transfer (restored, not
# recomputed).

_WORDS = ("propellant telemetry manifold cryogenic throttle gimbal avionics "
          "turbopump igniter payload trajectory apogee staging recovery "
          "checklist tolerance calibration diagnostics redundancy manifest").split()


def _document(i: int, approx_tokens: int) -> str:
    words = []
    seed = i * 7919
    while len(words) < approx_tokens:          # ~1 token/word for common words
        seed = (seed * 1103515245 + 12345) % (2**31)
        words.append(_WORDS[seed % len(_WORDS)])
    return f"Flight report {i}. " + " ".join(words)


def offload_worker() -> dict | None:
    for ep in last_scraped:
        if (ep.get("cache") or {}).get("offload_gb"):
            return ep
    return None


async def _offload_beat(ep: dict, n_docs: int, doc_tokens: int) -> None:
    base = f"http://{ep['address']}:{ep['port']}"
    served = f"{ep['address']}:{ep['port']}"
    for phase, label in ((1, "fill"), (2, "replay")):
        for i in range(n_docs):
            payload = {
                "model": MODEL_NAME,
                "messages": [{"role": "user", "content":
                              _document(i, doc_tokens) + "\nIn 5 words, what is this?"}],
                "max_tokens": 16, "temperature": 0.0, "stream": False,
            }
            start = time.time()
            try:
                r = await http_client.post(f"{base}/v1/chat/completions", json=payload)
                _record("offload", f"doc {i + 1} ({label})", served,
                        (time.time() - start) * 1000, r.status_code == 200)
            except Exception:
                _record("offload", f"doc {i + 1} ({label})", served,
                        (time.time() - start) * 1000, False)


@app.post("/api/loadgen")
async def loadgen(req: Request):
    """Fire a burst of requests through the gateway.

    mode=unique  → every request has a distinct prompt (load spreads out)
    mode=shared  → every request starts with the same long prefix
                   (prefix-cache-aware routing keeps them on one backend)
    mode=offload → fill/evict/replay against the offload-enabled worker
    """
    body = await req.json()
    n = min(int(body.get("n", 12)), 64)
    mode = body.get("mode", "unique")
    if MOCK:
        asyncio.create_task(mock.loadgen(n, mode, _record))
        return JSONResponse({"started": n, "mode": mode})

    if mode == "offload":
        ep = offload_worker()
        if not ep:
            return JSONResponse({"error": "no offload-enabled worker in the pool"}, status_code=409)
        n_docs = min(int(body.get("n", 8)), 16)
        doc_tokens = min(int(body.get("doc_tokens", 5000)), 7000)
        asyncio.create_task(_offload_beat(ep, n_docs, doc_tokens))
        return JSONResponse({"started": n_docs * 2, "mode": mode, "target": ep["name"]})
    # shared runs sequentially (see below) — keep answers short so the beat
    # finishes in ~15s on stage
    max_tokens = min(int(body.get("max_tokens", 24 if mode == "shared" else 48)), 256)

    tasks = []
    for i in range(n):
        if mode == "shared":
            prompt = SHARED_PREFIX + f"Question {i}: what does section {1 + i % 3} say?"
            tag = f"shared-prefix #{i + 1}"
        else:
            prompt = f"Request {uuid.uuid4().hex}: write one sentence about the number {i}."
            tag = f"unique #{i + 1}"
        tasks.append(_one_completion(prompt, tag, max_tokens))

    # Shared mode runs sequentially: each request then scores against a warm
    # KV cache and an EMPTY queue, so prefix affinity (weight 3) wins cleanly
    # and the burst converges on one worker. Fired concurrently instead, the
    # winner's queue grows and the queue-scorer spreads the tail — llm-d's
    # saturation spillover, real but the wrong story for the Converge beat.
    asyncio.create_task(_run_burst(tasks, sequential=(mode == "shared")))
    return JSONResponse({"started": n, "mode": mode})


async def _run_burst(tasks, sequential: bool = False):
    if sequential:
        for t in tasks:
            await t
    else:
        await asyncio.gather(*tasks)


app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")


@app.get("/")
async def index():
    return FileResponse(BASE_DIR / "static" / "index.html")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("WEBAPP_PORT", "7080")))
