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

## The swappable brain seam (today's crutch, tomorrow's switch)

Today Flint defaults to Claude for capability and falls back to the local model
when offline or when Will asks to stay private. The frontier brain is one
swappable seam, so it can be repointed at Flint's own grown-up model — or
switched off entirely — the day that model is good enough.

## The seam (already in code)

`buildFrontierProvider()` in `apps/server/src/index.ts` picks the escalation
brain from env:

| Env | Effect |
|-----|--------|
| `ANTHROPIC_API_KEY` (in `~/.flint/secrets.env`) | Escalate to Claude (default `claude-sonnet-4-6`; set `FLINT_FRONTIER_MODEL=claude-opus-4-8` for max). |
| `FLINT_FRONTIER_PROVIDER=ollama` + `FLINT_FRONTIER_BASE_URL` + `FLINT_FRONTIER_MODEL` | Escalate to a **self-hosted big model** (e.g. a 70B on a home box). Fully independent. |
| none | Pure local — frontier off. The header "Local only" toggle forces this per-session too. |

Switching from Claude to a local 70B is therefore a **config change, not a
rewrite**. Everything else — the difficulty judge, the shared memory + tools,
the streaming, the badge — stays identical.

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
