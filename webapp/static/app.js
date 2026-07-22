/* llm-d local demo dashboard */

const css = getComputedStyle(document.documentElement);
const PALETTE = ['--series-1', '--series-2', '--series-3'].map(v => css.getPropertyValue(v).trim());
const FALLBACK = css.getPropertyValue('--series-overflow').trim() || '#B8B8B8';
const POLL_MS = 1500;
const SPARK_POINTS = 60;

const seriesColor = new Map(); // endpoint name -> color, fixed on first sight
const history = new Map();     // endpoint name -> [{t, rate}]
const lastTokens = new Map();  // endpoint name -> {t, total}
const payoffWindow = new Map(); // endpoint name -> [{t, reused}], 60s window
const lastReused = new Map();   // endpoint name -> reused total (bump detection)

function colorFor(name) {
  if (!seriesColor.has(name)) {
    const idx = seriesColor.size;
    seriesColor.set(name, idx < PALETTE.length ? PALETTE[idx] : FALLBACK);
  }
  return seriesColor.get(name);
}

function fmt(n, d = 0) {
  return n == null ? '–' : Number(n).toFixed(d);
}

function fmtTokens(n) {
  if (n == null) return null;
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'K';
  return String(Math.round(n));
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function shortModel(id) {
  // "mlx-community/Qwen2.5-7B-Instruct-4bit" -> "Qwen2.5-7B-Instruct-4bit"
  return id ? String(id).split('/').pop() : null;
}

/* ---------- glossary: plain-English definitions, shared tooltip ---------- */

const GLOSSARY = {
  epp:        ['Endpoint Picker (EPP)', 'The scheduler. It checks every machine’s live stats and picks one for each request.'],
  gateway:    ['Gateway (Envoy)', 'The single front door. Every request enters here, whichever machine ends up answering.'],
  kv:         ['KV cache', 'The model’s short-term memory of text it has already read. Reusing it skips redoing that work.'],
  prefix:     ['Prefix', 'The identical beginning shared by several prompts — like the same long instructions pasted at the top.'],
  prefixhit:  ['Prefix-cache hit', 'How much of a new prompt this machine had already processed and could reuse.'],
  roundrobin: ['Round-robin', 'Taking turns blindly — 1, 2, 1, 2 — ignoring how busy each machine is. This scheduler doesn’t do that.'],
  cachemiss:  ['Cache miss', 'The chosen machine hasn’t seen this prompt’s beginning before, so it must redo all of that work.'],
  vllm:       ['vLLM', 'The open-source engine that actually runs the AI model on each machine.'],
  kubernetes: ['Kubernetes', 'The heavyweight cluster software normally needed to run a fleet like this. This demo does without it — the machine list is a text file.'],
  openai:     ['OpenAI-compatible', 'Speaks the same API format as OpenAI, so existing apps can point here unchanged.'],
  cachedprice: ['Cached-token pricing', 'Commercial AI APIs charge ~10× less for prompt tokens served from cache (e.g. $3.00 vs $0.30 per million) because the provider skips the compute. The same economics apply to your own hardware: reused work is capacity you get back.'],
};

// typical frontier-API list prices, $ per million input tokens — the market's
// own measure of what a cache hit is worth (the llm-d project cites the same gap)
const PRICE_FRESH_PER_M = 3.00;
const PRICE_CACHED_PER_M = 0.30;

const tooltip = document.getElementById('tooltip');

document.addEventListener('mouseover', (ev) => {
  const el = ev.target.closest('.term');
  if (!el) return;
  const entry = GLOSSARY[el.dataset.term];
  if (!entry) return;
  tooltip.style.display = 'block';
  tooltip.style.maxWidth = '340px';
  tooltip.style.whiteSpace = 'normal';
  tooltip.innerHTML = `<b>${escapeHtml(entry[0])}</b> — ${escapeHtml(entry[1])}`;
  const r = el.getBoundingClientRect();
  tooltip.style.left = (r.left + window.scrollX + r.width / 2) + 'px';
  tooltip.style.top = (r.top + window.scrollY - 6) + 'px';
});
document.addEventListener('mouseout', (ev) => {
  if (ev.target.closest && ev.target.closest('.term')) {
    tooltip.style.display = 'none';
    tooltip.style.maxWidth = '';
    tooltip.style.whiteSpace = 'nowrap';
  }
});

// populate the collapsible glossary panel from the same dict
document.getElementById('glossary-list').innerHTML =
  Object.values(GLOSSARY).map(([t, d]) => `<div><dt>${escapeHtml(t)}</dt><dd>${escapeHtml(d)}</dd></div>`).join('');

/* ---------- info popovers: the page's explanatory prose, on demand ---------- */

const INFO = {
  addworker: `<h4>Add a machine</h4>
    <p>Type a machine's LAN address and port; it's appended to the pool file and the
    <span class="term" data-term="epp">scheduler</span> live-reloads within a couple of seconds — no
    restart. The address must be a literal IPv4: the file-based discovery plugin doesn't resolve
    hostnames.</p>
    <p>If the machine isn't answering yet it's written to the file but held out of the live pool
    until it responds — the same health check the command line does.</p>`,
  drain: `<h4>Drain a machine</h4>
    <p>Draining comments the machine out of the list the scheduler reads — the line stays in the
    file, so nothing is lost, but no new request is sent there. Undo it and the machine rejoins in
    seconds.</p>
    <p>This is the safe way to take a machine out of rotation. (Leaving a <i>dead</i> machine listed
    is the opposite mistake — to the scheduler an unreachable worker looks perfectly idle, so it
    keeps winning traffic. That's why the pool file skips machines that don't answer.)</p>`,
  rrsplit: `<h4>llm-d vs. blind round-robin</h4>
    <p>For every recent request the dashboard also asks: which machine would a cache-blind
    <span class="term" data-term="roundrobin">round-robin</span> balancer have picked? The bars
    compare how often each approach landed on a machine that <i>already remembered</i> the prompt's
    beginning — a warm cache instead of redone work.</p>
    <p>Round-robin's bar is a live counterfactual: that machine never actually ran the request, so
    it's an estimate from the same stats the scheduler saw.</p>`,
  overview: `<h4>What is this?</h4>
    <p>Two very different machines serve one AI model behind one address. The list of machines is a
    plain text file (<span class="mono">endpoints.yaml</span>); a small scheduler — the
    <span class="term" data-term="epp">llm-d Endpoint Picker</span> — reads each machine's live stats
    and picks the best one for every request. No <span class="term" data-term="kubernetes">Kubernetes</span> cluster anywhere.</p>
    <p class="steps"><b>①</b> A request arrives at one front door (the <span class="term" data-term="gateway">gateway</span>) &nbsp;
    <b>②</b> The scheduler checks every machine's queue, memory and reusable work — and picks one &nbsp;
    <b>③</b> The answer streams back; the coloured badge shows which machine wrote it</p>`,
  machines: `<h4>The machines</h4>
    <p><span class="lead">What ·</span> Every worker in the pool, with live stats scraped from its own
    <span class="term" data-term="vllm">vLLM</span> metrics — the real model it runs, how many
    requests it's answering now, and its <span class="term" data-term="kv">KV cache</span> use.</p>
    <p><span class="lead">Why ·</span> The point of llm-d is one service across very different hardware
    — a desktop AI box and a laptop's graphics chip answer behind a single address. The cards show the
    real weights behind each, so a heterogeneous pool is visible even though every worker answers to
    one shared model name.</p>
    <p><span class="lead">How ·</span> The memory bar's <i>length</i> is that machine's share of the
    pool's total KV-cache capacity — some tanks are ~5× bigger. Cards appear and vanish as the pool
    file changes.</p>`,
  workersavings: `<h4>Work this machine never redid</h4>
    <p>Of all the prompt text this machine has ever been asked to read, the coloured share was
    already sitting in its <span class="term" data-term="kv">KV cache</span> — served as a lookup
    instead of recomputed. The grey share was fresh work. A paler segment appears when tokens came
    back from the offload buffer rather than the fast tier (Beat 4).</p>
    <p>The dollar figure prices those reused tokens at the commercial-API gap for
    <span class="term" data-term="cachedprice">cached input</span> ($3.00 vs $0.30 per million).
    Every machine's bar adds up to the pool counter above — same numbers, split per machine. These
    are the worker's own lifetime counters (<code>prompt_tokens_by_source</code>), not this page's
    bookkeeping.</p>`,
  routingvalue: `<h4>What routing itself is worth</h4>
    <p>For every request the dashboard also asks: which machine would a blind
    <span class="term" data-term="roundrobin">round-robin</span> balancer have picked? When the
    scheduler chose a machine that already remembered the prompt's beginning and round-robin's
    pick did not, that request's reused work was preserved by routing — not luck.</p>
    <p>The estimate multiplies each such request's prompt size (reported by the worker) by the
    extra share the chosen machine had cached, priced at the cached-token gap. It is labelled an
    estimate because the counterfactual machine never actually ran the request.</p>`,
  scheduling: `<h4>Scheduling</h4>
    <p><span class="lead">What ·</span> Every request is scored against each machine's live stats and
    flies to the winner — each dot is a real request consulting the scheduler. No blind turn-taking
    (<span class="term" data-term="roundrobin">round-robin</span>).</p>
    <p><span class="lead">Why ·</span> A <span class="term" data-term="cachemiss">cache miss</span>
    means redoing all the work on a prompt's shared beginning; a hit turns it into a lookup. So "most
    reusable work" carries the highest weight (3×), above short queue (2×), free memory (2×) and
    spreading cold prompts off hot caches (2×).</p>
    <p><span class="lead">How ·</span> The scheduler (llm-d's Endpoint Picker) scrapes each worker's
    vLLM metrics, scores them per request, and hands the pick to the gateway. llm-d benchmarks:
    3× throughput, 2× faster first response vs round-robin ·
    <a href="https://github.com/llm-d/llm-d">github.com/llm-d</a></p>`,
  savings: `<h4>What the cache is worth</h4>
    <p><span class="lead">What ·</span> The pool's reused prompt tokens — served from cache instead of
    recomputed — counted, and priced in dollars.</p>
    <p><span class="lead">Why ·</span> Commercial AI APIs charge ~10× less for cached input (typically
    $3.00 per million fresh vs $0.30 cached) because the provider skips the compute. The same
    economics apply on your own hardware: reused work is capacity — and latency — you get back.</p>
    <p><span class="lead">How ·</span> Summed from every worker's own vLLM counter
    (<code>prompt_tokens_by_source</code>) and priced at that gap. Each machine's "work never redone"
    bar adds up to this pool figure.</p>`,
  beat1: `<h4>Beat 1 · Spread</h4>
    <p><span class="lead">What ·</span> Fires 12 completely different questions at once. The dots fan
    out roughly evenly, hollow (fresh work) on each machine.</p>
    <p><span class="lead">Why ·</span> Nothing is reusable between distinct prompts, so there's no
    cache to chase — the scheduler's job reduces to keeping every queue short. Here a good round-robin
    would do about as well; the payoff comes in Beat 2, when work <i>is</i> reusable.</p>
    <p><span class="lead">How ·</span> Each request carries a random unique prompt; the scheduler
    scores every machine on queue depth and picks the shortest line.</p>`,
  beat2: `<h4>Beat 2 · Converge</h4>
    <p><span class="lead">What ·</span> Fires 12 questions that all begin with the same long
    instructions (a shared <span class="term" data-term="prefix">prefix</span>, like a system prompt).
    They all land on ONE machine, the dots turn solid, and the savings counter climbs.</p>
    <p><span class="lead">Why ·</span> The first request makes one machine remember that shared
    beginning in its <span class="term" data-term="kv">KV cache</span>. Re-reading it there is free, so
    the prefix scorer (the heaviest weight) keeps sending the rest to the same machine — affinity the
    scheduler <i>derives</i>, not stickiness you configured.</p>
    <p><span class="lead">How ·</span> The prefix is a multi-KB block and the requests run one after
    another, so each scores against a warm cache and an empty queue and affinity wins cleanly.</p>`,
  rag: `<h4>Bigger · RAG workload</h4>
    <p><span class="lead">What ·</span> The real shape of a retrieval app: one long document, then 30
    different questions about it, paced over ~40 seconds.</p>
    <p><span class="lead">Why ·</span> After the first question warms the
    <span class="term" data-term="kv">cache</span>, every following question reuses that document
    instead of recomputing it — so the reuse counters and the winning machine's "work never redone"
    bar climb <i>steadily</i> for the whole run, not in one blip. The more a context is reused, the
    more routing to where it already lives is worth.</p>
    <p><span class="lead">How ·</span> All 30 questions share the document as their prefix and run
    paced, so they converge on one machine and ride its warm cache.</p>`,
  beat3: `<h4>Beat 3 · Reshape the pool</h4>
    <p><span class="lead">What ·</span> The list of machines is one text file. Each card has a
    <b>⏻ drain</b> (out of rotation, reversibly) and <b>✕ remove</b>; the dashed tile adds one live.
    The topology and ready-count reshape within a couple of seconds.</p>
    <p><span class="lead">Why ·</span> This is the part that normally needs a
    <span class="term" data-term="kubernetes">Kubernetes</span> control plane and an InferencePool.
    Here the "cluster state" is a YAML file the scheduler watches — add, drain, or remove capacity by
    editing it: no operators, no CRDs, no restarts.</p>
    <p><span class="lead">How ·</span> The controls edit <span class="mono">config/pool.txt</span>; a
    generated <span class="mono">endpoints.yaml</span> is what the scheduler reads, and it live-reloads
    that file (<span class="mono">watchFile</span>) so routing follows. Draining just comments a line
    out — the machine stays in the file but receives no traffic.</p>`,
  beat4: `<h4>Beat 4 · Overflow (KV offloading)</h4>
    <p><span class="lead">What ·</span> A worker's fast <span class="term" data-term="kv">KV-cache</span>
    tier is deliberately shrunk, then 8 large documents are sent to it. They overflow the tier, and
    blocks evicted from it spill into a slower, larger <b>offload buffer</b> instead of being
    discarded. Replaying the same 8 documents brings that work back as "restored from offload" — a
    memory copy, not a recompute.</p>
    <p><span class="lead">Why ·</span> On a discrete GPU the fast tier is VRAM: small and expensive.
    Host RAM is large and cheap. Keeping evicted prefixes in host RAM (or on disk) means a returning
    prompt reloads in milliseconds instead of being recomputed from scratch — llm-d's "advanced
    KV-cache management" / tiered-cache path (vLLM's offloading connector; LMCache extends it to disk
    and remote tiers).</p>
    <p><span class="lead">How ·</span> Start a CUDA worker with
    <code>OFFLOAD_GB=16 NUM_GPU_BLOCKS=2048</code> (see <span class="mono">scripts/spark/start-vllm.sh</span>)
    — that adds the offload buffer and shrinks the fast tier so eviction actually happens on stage.
    The button lights up once such a worker joins the pool. <b>Unified-memory machines can't show
    this</b>: on Apple Silicon and the DGX Spark, "GPU" and "CPU" are the same physical RAM, so
    offloading would copy bytes to themselves — there you right-size the memory fraction instead.</p>`,
  file: `<h4>The cluster is a file</h4>
    <p>This is the entire "cluster state": a plain YAML file listing the machines. The scheduler
    live-reloads it on every change (<span class="mono">watchFile</span>) — what Kubernetes does with
    a control plane, done here with a text file. The count is the scheduler's own gauge.</p>`,
  decisions: `<h4>Routing decisions</h4>
    <p>Where the scheduler sent traffic. "Served by" is reported by the gateway itself
    (<span class="mono">x-llmd-served-by</span> response header), not this page's bookkeeping — and the
    smaller number is the scheduler's own lifetime counter.</p>
    <p>Click any row to see what the scheduler saw at that moment: each machine's queue, memory and
    reusable work, as weighted score bars.</p>`,
  chat: `<h4>Chat through the gateway</h4>
    <p>This chat talks to the same OpenAI-compatible address your application would call
    (<span class="mono">:8080</span>). The scheduler picks a machine per message; the badge shows who
    wrote each reply.</p>
    <p><b>Conversation memory is a routing story:</b> every turn resends the whole history, so the
    prompt grows a shared <span class="term" data-term="prefix">prefix</span>. After the first turn,
    one machine's <span class="term" data-term="kv">KV cache</span> already holds that history — and
    the scheduler keeps sending the conversation there. <b>Clear memory</b> and the pin is released:
    the next message is fresh work, routable anywhere.</p>`,
};

const infoPop = document.getElementById('info-pop');
let openInfoBtn = null;

function closeInfo() {
  infoPop.style.display = 'none';
  if (openInfoBtn) openInfoBtn.classList.remove('open');
  openInfoBtn = null;
}

document.addEventListener('click', (ev) => {
  const btn = ev.target.closest('.info-btn');
  if (!btn) {
    if (!ev.target.closest('.info-pop')) closeInfo();
    return;
  }
  if (openInfoBtn === btn) { closeInfo(); return; }
  closeInfo();
  const html = INFO[btn.dataset.info];
  if (!html) return;
  openInfoBtn = btn;
  btn.classList.add('open');
  infoPop.innerHTML = html;
  infoPop.style.display = 'block';
  const r = btn.getBoundingClientRect();
  const popW = Math.min(420, window.innerWidth - 24);
  const left = Math.max(12, Math.min(r.left + window.scrollX - 10, window.scrollX + window.innerWidth - popW - 12));
  infoPop.style.left = left + 'px';
  infoPop.style.top = (r.bottom + window.scrollY + 8) + 'px';
});

/* ---------- instance cards ---------- */

function renderInstances(state) {
  const root = document.getElementById('instances');
  document.getElementById('model-name').textContent = state.model;
  const maxKv = Math.max(1, ...state.endpoints.map(e => e.cache?.kv_tokens || 0));

  // drop cards for endpoints removed from endpoints.yaml (live-reload demo);
  // leave the persistent "＋ add a machine" tile in place
  const current = new Set(state.endpoints.map(e => `card-${e.name}`));
  for (const card of [...root.children]) {
    if (card.id.startsWith('card-') && !current.has(card.id)) card.remove();
  }

  for (const ep of state.endpoints) {
    const color = colorFor(ep.name);
    let card = document.getElementById(`card-${ep.name}`);
    if (!card) {
      card = document.createElement('div');
      card.className = 'card';
      card.id = `card-${ep.name}`;
      card.style.setProperty('--series', color);
      card.innerHTML = `
        <h3><span class="chip"></span><span class="name"></span>
            <span class="state-badge" style="display:none">drained</span>
            <span class="role" style="display:none"></span>
            <span class="card-actions">
              <button class="card-btn" data-act="drain" title="drain / restore">⏻</button>
              <button class="card-btn" data-act="remove" title="remove from pool">✕</button>
            </span></h3>
        <p class="addr"></p>
        <p class="model-line" data-f="model"></p>
        <div class="stats">
          <div class="stat"><div class="v num" data-f="running">–</div><div class="k">answering now</div></div>
          <div class="stat"><div class="v num" data-f="waiting">–</div><div class="k">waiting in line</div></div>
          <div class="stat"><div class="v num" data-f="prefix">–</div><div class="k"><span class="term" data-term="prefixhit">work reused</span></div></div>
        </div>
        <div class="meter">
          <div class="label"><span><span class="term" data-term="kv">short-term memory used</span><span data-f="kv-cap"></span></span><b class="num" data-f="kv-label">–</b></div>
          <div class="guide"><div class="track"><div class="fill" data-f="kv" style="width:0%"></div></div></div>
        </div>
        <div class="meter payoff" data-f="payoff-wrap" style="display:none">
          <div class="label"><span>work never redone<button class="info-btn" data-info="workersavings">i</button></span><b class="num" data-f="payoff-label">–</b></div>
          <div class="ptrack">
            <div class="seg seg-cached" data-f="payoff-cached"></div>
            <div class="seg seg-restored" data-f="payoff-restored"></div>
            <div class="seg seg-computed" data-f="payoff-computed"></div>
          </div>
          <div class="payoff-recent num" data-f="payoff-recent"></div>
        </div>
        <div class="spark-wrap">
          <div class="label"><span>writing speed</span><b class="num" data-f="rate">– tok/s</b></div>
          <svg class="spark" data-f="spark" preserveAspectRatio="none"></svg>
        </div>`;
      // insert before the add-form tile (if open) so it stays last WITHOUT
      // ever moving it — moving a node that holds a focused input blurs it
      const addTile = document.getElementById('add-tile');
      if (addTile) root.insertBefore(card, addTile); else root.appendChild(card);
    }
    card.dataset.address = ep.address;
    card.dataset.port = ep.port;
    const drained = !!ep.disabled;
    card.classList.toggle('drained', drained);
    card.querySelector('.state-badge').style.display = drained ? '' : 'none';
    card.querySelector('[data-act=drain]').classList.toggle('active', drained);
    card.querySelector('.name').textContent = ep.name;
    const role = ep.device
      || (ep.labels && ep.labels['llm-d.ai/role'])
      || (ep.engine && ep.engine !== 'vllm' ? ep.engine : null);
    const roleEl = card.querySelector('.role');
    if (role) { roleEl.style.display = ''; roleEl.textContent = role; }
    const statusTxt = drained ? 'drained' : (ep.healthy ? 'healthy' : 'unreachable');
    const statusCol = drained ? 'var(--rh-text-sub)' : (ep.healthy ? 'var(--status-good)' : 'var(--status-bad)');
    card.querySelector('.addr').innerHTML =
      `${ep.address}:${ep.port} · <span style="color:${statusCol}">` +
      `${ep.healthy ? '●' : '○'}</span> ${statusTxt}`;
    card.querySelector('[data-f=model]').textContent = shortModel(ep.model_id) || '';

    const m = ep.metrics || {};
    card.querySelector('[data-f=running]').textContent = fmt(m.running);
    card.querySelector('[data-f=waiting]').textContent = fmt(m.waiting);
    const hit = m.prefix_queries > 0 ? (100 * m.prefix_hits / m.prefix_queries) : null;
    card.querySelector('[data-f=prefix]').textContent = hit == null ? '–' : fmt(hit) + '%';

    // capacity-true meter: track length ∝ this machine's KV capacity
    const cache = ep.cache || {};
    const trackPct = cache.kv_tokens ? Math.max(14, 100 * cache.kv_tokens / maxKv) : 100;
    card.querySelector('.track').style.width = trackPct + '%';
    card.querySelector('[data-f=kv-cap]').textContent = cache.kv_tokens
      ? ` · holds ${fmtTokens(cache.kv_tokens)} tokens${cache.dtype && cache.dtype !== 'auto' ? ' · ' + cache.dtype : ''}` +
        (cache.offload_gb ? ` · +${cache.offload_gb}GB offload buffer` : '')
      : '';
    const kv = m.kv_cache_usage != null ? Math.min(100, m.kv_cache_usage * 100) : null;
    card.querySelector('[data-f=kv]').style.width = (kv ?? 0) + '%';
    card.querySelector('[data-f=kv-label]').textContent = kv == null ? '–' : fmt(kv, 1) + '%';

    // throughput from generation_tokens_total delta
    const now = state.ts;
    const prev = lastTokens.get(ep.name);
    let rate = null;
    if (prev && m.generation_tokens != null && now > prev.t) {
      rate = Math.max(0, (m.generation_tokens - prev.total) / (now - prev.t));
    }
    if (m.generation_tokens != null) lastTokens.set(ep.name, { t: now, total: m.generation_tokens });
    const h = history.get(ep.name) || [];
    h.push({ t: now, rate: rate ?? 0 });
    while (h.length > SPARK_POINTS) h.shift();
    history.set(ep.name, h);
    card.querySelector('[data-f=rate]').textContent = rate == null ? '– tok/s' : fmt(rate, 1) + ' tok/s';
    drawSpark(card.querySelector('[data-f=spark]'), h, color, ep.name);

    // per-worker KV payoff: this machine's prompt tokens served from cache
    // (its own vllm:prompt_tokens_by_source counters) vs recomputed fresh
    const pw = card.querySelector('[data-f=payoff-wrap]');
    const cached = m.prompt_cached, restored = m.prompt_restored || 0, computed = m.prompt_computed || 0;
    const ptotal = cached != null ? cached + restored + computed : 0;
    pw.style.display = ptotal > 0 ? '' : 'none';
    if (ptotal > 0) {
      const reused = cached + restored;
      card.querySelector('[data-f=payoff-cached]').style.width = (100 * cached / ptotal) + '%';
      card.querySelector('[data-f=payoff-restored]').style.width = (100 * restored / ptotal) + '%';
      card.querySelector('[data-f=payoff-computed]').style.width = (100 * computed / ptotal) + '%';
      const dollars = reused * (PRICE_FRESH_PER_M - PRICE_CACHED_PER_M) / 1e6;
      const labelEl = card.querySelector('[data-f=payoff-label]');
      labelEl.textContent = `${Math.round(100 * reused / ptotal)}% · ${fmtDollars(dollars)} saved`;
      const prevReused = lastReused.get(ep.name);
      if (prevReused != null && reused > prevReused) {
        labelEl.classList.add('bump');
        setTimeout(() => labelEl.classList.remove('bump'), 700);
      }
      lastReused.set(ep.name, reused);
      // recent window: reused tokens over the last 60s (counter-reset safe)
      const win = payoffWindow.get(ep.name) || [];
      if (win.length && reused < win[win.length - 1].reused) win.length = 0;
      win.push({ t: now, reused });
      while (win.length && now - win[0].t > 60) win.shift();
      payoffWindow.set(ep.name, win);
      const recent = win.length ? Math.max(0, reused - win[0].reused) : 0;
      card.querySelector('[data-f=payoff-recent]').textContent =
        recent > 0 ? `▲ ${fmtTokens(recent)} reused in the last minute` : '';
    }
  }
}

const validIPv4 = s => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec((s || '').trim());
  return !!m && m.slice(1).every(o => +o <= 255);
};
// device becomes `ip:port|device` in pool.txt — strip the delimiter, newlines,
// and a leading '#' (which would comment the line out). The server re-sanitizes.
const cleanDevice = s => (s || '').replace(/[|\r\n]/g, ' ').replace(/^#+/, '').trim().slice(0, 40);

function closeAddMachine() {
  const t = document.getElementById('add-tile');
  if (t) t.remove();
}

// Opened on demand from the "＋ add machine" button — no grid space is reserved
// until asked for. The form appears as a tile in the machines grid, so adding a
// worker literally grows the grid; the grid re-flows as machines come and go.
function openAddMachine() {
  if (document.getElementById('add-tile')) { document.getElementById('add-addr').focus(); return; }
  const root = document.getElementById('instances');
  const tile = document.createElement('div');
  tile.className = 'card add-tile';
  tile.id = 'add-tile';
  tile.innerHTML = `
    <form class="add-form" id="add-form">
      <div class="add-head">Add a machine<button class="info-btn" data-info="addworker">i</button></div>
      <label>address<input id="add-addr" inputmode="decimal" autocomplete="off" placeholder="192.168.1.20"></label>
      <label>port<input id="add-port" type="number" min="1" max="65535" value="8001"></label>
      <label>device
        <select id="add-device">
          <option value="">Auto-detect</option>
          <option>Apple Silicon · Metal</option>
          <option>NVIDIA · CUDA</option>
          <option>vLLM worker</option>
          <option value="__custom">Custom…</option>
        </select>
      </label>
      <input id="add-device-custom" hidden maxlength="40" placeholder="short label">
      <div class="add-actions">
        <button type="submit" class="rh-button" id="add-submit" disabled>Add to pool</button>
        <button type="button" class="rh-button secondary" id="add-cancel">Cancel</button>
      </div>
      <p class="add-msg" id="add-msg"></p>
    </form>`;
  root.appendChild(tile);
  wireAddForm(tile);
  tile.querySelector('#add-addr').focus();
}

function wireAddForm(tile) {
  const form = tile.querySelector('#add-form');
  const addr = tile.querySelector('#add-addr');
  const portEl = tile.querySelector('#add-port');
  const deviceSel = tile.querySelector('#add-device');
  const deviceCustom = tile.querySelector('#add-device-custom');
  const submit = tile.querySelector('#add-submit');
  const msg = tile.querySelector('#add-msg');

  tile.querySelector('#add-cancel').addEventListener('click', closeAddMachine);

  const validate = () => {
    const okAddr = validIPv4(addr.value);
    addr.classList.toggle('invalid', !!addr.value && !okAddr);
    const p = +portEl.value;
    submit.disabled = !(okAddr && p >= 1 && p <= 65535);
  };
  addr.addEventListener('input', () => { addr.value = addr.value.replace(/[^0-9.]/g, ''); validate(); });
  portEl.addEventListener('input', validate);
  deviceSel.addEventListener('change', () => {
    deviceCustom.hidden = deviceSel.value !== '__custom';
    if (!deviceCustom.hidden) deviceCustom.focus();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const address = addr.value.trim();
    const port = String(+portEl.value);
    const device = cleanDevice(deviceSel.value === '__custom' ? deviceCustom.value : deviceSel.value);
    msg.style.color = ''; msg.textContent = 'writing to the pool file…';
    submit.disabled = true;
    try {
      await poolMutate('add', { address, port, device });
      const live = lastEndpoints.some(ep => ep.address === address && String(ep.port) === port);
      if (live) { closeAddMachine(); }
      else { msg.textContent = 'added to the file — held out of the live pool until it answers'; }
    } catch (err) { msg.textContent = err.message; }
    validate();
  });
}

document.getElementById('add-machine').addEventListener('click', openAddMachine);

// per-card drain / remove (delegated; two-step remove needs no modal)
document.getElementById('instances').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('.card-btn');
  if (!btn) return;
  const card = btn.closest('.card');
  const { address, port } = card.dataset;
  if (btn.dataset.act === 'remove') {
    if (!btn.classList.contains('confirm')) {
      card.querySelectorAll('.card-btn.confirm').forEach(b => { b.classList.remove('confirm'); b.textContent = '✕'; });
      btn.classList.add('confirm'); btn.textContent = 'remove?';
      setTimeout(() => { btn.classList.remove('confirm'); btn.textContent = '✕'; }, 3000);
      return;
    }
    btn.disabled = true;
    try { await poolMutate('remove', { address, port }); } catch { btn.disabled = false; }
  } else if (btn.dataset.act === 'drain') {
    const disabled = !card.classList.contains('drained');
    btn.disabled = true;
    try { await poolMutate('disable', { address, port, disabled }); } finally { btn.disabled = false; }
  }
});

function drawSpark(svg, points, color, name) {
  const W = svg.clientWidth || 300, H = 44, PAD = 3;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const max = Math.max(1, ...points.map(p => p.rate));
  const step = points.length > 1 ? (W - 2 * PAD) / (points.length - 1) : 0;
  const xy = points.map((p, i) => [PAD + i * step, H - PAD - (p.rate / max) * (H - 2 * PAD)]);
  const path = xy.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
  svg.innerHTML =
    `<line x1="${PAD}" y1="${H - PAD}" x2="${W - PAD}" y2="${H - PAD}" stroke="var(--rh-border)" stroke-width="1"/>` +
    `<path d="${path}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>` +
    `<circle class="hover-dot" r="4" fill="${color}" stroke="#0D0618" stroke-width="2" style="display:none"/>`;

  svg.onmousemove = (ev) => {
    if (!points.length) return;
    const rect = svg.getBoundingClientRect();
    const i = Math.max(0, Math.min(points.length - 1,
      Math.round((ev.clientX - rect.left) / rect.width * (points.length - 1))));
    const dot = svg.querySelector('.hover-dot');
    dot.style.display = '';
    dot.setAttribute('cx', xy[i][0]); dot.setAttribute('cy', xy[i][1]);
    tooltip.style.display = 'block';
    tooltip.style.left = (rect.left + window.scrollX + xy[i][0] / W * rect.width) + 'px';
    tooltip.style.top = (rect.top + window.scrollY + xy[i][1] / H * rect.height) + 'px';
    tooltip.textContent = `${name} · ${points[i].rate.toFixed(1)} tok/s`;
  };
  svg.onmouseleave = () => {
    svg.querySelector('.hover-dot').style.display = 'none';
    tooltip.style.display = 'none';
  };
}

/* ---------- request-flow topology ---------- */

// plain words first; raw plugin names live in the why-row note + this map
const SCORER_NAMES = {
  'queue-scorer': 'shortest line',
  'kv-cache-utilization-scorer': 'freest memory',
  'prefix-cache-scorer': 'most reusable work',
  'no-hit-lru-scorer': 'coldest cache',
};
const scorerWord = (name) => SCORER_NAMES[name] || name;

const SVG_NS = 'http://www.w3.org/2000/svg';
const topo = document.getElementById('topo');
const workerNodes = new Map();   // endpoint name -> {path, chips} refs for per-poll updates
let topoWorkersKey = '';
const flightDots = [];           // {path, len, start, dur, color, count, back}

// smooth both ends of the flight
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function svgEl(tag, attrs, text) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
}

function buildTopoStatic() {
  topo.innerHTML = '';
  const g = svgEl('g', { id: 'topo-static' });
  // your app
  g.appendChild(svgEl('rect', { class: 'node-box', x: 30, y: 128, width: 130, height: 48, rx: 4 }));
  g.appendChild(svgEl('text', { class: 'node-title', x: 95, y: 149, 'text-anchor': 'middle' }, 'your app'));
  g.appendChild(svgEl('text', { class: 'node-sub', x: 95, y: 166, 'text-anchor': 'middle' }, 'OpenAI-compatible client'));
  // gateway
  g.appendChild(svgEl('rect', { class: 'node-box', x: 305, y: 128, width: 160, height: 48, rx: 4 }));
  g.appendChild(svgEl('text', { class: 'node-title', x: 385, y: 149, 'text-anchor': 'middle' }, 'gateway'));
  g.appendChild(svgEl('text', { class: 'node-sub', x: 385, y: 166, 'text-anchor': 'middle' }, 'the front door · Envoy :8080'));
  // scheduler brain
  g.appendChild(svgEl('rect', { class: 'node-box epp-box', id: 'topo-epp-box', x: 530, y: 14, width: 385, height: 96, rx: 6 }));
  g.appendChild(svgEl('text', { class: 'node-title', x: 546, y: 38 }, 'endpoint picker'));
  g.appendChild(svgEl('text', { class: 'node-sub', x: 675, y: 38 }, 'the scheduler'));
  const f1 = svgEl('text', { class: 'node-formula', x: 546, y: 61, id: 'topo-formula-1' });
  const f2 = svgEl('text', { class: 'node-formula', x: 546, y: 79, id: 'topo-formula-2' });
  g.appendChild(f1); g.appendChild(f2);
  g.appendChild(svgEl('text', { class: 'node-sub', x: 546, y: 98, id: 'topo-epp-sub' }, ''));
  // dashed consult link from the flow to the brain
  g.appendChild(svgEl('path', { class: 'epp-link', d: 'M 500 152 C 520 152 525 130 525 110 L 545 62', id: 'topo-epp-link' }));
  g.appendChild(svgEl('text', { class: 'mono-label', x: 508, y: 122 }, 'consults'));
  // shared flow: app -> gateway
  g.appendChild(svgEl('path', { class: 'flow-path', d: 'M 160 152 L 305 152' }));
  topo.appendChild(g);
  topo.appendChild(svgEl('g', { id: 'topo-workers' }));
  topo.appendChild(svgEl('g', { id: 'topo-dots' }));
}
buildTopoStatic();

function renderTopology(state, epp) {
  // scheduler brain text — heaviest scorer first, split to fit the box
  const weights = [...(epp.weights || [])].sort((a, b) => b.weight - a.weight);
  if (weights.length) {
    const parts = weights.map(w => `${w.weight}× ${scorerWord(w.name)}`);
    const f1 = document.getElementById('topo-formula-1');
    const f2 = document.getElementById('topo-formula-2');
    f1.innerHTML = '';
    f1.appendChild(svgEl('tspan', { class: 'w' }, 'score = '));
    f1.appendChild(svgEl('tspan', {}, parts.slice(0, 2).join(' + ') + ' +'));
    f2.textContent = parts.slice(2).join(' + ') + '  →  highest wins';
  }
  const sub = [];
  if (epp.sched_avg_us != null) sub.push(`picks in ~${Math.round(epp.sched_avg_us)} µs`);
  if (epp.prefix_index_size != null) sub.push(`remembers ${epp.prefix_index_size} prompt-starts`);
  if (epp.version) sub.push(epp.version);
  document.getElementById('topo-epp-sub').textContent = sub.join(' · ');

  // worker nodes + paths (rebuild only when the pool changes)
  const eps = state.endpoints;
  const key = eps.map(e => `${e.name}:${e.healthy ? 1 : 0}:${e.disabled ? 'd' : ''}:${e.model_id || ''}`).join('|');
  if (key !== topoWorkersKey) {
    topoWorkersKey = key;
    const gw = document.getElementById('topo-workers');
    gw.innerHTML = '';
    workerNodes.clear();
    const n = eps.length;
    // stack workers around y=130, spaced so boxes (56 tall) fit the 250 viewBox
    const spacing = n > 1 ? Math.min(84, 160 / (n - 1)) : 0;
    eps.forEach((ep, i) => {
      const cy = n === 1 ? 152 : 130 + (i - (n - 1) / 2) * spacing;
      const color = colorFor(ep.name);
      const grp = svgEl('g', ep.disabled ? { opacity: 0.4 } : (ep.healthy ? {} : { opacity: 0.45 }));
      // drained workers are detached from the flow — a short dashed stub, no
      // connecting path, so "no traffic reaches it" reads visually
      const path = ep.disabled
        ? svgEl('path', { class: 'flow-path', d: `M 900 ${cy} L 935 ${cy}`, style: 'stroke-dasharray:4 5' })
        : svgEl('path', { class: 'flow-path', d: `M 465 152 C 640 152 780 ${cy} 935 ${cy}` });
      grp.appendChild(path);
      grp.appendChild(svgEl('rect', { class: 'node-box', x: 935, y: cy - 28, width: 235, height: 56, rx: 4, style: `stroke:${color};stroke-width:1.5` }));
      grp.appendChild(svgEl('circle', { cx: 953, cy: cy - 13, r: 5, fill: ep.disabled ? 'var(--rh-text-sub)' : (ep.healthy ? 'var(--status-good)' : 'var(--status-bad)') }));
      grp.appendChild(svgEl('text', { class: 'worker-name', x: 965, y: cy - 8 }, ep.name));
      grp.appendChild(svgEl('text', { class: 'node-sub', x: 953, y: cy + 7 },
        (ep.device || 'vLLM worker') + (ep.disabled ? ' · drained' : (ep.healthy ? '' : ' · unreachable'))));
      const model = shortModel(ep.model_id);
      if (model) grp.appendChild(svgEl('text', { class: 'mono-label', x: 953, y: cy + 21 }, model));
      const chips = svgEl('g', {});
      grp.appendChild(chips);
      gw.appendChild(grp);
      workerNodes.set(ep.name, { path, chips, cy, color, disabled: !!ep.disabled });
    });
  }

  // live queue chips: filled = answering now, hollow = waiting in line
  for (const ep of eps) {
    const node = workerNodes.get(ep.name);
    if (!node || node.disabled) continue;
    const m = ep.metrics || {};
    node.chips.innerHTML = '';
    const running = Math.round(m.running || 0), waiting = Math.round(m.waiting || 0);
    const shown = Math.min(running + waiting, 14);
    for (let j = 0; j < shown; j++) {
      const isRun = j < running;
      node.chips.appendChild(svgEl('rect', {
        class: 'qchip' + (isRun ? '' : ' waiting'),
        x: 1160 - j * 10, y: node.cy - 22, width: 7, height: 7,
        style: isRun ? `fill:${node.color}` : `stroke:${node.color}`,
      }));
    }
    if (running + waiting > shown) {
      node.chips.appendChild(svgEl('text', {
        class: 'mono-label', x: 1160 - shown * 10, y: node.cy - 15, 'text-anchor': 'end',
      }, `+${running + waiting - shown}`));
    }
  }
}

function eppThink() {
  const box = document.getElementById('topo-epp-box');
  if (!box) return;
  box.classList.add('think');
  setTimeout(() => box.classList.remove('think'), 250);
}

function spawnDot(name, count, warm) {
  const node = workerNodes.get(name);
  if (!node) return;
  eppThink();
  flightDots.push({
    path: node.path, len: node.path.getTotalLength(),
    start: performance.now(), dur: 1200,
    color: seriesColor.get(name) || FALLBACK,
    count, warm: !!warm,
  });
  if (flightDots.length === 1) requestAnimationFrame(tickDots);
}

function tickDots(now) {
  const gd = document.getElementById('topo-dots');
  gd.innerHTML = '';
  for (let i = flightDots.length - 1; i >= 0; i--) {
    const d = flightDots[i];
    const t = (now - d.start) / d.dur;
    if (t >= 1) {
      if (!d.back) {
        // arrival pulse at the worker node, then the answer travels home
        const end = d.path.getPointAtLength(d.len);
        const pulse = svgEl('circle', { cx: end.x, cy: end.y, r: 6, fill: 'none', stroke: d.color, 'stroke-width': 2, opacity: 0.9 });
        gd.appendChild(pulse);
        const born = now;
        const fade = (n2) => {
          const k = (n2 - born) / 450;
          if (k >= 1) { pulse.remove(); return; }
          pulse.setAttribute('r', 6 + k * 16);
          pulse.setAttribute('opacity', String(0.9 * (1 - k)));
          requestAnimationFrame(fade);
        };
        requestAnimationFrame(fade);
        flightDots.push({ ...d, back: true, start: now + 120, dur: 900 });
      }
      flightDots.splice(i, 1);
      continue;
    }
    const k = easeInOut(Math.max(0, Math.min(1, t)));
    const p = d.path.getPointAtLength((d.back ? 1 - k : k) * d.len);
    if (d.back) {
      // the answer: a hollow dot streaming back to "your app"
      gd.appendChild(svgEl('circle', { cx: p.x, cy: p.y, r: 4, fill: 'none', stroke: d.color, 'stroke-width': 2 }));
    } else if (d.warm) {
      // warm hit: filled dot with a soft halo — the chosen machine remembered it
      gd.appendChild(svgEl('circle', { cx: p.x, cy: p.y, r: 10, fill: d.color, opacity: 0.18 }));
      gd.appendChild(svgEl('circle', { cx: p.x, cy: p.y, r: 5.5, fill: d.color, stroke: '#0D0618', 'stroke-width': 1.5 }));
      if (d.count > 1) {
        gd.appendChild(svgEl('text', { x: p.x, y: p.y - 11, 'text-anchor': 'middle', class: 'mono-label', style: `fill:${d.color}` }, `×${d.count}`));
      }
    } else {
      // cold: hollow ring — fresh work, nothing cached here
      gd.appendChild(svgEl('circle', { cx: p.x, cy: p.y, r: 5, fill: 'none', stroke: d.color, 'stroke-width': 2 }));
      if (d.count > 1) {
        gd.appendChild(svgEl('text', { x: p.x, y: p.y - 9, 'text-anchor': 'middle', class: 'mono-label', style: `fill:${d.color}` }, `×${d.count}`));
      }
    }
  }
  if (flightDots.length) requestAnimationFrame(tickDots);
}

/* ---------- prefill savings counter ---------- */

let shownSaved = null;

function fmtDollars(d) {
  if (d >= 100) return '$' + Math.round(d);
  if (d >= 1) return '$' + d.toFixed(2);
  if (d >= 0.01) return '$' + d.toFixed(3);
  return '$' + d.toFixed(4);
}

function countUp(el, from, to, fmtFn) {
  const born = performance.now();
  el.classList.add('bump');
  const step = (now) => {
    const k = Math.min(1, (now - born) / 600);
    el.textContent = fmtFn(from + (to - from) * k);
    if (k < 1) requestAnimationFrame(step);
    else el.classList.remove('bump');
  };
  requestAnimationFrame(step);
}

function renderSavings(state) {
  let cached = 0, restored = 0, total = 0;
  for (const ep of state.endpoints) {
    const m = ep.metrics || {};
    if (m.prompt_cached != null) {
      cached += m.prompt_cached;
      restored += m.prompt_restored || 0;
      total += m.prompt_cached + (m.prompt_restored || 0) + (m.prompt_computed || 0);
    }
  }
  const saved = cached + restored;   // work avoided, whichever tier served it
  const el = document.getElementById('tokens-saved');
  const pctEl = document.getElementById('tokens-saved-pct');
  const costEl = document.getElementById('cost-saved');
  const cutEl = document.getElementById('bill-cut');
  if (!total) { el.textContent = '–'; pctEl.textContent = ''; costEl.textContent = '–'; cutEl.textContent = '–'; return; }

  const share = saved / total;
  pctEl.textContent = `(${Math.round(100 * share)}% of all prompt tokens` +
    (restored > 0 ? ` · ${fmtTokens(restored)} restored from offload buffer` : '') + ')';
  // what this cache-hit mix does to the prompt bill, at list prices
  const dollars = saved * (PRICE_FRESH_PER_M - PRICE_CACHED_PER_M) / 1e6;
  cutEl.textContent = Math.round(100 * share * (1 - PRICE_CACHED_PER_M / PRICE_FRESH_PER_M)) + '%';

  if (shownSaved == null) {
    shownSaved = saved;
    el.textContent = fmtTokens(saved);
    costEl.textContent = fmtDollars(dollars);
    return;
  }
  if (saved > shownSaved) {
    const fromDollars = shownSaved * (PRICE_FRESH_PER_M - PRICE_CACHED_PER_M) / 1e6;
    countUp(el, shownSaved, saved, fmtTokens);
    countUp(costEl, fromDollars, dollars, fmtDollars);
    shownSaved = saved;
  }
}

/* ---------- cluster-file panel ---------- */

let lastPoolRaw = null;

function renderPoolFile(state, epp) {
  const pre = document.getElementById('pool-file');
  const raw = state.pool_file?.raw ?? '';
  if (raw !== lastPoolRaw) {
    pre.textContent = raw || '(endpoints.yaml missing)';
    if (lastPoolRaw !== null) {          // don't flash on first paint
      pre.classList.remove('changed');
      void pre.offsetWidth;
      pre.classList.add('changed');
      lastPoolChangeAt = state.ts;
    }
    lastPoolRaw = raw;
  }
  document.getElementById('pool-ready').textContent = epp.ready_endpoints ?? '–';
  const mtime = state.pool_file?.mtime;
  document.getElementById('pool-age').textContent =
    mtime ? `file written ${ago(state.ts - mtime)} ago` : '';
}

function ago(s) {
  if (s < 90) return Math.max(0, Math.round(s)) + 's';
  if (s < 5400) return Math.round(s / 60) + 'm';
  return Math.round(s / 3600) + 'h';
}

/* ---------- routing scoreboard, ribbon + decision feed ---------- */

function shortName(servedBy, endpoints) {
  // served_by is "ip:port" — map back to the endpoint name when we can
  if (!servedBy) return 'unknown';
  const [addr, port] = servedBy.split(':');
  const ep = endpoints.find(e => e.address === addr && String(e.port) === String(port));
  return ep ? ep.name : servedBy;
}

let lastEndpoints = [];
let lastEpp = null;
const seenDecisions = new Set();
const openRows = new Set();   // decision ids expanded to the "why" view
let seenAnything = false;     // suppress dots for history loaded on first paint

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function renderScoreboard(rows, epp) {
  const board = document.getElementById('scoreboard');
  const counts = new Map();
  for (const ep of lastEndpoints) counts.set(ep.name, 0);
  for (const d of rows) {
    const name = shortName(d.served_by === 'unknown' ? null : d.served_by, lastEndpoints);
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  board.innerHTML = '';
  for (const [name, count] of counts) {
    const color = seriesColor.get(name) || FALLBACK;
    const lifetime = epp?.attempts?.[name];
    const med = median(rows.filter(d => d.ok &&
      shortName(d.served_by === 'unknown' ? null : d.served_by, lastEndpoints) === name).map(d => d.latency_ms));
    const tile = document.createElement('div');
    tile.className = 'score-tile';
    tile.style.setProperty('--series', color);
    tile.innerHTML =
      `<div class="name"><span class="chip" style="background:${color};width:10px;height:10px;border-radius:3px"></span>${escapeHtml(name)}</div>` +
      `<div class="v num">${count}</div>` +
      `<div class="sub num">${lifetime != null ? `scheduler lifetime ${Math.round(lifetime)}` : ''}` +
      (med != null ? ` · median ${(med / 1000).toFixed(1)}s` : '') + `</div>`;
    board.appendChild(tile);
  }
}

function renderRibbon(decisions) {
  const ribbon = document.getElementById('ribbon');
  const rows = decisions.slice(-80);
  ribbon.innerHTML = '';
  for (const d of rows) {
    const name = shortName(d.served_by === 'unknown' ? null : d.served_by, lastEndpoints);
    const tick = document.createElement('div');
    tick.className = 'tick' + (d.ok ? '' : ' err');
    tick.style.background = seriesColor.get(name) || FALLBACK;
    tick.title = `${d.tag} → ${name}`;
    ribbon.appendChild(tick);
  }
}

function whyRowHtml(d) {
  const signals = d.signals || {};
  const chosen = shortName(d.served_by === 'unknown' ? null : d.served_by, lastEndpoints);
  const weights = Object.fromEntries((lastEpp?.weights || []).map(w => [w.name, w.weight]));
  const wPrefix = weights['prefix-cache-scorer'] ?? 3;
  const wQueue = weights['queue-scorer'] ?? 2;
  const wKv = weights['kv-cache-utilization-scorer'] ?? 2;
  const wTotal = wPrefix + wQueue + wKv;
  const maxQueue = Math.max(1, ...Object.values(signals).map(s => s.queue || 0));

  const bars = Object.entries(signals).map(([name, s]) => {
    const color = seriesColor.get(name) || FALLBACK;
    if (s.healthy === false) {
      return `<div class="score-row"><span class="who-label"><span class="chip" style="background:${FALLBACK};width:9px;height:9px;border-radius:3px"></span>${escapeHtml(name)}</span>
        <div class="bar"><div class="seg" style="width:100%;background:${FALLBACK};opacity:0.2"></div></div><span class="total">down</span></div>`;
    }
    const prefixN = (s.prefix_hit_pct ?? 0) / 100;
    const queueN = 1 - (s.queue || 0) / maxQueue;
    const kvN = 1 - (s.kv_pct ?? 0) / 100;
    const score = wPrefix * prefixN + wQueue * queueN + wKv * kvN;
    const segs = [
      [wPrefix * prefixN, 1.0], [wQueue * queueN, 0.6], [wKv * kvN, 0.35],
    ].map(([v, op]) => `<div class="seg" style="width:${(100 * v / wTotal).toFixed(1)}%;background:${color};opacity:${op}"></div>`).join('');
    return `<div class="score-row ${name === chosen ? 'chosen' : ''}">
      <span class="who-label"><span class="chip" style="background:${color};width:9px;height:9px;border-radius:3px"></span>${escapeHtml(name)}${name === chosen ? ' ✓' : ''}</span>
      <div class="bar">${segs}</div><span class="total num">≈${score.toFixed(1)}</span></div>`;
  }).join('');

  const ttft = d.ttft_ms != null ? ` · first token after ${fmt(d.ttft_ms)} ms` : '';
  let ghost = '';
  if (d.rr_pick && d.rr_pick !== chosen && signals[d.rr_pick]) {
    const hit = signals[d.rr_pick].prefix_hit_pct;
    ghost = `<div class="why-note">a blind round-robin balancer would have sent this to ${escapeHtml(d.rr_pick)}` +
      (hit != null ? ` (reusable work there: ${hit}%)` : '') + `</div>`;
  }
  return `<td></td><td colspan="4">
    <div class="why-legend">what the scheduler saw (bar = weighted score):
      <span class="sw" style="background:var(--rh-text-sub);opacity:1"></span>${wPrefix}× reusable work
      <span class="sw" style="background:var(--rh-text-sub);opacity:0.6"></span>${wQueue}× short line
      <span class="sw" style="background:var(--rh-text-sub);opacity:0.35"></span>${wKv}× free memory
    </div>
    ${bars}
    ${ghost}
    <div class="why-note">approximation rebuilt from stats sampled ~1.5 s before the decision (plugins: ${(lastEpp?.weights || []).map(w => w.name).join(', ')})${ttft}</div>
  </td>`;
}

function chosenHit(d) {
  const name = shortName(d.served_by === 'unknown' ? null : d.served_by, lastEndpoints);
  return d.signals?.[name]?.prefix_hit_pct ?? null;
}

function renderInsights(decisions) {
  const strip = document.getElementById('insight-strip');
  const rows = decisions.filter(d => d.ok && (d.kind === 'loadgen' || d.kind === 'chat')).slice(-60);
  const warm = [], cold = [];
  let avoided = 0, comparable = 0, preserved = 0;
  for (const d of rows) {
    const hit = chosenHit(d);
    if (hit == null) continue;
    (hit >= 50 ? warm : cold).push(d.latency_ms);
    if (d.rr_pick && d.signals?.[d.rr_pick]) {
      comparable++;
      const rrHit = d.signals[d.rr_pick].prefix_hit_pct ?? 0;
      if (hit >= 50 && rrHit < 50) {
        avoided++;
        // conservative: only the chosen machine's *extra* cached share counts
        if (d.prompt_tokens) preserved += d.prompt_tokens * Math.max(0, hit - rrHit) / 100;
      }
    }
  }
  const parts = [];
  const wMed = median(warm), cMed = median(cold);
  if (wMed != null && cMed != null && warm.length >= 3 && cold.length >= 3 && cMed > wMed) {
    parts.push(`warm cache median <b>${(wMed / 1000).toFixed(1)}s</b> vs cold <b>${(cMed / 1000).toFixed(1)}s</b> — ` +
      `${(cMed / wMed).toFixed(1)}× faster <span class="term" data-term="prefixhit">reusing work</span>`);
  }
  if (comparable >= 6 && avoided > 0) {
    let s = `<b>${avoided}</b> of the last ${comparable} requests would have missed the warm cache under ` +
      `<span class="term" data-term="roundrobin">round-robin</span>`;
    if (preserved > 0) {
      const pd = preserved * (PRICE_FRESH_PER_M - PRICE_CACHED_PER_M) / 1e6;
      s += ` — ~<b>${fmtTokens(Math.round(preserved))}</b> reused tokens (≈${fmtDollars(pd)}) ` +
        `preserved by routing <i>(est.)</i><button class="info-btn" data-info="routingvalue">i</button>`;
    }
    parts.push(s);
  }
  strip.innerHTML = parts.join('<span style="opacity:0.4">·</span>');
}

// standing "llm-d vs blind round-robin" scoreboard: for each recent request,
// did the chosen worker land on a warm cache, and would round-robin's pick
// have? The RR side is a counterfactual (that machine never ran it) — same
// comparable set the insight strip trusts.
function renderRrSplit(decisions) {
  const box = document.getElementById('rr-split');
  if (!box) return;
  const rows = decisions.filter(d => d.ok && (d.kind === 'loadgen' || d.kind === 'chat')
    && d.rr_pick && d.signals?.[d.rr_pick]).slice(-40);
  if (rows.length < 6) { box.style.display = 'none'; return; }
  let llmd = 0, rr = 0;
  for (const d of rows) {
    if ((chosenHit(d) ?? 0) >= 50) llmd++;
    if ((d.signals[d.rr_pick].prefix_hit_pct ?? 0) >= 50) rr++;
  }
  const lp = Math.round(100 * llmd / rows.length), rp = Math.round(100 * rr / rows.length);
  box.style.display = '';
  document.getElementById('rr-llmd').style.width = lp + '%';
  document.getElementById('rr-rr').style.width = rp + '%';
  document.getElementById('rr-llmd-v').textContent = lp + '%';
  document.getElementById('rr-rr-v').textContent = rp + '%';
}

function renderDecisions(decisions, epp) {
  const feed = document.getElementById('feed');
  const empty = document.getElementById('feed-empty');
  const rows = decisions.slice(-30).reverse();
  empty.style.display = rows.length ? 'none' : '';

  // launch topology dots for decisions new since the last poll, batched per
  // worker AND by cache warmth so the animation itself carries the thesis:
  // filled dot = the chosen machine already had this prompt warm, hollow = fresh
  const newByWorker = new Map();
  for (const d of decisions) {
    if (seenDecisions.has(d.id)) continue;
    seenDecisions.add(d.id);
    if (!seenAnything) continue;
    const name = shortName(d.served_by === 'unknown' ? null : d.served_by, lastEndpoints);
    const hit = chosenHit(d);
    const b = newByWorker.get(name) || { warm: 0, cold: 0 };
    (hit != null && hit >= 50) ? b.warm++ : b.cold++;
    newByWorker.set(name, b);
  }
  for (const [name, b] of newByWorker) {
    if (b.warm) spawnDot(name, b.warm, true);
    if (b.cold) spawnDot(name, b.cold, false);
  }
  seenAnything = true;

  feed.innerHTML = '';
  for (const d of rows) {
    const name = shortName(d.served_by === 'unknown' ? null : d.served_by, lastEndpoints);
    const color = seriesColor.get(name) || FALLBACK;
    const t = new Date(d.ts * 1000).toLocaleTimeString();
    const tr = document.createElement('tr');
    tr.className = 'decision' + (openRows.has(d.id) ? ' open' : '');
    tr.innerHTML = `
      <td class="mono"><span class="chev">▸</span></td>
      <td class="mono num">${t}</td>
      <td class="mono">${escapeHtml(d.tag)}</td>
      <td><span class="served"><span class="chip" style="background:${color};width:10px;height:10px;border-radius:3px"></span>${escapeHtml(name)}</span></td>
      <td class="mono num">${d.ok ? fmt(d.latency_ms) + ' ms' : 'error'}</td>`;
    tr.onclick = () => {
      openRows.has(d.id) ? openRows.delete(d.id) : openRows.add(d.id);
      renderDecisions(decisions, epp);
    };
    feed.appendChild(tr);
    if (openRows.has(d.id)) {
      const why = document.createElement('tr');
      why.className = 'why';
      why.innerHTML = whyRowHtml(d);
      feed.appendChild(why);
    }
  }

  renderScoreboard(rows, epp);
  renderRibbon(decisions);
}

/* ---------- demo beats ---------- */

const bursts = { unique: null, shared: null, rag: null };  // mode -> {start, n, capEl, baseText}

const TAG_PREFIX = { unique: 'unique', shared: 'shared-prefix', rag: 'RAG' };

async function burst(mode, btn, n) {
  n = n || 12;
  btn.disabled = true;
  const cap = document.getElementById(`cap-${mode}`);
  bursts[mode] = { start: Date.now() / 1000, n, capEl: cap, baseText: cap.dataset.base ?? cap.textContent };
  cap.dataset.base = bursts[mode].baseText;
  cap.classList.remove('result');
  cap.textContent = `Routing ${n} requests…`;
  try {
    await fetch('/api/loadgen', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ n, mode }),
    });
  } finally {
    setTimeout(() => { btn.disabled = false; }, n > 20 ? 4000 : 2500);
  }
}

function updateBeatCaptions(decisions) {
  for (const [mode, b] of Object.entries(bursts)) {
    if (!b) continue;
    const done = decisions.filter(d => d.kind === 'loadgen' && d.ts >= b.start && d.tag.startsWith(TAG_PREFIX[mode]));
    if (done.length < b.n) {
      if (done.length) b.capEl.textContent = `Routing… ${done.length}/${b.n} answered`;
      continue;
    }
    const counts = new Map();
    for (const d of done) {
      const name = shortName(d.served_by === 'unknown' ? null : d.served_by, lastEndpoints);
      counts.set(name, (counts.get(name) || 0) + 1);
    }
    const ranked = [...counts.entries()].sort((a, b2) => b2[1] - a[1]);
    const split = ranked.map(([n, c]) => `${c} → ${n}`).join(' · ');
    const topShare = ranked[0][1] / done.length;
    b.capEl.classList.add('result');
    if (mode === 'shared' || mode === 'rag') {
      b.capEl.textContent = topShare >= 0.75
        ? `Result: ${split} — one machine held the shared text, so ${done.length - ranked[0][1] === 0 ? 'nothing' : 'almost nothing'} was recomputed.`
        : `Result: ${split} — reuse won until the line got long, then the scheduler spilled the rest over.`;
    } else {
      b.capEl.textContent = `Result: ${split} — spread so no machine builds a queue.`;
    }
    bursts[mode] = null;
  }
}

document.getElementById('btn-unique').onclick = (e) => burst('unique', e.target, 12);
document.getElementById('btn-shared').onclick = (e) => burst('shared', e.target, 12);
document.getElementById('btn-rag').onclick = (e) => burst('rag', e.target, 30);

/* Beat 4 · Overflow — needs an offload-enabled worker in the pool */

let offloadBeat = null;   // {start, nDocs, restoredAt}

function restoredNow() {
  return lastEndpoints.reduce((sum, ep) => sum + (ep.metrics?.prompt_restored || 0), 0);
}

document.getElementById('btn-offload').onclick = async (e) => {
  const btn = e.target;
  btn.disabled = true;
  const cap = document.getElementById('cap-offload');
  cap.classList.remove('result');
  cap.textContent = 'Starting…';
  try {
    const r = await fetch('/api/loadgen', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'offload', n: 8 }),
    });
    if (!r.ok) { cap.textContent = (await r.json()).error || 'failed to start'; return; }
    offloadBeat = { start: Date.now() / 1000, nDocs: 8, restoredAt: restoredNow() };
  } finally {
    setTimeout(() => { btn.disabled = !offloadWorkerPresent(); }, 4000);
  }
};

function offloadWorkerPresent() {
  return lastEndpoints.some(ep => ep.cache?.offload_gb);
}

function updateOffloadBeat(decisions) {
  const btn = document.getElementById('btn-offload');
  const cap = document.getElementById('cap-offload');
  if (!offloadBeat) {
    btn.disabled = !offloadWorkerPresent();
    if (!offloadWorkerPresent() && !cap.classList.contains('result')) {
      cap.textContent = 'needs an offload-enabled worker in the pool — see ⓘ';
    }
    return;
  }
  const b = offloadBeat;
  const done = decisions.filter(d => d.kind === 'offload' && d.ts >= b.start);
  const fills = done.filter(d => d.tag.includes('(fill)')).length;
  const replays = done.filter(d => d.tag.includes('(replay)')).length;
  if (replays >= b.nDocs) {
    const restored = restoredNow() - b.restoredAt;
    cap.classList.add('result');
    cap.textContent = restored > 0
      ? `Result: ${fmtTokens(restored)} tokens came back from the offload buffer — evicted, then restored instead of recomputed.`
      : 'Result: replay complete — restored-token counter did not move (was the fast tier big enough to evict?).';
    offloadBeat = null;
  } else if (replays > 0) {
    cap.textContent = `Replaying the same documents… ${replays}/${b.nDocs} (watch “restored from offload” climb)`;
  } else if (fills > 0) {
    cap.textContent = `Filling the small fast tier… ${fills}/${b.nDocs} big documents (earlier ones are being evicted to the buffer)`;
  }
}

/* ---------- chat ---------- */

const chatLog = document.getElementById('chat-log');
const chatInput = document.getElementById('chat-input');
const chatSend = document.getElementById('chat-send');
const chatClear = document.getElementById('chat-clear');
const chatMem = document.getElementById('chat-mem');

// Conversation memory: past turns ride along on every request, so the prompt
// grows a shared prefix — and the prefix scorer pins the conversation to the
// machine whose KV cache already holds the history. Clearing releases the pin.
const chatHistory = [];   // [{role, content}]
let chatPinnedTo = null;  // worker that served the latest turn
// salts the system prompt per conversation (crypto.randomUUID needs a secure
// context, and this dashboard is plain http on a LAN IP — hence the fallback)
const newSession = () => crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36);
let chatSession = newSession();

function updateChatMeta() {
  const turns = chatHistory.filter(m => m.role === 'user').length;
  chatClear.disabled = turns === 0;
  if (!turns) {
    chatMem.textContent = 'memory: empty — first message starts a conversation';
    return;
  }
  const color = seriesColor.get(chatPinnedTo) || FALLBACK;
  chatMem.innerHTML = `memory: ${turns} turn${turns > 1 ? 's' : ''} — this conversation's history lives in ` +
    `<span class="served" style="color:${color}"><span class="chip" style="background:${color};width:9px;height:9px;border-radius:3px"></span>` +
    `${escapeHtml(chatPinnedTo || '…')}</span>'s <span class="term" data-term="kv">KV cache</span>`;
}

chatClear.onclick = () => {
  chatHistory.length = 0;
  chatPinnedTo = null;
  chatSession = newSession();
  const div = document.createElement('div');
  div.className = 'msg divider';
  div.textContent = 'memory cleared — the next message starts a fresh prompt, so the scheduler is free to pick any machine again';
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
  updateChatMeta();
};

function addMsg(who, badgeHtml = '') {
  const div = document.createElement('div');
  div.className = 'msg';
  div.innerHTML = `<div class="who">${who} ${badgeHtml}</div><div class="body"></div>`;
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
  return div.querySelector('.body');
}

async function sendChat() {
  const text = chatInput.value.trim();
  if (!text || chatSend.disabled) return;
  chatInput.value = '';
  chatSend.disabled = true;
  addMsg('you').textContent = text;
  const body = addMsg('assistant');
  const badgeHost = body.parentElement.querySelector('.who');
  try {
    const resp = await fetch('/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: chatSession, messages: [...chatHistory, { role: 'user', content: text }] }),
    });
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '', event = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line.startsWith('event:')) { event = line.slice(6).trim(); continue; }
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (event === 'routing') {
          const { served_by } = JSON.parse(data);
          const name = shortName(served_by === 'unknown' ? null : served_by, lastEndpoints);
          const color = seriesColor.get(name) || FALLBACK;
          chatPinnedTo = name;
          badgeHost.innerHTML += ` <span class="served" style="color:${color}">
            <span class="chip" style="background:${color};width:9px;height:9px;border-radius:3px"></span>${escapeHtml(name)}</span>`;
        } else if (event === 'error') {
          body.append(`\n[error: ${JSON.parse(data).error}]`);
        } else if (data && data !== '[DONE]' && data !== '{}') {
          try {
            const delta = JSON.parse(data).choices?.[0]?.delta || {};
            const thinking = delta.reasoning ?? delta.reasoning_content;
            if (thinking) {
              // reasoning models think before answering;
              // keep the thought process tucked behind a collapsed toggle
              let box = body.querySelector('details.thinking');
              if (!box) {
                box = document.createElement('details');
                box.className = 'thinking';
                box.innerHTML = '<summary>thinking…</summary><span class="reasoning"></span>';
                body.appendChild(box);
              }
              box.querySelector('.reasoning').textContent += thinking;
            }
            if (delta.content) {
              let a = body.querySelector('.answer');
              if (!a) {
                a = document.createElement('span');
                a.className = 'answer';
                body.appendChild(a);
                const box = body.querySelector('details.thinking');
                if (box) box.querySelector('summary').textContent = 'thought process';
              }
              // strip model format markers like <|START_TEXT|>, tolerating
              // tokens split across stream chunks (partial tail kept pending)
              a.dataset.raw = (a.dataset.raw || '') + delta.content;
              a.textContent = a.dataset.raw
                .replace(/<\|[^|>]*\|>/g, '')
                .replace(/<\|[^|>]*$/, '');
            }
            chatLog.scrollTop = chatLog.scrollHeight;
          } catch { /* keepalive/non-JSON line */ }
        }
        event = null;
      }
    }
  } catch (e) {
    body.append(`\n[request failed: ${e.message}]`);
  } finally {
    // commit the turn to memory (answer text only — reasoning is not history)
    let answer = body.querySelector('.answer')?.textContent || '';
    if (!answer && body.querySelector('details.thinking')) {
      // the whole token budget went on reasoning and no answer ever arrived
      const note = document.createElement('div');
      note.className = 'no-answer';
      note.textContent = '[the model spent its entire token budget thinking and never answered — try asking again, more simply]';
      body.appendChild(note);
      body.querySelector('details.thinking summary').textContent = 'thought process (no answer emitted)';
      answer = '[no answer — the response ran out of tokens while reasoning]';
    }
    chatHistory.push({ role: 'user', content: text });
    chatHistory.push({ role: 'assistant', content: answer });
    updateChatMeta();
    chatSend.disabled = false;
    chatInput.focus();
  }
}
chatSend.onclick = sendChat;
chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });

/* ---------- presenter caption bar (press 'c') ---------- */

const presenterBar = document.getElementById('presenter-bar');
if (localStorage.getItem('llmd-presenter')) presenterBar.classList.add('on');
document.addEventListener('keydown', (e) => {
  if (e.key !== 'c' || e.target.tagName === 'INPUT' || e.metaKey || e.ctrlKey) return;
  presenterBar.classList.toggle('on');
  presenterBar.classList.contains('on')
    ? localStorage.setItem('llmd-presenter', '1')
    : localStorage.removeItem('llmd-presenter');
});

let lastPoolChangeAt = 0;

function renderPresenter(state, epp, decisions) {
  if (!presenterBar.classList.contains('on')) return;
  const now = state.ts;
  const latest = decisions[decisions.length - 1];
  if (now - lastPoolChangeAt < 8) {
    presenterBar.textContent = 'The machine list file just changed — watch the pool reshape. No restarts, no operators: a text file.';
    return;
  }
  if (latest && now - latest.ts < 8) {
    const name = shortName(latest.served_by === 'unknown' ? null : latest.served_by, lastEndpoints);
    const hit = chosenHit(latest);
    presenterBar.textContent = latest.kind === 'offload'
      ? `${latest.tag} → ${name} — the offload buffer at work`
      : `“${latest.tag}” → ${name}` + (hit != null && hit >= 50
          ? ` — it already remembered ${Math.round(hit)}% of this prompt`
          : ' — shortest line at that moment');
    return;
  }
  const n = state.endpoints.length;
  presenterBar.textContent = `${n} machine${n === 1 ? '' : 's'} · 1 model · the scheduler picks in ~${Math.round(epp.sched_avg_us || 15)} µs`;
}

/* ---------- polling ---------- */

function setPill(id, ok, label) {
  const pill = document.getElementById(id);
  pill.querySelector('.dot').className = 'dot ' + (ok ? 'good' : 'bad');
  pill.childNodes[1].textContent = label;
}

async function refresh() {
  const [state, dec, epp] = await Promise.all([
    fetch('/api/state').then(r => r.json()),
    fetch('/api/decisions').then(r => r.json()),
    fetch('/api/epp').then(r => r.json()),
  ]);
  lastEndpoints = state.endpoints;
  lastEpp = epp;
  // fix series colors in endpoint-file order before anything else renders
  state.endpoints.forEach(ep => colorFor(ep.name));
  renderInstances(state);
  renderTopology(state, epp);
  renderSavings(state);
  renderPoolFile(state, epp);
  renderDecisions(dec.decisions, epp);
  renderInsights(dec.decisions);
  renderRrSplit(dec.decisions);
  updateBeatCaptions(dec.decisions);
  updateOffloadBeat(dec.decisions);
  renderPresenter(state, epp, dec.decisions);
  setPill('pill-gateway', state.gateway_healthy, 'gateway');
  setPill('pill-epp', epp.healthy, 'endpoint picker');
}

async function poll() {
  try { await refresh(); } catch { /* backend restarting; try again next tick */ }
  setTimeout(poll, POLL_MS);
}
poll();

// Reshape the pool from the browser (Beat 3). Every control routes through
// here; /api/state is the source of truth, so a forced refresh reconciles the
// optimistic change within one frame.
async function poolMutate(path, body) {
  const r = await fetch('/api/pool/' + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  try { await refresh(); } catch { /* next tick */ }
  if (!r.ok) throw new Error(data.error || 'pool change failed');
  if (data.warning) showToast(data.warning);   // e.g. can't remove the last live worker
  return data;
}

let toastTimer = null;
function showToast(msg) {
  let t = document.getElementById('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 4000);
}
