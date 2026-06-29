# Flint's own brain — local fine-tuning harness (MLX)

Proof-of-loop: distill Claude's captured answers into a model Will OWNS, trained
locally on Apple Silicon (no cloud). See ../../../docs/INDEPENDENCE.md.

## Pipeline
1. `seed_corpus.py` — fire diverse public prompts at Flint so Claude's answers
   are captured to `~/.flint/training/corpus.jsonl` (the teacher signal).
2. `prepare_data.py` — corpus → MLX chat training set (train/valid) + holdout.
3. `run_all.sh` — waits for corpus, prepares, frees GPU, runs `mlx_lm.lora`
   (LoRA), evals. Env in `~/.flint/brain/.venv` (uv + python3.12 + mlx-lm).
4. `eval.py` — generate base vs base+adapter (Flint-v0) on holdout.

## First run (2026-06-27) — Qwen2.5-3B student, 101 teacher examples, 200 iters
RESULT: **loop works.** Validation loss on held-out prompts dropped 2.634 →
2.157 — the model generalizably learned to be more Claude-like. Outputs visibly
adopted Claude's structured/concise style. Peak mem 4.8GB (room for 7B+).

NOTE: the embedding-similarity check in eval.py is too blunt (saturates ~0.87,
measures topic not quality) — it failed to register the win. NEXT: replace with
an LLM judge (pairwise, Claude scores which answer is closer), scale base to 7B+,
and grow the corpus from Will's real daily usage.

## Cycle 2 (2026-06-27) — Qwen2.5-7B student, SAME 101-example corpus, 300 iters
Claude LLM-judge (eval_judge.py): Flint-v1 4/8, base 3/8, 1 tie (slight edge, within
noise on n=8). BUT training OVERFIT: train loss crashed to 0.50 (memorized) while
VAL loss ROSE 2.431 -> 2.474 (worse on held-out). Peak mem 8.8GB.

LESSON: data is the bottleneck, not model size. The 3B generalized (val loss down)
on the same corpus; the 7B memorized (val loss up). The slight judge edge is mostly
STYLE absorption, not generalizable capability. NEXT: grow the corpus to 1000+
examples (Will's real daily usage = personalization, plus more diverse seeding)
BEFORE scaling the model; use fewer iters / early-stop on best val loss; then 7B/14B
pays off. eval_judge.py reads ANTHROPIC_API_KEY from ~/.flint/secrets.env.

## Accumulation + auto-retrain (2026-06-27)
- `bulk_seed.py` — Claude generates ~880 diverse PUBLIC questions, fired concurrently
  at Flint so Claude's answers are captured as teacher data (corpus -> ~980).
- `retrain.sh` — reusable retrain job: prepare -> train (periodic val + checkpoints)
  -> `pick_best.py` (early-stop: activate the lowest-val-loss checkpoint, avoiding
  cycle-2's overfit) -> Claude judge -> append to ~/.flint/brain/history.log.
- `com.flint.retrain.plist` — launchd agent, runs retrain.sh WEEKLY (Sun 4am). So
  Flint's brain improves automatically as the corpus grows from real usage.
- Model via FLINT_BRAIN_MODEL env (default Qwen2.5-7B-Instruct-4bit). Iters scale to
  ~2 epochs (capped 1000); early-stopping makes overshoot safe.

## Autonomous growth (2026-06-28) — Flint trains itself
- `auto_grow.py` + `com.flint.grow.plist`: DAILY (3am) Claude generates ~150 fresh
  diverse questions (weighted to Will's domains + general breadth), Flint captures
  Claude's answers as teacher data, deduped vs the corpus. Knobs: GROW_TARGET,
  GROW_CONCURRENCY. So the corpus grows ~150/day with zero manual use.
- Full autopilot: com.flint.grow (daily, generate data) + com.flint.retrain
  (weekly, distill it into the model). Flint's brain compounds on its own.
- CEILING: synthetic distillation is capped at the teacher (Claude) and has
  diminishing returns on generic breadth — Will's REAL usage + REAL data remain the
  higher-value, personalized fuel. This complements, doesn't replace, real use.
