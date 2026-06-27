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
