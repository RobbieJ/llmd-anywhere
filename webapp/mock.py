"""Zero-hardware mock backend for the dashboard (MOCK=1).

Simulates a two-worker heterogeneous pool with plausible scheduler behaviour:
unique bursts spread, shared-prefix bursts converge on one worker, cached
token counters climb. Lets anyone explore the dashboard with no vLLM, no
Docker, no GPUs — `MOCK=1 python webapp/server.py`.
"""

import asyncio
import random
import time

MODEL = "llmd-demo"

WORKERS = [
    {
        "name": "vllm-10-8001", "address": "10.0.0.10", "port": "8001",
        "labels": {"model": MODEL, "llm-d.ai/device": "NVIDIA GB10 (simulated)"},
        "kv_tokens": 2252377, "dtype": "fp8", "latency": (0.35, 0.9),
    },
    {
        "name": "vllm-20-8002", "address": "10.0.0.20", "port": "8002",
        "labels": {"model": MODEL, "llm-d.ai/device": "Apple M3 Max (simulated)"},
        "kv_tokens": 415152, "dtype": None, "latency": (0.6, 1.6),
    },
]

# mutable per-worker counters, random-walked as fake load flows through.
# Asymmetric seeds: the M3 Max "holds" the shared prefix (warm, high reuse);
# the GB10 is colder but shows a restored-from-offload slice.
_SEEDS = {
    "vllm-10-8001": {"prefix_hits": 8.0, "prefix_queries": 60.0, "prompt_cached": 5000.0,
                     "prompt_restored": 2000.0, "prompt_computed": 18000.0},
    "vllm-20-8002": {"prefix_hits": 40.0, "prefix_queries": 60.0, "prompt_cached": 26000.0,
                     "prompt_restored": 0.0, "prompt_computed": 12000.0},
}
_stats = {
    w["name"]: {
        "running": 0, "waiting": 0, "gen_tokens": 0.0,
        "attempts": random.randint(20, 40),
        **_SEEDS[w["name"]],
    }
    for w in WORKERS
}
_epp_index_size = 47
_warm_worker = WORKERS[1]["name"]   # who currently "holds" the shared prefix


def state() -> dict:
    endpoints = []
    for w in WORKERS:
        if w.get("disabled"):        # drained: greyed, out-of-rotation stub
            endpoints.append({
                **{k: w[k] for k in ("name", "address", "port", "labels")},
                "healthy": False, "disabled": True, "engine": "drained",
                "device": w["labels"]["llm-d.ai/device"],
                "metrics": {}, "cache": {}, "model_id": None,
            })
            continue
        s = _stats[w["name"]]
        endpoints.append({
            **{k: w[k] for k in ("name", "address", "port", "labels")},
            "healthy": True, "engine": "vllm",
            "model_id": "Qwen/Qwen2.5-7B-Instruct" if w["dtype"] else "mlx-community/Qwen2.5-1.5B-Instruct-4bit",
            "device": w["labels"]["llm-d.ai/device"],
            "cache": {"kv_tokens": w["kv_tokens"],
                      **({"dtype": w["dtype"]} if w["dtype"] else {}),
                      **({"offload_gb": 8.0} if w["dtype"] else {})},   # sim: GB10 has offload
            "metrics": {
                "running": s["running"], "waiting": s["waiting"],
                "kv_cache_usage": min(0.9, (s["running"] + s["waiting"]) * 0.03),
                "generation_tokens": s["gen_tokens"],
                "prefix_hits": s["prefix_hits"], "prefix_queries": s["prefix_queries"],
                "prompt_cached": s["prompt_cached"], "prompt_restored": s["prompt_restored"],
                "prompt_computed": s["prompt_computed"],
            },
        })
    pool_raw = "# simulated pool (MOCK=1) — no real machines behind this\nendpoints:\n" + "".join(
        f'  - name: {w["name"]}\n    address: "{w["address"]}"\n    port: "{w["port"]}"\n'
        f'    labels:\n      model: {MODEL}\n      llm-d.ai/device: "{w["labels"]["llm-d.ai/device"]}"\n'
        for w in WORKERS if not w.get("disabled")
    )
    return {
        "ts": time.time(), "model": MODEL, "gateway": "mock://gateway",
        "gateway_healthy": True, "endpoints": endpoints,
        "pool_file": {"raw": pool_raw, "mtime": time.time() - 120},
    }


def epp(weights: list) -> dict:
    return {
        "healthy": True,
        "attempts": {w["name"]: _stats[w["name"]]["attempts"] for w in WORKERS},
        "sched_avg_us": round(random.uniform(12, 17), 1),
        "plugin_avg_us": {"prefix-cache-scorer": 1.1, "queue-scorer": 0.4,
                          "kv-cache-utilization-scorer": 0.3, "no-hit-lru-scorer": 2.0},
        "ready_endpoints": len(WORKERS),
        "prefix_index_size": _epp_index_size,
        "version": "v0.9.0 (mock)",
        "weights": weights or [
            {"name": "queue-scorer", "weight": 2},
            {"name": "kv-cache-utilization-scorer", "weight": 2},
            {"name": "prefix-cache-scorer", "weight": 3},
            {"name": "no-hit-lru-scorer", "weight": 2},
        ],
    }


def _signals() -> dict:
    out = {}
    for w in WORKERS:
        s = _stats[w["name"]]
        hit = round(100 * s["prefix_hits"] / s["prefix_queries"], 1) if s["prefix_queries"] else None
        out[w["name"]] = {
            "queue": s["waiting"],
            "kv_pct": round(min(90.0, (s["running"] + s["waiting"]) * 3.0), 1),
            "prefix_hit_pct": hit, "healthy": True,
        }
    return out


def _pick(mode: str, i: int) -> dict | None:
    active = [w for w in WORKERS if not w.get("disabled")] or WORKERS
    if not active:
        return None                         # empty pool — caller no-ops the burst
    if mode == "shared":
        return next((w for w in active if w["name"] == _warm_worker), active[0])
    # unique: spread, lightly favouring the shorter queue
    return min(active, key=lambda w: _stats[w["name"]]["waiting"] + random.random())


def _pool_response() -> dict:
    s = state()
    return {
        "ok": True,
        "pool_file": {"raw": s["pool_file"]["raw"], "mtime": time.time()},
        "endpoints": [{"name": e["name"], "address": e["address"],
                       "port": e["port"], "labels": e["labels"]} for e in s["endpoints"]],
    }


def pool_add(ep: str, device: str) -> dict:
    ip, port = ep.split(":")
    WORKERS[:] = [w for w in WORKERS if f'{w["address"]}:{w["port"]}' != ep]
    name = f"vllm-{ip.split('.')[-1]}-{port}"
    WORKERS.append({
        "name": name, "address": ip, "port": port,
        "labels": {"model": MODEL, "llm-d.ai/device": device or "Simulated worker"},
        "kv_tokens": 415152, "dtype": None, "latency": (0.5, 1.4), "disabled": False,
    })
    _stats[name] = {
        "running": 0, "waiting": 0, "gen_tokens": 0.0, "attempts": 0,
        "prefix_hits": 0.0, "prefix_queries": 0.0,
        "prompt_cached": 0.0, "prompt_restored": 0.0, "prompt_computed": 0.0,
    }
    return _pool_response()


def pool_remove(ep: str) -> dict:
    for w in [w for w in WORKERS if f'{w["address"]}:{w["port"]}' == ep]:
        WORKERS.remove(w)
        _stats.pop(w["name"], None)
    return _pool_response()


def pool_disable(ep: str, disabled: bool) -> dict:
    for w in WORKERS:
        if f'{w["address"]}:{w["port"]}' == ep:
            w["disabled"] = disabled
    return _pool_response()


async def _one(worker: dict, tag: str, kind: str, record) -> None:
    global _epp_index_size
    s = _stats[worker["name"]]
    s["waiting"] += 1
    await asyncio.sleep(random.uniform(0.05, 0.4))
    s["waiting"] -= 1
    s["running"] += 1
    start = time.time()
    lo, hi = worker["latency"]
    # shared and RAG both reuse a long shared prefix → warm cache hits
    reuse = tag.startswith(("shared", "RAG"))
    big = tag.startswith("RAG")
    dur = random.uniform(lo, hi) * (0.5 if reuse else 1.0)
    await asyncio.sleep(dur)
    s["running"] -= 1
    s["gen_tokens"] += random.randint(20, 60)
    s["prefix_queries"] += 1
    s["attempts"] += 1
    if reuse:
        s["prefix_hits"] += 1
        s["prompt_cached"] += random.randint(900, 1300) if big else random.randint(280, 380)
        s["prompt_computed"] += random.randint(10, 40)
    else:
        s["prompt_computed"] += random.randint(30, 90)
        _epp_index_size += 1
    record(kind, tag, f'{worker["address"]}:{worker["port"]}',
           (time.time() - start) * 1000, True, signals=_signals(),
           prompt_tokens=random.randint(400, 440) if reuse else random.randint(25, 45))


async def loadgen(n: int, mode: str, record) -> None:
    if not [w for w in WORKERS if not w.get("disabled")]:
        return                              # empty/all-drained pool — nothing to route
    if mode == "offload":
        # simulate fill/evict/replay against the offload-enabled worker
        worker = WORKERS[0]
        s = _stats[worker["name"]]
        served = f'{worker["address"]}:{worker["port"]}'
        for phase, label in ((1, "fill"), (2, "replay")):
            for i in range(8):
                await asyncio.sleep(random.uniform(0.4, 0.9) if phase == 1 else random.uniform(0.15, 0.3))
                if phase == 1:
                    s["prompt_computed"] += 5000
                else:
                    s["prompt_restored"] += random.randint(4200, 5000)
                s["gen_tokens"] += 16
                s["attempts"] += 1
                record("offload", f"doc {i + 1} ({label})", served,
                       random.uniform(300, 900) * (3 if phase == 1 else 1), True,
                       signals=_signals(), prompt_tokens=5000)
        return
    seq = mode in ("shared", "rag")
    tasks = []
    for i in range(n):
        if mode == "rag":
            tag = f"RAG q{i + 1}"
        elif mode == "shared":
            tag = f"shared-prefix #{i + 1}"
        else:
            tag = f"unique #{i + 1}"
        worker = _pick("shared" if seq else mode, i)
        tasks.append(_one(worker, tag, "loadgen", record))
    if seq:
        for t in tasks:
            await t
    else:
        await asyncio.gather(*tasks)


_REPLY = ("This is a simulated reply — no model is running. Start real workers "
          "with ./demo up, or just enjoy the routing animation. ")


async def chat_stream(tag: str, record):
    """Yield SSE lines shaped like the real /api/chat."""
    import json as _json
    worker = _pick("unique", 0)
    served = f'{worker["address"]}:{worker["port"]}'
    yield f"event: routing\ndata: {_json.dumps({'served_by': served})}\n\n"
    start = time.time()
    for word in (_REPLY * 2).split(" "):
        await asyncio.sleep(0.04)
        chunk = {"choices": [{"delta": {"content": word + " "}}]}
        yield f"data: {_json.dumps(chunk)}\n\n"
    s = _stats[worker["name"]]
    s["gen_tokens"] += len(_REPLY.split())
    s["attempts"] += 1
    s["prefix_queries"] += 1
    s["prompt_computed"] += random.randint(60, 120)
    record("chat", tag, served, (time.time() - start) * 1000, True,
           ttft_ms=80.0, signals=_signals(), prompt_tokens=random.randint(80, 120))
    yield "event: done\ndata: {}\n\n"
