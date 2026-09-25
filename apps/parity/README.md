# @flint/parity: the parity eval

Is Flint as good as ChatGPT, Claude and Perplexity on the things Will actually asks
him? `apps/train/mlx/eval_judge.py` can't answer that: it compares a fine-tuned model
with its own base. This package runs Flint **end to end** (router, persona, memory,
tools) against the vendors' strong general models on a frozen set of Will's real
prompts. An LLM judge (one Claude model, or a cross-vendor panel with `--judge-panel`)
compares each pair blind, and the result gets a sign test so a coin flip doesn't read as
progress.

Everything it writes lives under `~/.flint/eval/`:

| path | what |
| --- | --- |
| `parity_prompts.jsonl` (+ `.meta.json`) | the frozen prompt set |
| `runs/<ts>/answers.jsonl` | every answer from every contestant (the resume cache) |
| `runs/<ts>/judgments.jsonl` | every judge verdict, with its reason |
| `runs/<ts>/report.md` | the report (`report-<subject>.md` for `flint-local`, each `--local-model` candidate and each `--local-think` variant) |
| `runs/<ts>/run.json` | the config the run started with |
| `parity_history.csv` | one row per competitor per run, for the trend line |

## 1. Freeze the prompt set (once)

```bash
pnpm --filter @flint/core --filter @flint/persona --filter @flint/mcp build   # the workspace libs run from dist/
pnpm --filter @flint/parity build-prompts             # --seed 1 --max 300 by default
```

Reads `~/.flint/training/corpus.jsonl` and:

- drops greetings, acknowledgements, context-dependent follow-ups ("yes", "go ahead"),
  API probes ("say ok") and bare URLs;
- drops exact and near duplicates (content-word Jaccard ≥ 0.8, or a short ask ≥ 80%
  contained in a longer one), keeping Will's own (organic) copy over a seeding
  script's (synthetic);
- tags each prompt with a category from the tools the original turn used plus keywords:
  `research`, `email-calendar-drive`, `finance-systems`, `coding`, `planning-writing`,
  `knowledge` (explanatory questions), `chit-chat`;
- stratifies: every category gets an equal share of the 300, and whatever a small
  category can't use goes to the others. Within a category organic prompts go first,
  then a seeded shuffle of the synthetic ones.

The output is deterministic: the same corpus and seed give a byte-identical file. It is
**never overwritten** unless you pass `--rebuild`. Rebuild only on purpose, because
results are only comparable across runs on the same set. Prompt ids are hashes of the
text, so answers cached by an old run still match after a rebuild.

As of 2026-09 the corpus is mostly synthetic seeding (bulk/grow/seed) with only ~90
organic turns, and has **no** email/calendar/drive or finance-systems asks. Those two
rows stay empty until Will's real use puts them in the corpus. The build prints the
per-category counts.

## 2. Run

```bash
pnpm --filter @flint/parity parity --limit 3 --budget-usd 1     # smoke test
pnpm --filter @flint/parity parity --budget-usd 60              # the full set
```

Contestants (`--contestants flint,openai,claude,perplexity`):

| name | how | default model | flag / env |
| --- | --- | --- | --- |
| `flint` | `POST /generate` on the running server with `eval: true` | whatever the server routes to | `--flint-url` / `FLINT_URL` (default `http://127.0.0.1:8080`) |
| `openai` | `OpenAiProvider` from @flint/core | `gpt-5` | `--openai-model` / `PARITY_OPENAI_MODEL` |
| `claude` | `AnthropicProvider` | `claude-opus-5` | `--claude-model` / `PARITY_CLAUDE_MODEL` |
| `perplexity` | `PerplexityProvider` (skipped with a note if no key) | `sonar-pro` | `--perplexity-model` / `PARITY_PERPLEXITY_MODEL` |
| judge | `AnthropicProvider` | `claude-opus-5` | `--judge-model` / `PARITY_JUDGE_MODEL` |
| judge panel | `AnthropicProvider` + `OpenAiProvider` | off | `--judge-panel` / `PARITY_JUDGE_PANEL` (see below) |

Keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `PERPLEXITY_API_KEY`) come from the
environment or `~/.flint/secrets.env`, parsed the same way as the server's
`loadSecrets`. Flint's bearer token comes from `$FLINT_TOKEN`, then `~/.flint/token`,
then the `com.flint.server` launchd plist, and is never printed.

**Eval mode.** With `eval: true`, `/generate` answers exactly as usual but does not log
the turn to the training corpus (a replay would leak the eval into what it measures).
It also hides the `remember` tool and auto-rejects any write proposal. The harness
checks `/health` for `evalMode: true` **before** sending anything, and refuses a server
that predates it unless you pass `--allow-training-log`. So the harness only works
against the live server once this branch is deployed.

Other flags: `--limit N` takes N prompts round-robin across categories.
`--categories a,b` filters by category. `--concurrency 3` sets vendor and judge
concurrency. `--judge-only` (with `--run`) re-judges cached answers without calling Flint
or any contestant, so the server needn't be up and nothing is re-answered; pairs with a
missing answer are skipped. `--flint-concurrency 1` stays at 1 so the tools reported for each Flint
answer are exact. `--max-tokens 8192` caps answers and `--judge-max-tokens 4096` caps
the judge. `--flint-timeout-s 240`. `--no-judge` collects answers only. `--seed 1` sets
the A/B order.

**Budget.** `--budget-usd` (default 10) is a hard ceiling for the invocation. Each paid
call reserves a pessimistic estimate first and is refused if spent + in-flight + estimate
would cross the limit. After the call, the real cost is computed from the returned
usage and list prices (`src/pricing.ts`). On a refusal the run stops launching work,
writes the report and exits. Rough full-set cost at the defaults: about $15 of
answers, $15 to $25 of Flint frontier tokens, and $20 to $35 of judging. Budget $60 to $80,
or less with `--judge-model claude-sonnet-5`.

**Flint on his own (`--flint-local`).** Flint answers with the local brain only
(`localOnly: true`, no Claude), as the contestant `flint-local`. Point it at an
existing run with `--run <ts>` and the competitors' answers are reused, so only Flint's
local answers and the new verdicts cost anything (local answers are free). Its
verdicts carry `subject: "flint-local"` and never mix with normal Flint's. The report
goes to `report-flint-local.md`, and history rows get `subject=flint-local` (the
history CSV's last column; older files are upgraded in place). The local brain has
to be up (Ollama). A training run unloads it, so wait for that to finish.

```
pnpm --filter @flint/parity parity --run <ts> --flint-local --budget-usd 40
pnpm --filter @flint/parity report --run <ts> --flint-local
```

**Bake-off candidate local models (`--local-model <name>`).** Runs Flint's real local
pipeline (persona, tools, memory context) on a different Ollama model, without changing
the live server's `OLLAMA_MODEL` or restarting it. Implies `--flint-local`. The request
carries `localModel`, which the server accepts only with `eval: true` and `localOnly: true`
(anything else is a 400); it builds and caches a persona identical to its own local one
except for the model. The contestant is `flint-local@<name>`, so each candidate's
answers, verdicts, report (`report-flint-local@<name>.md`, with `:` and `/` turned into
`_`) and history rows (`subject`) are kept separate. Before sending anything the harness
checks that the model is pulled (`GET $OLLAMA_HOST/api/tags`, default
`http://127.0.0.1:11434`) and that the server's `/health` has `localModelOverride: true`.
If an answer comes back from any other model, the run stops. Needs a server deployed from
this branch.

```
ollama pull qwen3:14b                                           # first; the harness won't pull
pnpm --filter @flint/parity parity --run <ts> --local-model qwen3:14b --contestants flint,openai,claude,perplexity --claude-model <the run's claude model> --budget-usd 40
pnpm --filter @flint/parity report --run <ts> --local-model qwen3:14b
```

Reuse an existing run so the competitors' answers are cached and only the candidate's
(free) answers and the verdicts cost anything. Pass the same `--claude-model` /
`--openai-model` the run used, or those answers won't match the cache and get re-bought.
Run candidates one at a time: Ollama swaps models in and out of memory, so interleaving
them is slow.

**Thinking on or off (`--local-think on|off`).** Thinking models (qwen3.8, muse-glimmer)
reason before they answer unless told not to. Ollama returns the reasoning separately
(`message.thinking`), so it never reaches Flint's answer, but it is most of the answer
time. `--local-think off` (or `on`) sends `localThink` with the request, and the server
answers with a persona built on an Ollama client that sends that `think` flag (same 16K
context as any candidate). It works only with `--local-model`; on its own it's an error.
The contestant becomes `flint-local@<name>~nothink` (or `~think`), with its own answers,
verdicts, report (`report-flint-local@<name>~nothink.md`) and history rows. **Without the
flag nothing changes**: no `localThink` is sent, the model thinks by its own default, and
the name stays `flint-local@<name>`. So a run's existing answers for that candidate stay
valid and are never mixed with a think variant. Before sending anything the harness checks
that `/health` has `localThinkOverride: true` and, for `on`, that Ollama lists `thinking`
among the model's capabilities (`POST /api/show`). If the server doesn't echo
`localThink` back on an answer, the run stops.

```
pnpm --filter @flint/parity parity --run <ts> --local-model qwen3.8:27b --local-think off --contestants flint,openai,claude,perplexity --claude-model <the run's claude model> --budget-usd 40
pnpm --filter @flint/parity report --run <ts> --local-model qwen3.8:27b --local-think off
```

What `think` does, on Ollama 0.34.2, for one arithmetic word problem at temperature 0.
That's one prompt: it shows the mechanism, not the quality. Measuring quality is what the
bake-off is for.

| model | `think` omitted | `think: false` | `think: true` |
| --- | --- | --- | --- |
| qwen3.8:27b | thinks: 115 tokens, 2.6s, right answer | no reasoning at all: 9 tokens, 0.3s, **wrong** answer | thinks: 115 tokens, 2.2s, right answer |
| muse-glimmer:30b | thinks: 426 tokens, 14s | no `thinking` field, but still 181 tokens and 6s: it still reasons, and Ollama drops it | thinks: 426 tokens, 14s |
| qwen2.5:7b (live) | no reasoning | identical to omitted | HTTP 400 "does not support thinking" |

The live server's own local brain takes the same flag from `OLLAMA_THINK` (see
apps/server/README.md). Unset, it behaves exactly as before.

**Resume.** Re-run with `--run <ts>` (or a path). Cached successful answers and
verdicts are reused, and failures are retried. That is how you continue after a budget
stop or Ctrl-C.

**Failures.** A prompt Flint fails on (e.g. the local brain is down) is not judged and
not counted as a loss. It's listed in the report so you can fix the cause and resume.

## 3. The judge panel (`--judge-panel`)

A single Claude judge prefers answers written by its own model. Measured on the same 29
sampled pairs of Opus-backed Flint vs GPT-5: the Opus judge said 25-4 for Flint, a GPT-5
judge said 12-15-2, and the two agreed on only 16 of 29.

`--judge-panel anthropic:claude-opus-5-5,openai:gpt-5` has every panelist judge each pair
independently, with the same rubric and prompt as the single judge. Each panelist gets its
own A/B order (seeded from the seed, the pair and the judge, so it is reproducible). The
consensus rule: **a win or loss counts only if every panelist gives it; any disagreement
is a tie (a "split")**. That makes the panel conservative: it only calls a result when
judges from different vendors see it the same way. If any panelist errors, the pair is a
judge error, excluded from the tally and retried on resume, not a tie.

- Each judgment row keeps every panelist's verdict: `panel: [{judge, flintIsA, verdict,
  outcome, reason, costUsd}]`, plus `agreed`. The top-level `verdict`/`outcome` is the
  consensus.
- The rows' `judgeModel` is the panel id, e.g.
  `panel:anthropic:claude-opus-5-5+openai:gpt-5` (members sorted, so the order you list
  them in doesn't matter). Panel and single-judge verdicts therefore never mix in the resume
  cache, the report or `parity_history.csv` (its `judge_model` column holds the panel id).
- The report adds a per-competitor **panel agreement** rate (the share of pairs where all
  panelists agreed) and states the consensus rule.
- Budget: every panelist's call is reserved before any of them runs, and each is settled at
  its real cost. OpenAI panelists get `max(--judge-max-tokens, 16384)` output tokens, since
  GPT-5's reasoning counts against that cap. A pair costs about $0.04 for Opus 5.5 + GPT-5.
- Supported panel providers: `anthropic`, `openai` (keys as above). At least two judges.

Re-judge an existing run with the panel, without re-answering anything:

```
pnpm --filter @flint/parity parity --run 20260924-tiered --judge-only \
  --judge-panel anthropic:claude-opus-5-5,openai:gpt-5 \
  --contestants flint,openai,claude,perplexity --claude-model claude-opus-5-5 --budget-usd 45
pnpm --filter @flint/parity report --run 20260924-tiered --judge-panel anthropic:claude-opus-5-5,openai:gpt-5
```

Add `--flint-local` to both lines to re-judge the local-only answers. `report` defaults to
the judge in `run.json`; pass `--judge-model` or `--judge-panel` to render another judge's
verdicts.

## 4. Read the result

Per competitor, the report shows Flint's W/L/T, its win rate (a tie counts as half, so
50% is parity), the exact two-sided sign test p on decisive games, and a signal using
the same labels as `eval_judge.py`: **SIGNIFICANT** (p < 0.05), **weak** (p < 0.32),
**NOISE** (anything else, or fewer than 4 decisive games). The same breakdown is then
repeated per category. `parity_history.csv` gets one cumulative row per competitor per
invocation that judged something new. For a resumed run, the last row for that `run`
id is the result.

`pnpm --filter @flint/parity report --run <ts>` re-renders a report from the cached
rows without calling anything.

## Caveats (read these before quoting a number)

- **The competitors get no tools.** They answer through the raw APIs with the same
  date and location line Flint gets, but no web search. That's deliberate: "can Flint
  do what ChatGPT with search can't, on Will's systems" is part of parity. It also means
  `research` compares Flint against models that can't look anything up, so it isn't a
  fair comparison with the consumer apps.
- **Memory prompts favour Flint by design.** Questions like "what's my dog's name?"
  need Flint's long-term memory, which the vendors don't have.
- **Self-preference.** The default judge is Claude. The `claude` competitor is also
  Claude, and so is Flint's frontier brain. Quote important results from a
  `--judge-panel` run, not the single judge (see section 3).
- **Prices are list-price estimates** kept in `src/pricing.ts`. Unknown models are
  priced high, so the guard trips early rather than late.

## Tests

```bash
pnpm --filter @flint/parity test        # no network
```

The tests cover category tagging, trivial filtering, dedupe, determinism and
stratification, strict judge parsing (with one retry), position randomization, the
sign test, the budget guard (including under concurrency), pricing, the history CSV,
secrets parsing and token resolution; the panel's consensus rule, per-panelist A/B order,
error and budget handling, and cache separation from single-judge rows; the
local-model contestant's naming, report filename, model-mismatch guard and Ollama check;
and `--local-think`'s naming (unchanged without the flag), request field, echo guard,
flag parsing and the Ollama capability check.
