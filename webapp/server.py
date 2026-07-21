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

# Live pool reshaping (Beat 3 from the browser). We mutate config/pool.txt in
# Python — one line per worker, `ip:port|device`, a leading `#` = disabled —
# then shell out to the SAME generator the CLI uses to rewrite endpoints.yaml,
# which the EPP live-reloads. The webapp binds 0.0.0.0 with no auth (trust your
# LAN, per the README), so every field is validated/sanitized before it can
# reach the file or the YAML the label lands in — no shell interpolation ever.
POOL_FILE = Path(os.environ.get("POOL_FILE", REPO_DIR / "config" / "pool.txt"))
GEN_SCRIPT = REPO_DIR / "scripts" / "mac" / "gen-endpoints.sh"
SERVED_NAME = os.environ.get("SERVED_NAME", MODEL_NAME)

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


@app.middleware("http")
async def _no_cache(request: Request, call_next):
    # a live demo should never serve a stale dashboard after an edit/redeploy
    resp = await call_next(request)
    if request.url.path == "/" or request.url.path.startswith("/static"):
        resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    return resp

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

    # drained workers (commented out in pool.txt) aren't in endpoints.yaml, so
    # they never get scraped — surface them as greyed, out-of-rotation stubs so
    # the dashboard can show "still in the file, no traffic reaching it".
    live_keys = {f"{e['address']}:{e['port']}" for e in scraped}
    for ep in _drained_endpoints():
        if f"{ep['address']}:{ep['port']}" not in live_keys:
            scraped.append(ep)

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


# ---- RAG marathon + saturation beats --------------------------------------
# One long shared document (a realistic RAG context, ~1.2K tokens) that many
# questions reference — the shape real apps hit prefix-cache affinity with.
RAG_DOC = (
    "ACME ROCKET COMPANY — FLIGHT OPERATIONS HANDBOOK (rev 12, unabridged)\n\n"
    "Section 1 — Purpose and scope: this handbook governs all pre-flight, "
    "flight, and post-flight operations for the Aurora and Borealis launch "
    "vehicles. It supersedes all prior revisions and must be carried, in full, "
    "by the flight director and every certified operator on console.\n"
    "Section 2 — Roles: the flight director owns the go/no-go decision. The "
    "propulsion officer owns cryogenic loading. The range safety officer owns "
    "the flight-termination system and may abort unilaterally at any time.\n"
    "Section 3 — Countdown: the terminal count begins at T-10 minutes. Holds "
    "may be called by any console for a red parameter; the count resumes only "
    "on the flight director's explicit poll of all stations.\n"
    "Section 4 — Cryogenic propellant: liquid oxygen and methane are loaded "
    "only with two certified technicians present. Loading pauses automatically "
    "if tank pressure exceeds the yellow band in Appendix C.\n"
    "Section 5 — Weather: launch is prohibited through cumulus cloud within "
    "10 nautical miles, or when the field mill reads above the threshold in "
    "Appendix D. The weather officer briefs the flight director at T-30.\n"
    "Section 6 — Abort modes: pad abort returns to safe-and-secure. Ascent "
    "aborts follow the mode-line table in Appendix E; each mode names a "
    "downrange recovery zone and a maximum wind for parachute descent.\n"
    "Section 7 — Anomalies: any in-flight anomaly is logged on form AR-11 "
    "within 24 hours and reviewed by the anomaly board before the next flight.\n"
    "Section 8 — Vendor relations: suppliers are referred to as 'qualified "
    "suppliers' in all external communication; pricing questions go to "
    "procurement, never to engineering.\n"
    "Section 9 — Confidentiality: engine performance figures are disclosed "
    "only in the ranges already published in the current press kit.\n"
    "Section 10 — Post-flight: the recovery team safes residual propellant "
    "before approach; the data team pulls telemetry within one hour and files "
    "the quick-look report before crew debrief.\n\n"
    "Answer strictly from the handbook above, in one or two sentences, and "
    "cite the section number you relied on.\n\n"
)

RAG_QS = [
    "who owns the go/no-go decision?", "who can abort unilaterally?",
    "when does the terminal count begin?", "how many technicians load cryogenic propellant?",
    "what happens if tank pressure exceeds the yellow band?", "what is the cloud rule for launch?",
    "who briefs the flight director on weather, and when?", "where are ascent-abort recovery zones listed?",
    "what form logs an in-flight anomaly, and by when?", "how are suppliers referred to externally?",
    "who answers pricing questions?", "what engine figures may be disclosed?",
    "what does the recovery team do before approach?", "when is telemetry pulled post-flight?",
    "who owns cryogenic loading?", "what may the range safety officer do at any time?",
]


async def _rag_beat(n: int) -> None:
    """A sustained RAG workload: many questions against one pinned document.
    Runs paced/sequential so prefix affinity converges and the reuse counters
    climb steadily for the length of the run instead of blipping once."""
    for i in range(n):
        prompt = RAG_DOC + f"Question {i + 1}: {RAG_QS[i % len(RAG_QS)]}"
        await _one_completion(prompt, f"RAG q{i + 1}", 24)


@app.post("/api/loadgen")
async def loadgen(req: Request):
    """Fire a burst of requests through the gateway.

    mode=unique   → every request has a distinct prompt (load spreads out)
    mode=shared   → every request starts with the same long prefix (converges)
    mode=rag      → a long RAG document + many questions, paced (reuse climbs)
    mode=offload  → fill/evict/replay against the offload-enabled worker
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

    if mode == "rag":
        n = min(int(body.get("n", 30)), 48)
        asyncio.create_task(_rag_beat(n))
        return JSONResponse({"started": n, "mode": mode})
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


# ---- live pool reshaping --------------------------------------------------

_IPV4_RE = re.compile(r'^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$')
# device label charset: letters/digits/space and the few separators the pool
# actually uses (· × / + . ( ) _ -). Everything else is dropped, so the label
# can never break the pool file (|) or the YAML string it becomes ("), nor
# carry anything a shell would ever see (it doesn't — gen-endpoints reads the
# file, we never pass the label as an argument).
_LABEL_DROP = re.compile(r'[^A-Za-z0-9 ._/+()·×·-]')
_pool_lock = asyncio.Lock()


def _valid_ipv4(a: str | None) -> bool:
    m = _IPV4_RE.match(a or "")
    return bool(m) and all(0 <= int(o) <= 255 for o in m.groups())


def _sanitize_device(s: str | None) -> str:
    s = (s or "").replace("|", " ").replace('"', "").replace("\n", " ")
    s = _LABEL_DROP.sub("", s)
    return re.sub(r"\s+", " ", s).strip()[:48]


def _ep_from_body(body: dict) -> tuple[str | None, str | None]:
    addr = body.get("address")
    port = str(body.get("port", "")).strip()
    if not _valid_ipv4(addr):
        return None, "address must be a literal IPv4 (e.g. 192.168.1.20)"
    if not (port.isdigit() and 1 <= int(port) <= 65535):
        return None, "port must be a number 1–65535"
    return f"{addr}:{int(port)}", None


def _pool_lines() -> list[str]:
    try:
        return POOL_FILE.read_text().splitlines()
    except FileNotFoundError:
        return []


def _write_pool(lines: list[str]) -> None:
    POOL_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = POOL_FILE.with_suffix(".tmp")
    tmp.write_text("\n".join(lines) + ("\n" if lines else ""))
    tmp.replace(POOL_FILE)


def _line_ep(line: str) -> str:
    body = line[1:] if line.lstrip().startswith("#") else line
    return body.split("|", 1)[0].strip()


def _drained_endpoints() -> list[dict]:
    """Commented-out (`#`) pool.txt lines → greyed out-of-rotation stubs."""
    out = []
    for line in _pool_lines():
        s = line.lstrip()
        if not s.startswith("#"):
            continue
        body = s[1:].strip()
        ep = body.split("|", 1)[0].strip()
        if ":" not in ep:
            continue
        addr, _, port = ep.rpartition(":")
        if not _valid_ipv4(addr):
            continue
        device = body.split("|", 1)[1].strip() if "|" in body else ""
        out.append({
            "name": f"vllm-{addr.rsplit('.', 1)[-1]}-{port}",
            "address": addr, "port": port,
            "labels": {DEVICE_LABEL: device} if device else {},
            "device": device or None,
            "healthy": False, "disabled": True, "engine": "drained",
            "metrics": {}, "cache": {}, "model_id": None,
        })
    return out


async def _regen_endpoints() -> tuple[int, str]:
    """Rerun the CLI's generator to rewrite endpoints.yaml from pool.txt."""
    proc = await asyncio.create_subprocess_exec(
        "bash", str(GEN_SCRIPT),
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        env={**os.environ, "SERVED_NAME": SERVED_NAME},
    )
    _, err = await proc.communicate()
    return proc.returncode, (err or b"").decode(errors="replace").strip()


def _pool_response(warning: str | None = None) -> dict:
    try:
        pf = {"raw": ENDPOINTS_FILE.read_text(), "mtime": ENDPOINTS_FILE.stat().st_mtime}
    except OSError:
        pf = {"raw": "", "mtime": None}
    out = {"ok": True, "pool_file": pf, "endpoints": load_endpoints()}
    if warning:
        out["warning"] = warning
    return out


async def _detect_device(ep: str) -> str:
    """Best-effort device label from the worker's model id, so a non-Apple
    machine isn't silently mislabeled when the user leaves 'Auto-detect'."""
    addr, _, port = ep.rpartition(":")
    try:
        r = await http_client.get(f"http://{addr}:{port}/v1/models", timeout=2.0)
        data = (r.json().get("data") or [{}])[0]
        mid = (data.get("root") or data.get("id") or "").lower()
    except Exception:
        return ""
    if mid.startswith("nvidia") or "cuda" in mid or "nvfp4" in mid:
        return "NVIDIA · CUDA"
    if "mlx" in mid:
        return "Apple Silicon · Metal"
    return "vLLM worker" if mid else ""


@app.post("/api/pool/add")
async def pool_add(req: Request):
    body = await req.json()
    ep, err = _ep_from_body(body)
    if err:
        return JSONResponse({"error": err}, status_code=400)
    device = _sanitize_device(body.get("device"))
    if MOCK:
        return JSONResponse(mock.pool_add(ep, device or "Simulated worker"))
    if not device:                          # 'Auto-detect' → derive from the worker
        device = _sanitize_device(await _detect_device(ep))
    async with _pool_lock:
        lines = [l for l in _pool_lines() if _line_ep(l) != ep]
        lines.append(f"{ep}|{device}")
        _write_pool(lines)
        rc, gen_err = await _regen_endpoints()
    return JSONResponse(_pool_response(gen_err if rc else None))


@app.post("/api/pool/remove")
async def pool_remove(req: Request):
    body = await req.json()
    ep, err = _ep_from_body(body)
    if err:
        return JSONResponse({"error": err}, status_code=400)
    if MOCK:
        return JSONResponse(mock.pool_remove(ep))
    async with _pool_lock:
        lines = [l for l in _pool_lines() if _line_ep(l) != ep]
        _write_pool(lines)
        rc, gen_err = await _regen_endpoints()
    return JSONResponse(_pool_response(gen_err if rc else None))


@app.post("/api/pool/disable")
async def pool_disable(req: Request):
    """Comment a worker out (drain) without deleting it, or restore it."""
    body = await req.json()
    ep, err = _ep_from_body(body)
    if err:
        return JSONResponse({"error": err}, status_code=400)
    disabled = bool(body.get("disabled", True))
    if MOCK:
        return JSONResponse(mock.pool_disable(ep, disabled))
    async with _pool_lock:
        out = []
        for l in _pool_lines():
            if _line_ep(l) == ep:
                bare = l.lstrip()[1:].lstrip() if l.lstrip().startswith("#") else l
                out.append(f"# {bare}" if disabled else bare)
            else:
                out.append(l)
        _write_pool(out)
        rc, gen_err = await _regen_endpoints()
    return JSONResponse(_pool_response(gen_err if rc else None))


app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")


@app.get("/")
async def index():
    return FileResponse(BASE_DIR / "static" / "index.html")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("WEBAPP_PORT", "7080")))
