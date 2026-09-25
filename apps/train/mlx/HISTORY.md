# Retired: the v1 local-brain pipeline (2026-06 to 2026-09)

Kept for the record. Everything below was deleted from the repo on 2026-09-25 in
favour of the v2 cycle (README.md). Every file is still in git: view one with

```bash
git show ec02b7d:apps/train/mlx/retrain.sh      # any path from the table below
```

## What it was

Distill Claude into an owned open model: capture Claude's answers through Flint's
server into `~/.flint/training/corpus.jsonl`, pad them with synthetic traffic and
50k public rows, LoRA-train a Qwen2.5 student with mlx-lm, pick the lowest-val-loss
checkpoint, and have one Claude model judge the student against its own base.

| file | what it did |
| --- | --- |
| `seed_corpus.py` | fired a hand-written list of public prompts at `/chat` so Claude's answers were logged |
| `bulk_seed.py` | had claude-sonnet-4-6 write ~880 questions, then fired them at Flint |
| `auto_grow.py` + `com.flint.grow.plist` | the same, daily at 03:00 (~150 new rows a day) |
| `pull_open_data.py` | downloaded ~50k OpenHermes rows (`~/.flint/brain/data/public.jsonl`) |
| `prepare_data.py` | corpus + public rows -> `train/valid` + a frozen 150-prompt holdout |
| `run_all.sh`, `run_cycle2.sh`, `run_full.sh` | the first 3B and 7B runs, hard-coded to Qwen2.5 |
| `retrain.sh` + `com.flint.retrain.plist` | the weekly retrain (Sun 04:00): prepare, unload Ollama, train, pick_best, judge, gate |
| `ultimate_upgrade.sh` | the one-off 72B QLoRA run on the Studio |
| `pick_best.py` | after the run, copied the checkpoint nearest the best logged val loss |
| `eval.py` | embedding similarity to the teacher answer (saturated at ~0.87; measured topic, not quality) |
| `eval_judge.py` | a Claude judge, fine-tune vs its own base, raw generations capped at 360 tokens |
| `promote_gate.py` | PROMOTED.json if `eval_judge.py` called the win SIGNIFICANT |

## What it produced

- **Qwen2.5-3B, 101 teacher rows, 200 iters (2026-06-27):** val loss 2.634 -> 2.157;
  answers took on Claude's structure. The loop worked mechanically.
- **Qwen2.5-7B, same 101 rows, 300 iters:** train loss 0.50 (memorised), val loss
  rose 2.431 -> 2.474. Judge 4-3-1 on 8 prompts: noise.
- **Qwen2.5-7B weekly retrain (2026-09-20):** SIGNIFICANT at 25-48, i.e. significantly
  *worse* than its base; nothing checked the direction until promote_gate.py.
- **Qwen2.5-72B, ~30.6k rows (65% OpenHermes), 2026-09-22/23:** run 1 went 8,000
  iterations with its best val at 800 (1.403, rising to 2.02 by 7,200); run 2 went
  2,000 with its best at 600. Judged vs the 72B base: 31-34 of 150 with 85 ties, NOISE.
  Nothing it produced was ever served.

## Why it was retired (the v2 audit)

1. **It never measured the thing that matters.** Every verdict compared a fine-tune
   with its own base. None asked whether Flint's local brain got closer to a frontier
   model. The parity harness (apps/parity) does, and the v2 gate is built on it.
2. **It trained on Claude's answers.** 757 of the corpus's 827 targets are
   claude-sonnet-4-6 answers, and the grow/bulk prompts were written by Claude too.
   Anthropic's terms prohibit using outputs as training targets; OpenAI's bar
   developing competing models.
3. **The eval set was in the training data.** `parity_prompts.jsonl` was built from
   the same corpus: 310 rows were exact parity prompts, and the old holdout shared 63
   of its 150 prompts with parity.
4. **Training didn't match serving.** No system prompt, no memory, no history, and
   tool-using answers without their tool calls, which teaches stating looked-up facts
   without looking them up. `mask_prompt` was off.
5. **Early stopping was after the fact and noisy.** 25 of 40 valid rows, re-sampled
   at every eval; the nearest checkpoint, not the best weights.
6. **It took the live model offline.** `retrain.sh` and `ultimate_upgrade.sh`
   unloaded `com.flint.ollama`, which also removed nomic-embed-text, used by memory
   recall, knowledge and the router on every frontier turn; an aborted run left it
   unloaded.
7. **The research says the gap isn't trainable this way.** Of muse-glimmer's 245
   losses to GPT-5, ~44% were "thinner" and ~26% factual errors, and 77% of the parity
   set is long-tail knowledge. Imitation moves style, not knowledge (Gudibande et al.
   2023); fine-tuning adds knowledge slowly and raises hallucination (Gekhman et al.
   2024); retrieval beats it for knowledge (Ovadia et al. 2024).

## Left on disk, outside the repo (not touched by this change)

The launchd jobs `com.flint.retrain` and `com.flint.grow` are disabled
(`launchctl print-disabled gui/$(id -u)`). Their installed plists still point at
copies in `~/.flint/brain` that differ from the repo; never re-enable those. For
Will to remove when he chooses:

| path | size |
| --- | ---: |
| `~/.flint/brain/adapters/` | 38M |
| `~/.flint/brain/adapters7b/` | 550M |
| `~/.flint/brain/adapters70b/` | 1.5G |
| `~/.flint/brain/adapters70b.run1-8000/` | 884M |
| `~/.flint/brain/data/public.jsonl` | 83M |
| `~/.flint/brain/data/train.jsonl` | 62M |
| Hugging Face cache: `mlx-community/Qwen2.5-72B-Instruct-4bit` | 38G |
| Ollama `qwen2.5:7b` (3% vs GPT-5) | 4.7G |
| `~/Library/LaunchAgents/com.flint.grow.plist` | |

Plus `holdout.jsonl`, `holdout_keys.json`, the script copies (`retrain.sh`,
`prepare_data.py`, ...), `wait_then_upgrade.sh` and `real_eval.sh` in
`~/.flint/brain`. Keep `eval_history.csv` and `history.log`: they are the record
the server's `training_status` tool still reads.
