# Flint independence roadmap

The goal: **Flint's own brain** — a model Will owns and develops, as capable as
any AI out there, that one day needs no external service. Today Flint runs on
Claude for full capability now; that is the **teacher and the temporary crutch**,
not the destination.

## Building Flint's own brain (the real project)

You cannot train a frontier model from scratch solo ($10M–$100M+, a research
team, trillions of tokens). You CAN own one and grow it into Flint. The ladder:

1. **Capture (running now).** Every interaction is logged as a training example
   to `~/.flint/training/corpus.jsonl` (`TrainingLogger`). Frontier/Claude
   answers are the **teacher signal** — the targets to distill. `GET /training`
   shows the count. This corpus is the seed of Flint's own brain; it compounds
   daily and is the irreplaceable asset. The data is local, never sent anywhere.
2. **Distill + fine-tune.** Periodically fine-tune an OWNED open model (Qwen /
   Llama / DeepSeek) on the corpus — LoRA/QLoRA, doable on the Mac or a few hours
   of rented cloud GPU (~$10–100). The student absorbs the teacher's capability
   and Will's voice/domains. Measure: does the fine-tuned model match Claude's
   answers on held-out prompts?
3. **Own bigger weights.** With the loop proven, a dedicated box (64–128GB Mac
   Studio or GPU server, ~$2–4k) runs a frontier-class open model (70B+) entirely
   on Will's hardware — runtime independence, now.
4. **Grow until the crutch drops.** Bigger owned model + continual fine-tuning on
   the ever-growing corpus → Claude's share of queries shrinks toward zero. Flip
   the bridge off (below) when Flint's own brain is good enough.

Independence is BUILT now (capture + distill), not flipped later.

> **Update (2026-09): steps 2 and 4 changed.** Claude's answers are no longer
> training targets: Anthropic's terms prohibit using outputs as training targets
> (OpenAI's bar developing competing models), and the research and Flint's own runs
> agree that imitation moves style, not the knowledge gap the local model actually
> loses on. The measure is also different: not "does it match Claude's answers" but
> "does Flint-local win measurably more often against GPT-5". A local candidate
> ships only through that gate, trained on terms-compliant data (Will's own, the
> base model's verified self-samples, or open-weight teachers whose licences allow
> it). Parity with the frontier comes from the frontier tiers for now. See
> [apps/train/mlx/README.md](../apps/train/mlx/README.md).

## The swappable brain seam (today's crutch, tomorrow's switch)

Today Flint defaults to Claude for capability and falls back to the local model
when offline, when Claude keeps failing, or when Will asks to stay private. The frontier brain is one
swappable seam, so it can be repointed at Flint's own grown-up model — or
switched off entirely — the day that model is good enough.

## The seam (already in code)

`buildFrontierProvider()` in `apps/server/src/brains.ts` picks the escalation
brain from env:

| Env | Effect |
|-----|--------|
| `ANTHROPIC_API_KEY` (in `~/.flint/secrets.env`) | Escalate to Claude (default `claude-sonnet-4-6`; set `FLINT_FRONTIER_MODEL=claude-opus-4-8` for max). |
| `FLINT_FRONTIER_PROVIDER=ollama` + `FLINT_FRONTIER_BASE_URL` + `FLINT_FRONTIER_MODEL` | Escalate to a **self-hosted big model** (e.g. a 70B on a home box). Fully independent. |
| none | Pure local — frontier off. The header "Local only" toggle forces this per-session too. |

Switching from Claude to a local 70B is therefore a **config change, not a
rewrite**. Everything else — the difficulty judge, the shared memory + tools,
the streaming, the badge — stays identical.

### Already off the frontier

- **Learning from Will's chats** (memory extraction: durable facts into
  long-term memory) runs on the local model by default, with no API key, and
  yields to his chat. The frontier is an opt-in (`FLINT_MEMORY_BRAIN=frontier`),
  never a fallback. See [apps/server/README.md](../apps/server/README.md),
  "Memory extraction".
- **Flint stops waiting on Claude.** When an outside AI is going to keep
  failing (no credit, a rejected key, an outage), a circuit breaker leaves it
  alone for a cool-down and the local model answers at once, on `/chat` and
  `/generate`, every tier. One cheap check after the cool-down; a success puts
  it back in use. The Anthropic client no longer retries on its own and waits
  60 seconds, not 10 minutes, for a response to start. See
  [apps/server/README.md](../apps/server/README.md), "When the frontier keeps
  failing".
- **The local brain is never quietly Claude.** With `OLLAMA_MODEL` unset the
  server (and the `ask` CLI) used to make Anthropic's Sonnet the "local" brain
  whenever a key was present. They ask Ollama which model it has instead; no
  key changes that. See "The local brain is always Ollama" in the same README.
- **The `playground` demos** got the same rule: a local model, and Anthropic
  only when asked for by name (`PLAYGROUND_PROVIDER=anthropic`).
- **Flint says what is actually answering.** Each brain's prompt names its own
  model after the style guide, so a local model asked what it runs on no longer
  answers "Claude" (packages/persona/README.md, "What powers this answer").
- **A Local-only turn keeps its question on this machine.** deep_research used
  to send the question to the frontier's routine tier to plan its searches,
  whatever the turn. On a turn the local model is answering it now plans by its
  heuristic, and no outside AI is asked. (Its web searches are still web
  searches: see "Still on an outside AI".)
- **Background calls** the runtime asks the server for (`/internal/complete`)
  are answered by the local model, never a frontier tier. Nothing uses them
  yet; whatever does will be local from its first call.
- **`evolve try` only tries local models.** It rewrites `FLINT_TIER_*` in the
  live config, and used to accept any provider. It now refuses anything but
  `ollama:<model>` (not an Ollama cloud model either), at four separate points,
  the config write included, and a refused request touches nothing. Undoing a
  try writes no value of its own either: the line a tier had before is parked
  as a comment in the config and un-parked, so the only tier values evolve can
  put there are a local candidate and Will's own line. Its rollback marker is
  checked before it is believed. `evolve discover` lists the models on the
  Ollama the tiers use; the outside vendors' lists need `--vendors`. Putting a
  tier on an outside model is Will's call, made by hand.

### Still on an outside AI

- **Hard and everyday questions**, while `ANTHROPIC_API_KEY` is set: `judgeBrain`
  (apps/server/src/policy.ts) sends them to the frontier tiers by default.
- **`evolve measure`'s judge** (Claude), **voice output** (OpenAI TTS, with the
  browser's voice as its fallback), and **paid search** (Perplexity, Tavily),
  which a Local-only turn can still call: the search query leaves the machine
  even when the question's answer is written here.
- **deep_research's planner**, on a frontier turn: the routine tier writes the
  search queries.

## The milestone

A local model that meaningfully closes the gap on hard reasoning/coding is in
the **32B–70B** class, which needs roughly **48–64 GB** of (V)RAM:

- **Mac Studio / Mac mini, 64 GB unified** — ~$1,500–2,000. Quietest, simplest;
  runs a 70B (quantized) or a fast 32B via Ollama. Recommended path.
- **Single/dual used GPU box (2× 24 GB)** — similar cost, more speed, but power,
  heat, noise, and maintenance.

Even then it won't fully equal the current frontier and will be slower per
token — but for *Will's* mix of queries (everyday + web-grounded + the
occasional hard one) it crosses "good enough to drop the bridge."

### Steps to flip independence on, when the hardware lands

1. `ollama pull` the target model (e.g. a 70B) on the box.
2. In `~/.flint/secrets.env`: set `FLINT_FRONTIER_PROVIDER=ollama`,
   `FLINT_FRONTIER_BASE_URL=http://<box>:11434`, `FLINT_FRONTIER_MODEL=<model>`,
   and remove `ANTHROPIC_API_KEY`.
3. `./apps/server/install-server.sh` to reload.
4. Log shows `[brain] frontier escalation ENABLED -> ollama:<model>`. Done —
   no code touched, nothing leaves the network.

Until then, the bridge gives frontier-grade answers now, at pennies, with the
local brain handling everything private and everyday.
