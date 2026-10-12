# Hosted Flint (server)

The always-on shared Flint service. Wraps the Flint client (with the Flint
persona) behind an authenticated HTTP/SSE API so your apps and devices talk to
**one** Flint. Provider/memory/tools come from env. The local brain is always an
Ollama model: this Mac's, or a remote Ollama at `OLLAMA_HOST` (a rented GPU). An
outside model (Claude) answers only as a frontier tier, never as a default: see
"The local brain is always Ollama" and "When the frontier keeps failing".

## Endpoints

| Method | Path | Auth | Body | Returns |
| --- | --- | --- | --- | --- |
| GET | `/health` | no | — | `{ ok, provider, model, localModelFrom, tools, servers, evalMode, styleVariants, promptRevisions, groundingCharsMax, evalDiscovery, evalRecallOverride, frontierPaused, … }` |
| POST | `/generate` | yes | `{ prompt }` | `{ text, usage, reason, brain, model, … }`. `brain` is `local` or `frontier`, `model` who answered; `frontierPaused` (e.g. `anthropic:credit`) is there when the breaker left outside brains out of the turn (see "When the frontier keeps failing") |
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
| GET | `/goals?tab=active\|suggested\|finished`, `/goals/:id` | yes | — | Will's goals (`GoalsPage`, `{ goal: GoalView }` in @flint/policy). See "Goals" |
| POST | `/goals` | yes | `{ draftKey, args }` | `{ id, deduped }`: a new goal's card, to sign in the console |
| POST | `/goals/:id/edit\|timing\|done\|abandon\|resume\|plan` | yes | `{ args }` | `{ id, deduped }`: that change's card |
| POST | `/goals/:id/pause\|dismiss\|review`, `/goals/:id/criteria/:cid`, `/goals/:id/steps/:key` | yes | `{}`, `{ met }`, `{ status }` | `{ ok: true }`: unsigned, audited by the runtime (`review` is Review Now) |
| POST | `/goals/linkable` | yes | `{ q }` | `{ items }`: items a check may watch |

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
| `OLLAMA_MODEL` + `OLLAMA_HOST` | no | The local brain: an Ollama model at `OLLAMA_HOST` (default `http://127.0.0.1:11434`; a remote Ollama, e.g. a rented GPU, works the same). `OLLAMA_MODEL` unset: Ollama is asked which chat model it has (see "The local brain is always Ollama"). |
| `ANTHROPIC_API_KEY` | no | Turns on the frontier (escalation) brain: Claude, `FLINT_FRONTIER_MODEL` or `claude-sonnet-4-6`, and any `FLINT_TIER_*` on Anthropic. It never becomes the local brain. Unset, with no other frontier configured: Flint runs local-only. |
| `FLINT_DEBUG_ERRORS` | no | `1` logs whole errors (message, stack, the provider's raw response). Unset, the log carries an error's class only: its kind, the provider's code and the breaker's reason, e.g. `[brain] anthropic:claude-opus-5-5 failed, falling back to anthropic:claude-sonnet-5: provider_unavailable 529 transient` (`src/error-log.ts`). A provider's error message is the provider's words, an Ollama error body echoes model output, and an OpenAI-compatible one can quote the request, so none of it is logged by default. Turn it on to see what a provider is really saying, then off again. |
| `FLINT_FRONTIER_MAX_RETRIES` / `FLINT_FRONTIER_TIMEOUT_MS` | no | How the Anthropic client fails: its own retries of a failed request (default 0, up to 5) and how long it waits for a response to start (default 60000, from 1000 to 600000). See "When the frontier keeps failing". |
| `OLLAMA_THINK` | no | `true` or `false`: Ollama's `think` flag for the local brain. `false` stops a thinking model (qwen3.8, muse-glimmer) reasoning before it answers, which is most of its answer time. It may still reason in the answer text itself (qwen3.8 sometimes self-corrects there, visibly), so check a no-think bake-off's answers before setting it live (apps/parity README). Unset, or any other value, sends no flag: the model's default, as before. Don't set `true` on a model that can't think: Ollama rejects every turn with a 400 (qwen2.5 says "does not support thinking"). `false` is harmless there. |
| `FLINT_STYLE_VARIANT` | no | The frontier tiers' style guide: `v1` (`FLINT_STYLE_GUIDE`, today's), `v2` (`FLINT_STYLE_GUIDE_V2`) or `local-v1` (`FLINT_LOCAL_STYLE_GUIDE`). Unset: `v1`, as before. An unknown value is logged and ignored (`v1`). Set a variant live only after a judged parity A/B (`--flint-variant`) shows it wins. |
| `FLINT_LOCAL_STYLE_VARIANT` | no | The same, for the local brain and the eval `localModel` override personas. Unset: `v1`, as before. |
| `FLINT_HISTORY_TURNS` / `FLINT_HISTORY_MAX_AGE_HOURS` | no | How much of a `/chat` conversation each new message carries: the last `FLINT_HISTORY_TURNS` complete turns (default 12) that started within `FLINT_HISTORY_MAX_AGE_HOURS` (default 48), whichever leaves fewer. Every turn stays stored in `~/.flint/memory/conversations.json`, and the memory extractor still reads all of them, but it keeps only durable facts about Will: what was said or decided in an older turn doesn't come back. So when turns are left out, the turn's context says how many, and the persona tells Flint to say so rather than reconstruct them. The tier classifier's "deep thread" rule counts the turns sent (8 or more). `0` means no earlier turns; anything that isn't a number >= 0 is logged and ignored (the default). |
| `FLINT_MEMORY_BRAIN` / `FLINT_MEMORY_MODEL` | no | Which model learns from Will's chats, and which local model it uses: see "Memory extraction". Unset: the local model, `OLLAMA_MODEL`. |
| `MCP_CONFIG` | no | Path to an `mcp.json` of integration servers (your apps as tools). |
| `FLINT_TIER_LAST_RESORT` | no | `provider:model` (e.g. `openai:gpt-5`) tried after every frontier tier. A refused or empty frontier reply (no text, no tool call) moves down the tier chain like an error; the Claude tiers refuse the same prompts, so this is where a refusal can still get answered. Unset: no extra link, and a reply no tier answers becomes a short honest message instead of an empty one. Ignored with `FLINT_TIERS=off`. |
| `FLINT_WORLD_NOW` | no | `1` adds the "World now" block to frontier chat turns (see "The runtime's lanes"); it costs tokens on every such turn. Unset: off. |
| `FLINT_GOALS_NOW` | no | `1` adds Will's goals to chat turns that a model on this Mac answers, and to no other turn (see "Goals in chat"). At most 300 tokens, and never more than that model's real context has room for. Unset: off. |
| `FLINT_GOALS_TO_FRONTIER` | no | `on` also sends the goals block to outside models. **This sends Will's goal text to whichever provider answers the turn** (Anthropic, OpenAI, Perplexity): the titles of his active goals, their counts and forecasts. It also lets those providers read the turns that were answered with the goals and the facts Flint learned from them, and offers every tool again. Only `on` turns it on, and only with `FLINT_GOALS_NOW=1`. Unset, or anything else: goals never leave this Mac. |
| `FLINT_CONTEXT_BLOCKS` | no | `off` is the kill switch for every context block (World now and goals), whatever their own settings say. A value that is neither `on` nor `off` is read as `off` and logged, so a mistyped `off` still turns them off. Unset or `on`: each block follows its own setting. |
| `FLINT_WATCHER` | no | `off` (or `0`, `false`, `no`) turns off the proactive Watcher, which only ever had the calendar check (through Trident's Google tools) and the opt-in Bellwether one. Set it only once the runtime's `google_calendar` source is live and its heads-ups are actually delivered: triage on and P2's promotion table signed (apps/runtime/README.md, "Your calendar", step 5). Those heads-ups keep titles out of notes. The server reads it at start, so run `launchctl kickstart -k gui/$(id -u)/com.flint.server` after setting it. Unset: on. `FLINT_WATCH_MS` sets its interval (default 30 minutes); `FLINT_WATCH_SIGNALS=1` adds the Bellwether check. |
| `FLINT_NTFY_TOPIC` | no | The ntfy.sh topic the phone subscribes to. Every phone push is the same content-free ping (`PHONE_PING` in src/notifications.ts): the words stay in the console. Unset: no pings. |
| `FLINT_INTERNAL_PORT` | no | The port of the internal listener the runtime calls back on (`[::1]`, default 8081). Only a second Flint on the same Mac needs it: a rebuild rehearsal (`apps/studio/rebuild.sh --rehearse`) runs one beside the real one and must never take its port. Anything that is not a port above 1023 is ignored. |
| `PORT` | no | Injected by Railway. |

## The local brain is always Ollama

The local brain (private questions, Local-only, the answer when the frontier can't) is an Ollama
model, whatever keys are in the environment (`chooseLocalBrain` in `src/local-model.ts`).

**A turn the local model answers keeps its question here.** deep_research plans its searches with
the frontier's routine tier when there is one, and that prompt is the question itself. On a turn
the local model is answering (Local-only, a question Will asked to keep private, a turn handed to
it) the planner is not asked: deep_research plans by its heuristic (`asLocalTurn` in
`src/turn-taint.ts`, `pausable` in `src/spend.ts`). The searches it then runs are the same web
searches as on any turn.

Which model it is:

- `OLLAMA_MODEL` names it. An Ollama cloud model (`...-cloud`, `:cloud`) is refused: it runs on
  Ollama's servers, which is an outside AI by another door. The pick below is used in its place.
- Unset, the server asks Ollama at boot (two free list calls, nothing generated): the chat model
  Ollama already has loaded, else the first one pulled, skipping embedders and Ollama cloud models.
  A loaded model keeps the context size it is loaded with (unless `OLLAMA_NUM_CTX` is set), and
  memory extraction and background calls use the same, so the pick never makes Ollama reload it.
- The server never waits on Ollama before it listens. The pick is asked once and cut off by the
  clock (5 s at most, `LOCAL_PICK_CAP_MS`), and so is embedding the tools for the router (3 s,
  `BOOT_EMBED_WAIT_MS` in `src/router.ts`: the server starts with the core tools, and the rest are
  offered once Ollama has embedded them). A server that waited there never answered `/health`
  while Ollama was slow, and the installer, which polls `/health` after a deploy, put the previous
  bundle back. The installer now polls for a minute (`HEALTH_WAIT_S` in `install-server.sh`).
- An Ollama that does not answer may simply not be up yet (both start at login). The server
  starts on `qwen2.5:7b` as a stand-in and keeps asking in the background (every 5 s for a minute,
  then every 30 s, `keepPickingLocal`). When Ollama answers, its model becomes the local brain for
  the next turn, with no restart; a turn already running finishes on the model it started with.
  Memory extraction on the local model starts then too. The log says both
  (`[brain] ... Ollama is not answering ...`, then `[brain] Ollama is answering now: ...`).
- An Ollama that answers and has no chat model leaves `qwen2.5:7b` as a guess that lasts until the
  next restart, and the console gets one note a day saying so ("Flint Is Guessing Its Local Model").
- `GET /health` says where the model came from as `localModelFrom`: `env` (`OLLAMA_MODEL`),
  `loaded`, `pulled`, or `default`. The boot log says the same
  (`[brain] OLLAMA_MODEL is unset: the local brain is ...`).

It used to become Anthropic's `claude-sonnet-4-6` whenever `OLLAMA_MODEL` was unset and
`ANTHROPIC_API_KEY` was present: a missing setting quietly sent every "local" answer to an
outside AI. `FLINT_MODEL`, which named that model, is no longer read (the boot log says so if it is
still set). A deployment that relied on it (a host with no Ollama) needs `OLLAMA_HOST` pointed at
one: its local turns fail, loudly, until then.

**What powers this answer.** Every persona carries one paragraph after its style guide saying
which model is answering (`engineLineFor` in `src/style-variant.ts`, `flintEngineLine` in
@flint/persona): "an open model (muse-glimmer:30b) that Will runs himself with Ollama. It is not
Claude" for the local brain, an eval `localModel` candidate and an `ollama:` tier; "Claude
(claude-opus-5-5), Anthropic's model: a borrowed engine" for a Claude tier. The style guides
themselves are unchanged (they are pinned by hash), and still say "Claude's model for most
questions"; the paragraph is the later word, so a local model asked what it runs on no longer
answers "Claude".

## When the frontier keeps failing

When an outside AI is going to keep failing, Flint stops asking it for a while and the local model
answers at once (`src/frontier-breaker.ts`). Before this, every turn asked Opus, then Sonnet, got
the same refusal from each, and only then asked the local model.

| What happened | Opens after | Cool-down | Then |
| --- | --- | --- | --- |
| `credit`: a 400 saying the credit balance is too low, a 402, or OpenAI's spent quota | 1 failed request | 15 minutes | checked again every 15 minutes |
| `auth`: 401 or 403, the key was rejected | 1 failed request | 15 minutes | checked again every 15 minutes |
| `transient`: 529 or any other 5xx, a timeout, a connection error | 2 failed requests in a row on the provider, no success between | 5 minutes | doubles with each failed check: 10, 20, 40, then 60 minutes |

- **What counts as a request.** Flint retries a retryable failure three times by itself; those
  share one request id and count once. So one model having a bad minute cannot pause the provider:
  Opus returns 529, the turn moves on to Sonnet, and Sonnet's answer starts the count over. It
  takes two different requests failing with nothing answered between them.
- **Per provider.** One key, one account: Opus failing for credit or a rejected key means Sonnet
  will too, so the rest of that turn's Claude tiers are skipped, not asked. An outage that opens
  the breaker mid-turn skips nobody in that turn; the next turn is the one that goes local. Another
  vendor's tier (`FLINT_TIER_LAST_RESORT=openai:...`) or an `ollama:` tier is still tried. The
  local model is never paused.
- **One model.** A 403 that is about a model, not the key ("does not have access to model ..."),
  pauses that model alone; its siblings on the same key stay in use, and the check asks that model.
- **While it is open**, a turn that would have gone to that provider is answered by the local model
  from the start, on `/chat` and `/generate` alike, on every tier. The console marks the reply
  **Local** (the `/chat` `meta` event says `brain: "local"`), `/generate` says `brain: "local"`,
  and both carry `frontierPaused` with the provider and reason code. Research planning
  (deep_research) falls back to its heuristic queries.
- **One cheap check.** After the cool-down, the next turn that arrives is still answered locally
  at once, and sets off a single one-token call to the cheapest brain on that provider (metered in
  the spend ledger like any call). If it is answered, the provider is back in use from the next
  turn; if not, the cool-down starts again. Credit and a rejected key are rechecked every 15
  minutes, because a failed check costs nothing. Any real call that succeeds closes it too. Nothing
  is asked while nobody is chatting. A check that hangs is cut off at 30 seconds and counts as an
  outage; a check that breaks for a reason of its own leaves the pause as it was.
- **A turn only the frontier can answer** (an image or a PDF) is not gated: it is asked as before,
  since there is no local answer to give instead.
- **An eval replay** (`/generate` with `eval: true`) is not rerouted either: it measures the tiers
  as configured, so every brain it planned is asked, as the caps do not apply to it. If they fail
  and the local model answers while a provider is paused, the response carries `frontierPaused`,
  and apps/parity does not judge that answer or file it under a frontier contestant (it is retried
  on resume). Its research planner does respect the pause.
- **Not counted:** a malformed request, an unknown model, a 429, a refusal, a closed tab.
- **Will is told.** Out of credit, a rejected key, or a model the key may not use puts one note in
  the console's notifications ("Claude Has No Credit Left"), once a day, with no banner and no phone
  ping; also when a check finds that an outage was one of those all along. A transient pause clears
  itself and says nothing. A note is plain words and carries no model id: the server log
  (`[breaker] anthropic:<model> paused (auth)`) and `GET /health` name the model.
- **`GET /health`** lists what is paused as `frontierPaused`:
  `[{ "scope": "anthropic", "reason": "credit", "nextCheckInSec": 840, "checking": false }]`
  (empty when nothing is). A model's own pause has the scope `openai:gpt-5`.
- **In memory only.** A restart starts closed; one failing call opens it again. Cool-downs run on
  the monotonic clock. The log names the provider and a reason code, never the provider's message:
  `[breaker] anthropic paused (credit): the local model answers; next check in 15 min`.

**One failing try is quick.** The Anthropic client no longer retries on its own
(`FLINT_FRONTIER_MAX_RETRIES`, default 0; the SDK's default is 2) and waits 60 seconds for a
response to start (`FLINT_FRONTIER_TIMEOUT_MS`; the SDK's default is 10 minutes). Flint's own loop
already retries a retryable failure three times, so the two used to multiply: up to nine requests
of up to ten minutes each before a turn fell back. Every call streams, so the 60 seconds is the
wait for the response to begin (which includes uploading a turn's attachments), not for the whole
answer.

**`/chat` falls back like `/generate`.** An error from the last frontier tier, before any text has
streamed, now goes to the local model (when it may answer the turn). It used to reach the console
as a reply that stopped early; only earlier tiers' errors moved on.

**A turn that has called a tool is never handed to another brain** (`mayAskAnother` in
`src/brains.ts`), on either route, tier to tier or frontier to local. A fallback starts the turn
over, so the next brain would call the tool again: an event created twice, a proposal filed twice.
Once a tool call has gone out, a failure ends the turn as a failure (`/chat`: the reply stops
early; `/generate`: 502), and a reply refused after its tools ran gets the honest message at once.
A failure that is not the provider's (a tool that threw, a tool loop that ran out) never falls
back either.

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
  what the fact says and every number in it (or the number is the turn's year, as 2026
  is for "August 2026"; never its month or day). So "is my Mac Studio fast enough" can't ground "Will's
  Mac Studio has 192GB". A quote found only in Flint's answers, or nowhere, drops the
  fact. The match ignores typography only (curly quotes, dashes, spacing,
  capitals); a word added, dropped or changed fails it.
- **Only a shown fact can be replaced.** A new fact may retire an old one only if the
  model was shown that old fact in this call, and the two share at least two content
  words, or one when both are that short ("Will lives in Dallas" and "Will lives in
  Austin"). An update that shares fewer is stored beside the old fact, never in its
  place.
- **A failure keeps its place.** No answer at all, or one that says Ollama can't serve
  anyone right now (404: the model isn't pulled; 429; 502, 503, 504: busy or down), is
  no strike and costs none of the day's calls. A reply that isn't the schema (bad JSON,
  a missing field), any other error status (a 500, a 4xx) or a timeout is a strike: the
  turns are retried, 3 strikes in a row halve the batch, and only a single turn is ever
  skipped. So one turn that always fails can't hold up the rest, and an outage that
  fails every batch costs at most a turn at a time. A reply cut off at its token limit
  is asked again with half the turns (for the rest of that pass); only a single turn
  still cut off is a strike. Any failure but a bad reply backs the next pass off: 15
  minutes, doubling, up to 6 hours.
- **Logs carry ids and counts only**, never a fact, a quote or anything Will or Flint
  said. The boot log names the model (`[memory-extract] on the local model ...`), and
  each pass logs one line of counts.

| Var | Default | Purpose |
| --- | --- | --- |
| `FLINT_MEMORY_BRAIN` | `local` | `local`; `frontier`: the primary frontier tier, metered as `extract` and paused with other background work at 80% of its vendor's cap. Only when set, and never a fallback: with no frontier configured nothing runs, and a local model that is down is not replaced by the frontier. `off`: no extraction. Anything else is logged and read as `local`. |
| `FLINT_MEMORY_MODEL` | `OLLAMA_MODEL` | Another local model for extraction. One that isn't the chat brain's (compared as Ollama does: case aside, no tag meaning `:latest`) is unloaded after each request (`keep_alive: 0`), so it never holds memory the chat model needs, at the price of a load per call. A cloud model is refused. |
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
model call it asks the server's internal listener (`POST /internal/complete`, `[::1]:8081`),
under one of four kinds, each with its own caps:
`FLINT_BUDGET_KIND_<RUNTIME|REVIEW|DISPATCH|SELFMOD>_DAILY_USD` / `_MONTHLY_USD`. Unlike a vendor
cap, **unset is $0**: a kind is off until both periods are raised (the boot log prints them as
`[spend] background kinds: ...`), and refused with 402 `kind_cap` until then.

**The call is answered by the local model** (`src/background-complete.ts`): the chat brain's own
Ollama model, at `OLLAMA_HOST` with the same `OLLAMA_NUM_CTX`, `think` off, no tools. It used to
go to the routine frontier tier (Sonnet) and answer 503 without one; nothing calls it yet, and
every background call from here on stays on this machine. With no local model to ask (the chat
model is an Ollama cloud model, or `OLLAMA_HOST` is no URL) it answers 503 `no_local_model`.

- **Will's chat comes first.** A call is not started while he is chatting, and one already running
  is cut off the moment a turn starts. Either way the answer is 503 `busy` (try later): nothing
  failed, the audit closes the intent as skipped, and it is not one of the day's calls.
- **Sized to the model's window.** The reply gets what was asked for, up to half the window; the
  prompt must fit in the rest, or the call is refused with 400 `too_long` before the model is
  asked. (Ollama would otherwise drop the start of the prompt, the instructions, without saying.)
- **A reply that is no answer is a failure, not a 200**: nothing in it (`EmptyReply`), cut off at
  its token limit (`Truncated`), or, when the request carried a `schema` (a JSON schema), not JSON
  of that shape (`InvalidReply`). All three are 502 `provider_failed`; the audit records the class,
  never the text.
- **Calls a day.** The local model costs nothing, so nothing is added to the ledger, `costUsd` is
  0, and the kind's dollar caps are simply its switch. What bounds a kind is
  `FLINT_BUDGET_KIND_<KIND>_DAILY_CALLS` (default 100; `0` turns it off): past it, 402 `call_cap`.
  The count is in memory, so a restart starts the day's over.

A durable audit intent is written first (if it can't be, nothing runs) and the outcome is audited.
One call at a time; every refusal is audited. The gate keeps its money guards for any brain that
bills, should one ever be put behind it: refused when its vendor is at 80% of Flint's own cap
(`vendor_cap`), or on the runtime's unified view of the vendor (every account's spend): missing
(`unified_missing`), older than 2 h (`unified_stale`), at 70% of Flint's cap (`unified_70`), or
when Flint has no cap for that vendor to hold it against (`vendor_uncapped`).

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

The local brain is always an Ollama model (see "The local brain is always Ollama"), so it is
free and never held to a cap. (`budgetTurn` still refuses a local brain that bills once its
vendor's budget is spent, with a 503 naming the cap; the server no longer builds one.)

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

**Model choice (the Railway tradeoff):** Railway can't run a local model, and the local brain
is never a hosted one. A hosted deployment points `OLLAMA_HOST` at a GPU box running the model
(with `OLLAMA_MODEL`); `ANTHROPIC_API_KEY` then adds Claude as the frontier, on top of it.

## Route log

Every message answered through `/chat` or `/generate` writes one `[route]` line to the
server log (`~/.flint/server.err.log` on the Studio): the tier it was sorted into, what
moved it off the tier its words alone get (`movedBy`: `tools` when an appended tool is a
confident match, `deep thread` past `LONG_CONVERSATION` turns), each appended tool with its
similarity score, the tier the spend plan actually ran when a budget stepped it
down (`planTier`), the outside providers the breaker had paused for this turn (`paused`, as
`provider:reason` codes such as `anthropic:credit`; see "When the frontier keeps failing"),
who answered (`answeredBy`, only when the outcome is `answered`; otherwise
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

Each line also has `promptRev`: 8 hex characters, a hash of the style guide and the engine
paragraph of the persona that was asked. A variant name says which guide; this says which exact
prompt, so lines (and parity answers: an eval response carries it too, and `/health` lists the
live ones as `promptRevisions`) from before and after a prompt change can be told apart.

A turn the local model answered because the frontier was paused, on either route:

```
[route] {"ts":"2026-10-12T15:00:00.000Z","path":"chat","tier":"hard","appended":[],"turns":0,"brain":"local","paused":"anthropic:credit","answeredBy":"muse-glimmer:30b","promptRev":"3fa9c1d2","outcome":"answered","ms":2100}
```

To see how often: `grep '^\[route\]' ~/.flint/server.err.log | cut -c9- | jq -r 'select(.paused) | .paused' | sort | uniq -c`.

A frontier `/chat` turn that carried the "World now" block also has `ctxTokens: { world: n }`,
the block's estimated tokens (plan 3.0.8: chat overhead is measured). A turn whose last-asked
brain was given Will's goals has `ctxTokens: { goals: n }` (at most 300): a size, never a word
of them. To see the goals block's size turn by turn:
`grep '^\[route\]' ~/.flint/server.err.log | cut -c9- | jq -c 'select(.ctxTokens.goals) | {brain, answeredBy, goals: .ctxTokens.goals}'`.

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
  prompt is already at its limit). `FLINT_CONTEXT_BLOCKS=off` turns it off with the goals block.
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

## Goals

The console's Goals panel (the target icon) reaches the runtime's goal routes through
src/goals-routes.ts, with the console's full token only. Every id and body (up to 64 KB) is
checked with @flint/policy's goal contracts before the runtime sees it, and every answer
before the console does. A goal card is filed with the runtime at once and never spooled to
disk, so a runtime that is down is a 503 and nothing changed. A write the runtime doesn't
answer (in time, or because the connection dropped on the way) is a 504 that says Flint
isn't sure it went through; filing the same card again is safe (it is the same card). A refusal reaches the console
only as one of the fixed goal sentences, by its code. A runtime that refuses the server's
token is a 502; a runtime without the routes answers 404, which is a 501 here, and the
console then hides its Goals button. The item search is a POST, so what Will types never lands
in a request log. `/goals` is never reported back to the runtime as a `route.error`.

Reviews (P3 part 3) run in the runtime, on its local model; the server only proxies. A goal's
view carries when it is next reviewed, its forecast and its latest review, each checked
against the contract (a review's suggestions are a step's title and closed sets, never free
text, and each says whether it is on no card yet); an answer from a runtime that has no
reviews yet still reads. Review Now (`POST /goals/:id/review`, an empty body) is unsigned,
and its refusals are the fixed sentences too. After a yes the console reads the open goal
again on its own until the review has finished (only the facts and LATEST REVIEW are redrawn,
and never under an open Add Step). The proxy logs its own sentences as strings (`errorRef`),
never an `Error` made up to carry one.

Approval cards now carry `kind`, `templateId` and `consequential`. The console never signs a
consequential card (every goal card, and a plan change that is not a review's small one) under
an earlier prompt or in Approve All: each asks for its own touch. Which plan card is a small
one the console reads from the card's operations as well (a status, a date moved by a week or
less, a place), never from the template's name alone.

### Goals in chat

Off by default (P3 part 4). With `FLINT_GOALS_NOW=1`, a `/chat` turn can start from Will's
active goals: a short block in the turn's context (src/goals-now.ts), from the runtime's
`GET /v1/goals/now`.

**Goal text is personal, so only a model on this Mac reads it.** The block is handed out per
ask, not per turn: every time `/chat` asks a brain (a frontier tier, the next tier, the local
model it falls back to), that brain gets the block only if it is local. Local is decided in one
place, `brainIsLocal` in src/policy.ts, and means all three of:

- the provider is Ollama's own API (never Anthropic, OpenAI or Perplexity);
- the model runs here: not one of Ollama's cloud models (`...-cloud`, `:cloud`);
- its server is this Mac (`127.0.0.1`, `localhost` or `::1`). An Ollama server on another
  machine (`OLLAMA_HOST`, `FLINT_TIER_OLLAMA_HOST` or `FLINT_FRONTIER_BASE_URL` set elsewhere)
  is not local.

So a turn Claude answers never holds a goal's words, an `ollama:` tier on this Mac does, and a
frontier turn that fails over to the local model gets the block only on that last ask. A test
proves it with a canary on real clients (test/goals-now.test.ts).

**One mark for "a model on this Mac is answering".** The server already marks a turn the local
model answers (`asLocalTurn` in src/turn-taint.ts), so nothing that turn sets off sends its
question to an outside AI. The goals use that same mark: an ask is given what stays here only
when its brain is on this Mac *and* the ask runs as a local model's turn. `/chat` enters the
mark for the local model, as before, and now also for a tier whose brain is on this Mac
(`ollama:` at a loopback address). The one change that brings: on a turn such a tier answers,
deep research plans its searches by rule, as it does on any local model's turn, instead of
asking the frontier planner. When the local model is swapped at run time (Ollama answered
late), the gate is named again for the new one. Tests: test/goals-local-turn.test.ts.

Four more things follow the block, so a goal's words don't leave by another door:

- **What the model then says stays here.** A turn whose brain was given the block is marked,
  with the turn, from the moment it begins (`context: { goals: true }` on the stored turn). A
  brain that isn't on this Mac never gets that turn back as history: its question and its
  answer are both left out, and one neutral line stands where they were ("An earlier part of
  this conversation isn't shown here.", as a placeholder exchange so every provider still gets
  alternating turns). A brain on this Mac reads the whole conversation. Memory extraction
  skips those turns too when its brain isn't on this Mac (`FLINT_MEMORY_BRAIN=frontier`, or a
  local model on another machine). Tests: test/goals-history.test.ts.
- **What Flint learns from it stays here.** A fact that memory extraction takes from such a
  turn is stored with a mark (`fromGoals` on the fact, in `knowledge.json`), and so is anything
  the model saves with `remember` during it. A marked fact is recalled only for a brain that
  may read the goals; any other brain gets the same recall without it, with the next most
  relevant fact in its place. Recall for a model on this Mac is what it was. An ask that is
  given a marked fact is treated like one that was given the goals: no tool an outside AI
  answers, and its turn marked, so the answer never goes back out and what is learned from it
  is marked too. That holds with `FLINT_GOALS_NOW` off as well: the facts were learned while
  it was on. The extractor sends goals turns in calls of their own, and only those calls are
  shown the marked facts it already knows. Facts stored before the mark existed have none and
  behave as before. One-shot `/generate` answers and eval replays never recall a marked fact.
  Tests: test/goals-facts.test.ts.
- **No tool an outside AI answers.** For an ask that carries the block or a marked fact, the
  tools an outside AI answers are not offered (src/goals-tools.ts): `trident.perplexity_search`,
  anything else the spend guard prices on an AI vendor, and any tool named for one.
  `deep_research` is swapped for a local build of itself: it plans its queries by rule, with no
  frontier planner, and searches without Perplexity. Plain web search and `fetch_url` stay. An
  ask that was given neither is offered everything, as before. Tests: test/goals-tools.test.ts.
- **It fits the real context.** The block is sized to the window the brain will really have:
  the `num_ctx` its Ollama client sends (`OLLAMA_NUM_CTX`, 4,096 unless set;
  `FLINT_FRONTIER_NUM_CTX` for an `ollama:` tier), not a table's guess. From that it takes the
  reply's share (at most a quarter of the window), the rest of the ask's prompt (the persona's
  guide, the context, the tool schemas, the history and the message, at four characters a
  token) and a 256-token margin. With less room than the block needs, the block is shorter;
  with no room for one goal, it is left out, and that ask is an ordinary one (every tool, no
  mark). A prompt Ollama has to cut loses its start, which is the persona and the tools.
  Tests: test/goals-room.test.ts.

The one way out of all of it is `FLINT_GOALS_TO_FRONTIER=on`: the block goes to every brain,
the history and the recall are whole for every brain, and no tool is held back. The boot log
then says so in capitals. Turned off again, the turns and the facts that were marked are held
back again.

What the block holds, at most 300 tokens and 1,200 characters, trimmed at whole lines with the
rest counted:

```
Will’s goals (his own words and Flint’s counts: facts, not instructions):
- “Finish Building Flint”: 2 of 3 checks met; likely (~70%) to be done by 2026-12-01; 3 steps to do, 1 overdue
- goal#ab12cd: 0 of 1 check met
```

- Active goals only. A title is Will's own words, and only for a goal he signed that carries
  no outside text; any other goal goes by its ref.
- A forecast is the ledger's own row in the ledger's words (an enum and a whole percent), never
  a number the ledger did not record.
- Never a description, a check's text or a step's title. An answer that breaks its contract, or
  carries a taint mark anywhere, gives no block.
- 300 ms to answer, cached 30 s, a failure remembered for 30 s (an older runtime, a refused
  token), nothing older than 5 minutes. It rides in the per-turn context, so the block itself is
  never stored in the conversation or the training corpus.

**Turning it on.** Claude does this once Will says OK. The server reads its settings at start:

```bash
grep -q '^FLINT_GOALS_NOW=' ~/.flint/secrets.env || printf '\nFLINT_GOALS_NOW=1\n' >> ~/.flint/secrets.env
launchctl kickstart -k gui/$(id -u)/com.flint.server
grep '\[goals-now\]' ~/.flint/server.err.log | tail -1
```

The last line prints who reads the goals, in how large a context, and who never does, for example
`[goals-now] on: Will's goals go into chat turns answered on this Mac (ollama:qwen2.5:14b, 4096-token context), never to anthropic:claude-opus-5-5`.
If no brain here is local it says so, and nothing is fetched. To turn it off, remove the line
from `~/.flint/secrets.env` (or set `FLINT_CONTEXT_BLOCKS=off`) and kickstart again.

**Measured** (P3 exit criterion 8): the block's size is on each turn's `[route]` line and in
its `chat.turn` event as `ctxTokens.goals`; the runtime rolls it up daily
(`p3.ctx_tokens.goals`, `p3.ctx_tokens.goals_max`) and `p3-report` checks the largest against
300.

**Known limits.**

- *A plain web search can carry a goal's words.* A local model that has read a goal may put
  its words in the query of a plain web search, or in a URL it fetches. That goes to a search
  engine or a website, not to another company's model, and is the same as anything Will types
  or Flint remembers about him.
- *Marked facts are missing from outside answers.* What Flint learned in a turn answered with
  the goals is not recalled for Claude or any other outside model, even when it has nothing to
  do with a goal (where Will lives, say, if he said it in such a turn). With goals on and a
  context large enough for the block, that is most of what the local model's turns teach. A
  marked fact that replaces an older one retires it for everyone, so an outside model then has
  neither. Nothing removes a mark; `FLINT_GOALS_TO_FRONTIER=on` lifts them all.
- *A fact Will states twice.* If Will says the same thing again in a turn without the goals,
  the stored fact is a duplicate and keeps its mark.
- *The training corpus keeps answers.* Each answered turn is logged for Flint's own training
  (`~/.flint/training/corpus.jsonl`, on this Mac), the marked ones included. An eval that sent
  corpus entries to an outside model would send those answers.
- *A small context gets a small block, or none.* At the default 4,096 tokens the prompt is
  already near its limit with the tool schemas, so the block is often shortened or left out;
  the `[route]` line's `ctxTokens.goals` says what each turn got. A local model loaded with a
  larger context gets the whole block.
- *Holes in an outside brain's history.* With goals on, every turn a local model answers with
  the block (or with a marked fact) is marked, so an outside brain that answers a later turn
  of the same conversation sees the placeholder instead. It is told something is missing,
  never what.
- *The sizes are estimates.* The prompt is measured at four characters a token, without the
  persona's lessons; the 256-token margin is for what that misses.
- *A 30-second cache.* Goals read up to 30 seconds ago are still served: a goal finished
  a few seconds ago can appear in one more turn.

Chat has no goal tools: nothing in a chat turn can read a goal by asking the runtime, and a
goal or plan card filed from a chat is refused by the runtime.

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
                   --set OLLAMA_HOST=https://your-gpu-box:11434 --set OLLAMA_MODEL=qwen2.5:14b
                   # the local brain; add ANTHROPIC_API_KEY=sk-ant-... for a Claude frontier on top
```

`railway.toml` (repo root) already points the build at this Dockerfile and uses
`/health` as the healthcheck. After deploy, `GET $RAILWAY_URL/health` should
return `ok`.

## Run locally

```bash
FLINT_TOKEN=dev OLLAMA_MODEL=qwen2.5:14b OLLAMA_HOST=http://127.0.0.1:11434 \
  PORT=8787 pnpm --filter server start
```
