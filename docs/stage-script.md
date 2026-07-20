# Stage script — llm-d without Kubernetes

A ~8-minute talk track for the dashboard. Have the dashboard full-screen and a
terminal on a second screen (or split) for Beat 3.

## Setup (before the audience arrives)

- `./demo up` (or confirm `./demo status` is green), open the dashboard URL.
- Send one chat message so the feed isn't empty.
- Know your numbers: pool size, KV-cache capacities on the machine cards.

## Opening (30s)

> "Two very different machines — [point at the cards] — serving one AI model
> behind one address. There is no Kubernetes here. The entire cluster state is
> a text file, and this [point at the scheduler node] is llm-d's Endpoint
> Picker deciding, per request, which machine should answer."

Point at the formula in the brain node: *most reusable work* carries the
highest weight — that's prefix-cache-aware routing.

## Beat 1 — Spread (1 min)

Press **Send 12 unique prompts**.

> "Twelve different questions. Nothing is reusable between them, so the
> scheduler's job is simply: keep every line short. Watch the dots — they fan
> out across both machines. No machine builds a queue."

Point at the queue chips appearing on the worker nodes, then the result
caption and the mixed-color ribbon.

## Beat 2 — Converge (2 min)

Press **Send 12 shared-prefix prompts**.

> "Now twelve questions that all start with the same long instructions — the
> same system prompt, like every real application sends. The first request
> lands somewhere; that machine now *remembers* the shared beginning in its
> KV cache. The scheduler's prefix scorer notices — and sends every following
> request to the same place."

Watch: all dots go to one worker; the ribbon runs solid in one color; the
**tokens never recomputed** and **dollar** counters climb.

> "That counter is prompt work we never redid — priced at what commercial APIs
> charge for exactly this: cached input tokens are ~10× cheaper than fresh
> ones. llm-d's own benchmarks: 3× throughput, 2× faster first token versus
> round-robin."

Click the newest decision row:

> "And it will show its work — here's what the scheduler saw for each machine
> at that moment: queue, memory, reusable work, as weighted scores."

## Beat 3 — The cluster is a file (2 min)

In the terminal:

```bash
./demo pool remove <ip:port>       # drop a worker
```

> "This is the part that normally needs a Kubernetes control plane. My cluster
> state is a YAML file. The Endpoint Picker watches it."

Watch the worker vanish from the topology and the ready-count drop. Then:

```bash
./demo pool add <ip:port> "<device>"
```

> "…and it's back. No restarts, no operators, no CRDs. A text file."

If you have a second machine handy, this is the moment to join it live
(`./demo worker` there, `./demo pool add` here).

## Beat 4 — Overflow: the offload buffer (optional, 2 min)

Needs an offload-enabled CUDA worker in the pool (`OFFLOAD_GB=16
NUM_GPU_BLOCKS=2048` on a vLLM worker — the button stays greyed out
otherwise). Press **Fill, evict & restore**.

> "Eight big documents, sent to a worker whose fast cache tier I've made
> deliberately tiny. Watch them overflow it — evicted memory is spilling into
> an offload buffer instead of being thrown away. Now the same eight documents
> replay… and look at 'restored from offload' climb. That work came back as a
> memory copy, not a recompute. On discrete GPUs that buffer is cheap host RAM
> behind expensive VRAM — and the tiers extend to disk."

Note for unified-memory-only pools (all-Mac, DGX Spark): skip this beat and
use the Q&A answer below if asked.

## Beat 5 — A sticky conversation (encore, 1 min)

Scroll to the chat. Send a message ("My name is … and my favourite colour
is …"), then a follow-up ("What's my favourite colour?").

> "This chat remembers the conversation — and notice the memory line: it names
> the machine whose KV cache holds our history. Every follow-up turn lands on
> that same machine, because re-reading the history there is free. That's not
> session stickiness I configured — the scheduler *derives* it from the
> prefix scorer."

Point at the worker badges on the two replies (same machine, same colour), and
the model badge on that machine's card — the audience can see exactly which
weights are answering. Then press **Clear memory**:

> "Clear the memory and the pin is gone — the next message is fresh work,
> routable anywhere."

## Close (30s)

Scroll to the footer.

> "Everything you watched is the same scheduler and gateway llm-d ships for
> Kubernetes — the well-lit path for intelligent inference scheduling — just
> discovered from a file instead of an InferencePool. llm-d is a CNCF Sandbox
> project from Red Hat, Google Cloud, IBM Research, CoreWeave and NVIDIA.
> The demo's on GitHub."

## Q&A ammunition

- **"Why not round-robin?"** — Round-robin is cache-blind: it splits shared
  prefixes across cold caches and recomputes them. llm-d's blog measured P90
  TTFT 0.54s vs 92.5s (random) under heavy shared-context load.
- **"What happens under saturation?"** — Affinity is weighted, not absolute:
  when the warm worker's queue grows, the queue scorer overrules prefix
  affinity and spills to the other machine. (You may see this live if you
  spam Beat 2 concurrently.)
- **"Does this scale?"** — Same components, Kubernetes discovery instead of a
  file; plus the paths this demo *doesn't* show: prefill/decode
  disaggregation, wide expert-parallelism, SLO-driven autoscaling.
- **"What about KV offloading / tiered caching?"** — Real and supported
  (vLLM's offloading connector, LMCache disk/remote tiers — llm-d's
  'advanced KV-cache management' path), but it pays off on discrete GPUs
  where VRAM is small and host DRAM is big. Every machine in THIS pool has
  unified memory — GPU and CPU share one RAM pool — so CPU offload would
  just copy bytes to itself. Right-sizing the cache fraction is the
  unified-memory equivalent.
- **"What's the scheduling overhead?"** — It's on screen: ~15 µs per decision
  against multi-second inferences.
- **"Why did my two-turn chat not pin?"** — The EPP's prefix indexer matches
  in 256-byte blocks; a couple of short bare turns is under one block. The
  demo chat carries a system prompt (as every real app does), which is what
  makes conversations pin from turn 2. Short prefixes scoring zero is by
  design — there's nothing worth chasing.
