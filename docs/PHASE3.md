# Phase 3 — "Flint's own AI" (the runbook)

The goal: a model that is **distinctively yours**, running locally behind Flint's
adapter — no Anthropic, no cloud. Phase 2 built the delivery vehicle
(`OllamaProvider`); Phase 3 is about what rides in it.

**Read this first:** Flint is the body, the local model is the brain. "Flint's
own AI" is not Flint generating text by itself — it's a self-hosted, tuned model
served through the same `ProviderAdapter`. Nothing in your app changes between a
stock local model and your tuned one; only the model behind Ollama changes.

## The sequencing (do NOT start with fine-tuning)

The spec is explicit: prompting + retrieval first, fine-tuning only if voice
specifically still falls short, proven with numbers.

### Step 0 — Prerequisites (need you / your machine)

- [ ] Install Ollama (`ollama serve`) and pull a base model
      (`ollama pull llama3.1` or `qwen2.5`).
- [ ] Verify live: `OLLAMA_MODEL=llama3.1 pnpm --filter playground start`.
      (The adapter is proven by the offline contract suite but has not yet hit a
      real Ollama — this is the one outstanding verification.)
- [ ] Assemble an eval set: 10–30 held-out examples of the voice/output you
      want, that the model will NOT be trained on. This is how we measure.

### Step 1 — Maximize prompting + retrieval (no training)

1. Write a detailed, specific **style guide** as the system prompt (voice, do/don't,
   examples). Pass it via `system` on `chat()`/`generate()`.
2. **Retrieve the user's own writing** into context (a few relevant samples per
   call). NOTE: retrieval is explicitly out of scope for `@flint/core` (spec §12)
   — build it in the app, or as a separate package, and feed results in as
   messages. Flint's `contextStrategy` budgets the window for you.
3. Measure voice quality against the held-out eval set. Manual scoring first.

**Gate:** if prompting + retrieval is good enough, STOP. You have "Flint's own
AI" without training. Most of the win lives here.

### Step 2 — LoRA fine-tune (only if voice *specifically* still falls short)

Justify it with numbers from Step 1, not vibes. Fine-tuning buys a marginal voice
gain while measurably degrading general reasoning — the bar is "prompting +
retrieval demonstrably wasn't enough."

1. Prepare a training set from the user's writing (instruction/response pairs in
   the voice you want).
2. Rent a GPU; run a **narrow LoRA** on the chosen open base model.
3. Convert/merge and serve through **Ollama** (a `Modelfile` over the base +
   adapter), so it appears as just another Ollama model.
4. Point Flint at it: `defaultModel: 'your-tuned-model'`. No app code changes.
5. Re-run the eval set. Compare voice AND reasoning vs. the stock base model
   (catch reasoning regressions) and vs. the Anthropic baseline (quality ceiling).
   Treat it as an opt-in experiment, not the default path.

## What's already in place (the vehicle)

- `OllamaProvider` — local models behind the same `ProviderAdapter`.
- Honest capability tiers + adapter-owned prompted tool-calling.
- The whole Flint layer around the model: tool loop, transactional memory,
  streaming, observability, concurrency.
- Anthropic is optional (0.3.0) — a local-only build pulls in zero Anthropic,
  and the Anthropic provider remains available purely as a quality baseline to
  measure your local model against.

## Decisions still needed from you

- Base model choice (llama3.1 / qwen2.5 / mistral …).
- What "your data" is (your writing? transcripts?) and where it lives.
- GPU plan for Step 2 (rented instance), if/when prompting + retrieval proves
  insufficient.
