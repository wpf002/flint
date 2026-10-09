# Hosted Flint (server)

The always-on shared Flint service. Wraps the Flint client (with the Flint
persona) behind an authenticated HTTP/SSE API so your apps and devices talk to
**one** Flint. Provider/memory/tools come from env — the same image runs with
Anthropic (cloud) or a remote Ollama (rented GPU). The local model never moves
here; Railway has no GPU.

## Endpoints

| Method | Path | Auth | Body | Returns |
| --- | --- | --- | --- | --- |
| GET | `/health` | no | — | `{ ok, provider, model, tools, servers, evalMode, styleVariants, groundingCharsMax, evalDiscovery, evalRecallOverride, … }` |
| POST | `/generate` | yes | `{ prompt }` | `{ text, usage, reason }` |
| POST | `/generate` (eval) | yes | `{ prompt, eval: true }` | `{ text, usage, reason, brain, model, styleVariant, tools, grounding, proposed, eval, costUsd, costByVendor, paidCalls, budgetBlocked? }` — not logged to the training corpus, no `remember`, proposals auto-rejected (used by `apps/eval`). `costUsd` is what the replay's paid calls cost (every model pass and fallback attempt, the research planner, paid searches; see "Spend caps"), and error responses (500 / 502 / 503) carry it too; `budgetBlocked` lists the paid tools refused because Flint's own cap for them is spent. `grounding` is `{ memory: string[], tools: [{ name, isError, excerpt }] }`: the long-term facts recalled into that turn and its own tool results, never a concurrent turn's (each excerpt at most 800 chars), for apps/parity `--judge-grounding` (src/grounding.ts). Normal responses never carry it. |
| POST | `/generate` (eval, style variant) | yes | `{ prompt, eval: true, styleVariant: "v2" }` | as above, answered with that style guide; `styleVariant` echoes the variant of the persona that answered, read from its own guide (not from the request). Unknown variant, or no `eval: true`: 400. `/health` lists the known ones as `styleVariants` (used by `apps/parity --flint-variant`) |
| POST | `/generate` (eval, longer excerpts) | yes | `{ prompt, eval: true, groundingChars: 16000 }` | as above, with each `grounding` tool excerpt cut at `groundingChars` instead of 800, echoed as `groundingChars`. An integer from 800 to `/health`'s `groundingCharsMax` (32000); otherwise, or without `eval: true`, 400. Used by apps/parity `tasks`, which hands competitors the data Flint read (src/eval-tools.ts) |
| POST | `/generate` (eval, no memory) | yes | `{ prompt, eval: true, recall: false }` | as above, answered without reading long-term memory (`grounding.memory` is empty), echoed as `recall: false`. A boolean; otherwise, or without `eval: true`, 400. Used by apps/parity `tasks` on every task whose point isn't memory: the frontier competitors get exactly Flint's data, which leaves Will's memory out (src/eval-tools.ts) |
| GET | `/eval/tools` | yes | — | `{ tools: string[] }`: every wired tool's name, so apps/parity `build-tasks` can check its templates' expected tools |
| POST | `/eval/tool` | yes | `{ eval: true, name, args? }` | `{ ok, name, isError, text }`: runs ONE tool from a fixed read-only discovery allowlist (`DISCOVERY_TOOLS` in src/eval-tools.ts: `meridian.list_tickers`, `vantage.top_scores`, `bellwether.list_industries`, …) to fill apps/parity task slots. Any other tool is a 403 before any handler runs, so it can't write or create a proposal; 404 if the tool isn't wired, 502 if it throws. Audited in the action log |
| POST | `/chat` | yes | `{ conversationId, message }` | SSE stream of `StreamEvent`s |
| GET | `/spend` | yes | — | Paid API spend today and this month per vendor, against the caps (see "Spend caps") |
| GET | `/inbox?lane=relevant\|quiet&before=<ISO>&limit=1..100` | yes | — | A page of the runtime's triage decisions, newest first (`InboxPage` in @flint/policy: `{ items, next }`; `next` is the `before` of the older page). See "The runtime's lanes" |
| POST | `/inbox/:id/feedback` | yes | `{ feedback: "should_escalate" \| "should_be_quiet" \| "ok" }` | `{ ok: true }`: Will's label on a decision |
| POST | `/escalations/:id/ack`, `/escalations/:id/dismiss` | yes | — | `{ ok: true }` |
| GET | `/runtime/health` | yes | — | The runtime's health report (`HealthReport`) |

Auth: send `Authorization: Bearer $FLINT_TOKEN` on everything but `/health`.

When no frontier tier answers (each one refused or came back with no text and no tool
call), `/generate` returns a short honest message as `text`; in eval mode the response
also carries `unanswered: "refusal" | "empty"`, so apps/parity records the prompt as a
failure instead of judging that message as an answer.

```bash
curl -s $URL/health
curl -s -X POST $URL/generate -H "Authorization: Bearer $FLINT_TOKEN" \
  -H 'Content-Type: application/json' -d '{"prompt":"status?"}'
```

## Environment

| Var | Required | Purpose |
| --- | --- | --- |
| `FLINT_TOKEN` | **yes** | Bearer token clients must send. Server refuses to start without it. |
| `ANTHROPIC_API_KEY` | one provider | Use Anthropic (model via `FLINT_MODEL`, default `claude-sonnet-4-6`). |
| `OLLAMA_MODEL` + `OLLAMA_HOST` | one provider | Use a remote Ollama (e.g. a rented GPU). Takes precedence over Anthropic. |
| `OLLAMA_THINK` | no | `true` or `false`: Ollama's `think` flag for the local brain. `false` stops a thinking model (qwen3.8, muse-glimmer) reasoning before it answers, which is most of its answer time. It may still reason in the answer text itself (qwen3.8 sometimes self-corrects there, visibly), so check a no-think bake-off's answers before setting it live (apps/parity README). Unset, or any other value, sends no flag: the model's default, as before. Don't set `true` on a model that can't think: Ollama rejects every turn with a 400 (qwen2.5 says "does not support thinking"). `false` is harmless there. |
| `FLINT_STYLE_VARIANT` | no | The frontier tiers' style guide: `v1` (`FLINT_STYLE_GUIDE`, today's), `v2` (`FLINT_STYLE_GUIDE_V2`) or `local-v1` (`FLINT_LOCAL_STYLE_GUIDE`). Unset: `v1`, as before. An unknown value is logged and ignored (`v1`). Set a variant live only after a judged parity A/B (`--flint-variant`) shows it wins. |
| `FLINT_LOCAL_STYLE_VARIANT` | no | The same, for the local brain and the eval `localModel` override personas. Unset: `v1`, as before. |
| `FLINT_HISTORY_TURNS` / `FLINT_HISTORY_MAX_AGE_HOURS` | no | How much of a `/chat` conversation each new message carries: the last `FLINT_HISTORY_TURNS` complete turns (default 12) that started within `FLINT_HISTORY_MAX_AGE_HOURS` (default 48), whichever leaves fewer. Every turn stays stored in `~/.flint/memory/conversations.json`, and the memory extractor still reads all of them, but it keeps only durable facts about Will: what was said or decided in an older turn doesn't come back. So when turns are left out, the turn's context says how many, and the persona tells Flint to say so rather than reconstruct them. The tier classifier's "deep thread" rule counts the turns sent (8 or more). `0` means no earlier turns; anything that isn't a number >= 0 is logged and ignored (the default). |
| `FLINT_MEMORY_BRAIN` / `FLINT_MEMORY_MODEL` | no | Which model learns from Will's chats, and which local model it uses: see "Memory extraction". Unset: the local model, `OLLAMA_MODEL`. |
| `MCP_CONFIG` | no | Path to an `mcp.json` of integration servers (your apps as tools). |
| `FLINT_TIER_LAST_RESORT` | no | `provider:model` (e.g. `openai:gpt-5`) tried after every frontier tier. A refused or empty frontier reply (no text, no tool call) moves down the tier chain like an error; the Claude tiers refuse the same prompts, so this is where a refusal can still get answered. Unset: no extra link, and a reply no tier answers becomes a short honest message instead of an empty one. Ignored with `FLINT_TIERS=off`. |
| `FLINT_WORLD_NOW` | no | `1` adds the "World now" block to frontier chat turns (see "The runtime's lanes"); it costs tokens on every such turn. Unset: off. |
| `FLINT_WATCHER` | no | `off` (or `0`, `false`, `no`) turns off the proactive Watcher, which only ever had the calendar check (through Trident's Google tools) and the opt-in Bellwether one. Set it only once the runtime's `google_calendar` source is live and its heads-ups are actually delivered: triage on and P2's promotion table signed (apps/runtime/README.md, "Your calendar", step 5). Those heads-ups keep titles out of notes. The server reads it at start, so run `launchctl kickstart -k gui/$(id -u)/com.flint.server` after setting it. Unset: on. `FLINT_WATCH_MS` sets its interval (default 30 minutes); `FLINT_WATCH_SIGNALS=1` adds the Bellwether check. |
| `FLINT_NTFY_TOPIC` | no | The ntfy.sh topic the phone subscribes to. Every phone push is the same content-free ping (`PHONE_PING` in src/notifications.ts): the words stay in the console. Unset: no pings. |
| `PORT` | no | Injected by Railway. |

## Memory extraction

Flint reads back over its own conversations and writes the durable facts about Will
to long-term memory (`~/.flint/memory/knowledge.json`), through the same store as the
`remember` tool, so dedupe, facts Will rejected and the filters for expiring details
all apply. The pass is `src/memory-extract.ts`; the choice of model is
`src/memory-brain.ts`.

- **It runs on the local model.** By default it asks the local Ollama model, the chat
  brain's own: `OLLAMA_MODEL` at `OLLAMA_HOST`, with the same `OLLAMA_NUM_CTX`, so
  Ollama never reloads the model between Will's chat and a pass. No outside AI and no
  API key: it runs with no Anthropic key at all. An Ollama cloud model (`...-cloud`,
  `:cloud`) runs off this Mac, so it is never used, and an `OLLAMA_MODEL` that is one
  gets a warning at boot. The reply is held to a JSON schema, `think` is off, and each
  call is sized to fit the model's context window. One more cost: a pass can push the
  chat's cached prompt out of Ollama's memory, so Will's first message after a pass
  may take a few seconds longer to start.
- **Will's chat comes first.** Before every call a pass checks for a `/chat` turn
  running, or one that ended less than 2 minutes ago, and if so tries again in 2
  minutes. A call already running is cut off the moment a turn starts. Waiting moves
  nothing and costs none of the day's calls.
- **Every fact quotes Will.** Each fact the model proposes carries `quote`: the words
  of Will's it rests on. It is stored only if that quote is in what Will wrote in the
  turns it was given, as whole words, and that turn's words also hold at least half of
  what the fact says (so "is my Mac Studio fast enough" can't ground "Will's Mac Studio
  has 192GB of unified memory"). A quote found only in Flint's answers, or nowhere,
  drops the fact. The match ignores typography only (curly quotes, dashes, spacing,
  capitals); a word added, dropped or changed fails it.
- **Only a shown fact can be replaced.** A new fact may retire an old one only if the
  model was shown that old fact in this call, and the two share a content word.
- **A failure keeps its place.** A reply that isn't the schema (bad JSON, a missing
  field), an error the server answered with (a 5xx, or a 4xx other than 404 and 429)
  or a timeout is a strike: the turns are retried, and a batch with 3 strikes in a row
  is skipped, so one batch that always fails can't hold up the rest. A reply cut off at
  its token limit is asked again with half the turns; only a single turn still cut off
  is a strike. No answer at all (Ollama down, the model not pulled, 429) is no strike
  and costs none of the day's calls. Any failure but a bad reply backs the next pass
  off: 15 minutes, doubling, up to 6 hours.
- **Logs carry ids and counts only**, never a fact, a quote or anything Will or Flint
  said. The boot log names the model (`[memory-extract] on the local model ...`), and
  each pass logs one line of counts.

| Var | Default | Purpose |
| --- | --- | --- |
| `FLINT_MEMORY_BRAIN` | `local` | `local`; `frontier`: the primary frontier tier, metered as `extract` and paused with other background work at 80% of its vendor's cap. Only when set, and never a fallback: with no frontier configured nothing runs, and a local model that is down is not replaced by the frontier. `off`: no extraction. Anything else is logged and read as `local`. |
| `FLINT_MEMORY_MODEL` | `OLLAMA_MODEL` | Another local model for extraction. One that isn't the chat brain's is unloaded after each request (`keep_alive: 0`), so it never holds memory the chat model needs, at the price of a load per call. A cloud model is refused. |
| `FLINT_EXTRACT_MAX_CALLS_PER_DAY` | 48 local, 24 frontier | Calls per UTC day: GPU time on the local model, dollars on the frontier. |
| `FLINT_EXTRACT_BATCH_CHARS` | 8,000 local, 24,000 frontier | Characters of transcript per call, at most (a small context window allows fewer). |
| `FLINT_EXTRACT_INTERVAL_MS` / `FLINT_EXTRACT_BACKLOG_INTERVAL_MS` | 6 hours / 15 minutes | Time between passes, and while a backlog remains. |
| `FLINT_EXTRACT_MAX_TURNS` | 60 | Turns per pass. |
| `FLINT_EXTRACT_SKIP_CONVERSATIONS` | `^(bulk\|grow\|seed)-` | Conversations never read: synthetic training traffic. |

## Spend caps

Every paid call Flint makes is appended to `~/.flint/spend/spend-YYYY-MM.jsonl`, one
JSON row per call: `{ ts, vendor, model, kind, usd, tokens? }`, where `kind` is `chat`,
`extract` (memory extraction on the frontier), `plan` (deep_research's query planner), `tts`,
`tool-search` (Tavily), `tool-perplexity` or `eval` (a parity replay). Totals per
vendor per day and per month (days end at midnight in `FLINT_USER_TZ`, default
America/Chicago) are rebuilt from the current month's file on boot, so a restart never
resets a cap.

What is recorded, and how it is priced (the price table is `packages/core/src/pricing.ts`,
shared with apps/parity):

- **Frontier model calls** (Anthropic, and OpenAI / Perplexity when a tier uses them): one
  row per provider pass, from the usage the provider reports. So every tool-loop
  iteration, retry, answer-only call and fallback tier's attempt is its own row. A stream
  cut off part way (a closed tab, a timeout, an error mid-answer) is still billed by the
  vendor for its full input and the output so far, and is recorded at that usage (Claude;
  the OpenAI adapter reports none, so a cut-off OpenAI stream is not counted). A request
  that failed before reaching the model was not billed and is not recorded. The local
  brain (Ollama) is free and never recorded.
- **Memory extraction and the research planner**: the same, tagged `extract` / `plan`.
  Extraction is billed only when Will opts it onto the frontier (`FLINT_MEMORY_BRAIN=frontier`):
  on the local model, the default, it is free and never recorded.
- **TTS** (`/speak`): per character sent, at the model's list price (`tts-1`: $15 / 1M).
- **Perplexity and Tavily searches** run in the MCP processes, so their usage never reaches
  the server: each SUCCESSFUL call of `trident.perplexity_search`, `web.web_search` or
  `trident.web_search` is recorded at a per-call estimate, `FLINT_PERPLEXITY_USD_PER_CALL`
  (default $0.008: sonar's $0.005 low-context fee plus ~1-3K tokens) and
  `FLINT_TAVILY_USD_PER_CALL` (default $0.008, one credit; an advanced search is two).
  deep_research's searches go through the same wrapped tools, so they count too.

| Var | Default | Purpose |
| --- | --- | --- |
| `FLINT_BUDGET_ANTHROPIC_DAILY_USD` / `_MONTHLY_USD` | unset (no cap) | Claude spend caps |
| `FLINT_BUDGET_OPENAI_DAILY_USD` / `_MONTHLY_USD` | unset | OpenAI (TTS, any OpenAI tier) |
| `FLINT_BUDGET_PERPLEXITY_DAILY_USD` / `_MONTHLY_USD` | unset | `perplexity_search` (and a Perplexity tier) |
| `FLINT_BUDGET_TAVILY_DAILY_USD` / `_MONTHLY_USD` | unset | `web_search` |
| `FLINT_PERPLEXITY_USD_PER_CALL`, `FLINT_TAVILY_USD_PER_CALL` | $0.008 each | per-call estimates above |

An unset cap is no cap: exactly what Flint did before. `0` is a real cap (the kill
switch: never call that vendor). A value that isn't a dollar amount is logged and ignored.
The boot log prints the caps in force (`[spend] caps: ...`).

**Background kinds** (Machine plan 3.0.8). The runtime holds no vendor keys; when it wants a
frontier call it asks the server's internal listener (`POST /internal/complete`, `[::1]:8081`),
under one of four kinds, each with its own caps:
`FLINT_BUDGET_KIND_<RUNTIME|REVIEW|DISPATCH|SELFMOD>_DAILY_USD` / `_MONTHLY_USD`. Unlike a vendor
cap, **unset is $0**: background spend is off until both periods are raised (the boot log prints
them as `[spend] background kinds: ...`). A call is refused (402 with a `reason`) when its kind's
spend plus the call's estimate would pass either cap (`kind_cap`), when its vendor is at 80% of
Flint's own cap (`vendor_cap`), or on the runtime's unified view of the vendor (every account's
spend): missing (`unified_missing`), older than 2 h (`unified_stale`), at 70% of Flint's cap
(`unified_70`), or when Flint has no cap for that vendor to hold it against (`vendor_uncapped`).
Otherwise a durable audit intent is written first (if it can't be, nothing runs), the call is
made on the routine tier with no tools, metered in the ledger under its kind, and its outcome
audited with the cost. One call at a time; every refusal is audited.

**Recommended values** (in `~/.flint/secrets.env` or the LaunchAgent's env; tune after a
couple of weeks of `/spend`):

```bash
FLINT_BUDGET_ANTHROPIC_DAILY_USD=20     # roughly 150-400 Opus 5.5 turns; degrades at $16
FLINT_BUDGET_ANTHROPIC_MONTHLY_USD=300
FLINT_BUDGET_OPENAI_DAILY_USD=3         # TTS is ~$0.015 a spoken minute on tts-1
FLINT_BUDGET_OPENAI_MONTHLY_USD=30
FLINT_BUDGET_PERPLEXITY_DAILY_USD=1.50  # ~190 searches
FLINT_BUDGET_PERPLEXITY_MONTHLY_USD=20
FLINT_BUDGET_TAVILY_DAILY_USD=1         # ~125 basic searches
FLINT_BUDGET_TAVILY_MONTHLY_USD=8       # = Tavily's 1,000 free credits; on a paid plan use credits x $0.008
```

**How Flint degrades** (a cap is the daily or the monthly one, whichever is closer to spent;
every decision is made before a call, so a turn already streaming always finishes):

| Level | Frontier (Claude) | Background work | Searches | Voice |
| --- | --- | --- | --- | --- |
| under 50% / 50% | unchanged | unchanged | unchanged | unchanged |
| 80% | standard, hard and code questions answer on the **routine** tier (only when that is a different, cheaper brain; not when it can't read the turn's image/PDF) | memory extraction on the frontier and research query planning wait (planning falls back to heuristic queries) | unchanged | unchanged |
| 100% | Claude is not called. The next brain in the chain whose vendor has budget answers (e.g. an OpenAI `FLINT_TIER_LAST_RESORT`); with none left, the **local brain** answers, and the first such answer in each `/chat` conversation each day (every `/generate` answer) ends with `(Running on my local brain — today's Claude budget is spent.)` (or "this month's"); the note is shown, never stored as the answer. An image/PDF turn gets a 422 saying why instead of a blind answer | paused | the spent tool returns an error naming only alternatives that are wired and still have budget (`perplexity_search` → `web_search`; `web_search` → `perplexity_search`; plus `fetch_url` on a keyless search page when it is wired). With both spent it says paid search is off and points at the keyless fetch, or, without one, tells the model to answer from what it knows and say live search is unavailable | OpenAI spent: `/speak` returns 503 `{ budget: true, fallback: "browser" }` and the console speaks with the browser's voice |

The same levels apply per vendor to any tier on that vendor. Responses say when the guard
changed a turn: `/generate` adds `budget: "degraded" | "exhausted"` (and `degradedFrom`), and
the `/chat` `meta` event carries the same fields. All of it is decided per turn by one tested
function (`budgetTurn` in `src/spend.ts`); index.ts only applies it.

Without `OLLAMA_MODEL` the "local" brain is itself Claude (`FLINT_MODEL`). It is then held to
Claude's cap like the tiers: once Claude's budget is spent, a turn that would land on it gets a
503 saying so (and naming the cap) instead of calling Claude past its cap, and the budget note
names the brain that actually answers when it isn't the free local one.

**Evals.** A parity replay (`/generate` with `eval: true`) is routed as if uncapped, and runs in
its own spend scope (`TurnSpend`): every paid call made inside it, model passes, fallback
attempts, the research planner and Perplexity / Tavily searches alike, is recorded as an `eval`
row that does NOT count toward these caps, and the response reports the total as `costUsd`,
whether the replay answered, came back `unanswered`, or failed. The parity harness charges
exactly that to its own shared daily budget (`PARITY_DAILY_BUDGET_USD`, apps/parity README), so
each dollar sits under exactly one cap. A paid search is still refused inside an eval when
Flint's own cap for it is spent (a `$0` kill switch holds for evals too); the response then lists
it in `budgetBlocked`, and parity doesn't judge that answer. A client that hangs up (parity's
timeout, a stopped run) cancels the turn, as `/chat` does, so an abandoned replay stops spending.

**Visibility.** `GET /spend` returns
`{ timeZone, day, month, thresholds, vendors: { anthropic: { name, today: { usd, capUsd, pct, evalUsd, calls }, month: {...}, fraction, level, binding, effect }, openai, perplexity, tavily } }`.
Flint can answer it himself through the read-only `spend_status` tool (appended by the tool
router when a question is about spend, credits or budgets). The notifications feed gets one
notice per vendor per cap per period at 50%, 80% and 100% (the phone, if `FLINT_NTFY_TOPIC`
is set, gets only the content-free ping), and the runtime gets a `spend.threshold` event for
each notice that is new (never for one re-raised at boot).

**Not covered here:** anything that calls a paid API outside this server: the Python
training scripts (`apps/train/mlx/bulk_seed.py`, `auto_grow.py`, `eval_judge.py` call
Anthropic directly; their `/chat` traffic to Flint IS counted), apps/ask, apps/responder
and trident's own tools other than its searches.

**Model choice (the Railway tradeoff):** Railway can't run the local 14B model.
Pick one — `ANTHROPIC_API_KEY` (fast, always-on, cloud-backed) **or** point
`OLLAMA_HOST` at a rented GPU box running your model. Swappable any time; it's
just env.

## Route log

Every message answered through `/chat` or `/generate` writes one `[route]` line to the
server log (`~/.flint/server.err.log` on the Studio): the tier it was sorted into, what
moved it off the tier its words alone get (`movedBy`: `tools` when an appended tool is a
confident match, `deep thread` past `LONG_CONVERSATION` turns), each appended tool with its
similarity score, the tier the spend plan actually ran when a budget stepped it
down (`planTier`), who answered (`answeredBy`, only when the outcome is `answered`; otherwise
`tried` names the last brain asked), how many tiers declined first (`declined`), the outcome
(`answered`, `unanswered` for the honest no-answer message, `empty`, `error`, `aborted` when the
client hung up) and the time taken. It never holds the message, the conversation or anything
the user wrote.

```
[route] {"ts":"2026-09-30T14:00:00.000Z","path":"chat","tier":"standard","movedBy":"tools","appended":[{"name":"nexus.thread_list","score":0.843}],"turns":2,"brain":"frontier","answeredBy":"anthropic:claude-opus-5-5","outcome":"answered","ms":1840}
```

Tools are offered above the router's floor (`FLINT_TOOL_FLOOR`, 0.55), but a tool only moves
a routine one-liner to the standard tier when it scores at least `FLINT_TIER_TOOL_SCORE`
(default 0.65). On 2026-09-30, unrelated tools just over the floor reached greetings
(`spend_status` at 0.602 for "How are you doing today Flint?") and sent them to Opus. A real
ask can score as low (0.603 for "How much have I spent on Claude today?"), so the floor stays
low and the tool is still offered; only the tier waits for a clear match.

To count tiers: `grep '^\[route\]' ~/.flint/server.err.log | cut -c9- | jq -r .tier | sort | uniq -c`.

A frontier `/chat` turn that carried the "World now" block also has `ctxTokens: { world: n }`,
the block's estimated tokens (plan 3.0.8: chat overhead is measured).

## The runtime's lanes

With the runtime installed (`~/.flint/tokens/runtime.token`), the server and the runtime talk
both ways (Machine plan P2):

- **Events** (src/runtime-events.ts): each `/chat` turn's brain, outcome, tool names, time and
  taint (`chat.turn`), each new spend threshold notice (`spend.threshold`) and each 5xx answer
  (`route.error`) go to the runtime's `POST /v1/events`: ids, enums and numbers only, never
  text, and nothing for an eval replay. They are spooled in `~/.flint/spool/events.jsonl`
  (0600, 2 MB) and shipped every 15 s, so a runtime that is down loses nothing.
- **World now** (src/world-now.ts): frontier `/chat` turns get a short block from the runtime's
  `GET /v1/world/now` in their per-turn context: each service by its ref (`service#24ehza`, and
  its name when it is a plain identifier) and health, counts, open escalations. At most 1,600
  characters and 400 tokens, 300 ms to answer, cached 30 s, never older than 5 minutes, never
  any text marked tainted, never stored in the conversation. Local turns go without (their
  prompt is already at its limit).
- **Internal listener** (`[::1]:8081`, the runtime's token): `/internal/notify` (a note in the
  console; `channels` adds a banner and the content-free phone ping, always with the in-app
  note; a resent `ref` is a duplicate), `/internal/load` (`/chat` turns in flight: triage
  yields to them), `/internal/complete` (see "Spend caps"), `/internal/spend-external`.
- **The console's Activity panel** (the bell): the relevant and quiet lanes, shown as the
  Important and Other tabs, page by page. Each decision has its escalation, an Outside Text mark
  when tainted, and two labels: Correct, plus Not Important (in Important) or Important (in
  Other), stored as ok, should_be_quiet and should_escalate. Acknowledge and Dismiss sit on an
  open escalation. The runtime's health report is under Settings → Health. Through the routes in the table above (src/inbox-routes.ts), which check what the
  console sends and what the runtime answers against @flint/policy's wire contracts; a runtime
  that refuses the server's token is a 502, never a 401.

## Tools / integrations

If `MCP_CONFIG` is set, the server connects those MCP servers and exposes their
tools. **Read-only tools run freely; side-effecting tools are DENIED** — a hosted
service has no interactive approver yet (a hosted approval flow is a later step).
Fail-safe by design.

Each entry either starts a server on this machine or reaches a remote one:

```json
{
  "servers": [
    { "name": "web", "command": "node", "args": ["web-server.mjs"] },
    { "name": "nexus", "url": "https://nexus-mcp.up.railway.app/mcp",
      "headers": { "Authorization": "Bearer ${NEXUS_TOKEN_FLINT}" } }
  ]
}
```

`${NAME}` in a header is read from the server's environment, so a token can stay out of
the file. A remote server whose variable isn't set is skipped and logged by name.

## Deploy to Railway

```bash
railway login
railway init                 # or: railway link  (existing project)
railway up                   # builds apps/server/Dockerfile from the repo root
railway variables --set FLINT_TOKEN=$(openssl rand -hex 24) \
                   --set ANTHROPIC_API_KEY=sk-ant-...   # or OLLAMA_MODEL + OLLAMA_HOST
```

`railway.toml` (repo root) already points the build at this Dockerfile and uses
`/health` as the healthcheck. After deploy, `GET $RAILWAY_URL/health` should
return `ok`.

## Run locally

```bash
FLINT_TOKEN=dev OLLAMA_MODEL=qwen2.5:14b OLLAMA_HOST=http://127.0.0.1:11434 \
  PORT=8787 pnpm --filter server start
```
