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
| `runs/<ts>/report.md` | the report (`report-<subject>.md` for `flint-local`, each `--local-model` candidate, each `--local-think` variant and each `--flint-variant`; a `--judge-grounding` judge's is `report+grounded.md` / `report+grounded-<subject>.md`) |
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
| judge | `AnthropicProvider` | `claude-opus-5` (a resumed run keeps its own, see Resume) | `--judge-model` / `PARITY_JUDGE_MODEL` |
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
reason before they answer unless told not to. With thinking on, Ollama returns the
reasoning separately (`message.thinking`), which Flint never reads, and it is most of the
answer time. With it off there is no `thinking` field, but the model can still reason in
the answer itself (see below). `--local-think off` (or `on`) sends `localThink` with the
request, and the server answers with a persona built on an Ollama client that sends that
`think` flag (same 16K context as any candidate). It works only with `--local-model`; on
its own it's an error.
The contestant becomes `flint-local@<name>~nothink` (or `~think`), with its own answers,
verdicts, report (`report-flint-local@<name>~nothink.md`) and history rows. **Without the
flag nothing changes**: no `localThink` is sent, the model thinks by its own default, and
the name stays `flint-local@<name>`. So a run's existing answers for that candidate stay
valid and are never mixed with a think variant. Before sending anything the harness checks
that `/health` has `localThinkOverride: true` and, for `on`, that Ollama lists `thinking`
among the model's capabilities (`POST /api/show`). The server echoes `localThink` as the
`think` the answering persona's Ollama client was built with, not the request's value;
if the echo is missing or different, the run stops.

To compare a variant with the thinking run of the same model, give it the same prompts,
competitors and judge. In `20260924-tiered` the thinking candidates answered
`--limit 100` and were judged only against `openai` by `claude-opus-5-5`:

```
pnpm --filter @flint/parity parity --run 20260924-tiered --local-model qwen3.8:27b --local-think off --limit 100 --contestants flint,openai --judge-model claude-opus-5-5 --budget-usd 5
pnpm --filter @flint/parity report --run 20260924-tiered --local-model qwen3.8:27b --local-think off --judge-model claude-opus-5-5
```

Without `--limit 100` it answers all 300 prompts, and with the default `--contestants`
it judges against all three competitors and re-buys any competitor answer that's missing.
That is about 9x the judging cost (about $13 against about $1.50 per model) and a
result you can't read against the thinking one.

**Check no-think answers for visible reasoning.** With `think: false` a model may do its
reasoning in the answer text. qwen3.8:27b, with a system prompt telling it to lead with
the answer, said "He has 24 sheep", then corrected itself in the answer ("Wait, I made a
calculation error...") and ended at 36. The judge sees that, and so would Will if it went live. Before deciding on
`OLLAMA_THINK=false`, grep the variant's answers in `answers.jsonl` for
`Wait,` / `Let me re-read` / `Correction`, and compare each answer's `usage.output`
tokens with its length. muse-glimmer does the opposite: it still spends tokens reasoning,
but Ollama drops them, so they cost time without showing.

What `think` does, on Ollama 0.34.2, for one arithmetic word problem at temperature 0.
That's one prompt: it shows the mechanism, not the quality. Measuring quality is what the
bake-off is for.

| model | `think` omitted | `think: false` | `think: true` |
| --- | --- | --- | --- |
| qwen3.8:27b | thinks: 115 tokens, 2.6s, right answer | no `thinking` field: 9 tokens, 0.3s, **wrong** answer (on other prompts it reasons in the answer text instead, see above) | thinks: 115 tokens, 2.2s, right answer |
| muse-glimmer:30b | thinks: 426 tokens, 14s | no `thinking` field, but still 181 tokens and 6s: it still reasons, and Ollama drops it | thinks: 426 tokens, 14s |
| qwen2.5:7b (live) | no reasoning | identical to omitted | HTTP 400 "does not support thinking" |

The live server's own local brain takes the same flag from `OLLAMA_THINK` (see
apps/server/README.md). Unset, it behaves exactly as before.

**Persona style variants (`--flint-variant <v>`).** A/B tests a persona style guide
without changing what Will gets. The request carries `styleVariant`, which the server
accepts only with `eval: true` (anything else is a 400), and answers with that variant's
persona: `v1` (today's `FLINT_STYLE_GUIDE`), `v2` (a new frontier persona), `local-v1` (a
compact local guide). The live defaults stay as they are unless `FLINT_STYLE_VARIANT` /
`FLINT_LOCAL_STYLE_VARIANT` are set on the server. It works on its own and with
`--flint-local`, `--local-model` and `--local-think`: the contestant gets `#<v>` appended
(`flint#v2`, `flint-local#local-v1`, `flint-local@muse-glimmer:30b~nothink#local-v1`), so
its answers, verdicts, report (`#` becomes `+`: `report-flint+v2.md`,
`report-flint-local@muse-glimmer_30b~nothink+local-v1.md`) and history rows never mix
with cached ones. **Without the flag nothing changes**: no `styleVariant` is sent and
the name stays as before. Before sending anything the harness checks that `/health`
lists the variant in `styleVariants` (a server without that field predates style
variants, and the run stops with a message saying so). Every reply must echo
`styleVariant` as the variant actually used; a missing or different echo stops the run.
So does any HTTP 400: that's the server refusing the request's shape, which would fail
every prompt the same way.

A fair A/B names both sides, so both are answered fresh by the same server:

```
pnpm --filter @flint/parity parity --run <ts> --flint-variant v1 --contestants flint,openai --judge-panel anthropic:claude-opus-5-5,openai:gpt-5 --budget-usd 30
pnpm --filter @flint/parity parity --run <ts> --flint-variant v2 --contestants flint,openai --judge-panel anthropic:claude-opus-5-5,openai:gpt-5 --budget-usd 30
pnpm --filter @flint/parity report --run <ts> --flint-variant v2 --judge-panel anthropic:claude-opus-5-5,openai:gpt-5
```

**Resume.** Re-run with `--run <ts>` (or a path). Cached successful answers and
verdicts are reused, and failures are retried. That is how you continue after a budget
stop or Ctrl-C. A call cut off by the run stopping (Ctrl-C, or another prompt's fatal
error) is not recorded at all, so it never counts as a failure, only as not asked yet. A resumed run keeps the judge in its `run.json` (model or panel) unless
you pass `--judge-model` or `--judge-panel`, as `report` does, so a later invocation on
the same run can't switch judges by accident.

**Failures.** A prompt Flint fails on (no successful answer after retries: an empty
answer, an HTTP 500, a timeout, the local brain being down) is not judged, so the
head-to-head tally leaves it out. That hides a Flint that often fails to answer, so the
report also shows each contestant's **answer rate** (answered / asked) and, next to the
normal tally, a **strict** line per competitor in which every prompt Flint failed and
the competitor answered counts as a Flint loss. A competitor's failures are not counted
as Flint wins, so the strict line is a lower bound for Flint. `report` gives a strict
line against each competitor the subject was judged against, and against any that
answered only prompts the subject failed (nothing to judge, so a candidate that failed
everything still shows 0-N); a competitor the subject answered alongside but was never
judged against (a later candidate run against fewer competitors) is left out. Failures
are listed in the report so you can fix the cause and resume.

A prompt no model answered is a failure too: when every tier refuses or comes back empty,
the server sends an honest fallback message ("I can't get you an answer on that one: ...")
and marks the eval response `unanswered: "refusal" | "empty"`. The harness records that
as a failure (`flint did not answer (unanswered=...)`), exactly as the empty reply it
replaced was recorded in earlier runs, and the report counts how many failures it was.

**Compare answers from the same server build.** Answers are cached per contestant
name, not per server build. Resuming an older run's `flint` on a newer server only
re-asks the prompts that failed, so the run ends up mixing two builds' answers (in
`20260924-tiered`, that would be ~11 refused prompts retried on a server with the
refusal fallback and `calculate`, next to 289 cached answers from the old one). To
measure a server change, answer every prompt on the new build: a fresh run, or a fresh
Flint contestant name in the existing run (e.g. a `flint#v1` baseline, once
`--flint-variant` exists), never a resume of the old `flint` answers.

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

## 4. Judge grounding (`--judge-grounding`)

The judge sees two answers and nothing else. When Flint states a fact it read from
long-term memory or a tool result (the dog's name, a Vantage score, today's calendar),
the judge can't tell it from an invention, and the rubric calls fabricated specifics a
severe failure. With `--judge-grounding` the judge (or every panelist) also sees what
Flint's answer was grounded on, in the user message between the request and the
answers: "Context Flint had access to (the other assistant did not)", the recalled
memory and each tool result (name, ok/error, the first 800 characters), with the
instruction that a fact this context supports is not a fabrication. It doesn't say which
slot is Flint's. The system prompt and rubric are unchanged, and **without the flag the
judge prompt is byte-for-byte what it was**.

- Where it comes from: every eval `/generate` response now carries
  `grounding: { memory: string[], tools: [{ name, isError, excerpt }] }` (the facts
  injected into that turn's context, and its tool results; see
  apps/server/src/grounding.ts). The harness stores it on the answer row
  (`answers.jsonl` `grounding`) whether or not the judge uses it. The tool results are
  the ones that turn produced, and only those: the server files each action-log entry
  under the /generate turn whose async context produced it (`TurnLog`), so a request
  running at the same time (another eval answer, a second harness, Will chatting) never
  adds its own. (The response's older `tools` list still reads the shared log, so keep
  `--flint-concurrency 1` if you rely on it.)
- Grounded verdicts carry the judge id plus `+grounded` (`claude-opus-5-5+grounded`,
  `panel:anthropic:claude-opus-5-5+openai:gpt-5+grounded`), so they never share a resume
  cache entry, a report or a `parity_history.csv` row with ungrounded ones. The report
  is `report+grounded.md` (`report+grounded-<subject>.md` for another subject, e.g.
  `report+grounded-flint+v2.md`), next to the ungrounded one. A new run started with the
  flag records that id in `run.json`, and a resumed run keeps it.
- A cached Flint answer with no `grounding` (answered by a server before this) is not
  judged grounded: its pairs are skipped and counted in the report's notes. Answer again
  in a new run, or under a `--flint-variant` name, to judge those prompts grounded.
- When answering, a server that sends no `grounding` stops the run (it predates it).
- `report --judge-grounding` renders the grounded verdicts of the chosen judge.
- **Privacy:** the context goes to every judge, including OpenAI in a panel, and tool
  excerpts can contain email, calendar or Drive text. The flag is opt-in for that reason.

```
pnpm --filter @flint/parity parity --run <ts> --flint-variant v2 --judge-grounding --contestants flint,openai --budget-usd 30
pnpm --filter @flint/parity report --run <ts> --flint-variant v2 --judge-grounding
```

## 5. Read the result

Per competitor, the report shows Flint's W/L/T, its win rate (a tie counts as half, so
50% is parity), the exact two-sided sign test p on decisive games, and a signal using
the same labels as `eval_judge.py`: **SIGNIFICANT** (p < 0.05), **weak** (p < 0.32),
**NOISE** (anything else, or fewer than 4 decisive games). Next to it, the strict line
counts Flint's failures as losses (see Failures above), and the contestants table shows
each one's answer rate. The same breakdown is then repeated per category. `parity_history.csv` gets one cumulative row per competitor per
invocation that judged something new. For a resumed run, the last row for that `run`
id is the result.

`pnpm --filter @flint/parity report --run <ts>` re-renders a report from the cached
rows without calling anything.

## search-compare: is keyless search good enough?

`web_search` can fall back to a local SearXNG (`SEARCH_PROVIDER=auto`, see
[packages/mcp/README.md](../../packages/mcp/README.md#web-search-metered-keyless-or-both)).
Before leaning on it harder, measure it. For each prompt, `search-compare` takes the top 5
from the metered provider and from SearXNG, through the same code `web_search` runs. A cheap
judge then decides which **result set** better supports answering the prompt: relevance,
authority, currency, coverage. The sets go in seeded-random A/B slots, and ties are allowed.

```bash
pnpm --filter @flint/parity search-compare --dry-run                   # prompts + worst-case spend, no calls
pnpm --filter @flint/parity search-compare --limit 3 --budget-usd 0.25  # smoke
pnpm --filter @flint/parity search-compare --budget-usd 1               # all research prompts (25 today, ≈ $0.43 worst case)
pnpm --filter @flint/parity search-compare --query "..." --query "..."  # your own list
```

| flag | default | |
| --- | --- | --- |
| `--prompts` / `--category` | `~/.flint/eval/parity_prompts.jsonl` / `research` | read only; `--category all` for every prompt |
| `--budget-usd` | `1` | hard cap on metered searches + judge; every paid call is reserved first |
| `--judge-model` | `claude-haiku-4-5` (`SEARCH_COMPARE_JUDGE_MODEL`) | e.g. `claude-sonnet-5` |
| `--provider` | from the key's config | `tavily` or `brave` |
| `--search-cost-usd` | tavily `0.008`, brave `0.005` | per successful metered search; a rejected one (quota, bad key) is free |
| `--searxng-url` | `$SEARXNG_URL` or `http://127.0.0.1:8888` | checked with `/healthz` before anything is spent |
| `--results` / `--seed` / `--concurrency` | `5` / `1` / `2` | |
| `--include-answer` | off | also show each engine's synthesized answer (Tavily's `answer`) to the judge |
| `--out` | none | append the rows as JSONL |

Keys come from `ANTHROPIC_API_KEY` (env or `~/.flint/secrets.env`) and `SEARCH_API_KEY`
(env, else the `web` server's env in `~/.flint/mcp.json`, which is what Flint runs with).
It only reads those files and never prints a key. The provider is placed as `web_search`
places it: `--provider`, `SEARCH_KEY_PROVIDER` or an explicit `SEARCH_PROVIDER`, checked
against the key's prefix. The output is a per-prompt table (latency, shared URLs, winner,
the judge's reason with the A/B layout) plus totals: wins, ties, forfeits, availability, a
sign test, mean latency, and spend split into searches and judge.

A side that searched and found nothing **forfeits** without a judge call. A side whose
search **failed** makes the row **unavailable**, with no winner. That covers a refused or
spent key, a rate limit, a timeout, and SearXNG's engines all blocked. A failure says nothing
about the other side's result quality, so these rows are left out of the wins and the sign
test. The **Availability** line reports how often each side failed. If the provider's key is
refused or over quota, the run stops at the first prompt with `provider key unusable: nothing
to compare`, having charged nothing. If the key runs out partway, the report covers the rows
judged before that.

By default the judge sees sources only. Tavily's synthesized `answer` is part of what the
local model reads from `web_search`, and SearXNG rarely has one, so `--include-answer`
measures that too.

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
- **One server build per comparison.** A win rate only compares with another from the
  same server build and prompt set (see "Compare answers from the same server build").

## Tests

```bash
pnpm --filter @flint/parity test        # no network
```

The tests cover category tagging, trivial filtering, dedupe, determinism and
stratification, strict judge parsing (with one retry), position randomization, the
sign test, the budget guard (including under concurrency), pricing, the history CSV,
secrets parsing and token resolution; the panel's consensus rule, per-panelist A/B order,
error and budget handling, and cache separation from single-judge rows; which judge a
run uses (flags, then a resumed run's own, then the defaults); the
local-model contestant's naming, report filename, model-mismatch guard and Ollama check;
`--local-think`'s naming (unchanged without the flag), request field, echo guard,
flag parsing and the Ollama capability check; `--flint-variant`'s naming alone and with
the local flags, report filename, request field, echo guard, HTTP 400 stop and `/health`
preflight (with a stub fetch); answer rates and the strict tally, including `report`'s
for a subject that failed everything; and judge grounding (parsing, the unchanged default
prompt, the grounded prompt, panel pass-through, the `+grounded` judge id, its cache
separation and report file, and resume behaviour). The steps `run` wires together are
tested through a recording judge (src/steps.ts): which pairs a grounded judge skips,
that it is shown the context and called and priced as the real model, never the
`+grounded` id, that an interrupted call is not recorded as a failure, and the Flint
preflight; and an `unanswered` reply recorded as a failure, not judged, and counted in the report.
