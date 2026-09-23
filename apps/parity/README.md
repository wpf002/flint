# @flint/parity: the parity eval

Is Flint as good as ChatGPT, Claude and Perplexity on the things Will actually asks
him? `apps/train/mlx/eval_judge.py` can't answer that: it compares a fine-tuned model
with its own base. This package runs Flint **end to end** (router, persona, memory,
tools) against the vendors' strong general models on a frozen set of Will's real
prompts. A Claude judge compares each pair blind, and the result gets a sign test so a
coin flip doesn't read as progress.

Everything it writes lives under `~/.flint/eval/`:

| path | what |
| --- | --- |
| `parity_prompts.jsonl` (+ `.meta.json`) | the frozen prompt set |
| `runs/<ts>/answers.jsonl` | every answer from every contestant (the resume cache) |
| `runs/<ts>/judgments.jsonl` | every judge verdict, with its reason |
| `runs/<ts>/report.md` | the report |
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
concurrency. `--flint-concurrency 1` stays at 1 so the tools reported for each Flint
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

**Resume.** Re-run with `--run <ts>` (or a path). Cached successful answers and
verdicts are reused, and failures are retried. That is how you continue after a budget
stop or Ctrl-C.

**Failures.** A prompt Flint fails on (e.g. the local brain is down) is not judged and
not counted as a loss. It's listed in the report so you can fix the cause and resume.

## 3. Read the result

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
  Claude, and so is Flint's frontier brain. Cross-check important results with a
  non-Claude judge when one is wired, or at least with a different Claude tier.
- **Prices are list-price estimates** kept in `src/pricing.ts`. Unknown models are
  priced high, so the guard trips early rather than late.

## Tests

```bash
pnpm --filter @flint/parity test        # no network
```

The tests cover category tagging, trivial filtering, dedupe, determinism and
stratification, strict judge parsing (with one retry), position randomization, the
sign test, the budget guard (including under concurrency), pricing, the history CSV,
secrets parsing and token resolution.
