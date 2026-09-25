# Flint's local brain: training, gated against the frontier

One rule: **a local model ships only if it makes Flint-local measurably better
against a frontier model.** Not "lower val loss", not "beats its own base": the
candidate and the live local model answer the same prompts through Flint's real
pipeline, a cross-vendor judge panel compares each answer with GPT-5's, and the
candidate is promoted only on a significant gain in how often Flint-local wins
(apps/parity, `gate`). Everything else in this directory exists to produce
candidates worth that test, without breaking the live model or the terms Flint's
frontier providers set.

The v1 pipeline this replaces (Claude distillation, the 72B fine-tune, the weekly
retrain and daily grow) is retired; what it did and why is in [HISTORY.md](HISTORY.md).

## What to expect from it

Flint's parity with the frontier comes from the frontier tiers: tiered Flint wins
59% against raw Opus and 64.5% against raw GPT-5 on the panel judge. The local model
(muse-glimmer:30b) wins 13.5% against GPT-5: 55% on chit-chat and 65% on research
(with its tools), 5% on knowledge, 0% on coding. Of its losses, ~44% are "thinner"
answers and ~26% factual errors, on a set that is 77% long-tail knowledge.

Fine-tuning won't close that. Imitating a stronger model copies style, not knowledge
(Gudibande et al. 2023); fine-tuning adds facts slowly and raises hallucination
(Gekhman et al. 2024); retrieval beats it for knowledge (Ovadia et al. 2024). muse-glimmer
is itself distilled from a much larger model at industrial scale. Realistic gains from
a narrow LoRA are in Flint-specific tool use (when to call recall/calculate/search, and
their exact schemas), answering from retrieved excerpts, and depth/format: maybe +5 to
+10 points on the local path. Knowledge will likely not move. Past jumps came from base
swaps (qwen2.5:7b 3% -> muse 14% -> qwen3.8 17.5% vs GPT-5), and the same gate
decides those.

## The cycle

```
gate --preflight-only  can the gate judge a candidate at all?  -> go | not gateable   (free: no server, model or paid call)
build_data.py      corpus + sample batches -> train/valid/manifest       (contamination-guarded, terms-compliant)
gate --preflight-only  was this data guarded against the gate's sets? -> go | UNGATEABLE
memcheck.py        fits next to the live model?  -> footprint | DEFER     (never touches Ollama)
train_lora.py      LoRA with in-process early stopping -> best adapter | NO_CANDIDATE | PREEMPTED
package_candidate  fuse + `ollama create flint-muse:c<id>`                (never the live tag)
parity `gate`      candidate vs GPT-5, compared with the live local model -> PROMOTE | REJECT | HOLD
```

`cycle.sh` runs them in order and records the outcome in
`~/.flint/brain/cycles/state.json`; each cycle's files are in
`~/.flint/brain/cycles/<id>/` (`cycle.log`, `data/manifest.json`, `memcheck.json`,
`adapter/early_stop.json`, `gate.json`). Flint's `training_status` tool reads them.
After the gate the fused weights are deleted (Ollama has its copy, and `adapter/`
can be re-fused); a REJECTed candidate is also removed from Ollama, while a HOLD or
PROMOTE keeps it (~17 GB) until you `ollama rm` it.

```bash
./cycle.sh --dry-run                 # counts and the plan; writes nothing
./cycle.sh --force                   # one supervised cycle
./cycle.sh --force --gate-sets parity_prompts.jsonl:100   # ...until flint_tasks.jsonl exists
./cycle.sh --if-due                  # what the schedule runs: no-op unless due
```

The gate's free checks run twice before any GPU is used: before the data is built
(every `--gate-sets` set on disk; default `parity_prompts.jsonl:100,flint_tasks.jsonl`,
or `FLINT_GATE_SETS`), and against the built manifest (guarded against those exact
sets). If the gate would HOLD or REJECT a candidate unjudged, the cycle stops there:
before the data it writes nothing, after it records `UNGATEABLE` with the reasons in
`gate.json`. Training anyway would spend up to 4 hours of GPU next to the live model and
leave a ~17 GB candidate in Ollama that no gate could promote. cycle.sh calls the gate
through its own `tsx`, not `pnpm run`, which turns every failing exit into 1 (a HOLD
would read as REJECT, remove the candidate and count toward the kill switch).

| file | does |
| --- | --- |
| `profiles/*.toml`, `profiles.py` | the base model and every knob; default `muse-glimmer-30b` (or `FLINT_BRAIN_PROFILE`) |
| `parity_text.py` | line-for-line port of parity's `normalize`, prompt id, near-duplicate and trivial rules |
| `contamination.py` | the fail-closed guard against the eval sets |
| `pool.py` | the permanent train/eval split of conversations |
| `provenance.py` | which answers may be training targets (the terms policy) |
| `build_data.py` | the data builder |
| `early_stop.py`, `train_lora.py` | early stopping with patience, and the training driver |
| `memcheck.py` | coexist-or-defer next to the live model |
| `package_candidate.sh` | adapter -> Ollama model |
| `cycle_state.py`, `cycle.sh` | when a cycle is due, the kill switch, the orchestrator |
| `setup_train_env.sh`, `requirements-train.txt` | the pinned training venv |
| `com.flint.retrain.plist` | the schedule (ships disabled) |

## Data

**Targets must be terms-compliant** (`provenance.py`, allow-list, fails closed):

| kind | allowed when |
| --- | --- |
| `human` | Will wrote the answer (a correction, a rewrite); `teacher.model` is empty or `will`, and a human row naming any model is refused |
| `self` | the base model's own answer (profile `self_models`) that passed at least one verifiable check (tests ran, the calculator agreed, the tool call matched its schema), recorded in `teacher.checks` |
| `open-weight` | a model listed in the profile's `[teachers]` with an `apache-2.0`/`mit` licence (the licence comes from the profile, never the row) |

A frontier vendor's output (Claude, GPT, Sonar, Gemini, Nova, Grok...) is never a
target, whatever the row says, `kind: human` included (a "Will edited Claude's reply"
row is still Claude's text); there is no flag for it. Anthropic's terms prohibit using
outputs as training targets and OpenAI's bar developing competing models. (Policy, not
legal advice.) Prompts a vendor model wrote (the retired `bulk_seed`/`auto_grow` rows)
are dropped too. Will's own prompts are his: when their answer is refused, the prompt
goes to `prompts_for_sampling.jsonl` for a compliant teacher to answer.

**What that leaves today:** zero target rows. Of the corpus's 827 rows, 625 have
Claude-written prompts, 101 overlap the parity set, 17 are in the eval pool, 42 are
trivial, and the rest have Claude's answers. 40 eligible prompts remain for sampling.
The cycle stays `not due` until the data would actually build: `min_train` (200) rows
left for training *after* the valid split takes its share (so about 250 compliant
targets), `min_valid` (50) valid rows, and enough rows with reasoning.

**Sample batches** (`~/.flint/training/samples/*.jsonl`) are how compliant targets
arrive. One row per example:

```json
{"prompt": "Will's ask", "conversationId": "c1790...", "ts": 1790000000000,
 "teacher": {"kind": "self", "model": "muse-glimmer:30b", "checks": {"passed": true, "verified": ["calculate-agrees"]}},
 "messages": [{"role": "system", "content": "the exact system prompt it was answered under"},
              {"role": "user", "content": "..."},
              {"role": "assistant", "content": "", "tool_calls": [{"id": "t1", "type": "function", "function": {"name": "calculate", "arguments": {"expression": "..."}}}]},
              {"role": "tool", "tool_call_id": "t1", "content": "..."},
              {"role": "assistant", "content": "final answer", "reasoning_content": "the model's own reasoning"}],
 "tools": [{"type": "function", "function": {"name": "calculate", "description": "...", "parameters": {}}}]}
```

or `"output"` (+ optional `"reasoning"`) instead of `"messages"` for a plain answer.
Tool-call `arguments` may be a JSON string; the builder turns them into mappings (the
Glimmer template needs that). Producing batches is not in this directory yet: it needs
the server to return a turn's tool trace and the model's reasoning (see "Not done yet").

**Filters, in order** (every drop is counted in `manifest.json` `drops`):
vendor-written prompt, trivial prompt, **eval overlap**, eval pool; then refused
provenance, bad tool-call JSON, the server's "no model answered" message, answers under
40 characters, tool use without its trajectory (it teaches stating looked-up facts
without looking), and answers that correct themselves mid-way ("Wait, ...").

**Contamination guard** (`contamination.py`): a prompt is out if it has the same
parity id as an eval prompt, or content-word Jaccard >= 0.6 with one (stricter than
dedupe's 0.8), or a 3+ word set is >= 80% contained in the other. Every user turn is
checked, not just the last. Required set: `~/.flint/eval/parity_prompts.jsonl`
(missing = exit 2, never "clean"); optional: `flint_tasks.jsonl` (recorded as absent).
After rendering, every user turn is checked again and any hit is exit 3. The manifest
records each set's path, sha256 and size, and the gate refuses a candidate guarded
against a different version of the set judging it. The normalisation is shared with the
TypeScript side through `apps/parity/test/fixtures/normalize-cases.json`, checked by
both test suites.

**Pool split** (`pool.py`, twin of `apps/parity/src/pool.ts`): every conversation
belongs to `eval` (30%) or `train` forever, by `sha256(key)`. The key is the
conversation id, or the prompt's parity id for the server's shared buckets (`console`,
`generate`, ...). Training uses only `train`; a real-task gate set (`flint_tasks.jsonl`)
must come only from `eval`.

**Dedupe and split:** exact + parity's near-duplicate rule, keeping human > self >
open-weight, then oldest. Deduping before the split means no valid prompt has a
near-duplicate in train. The valid set (120, or 20% of a small set) is stratified by
kind and fixed by a hash of each prompt id. Will's rows are repeated at most twice and
never past 30% of the set.

**Rendering:** the live local system prompt when given (`--local-prompt`, or
`FLINT_LOCAL_PROMPT` for the cycle: `{"system": ..., "sha": ...}`); a sample's own
recorded system prompt wins. One row per assistant turn of the final exchange
(mask_prompt trains only the last message, so each tool call and the final answer
are each a target once). Earlier turns are history, possibly another model's
answers, and stay masked context, never targets. Without
a system prompt the builder warns: the model would train in a context it's never
served in. The gate still judges the served model, so that wastes a run rather than
shipping a bad one.

**Thinking:** the live model runs with thinking on, and training only on final
answers erodes Glimmer's reasoning channel (Unsloth's warning). With `serve.think =
true`, a build where fewer than 30% of rows carry `reasoning_content` is NO_DATA.

## Training

`train_lora.py` calls mlx-lm's pieces directly (`utils.load`, `load_dataset`,
`lora.train_model`), because `mlx_lm lora`'s `run()` replaces any callback with its
own. Before training it refuses:

- an mlx-lm whose version isn't the profile's pin (`0.32.0`, git
  `1b3594b9`, the first line with `muse_glimmer`; the PyPI 0.31.3 in
  `~/.flint/brain/.venv` can't load it), or a changed `train_model` signature;
- a base model that isn't already local (`HF_HUB_OFFLINE=1` unless
  `--allow-download`), at the profile's pinned revision;
- a chat template whose prompt tokens aren't a prefix of the full row's (mask_prompt
  would mask the wrong span), or more than 10% of rows whose answer lies past
  `max_seq_length`.

**Early stopping** (`early_stop.py`), from inside the process: mlx-lm computes val loss
before step `it` with the weights after `it - 1` steps, so the callback saves exactly
the weights that scored. The first report is the base; a new best (by `min_delta`
0.005) saves `best_adapters.safetensors`; after `min_epochs` (0.5), 3 evals without one
stop the run; a val loss above 1.25x the best, or NaN, stops it at once. The whole
valid set is scored every time (`val_batches = -1`), so the curve moves only when the
weights do. `early_stop.json` has the curve and why it ended.

Muse defaults (profile): LoRA rank 16 on every linear layer of the last 16 blocks,
lr 1e-4 cosine to 1e-5 over optimizer updates after 10 warm-up updates, batch 1 with
8-step accumulation, up to 2 epochs, seq 2048, gradient checkpointing, 4 evals per
epoch. Exit codes: 0 CANDIDATE, 10 NO_CANDIDATE (nothing beat the base; no adapter
left), 75 PREEMPTED, 2 config/environment, 1 crash.

**Memory, and why there is no "cover mode".** The old scripts unloaded
`com.flint.ollama`, which also took down nomic-embed-text, used by recall, knowledge
and the router on every frontier turn, and an aborted run left it down. This pipeline
never touches Ollama. `memcheck.py` trains only in a footprint that fits next to the
live model (`ollama + train + 10 GB <= RAM` and `ollama + train <= wired limit - 2 GB`,
taking the live model at its worst case of 20 GB even when it's idle-unloaded) and
otherwise defers. On the Studio (64 GB, wired limit 57,344 MB) the estimate fits
2048x16 at ~30 GB; the first real run's measured peak replaces the estimate. During
training the callback preempts on a memory budget or critical memory pressure, so the
live model always wins; training also stops by 07:00. Taking the live model offline for
a longer run would mean either local-only / "keep it private" turns failing honestly,
or being silently answered by a frontier model, which `policy.ts` itself calls worse
than no switch. That is Will's decision, so it isn't built.

## Packaging

Ollama 0.34.2 rejects LoRA `ADAPTER`s and no longer converts safetensors to GGUF, so
`package_candidate.sh` fuses the adapter into the 4-bit MLX base (`mlx_lm fuse`),
drops the vision keys from `config.json` (mlx-lm's port is text-only), and runs
`ollama create <prefix>:c<id>` from that directory with the live model's
`PARAMETER`s. It refuses the live tag. **Unverified until the first real run:** that
Ollama's MLX importer accepts the text-only config and mlx-lm's weight names. Test it on
a scratch cycle first; a failure is PACKAGE_FAILED, never a change to the live model.
The candidate runs on Ollama's MLX engine, so `muse-glimmer:30b-mlx` is the baseline
that isolates the fine-tune from the engine; the gate's baseline is the live model,
because that's what the candidate would replace.

## The gate

See apps/parity/README.md "The promotion gate". In short: for each prompt set
(default `parity_prompts.jsonl:100,flint_tasks.jsonl`), a fresh run dir, the live model
(`--flint-local`) then the candidate (`--local-model`), both against GPT-5's answers,
judged by the `claude-opus-5-5 + gpt-5` panel. PROMOTE needs a one-sided sign test
p < 0.05, a gain of at least 5 points in strict win rate against GPT-5, and the 90%
bootstrap interval above 0, with no set going backwards, no category (n >= 10) dropping
more than 10 points, the answer rate within a point, and the median answer no more than
1.3x slower. HOLD when the measurement can't be trusted: a missing set (so with no
`flint_tasks.jsonl` yet, a cycle with the default sets stops before training, see
above), a server deploy mid-gate, too few pairs, too many judge errors, a manifest
guarded against another set version. REJECT outright for a contaminated manifest. About
$20 a gate. It never promotes: PROMOTE prints the commands that serve the candidate
exactly as it was judged (also kept in `gate.json` as `promote`), and running them is
Will's call. They set `OLLAMA_MODEL`, and `OLLAMA_THINK` to the think flag it was gated
with (`serve.think`; the live plist has none, and a fused candidate on Ollama's MLX
engine may default differently), reload the server so launchd re-reads the plist
(`bootout` + `bootstrap`; `kickstart -k` would restart the old definition, still on the
old model), and check that `/health` reports the candidate.

## Scheduling

`com.flint.retrain.plist` runs `~/flint/apps/train/mlx/cycle.sh --if-due` nightly at
02:30 from the deploy checkout. **It ships disabled**, and keeps the retired job's label
so launchd's existing `disabled` override still applies. A cycle is due only when the
data would build (`build_data --count-only` status `ok`), with 150+ new target rows or a
changed profile since the last training cycle, and 7+ days since it. A due cycle whose
gate would HOLD unjudged (with the default sets: until `flint_tasks.jsonl` exists) stops
before building anything, every night, at the cost of a few seconds. Two REJECT/NO_CANDIDATE results in a row
turn on the kill switch: only `cycle.sh --force` runs after that. A cycle also stands
down while a local parity run (a bake-off or a gate) is using the GPU, and holds a lock
so two never overlap. The gate refuses to run while a cycle trains (`TRAINING.json`).

To enable, **after one supervised `cycle.sh --force` has run cleanly end to end**:

```bash
cp ~/flint/apps/train/mlx/com.flint.retrain.plist ~/Library/LaunchAgents/   # replaces the stale one pointing at ~/.flint/brain/retrain.sh
launchctl enable gui/$(id -u)/com.flint.retrain
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.flint.retrain.plist
```

To disable: `launchctl bootout gui/$(id -u)/com.flint.retrain; launchctl disable gui/$(id -u)/com.flint.retrain`.
Never re-enable the currently installed plist as it is: it runs the retired
`~/.flint/brain/retrain.sh`, which unloads Ollama. `studio_bootstrap.sh` never loads
`com.flint.retrain` or `com.flint.grow`.

## First run, in order

1. `./setup_train_env.sh` (creates `~/.flint-train/venv`, ~200 MB), then
   `./setup_train_env.sh --download-base` when you want the base (~19.4 GB into the
   Hugging Face cache). Free disk for a cycle: ~20 GB fused + ~17 GB in Ollama.
2. Terms-compliant targets in `~/.flint/training/samples/` (see Data), enough to pass
   `min_train`. `./cycle.sh --dry-run` shows the count.
3. A real-task set for the gate, `~/.flint/eval/flint_tasks.jsonl`, from eval-pool
   conversations only. Until then run the cycle with `--gate-sets
   parity_prompts.jsonl:100`; with the default sets it stops before training (not gateable).
4. A scratch packaging test (`package_candidate.sh` on a first adapter) to settle the
   two unverified Ollama import questions.
5. `./cycle.sh --force` once, watched, when the bake-off isn't using Ollama.
6. Only then, the schedule.

## Base-model swaps

The gate decides these too, with nothing trained: `pnpm --filter @flint/parity gate
--no-manifest --candidate qwen3.8:27b --sets parity_prompts.jsonl:100`. Profiles for the
two alternates (`qwen3.8-27b`, `qwen3.6-35b-a3b`) are here for training on them if one
is promoted. Re-deciding the 2026-09-24 bake-off from its cached verdicts (no calls):
qwen3.8:27b vs muse-glimmer:30b is 31 better / 18 worse on 291 prompts, +3.4 points,
p = 0.043: below the 5-point margin and 1.6x slower, so it would be REJECTED once its
16 judge errors were re-judged (with them, HOLD).

## Not done yet

- **Producing compliant samples.** Needs the server to return a turn's tool trace and
  the model's reasoning for eval calls, and the training log to record `pool`,
  history and memory (server work, separate from this).
- **`GET /eval/local-prompt`**, so the builder renders the exact live local system
  prompt and the gate can check the candidate was trained on the one being served.
- **`flint_tasks.jsonl`** (Will's real tasks, eval pool only) and a tool-call accuracy
  suite, the measure where a narrow LoRA can actually move.

## Tests

```bash
pnpm --filter @flint/train test      # = cd mlx && python3 -m unittest discover -s tests -t tests
```

Stdlib only (Python 3.11+ for `tomllib`); no mlx, network or `~/.flint`. They cover
the shared parity fixtures, the guard, the pool, the terms policy, every builder filter
and the render, early stopping, the training driver's config and mask checks,
memcheck's decisions, due/kill-switch logic (against the builder's own verdict), the
profiles, the shell scripts' syntax and dry runs, cycle.sh stopping before training
when the gate would HOLD, and that nothing here unloads Ollama. The cycle.sh tests run
the real gate's free `--preflight-only` (skipped without `pnpm install`), with Ollama's
host pointed at a closed port, `pgrep`/`taskpolicy`/`ollama` stubbed on `PATH`, and a
measured peak that makes memcheck defer, so none of them can train.
