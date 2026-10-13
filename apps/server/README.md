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
| GET | `/health` | no | — | `{ ok, provider, model, localModelFrom, localModelSettled, mode, tools, servers, evalMode, styleVariants, promptRevisions, groundingCharsMax, evalDiscovery, evalRecallOverride, frontierPaused, … }` |
| POST | `/generate` | yes | `{ prompt }` | `{ text, usage, reason, brain, model, route, … }`. `brain` is `local` or `frontier`, `model` who answered, `route` the mode and the rule that decided (`{ mode, reason }`, see "Local inference"); `deep: true` in the body asks hybrid for the cloud model; `frontierPaused` (e.g. `anthropic:credit`) is there when the breaker left outside brains out of the turn (see "When the frontier keeps failing") |
| POST | `/generate` (eval) | yes | `{ prompt, eval: true }` | `{ text, usage, reason, brain, model, styleVariant, tools, grounding, proposed, eval, costUsd, costByVendor, paidCalls, budgetBlocked? }` — not logged to the training corpus, no `remember`, proposals auto-rejected (used by `apps/eval`). `costUsd` is what the replay's paid calls cost (every model pass and fallback attempt, the research planner, paid searches; see "Spend caps"), and error responses (500 / 502 / 503) carry it too; `budgetBlocked` lists the paid tools refused because Flint's own cap for them is spent. `grounding` is `{ memory: string[], tools: [{ name, isError, excerpt }] }`: the long-term facts recalled into that turn and its own tool results, never a concurrent turn's (each excerpt at most 800 chars), for apps/parity `--judge-grounding` (src/grounding.ts). Normal responses never carry it. |
| POST | `/generate` (eval, style variant) | yes | `{ prompt, eval: true, styleVariant: "v2" }` | as above, answered with that style guide; `styleVariant` echoes the variant of the persona that answered, read from its own guide (not from the request). Unknown variant, or no `eval: true`: 400. `/health` lists the known ones as `styleVariants` (used by `apps/parity --flint-variant`) |
| POST | `/generate` (eval, longer excerpts) | yes | `{ prompt, eval: true, groundingChars: 16000 }` | as above, with each `grounding` tool excerpt cut at `groundingChars` instead of 800, echoed as `groundingChars`. An integer from 800 to `/health`'s `groundingCharsMax` (32000); otherwise, or without `eval: true`, 400. Used by apps/parity `tasks`, which hands competitors the data Flint read (src/eval-tools.ts) |
| POST | `/generate` (eval, no memory) | yes | `{ prompt, eval: true, recall: false }` | as above, answered without reading long-term memory (`grounding.memory` is empty), echoed as `recall: false`. A boolean; otherwise, or without `eval: true`, 400. Used by apps/parity `tasks` on every task whose point isn't memory: the frontier competitors get exactly Flint's data, which leaves Will's memory out (src/eval-tools.ts) |
| GET | `/eval/tools` | yes | — | `{ tools: string[] }`: every wired tool's name, so apps/parity `build-tasks` can check its templates' expected tools |
| POST | `/eval/tool` | yes | `{ eval: true, name, args? }` | `{ ok, name, isError, text }`: runs ONE tool from a fixed read-only discovery allowlist (`DISCOVERY_TOOLS` in src/eval-tools.ts: `meridian.list_tickers`, `vantage.top_scores`, `bellwether.list_industries`, …) to fill apps/parity task slots. Any other tool is a 403 before any handler runs, so it can't write or create a proposal; 404 if the tool isn't wired, 502 if it throws. Audited in the action log |
| POST | `/chat` | yes | `{ conversationId, message }` | SSE stream of `StreamEvent`s. Ahead of each brain's reply, a `meta` event says whether the reply stays on this Mac and which stored turn it is: `{ type: "meta", staysHere, turn }` (see "Goals in chat"). When the server's own speech is made on this Mac the event also carries `speechHere: true` (see "Voice") |
| POST | `/speak` | yes | `{ text, conversationId?, turnId? }` | The text as speech, in the kind of audio the speech provider makes (`audio/mpeg` from OpenAI, always, which is the default; see "Voice"). From an outside service: 409 with `fallback: "browser"` for a reply that stays on this Mac (the client speaks it with its own voice), and 503 with no key, with the cap spent, or in Local mode. A provider on this Mac speaks every reply; the Mac's own voice answers 429 with `fallback: "browser"` when it already has as many replies in hand as it takes |
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
| GET | `/predictions/waiting` | yes | — | `{ questions, announce }`: what the console asks when it loads, and every few minutes. Two facts, and no number of any series |
| GET | `/predictions`, `/predictions/series/:key`, `/predictions/questions`, `/predictions/accuracy` | yes | — | Flint's forecasts, one number open, Will's questions, and how Flint has done (`PredictionsPage`, `{ series: SeriesView }`, `QuestionsPage`, `AccuracyView` in @flint/policy). See "Predictions" |
| POST | `/predictions/turn-on` | yes | `{ series }` | `{ id, deduped }`: the Turn On Predictions card, to sign in the console |
| POST | `/predictions/series/:key/turn-off`, `/predictions/questions/:id/answer` | yes | `{}`, `{ answer: "yes" \| "no" \| "skip" }` | `{ ok: true }`: unsigned, audited by the runtime |
| GET | `/assets` | yes | — | Settings > Assets: each asset, whether it is on, and its sentence (`AssetsPage` in @flint/policy). See "Tasks and assets" |
| POST | `/assets/:id/on`, `/assets/:id/off` | yes | `{}` | `{ proposalId, deduped }`: the card that turns it on, to sign in the console; `{ ok: true }` for off (unsigned, audited by the runtime) |
| GET | `/tasks?tab=active\|finished`, `/tasks/:id`, `/tasks/form` | yes | — | A tab of the Tasks panel, one task open, and what New Task can offer now (`TasksPage`, `{ task: TaskView }`, `TaskForm`) |
| POST | `/tasks` | yes | `{ draftKey, template, params, goalId?, dueAt? }` | `{ id, proposalId, deduped }`: a new task and its card, to sign in the console |
| POST | `/tasks/:id/cancel`, `/tasks/:id/accept\|reject` | yes | `{}` | Cancel: `{ ok: true }` while the task has not gone out, else `{ proposalId, deduped }`. Accept Anyway and Reject Anyway: always that card |
| POST | `/tasks/:id/again` | yes | `{ draftKey }` | `{ id, proposalId, deduped }`: Run Again, a new task like an ended one, and its card |
| GET | `/inference` | yes (full token) | — | The routing mode, this machine and the local models: `{ mode, modeSource, modeSentence, hardware: { accelerator, chip, memoryGb, usableGb, tier, tierLabel, recommended, name, sentence, notes }, local: { wire, server, host, model, contextLength, tools, primary, standby, embedding, confined, pull, warnings }, cloud, problems, notices, lines }`. `primary` and `standby` are `{ model, name, state, why?, pull?, downloadGb?, sentence }`. `lines` is the same as sentences for the command line (tags, keys); `name`, `sentence` and `notices` are for the console (display names, no key or tag). `hardware` is absent until the machine has been looked at. It takes one fresh look at the model server, and never starts a model load. See "Local inference", Status. |
| POST | `/inference/mode` | yes (full token) | `{ mode: "local" \| "hybrid" \| "cloud" }` or `{ reset: true }` | `{ ok, mode, previous, source }`. Switches the mode and saves it; `reset` goes back to `FLINT_INFERENCE_MODE`. Anything else: 400. Audited. |

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
| `FLINT_INFERENCE_MODE` | no | `local`, `cloud` or `hybrid`: which side answers. Unset: `cloud`, as before. An invalid value runs as `local`. A mode saved from Settings wins over it. See "Local inference", Modes. |
| `FLINT_HARDWARE_TIER` | no | `cpu-small`, `cpu`, `8gb`, `16gb`, `24gb` or `48gb`: this machine's hardware tier, in place of detecting it. Unset or `auto`: detect. See "Local inference", Hardware tiers. |
| `FLINT_LOCAL_*` | no | Local inference: which wire the local brain is on, its server's address, its deadlines. See "Local inference". Unset: Ollama's own API at `OLLAMA_HOST`, as before. |
| `OLLAMA_THINK` | no | `true` or `false`: Ollama's `think` flag for the local brain. `false` stops a thinking model (qwen3.8, muse-glimmer) reasoning before it answers, which is most of its answer time. It may still reason in the answer text itself (qwen3.8 sometimes self-corrects there, visibly), so check a no-think bake-off's answers before setting it live (apps/parity README). Unset, or any other value, sends no flag: the model's default, as before. Don't set `true` on a model that can't think: Ollama rejects every turn with a 400 (qwen2.5 says "does not support thinking"). `false` is harmless there. |
| `FLINT_STYLE_VARIANT` | no | The frontier tiers' style guide: `v1` (`FLINT_STYLE_GUIDE`, today's), `v2` (`FLINT_STYLE_GUIDE_V2`) or `local-v1` (`FLINT_LOCAL_STYLE_GUIDE`). Unset: `v1`, as before. An unknown value is logged and ignored (`v1`). Set a variant live only after a judged parity A/B (`--flint-variant`) shows it wins. |
| `FLINT_LOCAL_STYLE_VARIANT` | no | The same, for the local brain and the eval `localModel` override personas. Unset: `v1`, as before. In a window the guide would take more than half of, the main local model is given the compact guide (`local-v1`) instead: see "Local inference", Hardware tiers. |
| `FLINT_EMBED_MODEL` | no | The embedding model (recall, the knowledge store, the tool router), in place of the one the hardware tier table names. A value that is not a model name is ignored and reported. |
| `FLINT_STT_PROVIDER` / `FLINT_TTS_PROVIDER` | no | What turns Will's voice into text (`whisper-cpp` or `local`) and what speaks a reply (`openai`, `local`, `say` or `off`). Unset: `whisper-cpp` and `openai`, as before. See "Voice" for these and the settings each one reads (`FLINT_LOCAL_STT_*`, `FLINT_LOCAL_TTS_*`, `FLINT_SAY_VOICE`, `WHISPER_BIN`, `WHISPER_MODEL`, `FLINT_TTS_MODEL`, `FLINT_TTS_VOICE`). The last four are older than the rest and used to be ignored when they were saved in `~/.flint/secrets.env`; they apply from there now. |
| `FLINT_HISTORY_TURNS` / `FLINT_HISTORY_MAX_AGE_HOURS` | no | How much of a `/chat` conversation each new message carries: the last `FLINT_HISTORY_TURNS` complete turns (default 12) that started within `FLINT_HISTORY_MAX_AGE_HOURS` (default 48), whichever leaves fewer. Every turn stays stored in `~/.flint/memory/conversations.json`, and the memory extractor still reads all of them, but it keeps only durable facts about Will: what was said or decided in an older turn doesn't come back. So when turns are left out, the turn's context says how many, and the persona tells Flint to say so rather than reconstruct them. The tier classifier's "deep thread" rule counts the turns sent (8 or more). `0` means no earlier turns; anything that isn't a number >= 0 is logged and ignored (the default). |
| `FLINT_MEMORY_BRAIN` / `FLINT_MEMORY_MODEL` | no | Which model learns from Will's chats, and which local model it uses: see "Memory extraction". Unset: the local model, `OLLAMA_MODEL`. |
| `FLINT_EXTRACT_CANDIDATES` | no | `1` lets a model on this Mac suggest the goals Will sets in chat, each resting on his own quoted words and waiting for his approval (see "Goals and commitments from chat"). Unset: off. |
| `FLINT_EXTRACT_COMMITMENTS` | no | `1`, with the setting above, also suggests the things he says he will do. Its own switch, off: an approved commitment has nowhere to be seen or removed yet. Unset: off. |
| `MCP_CONFIG` | no | Path to an `mcp.json` of integration servers (your apps as tools). |
| `FLINT_TIER_LAST_RESORT` | no | `provider:model` (e.g. `openai:gpt-5`) tried after every frontier tier. A refused or empty frontier reply (no text, no tool call) moves down the tier chain like an error; the Claude tiers refuse the same prompts, so this is where a refusal can still get answered. Unset: no extra link, and a reply no tier answers becomes a short honest message instead of an empty one. Ignored with `FLINT_TIERS=off`. |
| `FLINT_WORLD_NOW` | no | `1` adds the "World now" block to frontier chat turns (see "The runtime's lanes"); it costs tokens on every such turn. Unset: off. |
| `FLINT_GOALS_NOW` | no | `1` adds Will's goals to chat turns that a model on this Mac answers, and to no other turn (see "Goals in chat"). At most 300 tokens, and never more than that model's real context has room for. Unset, blank or `0`: off. Anything else is read as off and logged. |
| `FLINT_GOALS_TO_FRONTIER` | no | `on` also sends the goals block to outside models. **This sends Will's goal text to whichever provider answers the turn** (Anthropic, OpenAI, Perplexity): the titles of his active goals, their counts and forecasts. It also lets those providers read the turns that were answered with the goals and the facts Flint learned from them, and offers every tool again. Only `on` turns it on, and only with `FLINT_GOALS_NOW=1`. Unset, or anything else: goals never leave this Mac. |
| `FLINT_CONTEXT_BLOCKS` | no | `off` is the kill switch for every context block (World now and goals), whatever their own settings say. A value that is neither `on` nor `off` is read as `off` and logged, so a mistyped `off` still turns them off. Unset or `on`: each block follows its own setting. |
| `FLINT_WATCHER` | no | `off` (or `0`, `false`, `no`) turns off the proactive Watcher, which only ever had the calendar check (through Trident's Google tools) and the opt-in Bellwether one. Set it only once the runtime's `google_calendar` source is live and its heads-ups are actually delivered: triage on and P2's promotion table signed (apps/runtime/README.md, "Your calendar", step 5). Those heads-ups keep titles out of notes. The server reads it at start, so run `launchctl kickstart -k gui/$(id -u)/com.flint.server` after setting it. Unset: on. `FLINT_WATCH_MS` sets its interval (default 30 minutes); `FLINT_WATCH_SIGNALS=1` adds the Bellwether check. |
| `FLINT_NTFY_TOPIC` | no | The ntfy.sh topic the phone subscribes to. Every phone push is the same content-free ping (`PHONE_PING` in src/notifications.ts): the words stay in the console. Unset: no pings. |
| `FLINT_INTERNAL_PORT` | no | The port of the internal listener the runtime calls back on (`[::1]`, default 8081). Only a second Flint on the same Mac needs it: a rebuild rehearsal (`apps/studio/rebuild.sh --rehearse`) runs one beside the real one and must never take its port. Anything that is not a port above 1023 is ignored. |
| `PORT` | no | Injected by Railway. |

## The local brain is always Ollama

The local brain (private questions, Local-only, the answer when the frontier can't) is a model on
Will's hardware, whatever keys are in the environment: an Ollama model on Ollama's own API by
default (`chooseLocalBrain` in `src/local-model.ts`), or a model on an OpenAI-compatible local
server when `FLINT_LOCAL_PROVIDER=openai` (see "Local inference"). Never a paid vendor's.
`FLINT_LOCAL_MODEL` names it on either wire, ahead of `OLLAMA_MODEL`.

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
  starts on a stand-in (the smallest GPU tier's model, then this machine's hardware tier's model
  once the machine has been looked at: see "Local inference", Hardware tiers) and keeps asking in
  the background (every 5 s for a minute, then every 30 s, `keepPickingLocal`). When Ollama
  answers, its model becomes the local brain for the next turn, with no restart; a turn already
  running finishes on the model it started with. Memory extraction on the local model starts then
  too. The log says both (`[brain] ... Ollama is not answering ...`, then
  `[brain] Ollama is answering now: ...`).
- **The stand-in is never asked.** Asking Ollama for a model it may not have would download
  nothing and load nothing, but it would also answer "not found" as if that were the local brain's
  word. Until a model is chosen (`localModelSettled: false` in `GET /health`) a local turn gets
  503 and a sentence ("Flint hasn't chosen its local model yet, because the local model server
  isn't answering, ..."), the status shows no model's name, and the health monitor does not probe
  or load the stand-in. A model Will named (`FLINT_LOCAL_MODEL`, `OLLAMA_MODEL`) is settled from
  the start.
- A brain adopted later is built exactly like the first one (`src/local-brains.ts`): the guarded
  fetch, the deadlines, the server's own word on tools, the health monitor. The monitor follows the
  adopted model; it never watches the stand-in.
- An Ollama that answers and has no chat model leaves the tier's model as a guess that lasts until
  the next restart, and the console gets one note a day saying so ("Flint Is Guessing Its Local
  Model").
- `GET /health` says where the model came from as `localModelFrom`: `env` (`FLINT_LOCAL_MODEL` or
  `OLLAMA_MODEL`), `tier` (this machine's hardware tier's model, see "Local inference"), `loaded`,
  `pulled`, or `default`. The boot log says the same
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

## Local inference

The local brain runs on a model server on Will's hardware. Flint can talk to that server two ways,
and watches its health so that a turn never waits on a model that is not ready.

### Setup

**Ollama's own API (the default).** Nothing to set: `OLLAMA_HOST`, `OLLAMA_MODEL`, `OLLAMA_NUM_CTX`
and `OLLAMA_THINK` are read as before, and requests are what they were. This wire can set the
context size per call, turn thinking off, hold a reply to a JSON schema, and recover tool calls a
model wrote as text. Memory extraction, background calls and the runtime's triage use it with the
same context, so Ollama never reloads the model between them and a chat.

**Any OpenAI-compatible local server** (Ollama's `/v1`, llama.cpp's `llama-server`, others):

```
FLINT_LOCAL_PROVIDER=openai
FLINT_LOCAL_BASE_URL=http://127.0.0.1:8080/v1     # llama-server; unset: http://127.0.0.1:11434/v1 (Ollama)
FLINT_LOCAL_MODEL=<the model's name on that server>
```

One adapter (`LocalOpenAiProvider` in @flint/core); only the base URL differs between servers.
Chat completions has no field for a context size, so the server's own setting applies. On Ollama
that is the model's default `num_ctx`: to run a model at the context chat should use, make one
whose default is that, and name it:

```
printf 'FROM <model>\nPARAMETER num_ctx 16384\n' > Modelfile
ollama create flint-chat -f Modelfile
```

then `FLINT_LOCAL_MODEL=flint-chat` and `OLLAMA_NUM_CTX=16384` (here it only sizes Flint's own
history budget). On this wire Ollama's thinking models think (there is no `think` field), and
there is no recovery of a tool call written as text. Measure before making it the live wire.

Both wires go through one guarded fetch (`src/local-backend.ts`): only the configured server, only
the paths Flint uses (there is none that downloads a model), and never a redirect.

| Var | Default | Purpose |
| --- | --- | --- |
| `FLINT_LOCAL_PROVIDER` | `ollama` | The wire: `ollama` (Ollama's own API) or `openai` (the OpenAI-compatible adapter). |
| `FLINT_LOCAL_BASE_URL` | `http://127.0.0.1:11434/v1` | The OpenAI-compatible server. http or https, no credentials, query or fragment; a URL with no path gets `/v1`. A refused value turns that provider **off** (local turns fail with a clear error); it is never replaced by another address. |
| `FLINT_LOCAL_ALLOW_REMOTE` | `0` | `1` allows the local model server to be on another machine, over https. Without it a local endpoint must be `127.0.0.1`, `localhost` or `[::1]`. It vouches for that ONE server (`FLINT_LOCAL_BASE_URL`, or `OLLAMA_HOST` on Ollama's own API) and for nothing else: an `OLLAMA_HOST` on some other machine is never "here" because of it. |
| `FLINT_LOCAL_ALLOW_INSECURE_REMOTE` | `0` | `1` also allows plain http to that machine: say so only for a private network. Plain http carries every prompt in the clear. Even then the API key is never sent over it. |
| `FLINT_LOCAL_API_KEY` | none | For a server started with a key (`llama-server --api-key`). Put it in `~/.flint/secrets.env`. It is never logged, never in a status, and never sent over plain http to another machine (the boot log says it was left out). |
| `FLINT_LOCAL_SERVER` | `auto` | What is at the address: `ollama`, `llamacpp`, `openai` (any other), or `auto` to ask it at boot. It decides which health checks run, and nothing else: whatever it says, the server is asked what it is at every look, and no model on it is taken for one on this Mac until it has answered (see "Local means this Mac" under Modes). |
| `FLINT_LOCAL_MODEL` | none | The local model, on either wire, ahead of `OLLAMA_MODEL`. An Ollama cloud tag is refused. |
| `FLINT_LOCAL_FALLBACK_MODEL` | the tier's standby | The standby model, which answers while the main one loads: a model's name on the local server, or `off` (or `none`) for none. Unset: the hardware tier's standby model, on an Ollama server. See "Warm start". |
| `FLINT_LOCAL_FALLBACK_NUM_CTX` | the tier's standby context | The standby's context (256 to 1048576). Unset: 8,192 on the 16 GB tier and up, 4,096 below. |
| `FLINT_LOCAL_TOOLS` | `auto` | `auto`: the local model is offered tools when its server says it can call them (Ollama's `/api/show`). `on` / `off`: always / never. |
| `FLINT_LOCAL_VISION` | `off` | `on`: a turn's pictures are sent to a local model its server says can see, on Ollama's own API, and a turn that stays on this Mac with a picture is answered here. `off`: no picture is sent on that wire, as before. See "Pictures and PDFs on this Mac". |
| `FLINT_LOCAL_PDF` | `off` | What reads a PDF's text on this Mac for the local model: `spotlight` (the Mac's own PDF importer, nothing to install) or `pdftotext` (poppler's, when it is installed). `off`: no PDF is read here, as before. A reader that is not on this Mac is refused, and nothing is installed for it. |
| `FLINT_LOCAL_CONNECT_TIMEOUT_MS` | `1500` | How long the server has to accept a connection (100 to 30000). |
| `FLINT_LOCAL_FIRST_OUTPUT_TIMEOUT_MS` | `20000` | How long a turn waits for the model's first token (500 to 300000). |
| `FLINT_LOCAL_TOOL_PASS_TIMEOUT_MS` | `60000` | The same for the call that follows a tool result (1000 to 600000). |
| `FLINT_LOCAL_REQUEST_TIMEOUT_MS` | `120000` | How long one call may take in all (1000 to 600000). |
| `FLINT_LOCAL_IDLE_TIMEOUT_MS` | `30000` | How long a reply may go quiet once it has begun, between one piece and the next (1000 to 600000). |
| `FLINT_LOCAL_HEALTH_INTERVAL_MS` | `15000` | How often the server's health is checked (2000 to 600000). |

Every value is checked by a schema (`src/inference-config.ts`). A bad one never stops Flint: the
boot log names the key and why (`[inference] FLINT_LOCAL_TOOLS is not one of auto, on, off; the
local model is offered no tools`), never the value, and the safe side is used. `OLLAMA_MODEL`,
`OLLAMA_NUM_CTX` and `FLINT_EMBED_MODEL` are older than these keys and are checked the same way
before they reach a request, a log or a status: a value that is not a model name, or not a context
size, is ignored and reported.

**Where the address may point.**

- The name `localhost` is pinned to `127.0.0.1`: a request goes to this machine's loopback
  whatever a resolver or a hosts file says the name means.
- A server on another machine needs `FLINT_LOCAL_ALLOW_REMOTE=1` and https. Plain http to another
  machine is refused (`insecure_remote`) unless `FLINT_LOCAL_ALLOW_INSECURE_REMOTE=1` also says the
  network is private.
- The helpers that always talk to Ollama's own address (`OLLAMA_HOST`: the embedder, memory
  extraction on the local model, and the runtime's background calls) are held to this Mac too.
  In the local and hybrid modes they send nothing to an Ollama on another machine, and a private
  message is not sent there in any mode. The one exception is an `OLLAMA_HOST` that IS the local
  model server Will allowed (the same origin): `FLINT_LOCAL_ALLOW_REMOTE` vouches for that server
  and no other. With the local model on this Mac and `OLLAMA_HOST` elsewhere, that Ollama gets
  nothing that stays here, whatever the switch says, and every sentence that says "this Mac" is
  true. Their requests then fail like an Ollama that is down, which each of them already lives
  with (recall matches words, only the core tools are offered, extraction waits).
- The address is not the whole of it for them either. The model a helper's request names is
  asked of that Ollama's own listing: a private message's words are embedded only by a model
  Ollama lists as its own (not by a cloud model under a plain name, and not by one Ollama has not
  been heard on yet), and so are the words of every turn of Local mode (the request is marked
  where it is routed, before the tool router or recall has embedded a word of it). Anything else
  made in the local and hybrid modes is sent unless the model is known to run on Ollama's
  servers. A fact that stays here is embedded only when the embedding model is one of Ollama's
  own, and a background call (`/internal/complete`) is answered only by a model Ollama has said
  is its own, in every mode.
- A model id that an OpenAI-compatible server reports is checked before it reaches a log or a
  status, and an Ollama cloud tag is refused on either wire.

### Modes

Flint answers in one of three modes. `FLINT_INFERENCE_MODE` sets the default; Will can change it
while Flint runs, in the console (Settings, Brain) or with the status command, and that choice is
saved and survives restarts.

| Mode | What answers | When that side can't |
| --- | --- | --- |
| `cloud` (the default) | The cloud tiers answer, and a message Will keeps private (Local Only, or "keep this private") is answered on this Mac. The hybrid rules are not consulted. What is different from before the modes existed is listed under "What is different in Cloud mode". | A failing cloud model falls back to the local one. |
| `local` | The local model, every message. **No outside AI and no paid service.** No cloud model is called for chat or `/generate`, the research planner uses its built-in queries, frontier memory extraction waits, and `/speak` answers 503 so the client uses its own voice. A paid tool (Perplexity, and Tavily's search, which returns an answer its own model wrote) is not offered and refuses if called. **Flint may still search the web:** the keyless search (SearXNG on this Mac), the page fetch and Will's own account tools stay. Local mode keeps the answer on this Mac; it does not cut Flint off from the web. | A sentence, never the cloud: "The local model isn't available, and Local mode never uses the cloud." |
| `hybrid` | The rule table below picks this Mac or the cloud for each message. | Per rule: a private message never leaves this Mac; other messages go to the other side when nothing has been shown yet. While the main local model loads, the standby model answers first (see "Warm start"). |

- **An invalid `FLINT_INFERENCE_MODE` runs as `local`**, never `cloud`, and the boot log says so:
  a typo must not send a private setup to the cloud.
- **The saved mode wins over the environment.** It lives in `~/.flint/inference.json` (the mode
  and when it was set). `POST /inference/mode {"reset": true}` forgets it.
- **A rebuilt Mac starts in Local mode.** The mode is never taken from a backup: not the file
  above (a rebuild never unpacks it), and not `FLINT_INFERENCE_MODE` (the settings manifest
  leaves it to Will). A backup that was changed could otherwise turn Local into Cloud, and the
  mode decides where his words go. `apps/studio/rebuild.sh` writes `FLINT_INFERENCE_MODE=local`
  for the new Mac and says: "Flint is in Local mode after a rebuild. Choose another mode in
  Settings if you want one."
- **The console follows the mode at every reply.** Each reply's first `meta` event carries the
  route it was given, mode included, and the page applies it. A mode changed on another device,
  or by a rebuild, is known at the next reply without Settings being opened, so the Local Only
  switch (and the Mac app's menu item) is never left locked while Flint is in Cloud mode, nor
  free while it is in Local mode.
- **A saved mode that cannot be read runs as `local` too**, whatever the environment says (the
  status's `modeSource` is `invalid_saved`, and Settings says so). The file is there, so Will chose
  a mode; a damaged file must not hand the choice back to the environment's `cloud`. Choosing a
  mode again, or `reset`, clears it. A file that is not there at all is no saved mode.
- **The saved mode is read only from a small regular file.** What is at that path is looked at
  before it is opened: a link (to anywhere, or to nothing), a pipe, a directory or a file over
  4 KB is "cannot be read", which is Local. It is written 0600 through a temp file of its own.
- **Only Will changes the mode.** `GET /inference` and `POST /inference/mode` need the full token
  (a voice or eval token cannot reach them), each change is written to the audit trail
  (`inference.mode`, from, to), and there is no tool for it, so nothing a model reads can talk
  Flint out of Local mode. Choosing the mode Flint is already in saves it (it then wins over the
  environment at the next restart): that is logged and audited too, with `from` equal to `to`.
- **"Local" means this Mac.** In the local and hybrid modes a model server on another machine is
  not used unless `FLINT_LOCAL_ALLOW_REMOTE=1` (and https, see Setup), and an Ollama cloud model
  is never used. **A name is not trusted for that:** `ollama cp gpt-oss:120b-cloud mine` gives a
  cloud model a plain name, and nothing in the name or the address says so. Ollama's own listing
  does (the model has a remote host), and Flint takes its word: every look the health monitor
  takes at the model server hands the listing to `src/ollama-locality.ts`. Settings then says
  "The local model is an Ollama cloud model, which runs on Ollama's servers, so Local and Hybrid
  modes will not use it." (a standby that is such a model is left out of every plan, and its row
  says so, and it is never loaded ahead of a turn), a turn that must stay here gets "The local
  model is one that runs on Ollama's servers, and ...", and that model is never asked for one.
  **The same holds on the OpenAI-compatible wire, and it fails closed there.** That wire can be
  pointed at an Ollama (`...:11434/v1`), and only the server knows whether it is one. So a server
  is known by its origin (`...:11434` and `...:11434/v1` are one server), every look asks it the
  one question only an Ollama answers with a listing (`GET /api/tags`), whatever
  `FLINT_LOCAL_SERVER` says and whatever answered at boot, and until it has answered nothing on
  it is local: a listing means an Ollama, held to that listing model by model; "no such thing
  here" (llama.cpp, LM Studio) means a server that runs only its own models, local by its address.
  "Not known yet" is never "so, yes": a model server that was not up when Flint booted is asked
  by the first turn that needs it. (What Flint cannot tell apart is a program at a loopback
  address that passes requests on to a cloud service: it answers like any server that is no
  Ollama. Point the local wire only at a server that runs its models on this Mac.) A tier named `local:<model>` is held to the same rule, and its
  server is asked every minute like any local brain's. A turn that stays
  here is planned only on a model that is KNOWN to run here (an eval replay too): one whose
  server has not been heard on it yet, or has stopped saying, gets "Flint cannot confirm right
  now that its local model runs on this Mac, and ...". **A turn that stays here asks first.** As soon as it is routed (a private
  message in any mode, and every turn of Local mode), and before it is refused, planned, or a word
  of it is embedded, the model server is asked what runs on it now (`routeFirst` in
  `src/inference.ts`). So a name pointed at a cloud model while Flint runs (`ollama cp`) is caught
  by the very next such turn, not a minute later, and one pointed back is not refused on old news.
  **Whoever did not ask first asks before it hands anything over.** A tier on a local wire has
  its server asked before the tier is asked. A local model that answers an ordinary turn in Cloud
  mode (no cloud model set up, or one that failed) has the model server looked at first. And
  every request of the helpers (the embedder, memory extraction, background calls) is decided
  where it is sent, after Ollama has been asked when its answer decides anything: a private
  message's request, one that carries text which stays here, a background call, and every
  request outside Cloud mode. (An ordinary Cloud-mode request is sent whatever the listing says,
  so it does not wait for one.) Each asks when the server's last word is more than two seconds
  old, counted from when that word was ASKED FOR, not from when it arrived: a listing that took
  most of two seconds to come is not handed on for two more (`fresh` in
  `src/ollama-locality.ts`; in the background every server is still asked once a minute). A request that carries text which stays here whatever the mode (a fact that stays
  here on its way to the embedder, a call of memory extraction about turns that do, and any call
  of it that asks for Will's goals) goes only to a model Ollama has just listed as its own.
  **A server that gives no word is not believed on what it said before.** When someone waits for
  its answer and gets none (it is down, its listing fails or hangs, the question is not let
  through), every model it had listed as its own stops being local at once, and so does "it is
  no Ollama": a name could have been pointed at a cloud model behind the silence. What it said
  runs on Ollama's servers is kept. That holds for the health monitor's look too, which is the
  one a turn that stays here waits for: the turn gets the sentence above, or "The local model
  isn't available, and ..." when the whole server is silent, inside the two seconds one look may
  take, and waits once for one silence. That is a private turn in any mode and every turn of
  Local mode: none of the turn's words are embedded or sent meanwhile. One bad answer is not yet
  silence: a question that fails at once (an error, a dropped connection) is asked once more
  inside the same look, so a server that was busy for a moment does not cost a turn; one that is
  not answered in time is not asked again. The next answer is believed again. What is left is
  under "Known limits", below. In Cloud mode an ordinary turn reaches a remote `OLLAMA_HOST` as it always has,
  and **a private message does not**: with a model server that is not this Mac, and that Will has
  not allowed, it is refused where it is first routed (503: "The local model server is on another
  machine, and a private message never leaves this Mac."), before a word of it is embedded,
  recalled against or sent. Cloud mode used to send it to that server.
- **With a server Will allowed**, a turn that stays "here" was answered on that server, and
  every sentence that says where an answer stays names it (only then: the switch vouches for the
  model server itself, so with the local model on this Mac no sentence names a second machine,
  and none is used): "Every answer stays on this Mac or the
  model server you allowed.", "...and a private message never leaves this Mac or the model server
  you allowed." That server is held as this Mac is by the one rule that decides where "here" is
  (`brainIsLocal`, below), on its own Ollama's word that the model runs on it: it reads its own
  private turns back as history, is given the facts learned from them, and is given Will's goals
  when the goals block is on. No other server is, whatever it lists.
- **Node's env proxy.** With `NODE_USE_ENV_PROXY=1` (or `--use-env-proxy`) and a proxy named,
  Node sends every request through the proxy, loopback included. A model server whose host is
  not named in `NO_PROXY` is then not "this Mac": Local and Hybrid do not use it, a private
  message is refused, and the boot log says to add the host to `NO_PROXY`. The status command
  does not send its token through the proxy either: it answers from the shell's settings and
  says what to change.
- **An eval replay** (`/generate` with `eval: true`) measures the model it named, so it is not
  routed by the hybrid rules. In the cloud and hybrid modes it runs as before. **In Local mode a
  replay that would go to a cloud model is refused** (409: "Flint is in Local mode, which never
  uses the cloud, so this eval replay was not run. Switch the mode, or replay it on a local
  model."); one that names a local model (`localModel`) runs. A `localModel` that is an Ollama
  cloud tag is refused in every mode.
- **Privacy covers history, memory and speech.** A turn Will kept on this Mac (Local Only, "keep
  this private", or any turn in Local mode) is marked where it is stored (`src/private-turns.ts`:
  `{ private: true }` in the turn's call context). The mark is one of the two that keep a stored
  turn here, beside the mark of a turn answered with his goals, and everything that follows from
  it is the one mechanism described under "Goals in chat" (`src/goals-now.ts`,
  `src/goals-chat.ts`). A turn can carry both marks.
  - *History.* A brain that is not on this Mac never gets the turn back: the question and the
    answer are left out, and one neutral exchange stands where they were ("[An earlier part of
    this conversation isn't shown here.]"). A brain on this Mac reads it, and its own turn is then
    kept private too.
  - *Memory.* What Flint learns from such a turn is marked (`fromPrivate` in
    `~/.flint/memory/knowledge.json`), on both paths a fact is learned by: the `remember` tool
    (the turn is offered the build that marks what it saves) and memory extraction. A marked fact
    is recalled only for a brain on this Mac. An outside model's own `remember` is answered
    "saved" for a marked fact's very words, as if it were not there, and `/generate`, which has no
    per-ask gate, recalls only the facts any brain may have.
  - *The extractor reads such a turn only on a brain on this Mac.* Not on the frontier
    (`FLINT_MEMORY_BRAIN=frontier`), and not on the local kind when `OLLAMA_HOST` is another
    machine. A call holds turns of one kind of mark, and is shown only the known facts held no
    more closely than its turns. A turn the extractor skips is never mined, so while where its
    own model runs is simply not known yet (Ollama has just started, or is restarting) the pass
    waits and skips nothing: the log says "waiting: the model server has not said that the memory
    model runs on this Mac", and it checks again in a minute and a half.
  - *Speech.* The reply is never sent to an outside speech service. The server says so ahead of the
    reply (`{ type: "meta", staysHere: true, turn }`), and `/speak` refuses it by the turn it
    stored (409), whatever the client sends: see "Two promises".
  - *`FLINT_GOALS_TO_FRONTIER=on` lifts none of this.* That switch sends Will's goals, the turns
    answered with them and the facts learned from them to any brain. It is about his goals, not
    about what he asked to keep private.
- **Two promises, and they are not the same** (`src/outside-ai.ts`):
  - **A private message** (the Local Only switch, or a message that asks to stay private):
    **nothing leaves this Mac.** The turn is offered only the tools on an explicit list of ones
    that run here: Flint's own memory, its own status, the calculator, and the runtime's reads of
    this Mac's own data. No web search of any kind (a keyless search still sends the question to
    search engines), no page fetch, no Google tool, no deep research. Any other tool that is
    called anyway refuses, and a model that names one the turn was not offered is told why in the
    same sentence, not "Unknown tool" (one rule object decides both; `FlintConfig.unknownTool` in
    @flint/core carries the answer). The model is told so in one sentence, so it does not promise a search
    it cannot make (and where the message stays, in the words Settings uses: "this Mac", or "this
    Mac or the model server you allowed"). `/speak` refuses the reply by the turn the server
    stored (409, `fallback: "browser"`): the client names the conversation and the turn, and a
    request that names neither, or a turn that is not there, is held to the strictest answer. A
    turn that may be spoken vouches for its own words and no others: the text sent with it must
    be part of that turn's reply (what the server streamed for it, or the reply it is stored with,
    compared word by word, as it came or made sayable the way the console does:
    `src/spoken-text.ts`), so another reply's words under an ordinary turn's name are refused. A
    request that names only a conversation names no reply at all, and is refused while any turn
    that conversation still carries stays here. The
    console never asks for such a reply, and speaks it with a voice the device makes itself: a
    browser's network voice is not used for it, and with no voice of the device's own the reply
    is shown and not spoken.
  - **Local mode, an ordinary message: no outside AI and no paid service.** Keyless web search,
    the page fetch and the account tools remain. A turn that was routed in Local mode keeps that
    rule to its end, even if the mode is changed while it is still running.
  So "stays here" (private, or any turn of Local mode: history, the training corpus, speech) and
  "explicitly private" (tools) are kept apart in the code.
- **The training corpus.** A turn that stays here is written to `~/.flint/training/corpus.jsonl`
  with `staysHere: true`: by its route (private, or Local mode), or because the brain that
  answered was given something that stays here (a private turn in its history, a marked fact,
  Will's goals). It is training data for a model on this Mac. Nothing that builds a set
  for an outside model or a judge takes it: `apps/parity` drops a marked row before it looks at
  anything else, and reports how many it left out.
- **One answer to "is this brain on this Mac?"** `brainIsLocal` in `src/policy.ts`: a local wire
  (`ollama`, or `local` for the OpenAI-compatible adapter), an address that is this Mac (or the
  one server Will allowed) and is not reached through a proxy, a model that is not an Ollama cloud
  tag, and the server's own word: an Ollama's that the model runs on it, or, on the `local` wire,
  that it is no Ollama at all. No word yet is "not local", on both wires. The facade tells that rule what the
  settings say about addresses when it is built (`setPlaceRules`); nothing else decides it.
  History, recall, memory extraction, the embedder's rule for marked facts and the plan for a
  turn that stays here all ask it.

**Known limits.**

- *Two seconds.* Where something that stays here is handed to a model on a local wire, its
  server's word was asked for two seconds ago at most. A name pointed at a cloud model inside
  those two seconds, or while a request to it is already on its way, is seen by the next one.
- *A server that stops listing.* It is no longer believed for five minutes (see above): the
  first caller that waits for its answer and gets none drops what it said, and it is then left
  alone for two seconds, so it is not asked at every call. Three things remain. The asks made
  in the background drop nothing by themselves, so what was last heard stands until someone who
  needs it asks (five minutes at most). A turn that arrives while a look is already out waits
  for that look, so a server that has just come back can cost the next turn one more sentence.
  And what is not a turn of Will's (the tools' descriptions embedded while Flint boots, and an
  ordinary turn's words in Hybrid mode, which may go to the cloud anyway) is held from a helper
  model only when the model is KNOWN to run on Ollama's servers: one whose server has gone silent
  is still asked. A private message, every turn of Local mode and text that stays here are held
  to the strict rule.
- *An ordinary Cloud-mode turn and a model server that answers nothing.* The tool router and
  recall embed an ordinary turn's words at Ollama with no deadline of their own. With the whole
  model server hung (it accepts the request and never answers), an ordinary Cloud-mode turn
  waits on that request, as it did before the modes existed. A private turn and a turn of Local
  mode get their sentence at two seconds.
- *A tier on a server that wants a key.* A tier's server is asked for its listing without a key
  (only the main model server's looks carry `FLINT_LOCAL_API_KEY`). A tier on an
  OpenAI-compatible server that wants one on every path, and is not also the main model server,
  is never heard, so it is never a brain on this Mac. One that IS also the main model server is
  heard through the main model's looks; a tier's own keyless ask of it, when that word is more
  than two seconds old, gets no answer and drops it until the next look.
- *A program that passes requests on.* A program at a loopback address that forwards to a cloud
  service answers like any server that is no Ollama, and Flint cannot tell it from one. Point the
  local wire only at a server that runs its models on this Mac.
- *`remember`, for a fact's exact words.* An outside model that already has the exact words of a
  fact Will forgot is told "already known" where a fact Flint never held is "saved" (see "Goals
  in chat"). No text is handed out.
- *Goals from chat.* A turn Will asked to keep private is never asked for a goal, even when it
  holds one, and neither is a turn of Local mode that was handed one; a turn taken in Local mode
  that read none is. See "Goals and commitments from chat".

**To switch modes** (no code, no restart):

1. In the console, open Settings (the gear, bottom left) and find BRAIN.
2. Under Mode, press Local, Hybrid or Cloud. The sentence under the buttons says what the mode
   does, and the choice is saved.

Or from Terminal on the Mac that runs Flint:

1. Open Terminal and go to the folder Flint runs from (on the Studio: `cd ~/flint`).
2. Run `pnpm --filter server inference-status -- --mode local` (or `hybrid`, `cloud`, or `reset`
   to go back to the default).
3. The command needs Flint's access token, which it finds by itself in the file `~/.flint/token`.
   If that file is not there, give it for this one command:
   `FLINT_TOKEN=<your token> pnpm --filter server inference-status -- --mode local`.
4. It prints "The mode is now local (it was cloud)." and then the status. If it prints "The mode
   was not changed", the rest of that sentence says why (Flint is not running, or the token was
   refused).
- In the cloud mode "cloud" means the frontier tiers as configured (`FLINT_TIER_*`), which can
  themselves be a self-hosted model.

```
[inference] mode=cloud (default)
[inference] mode=hybrid (saved in Settings; env says cloud)
[inference] mode hybrid -> local (console)
[inference] FLINT_INFERENCE_MODE is not one of local, cloud, hybrid; running as local, which never uses the cloud
[inference] cloud call refused in local mode (kind=plan)
```

### Hybrid rules

In the hybrid mode a rule table decides, per message, whether this Mac or the cloud answers. The
table is data in one module, `src/hybrid-rules.ts`, and that module is the place to tune it: delete
a row, reorder rows, or change a row's side. The first rule whose conditions all hold decides.

| # | Rule | When | Goes to | If that side cannot answer | Why |
| --- | --- | --- | --- | --- | --- |
| 1 | `private` | the message is private | this Mac | it is not answered | A private message stays on this Mac. |
| 2 | `media` | it carries a file the local model cannot read | the cloud | it is not answered | An image or PDF goes to a model that can read it. |
| 3 | `local_unavailable` | the local model is not available | the cloud | it is not answered | The local model is not available. |
| 4 | `cloud_unavailable` | no cloud model is configured | this Mac | it is not answered | No cloud model is configured. |
| 5 | `deep` | a deep answer was asked for | the cloud | this Mac answers | Will asked for a deep answer. |
| 6 | `tools_unsupported` | the message needs a tool, and the local model cannot call tools | the cloud | this Mac answers | The message needs tools and the local model cannot call them. |
| 7 | `tools` | the message needs a tool | the cloud | this Mac answers | The message needs tools. |
| 8 | `long_context` | the conversation is long for the local window | the cloud | this Mac answers | The conversation is too long for the local window. |
| 9 | `difficulty` | the tier is hard or code | the cloud | this Mac answers | The message is hard reasoning or code. |
| 10 | `default` | always | this Mac | the cloud answers | Everything else is answered on this Mac. |

- A **private** message is one sent with Local Only on, or one that asks to stay local ("keep this
  private", "on-device"). It never leaves this Mac: if no local model can answer, it is not answered.
  That is decided BEFORE the table is read (`finishRoute` in `src/mode-route.ts`), so deleting or
  reordering the `private` row cannot send a private message to the cloud. The row documents the
  rule; it does not carry it.
- A **deep** answer is asked for with `deep: true` on the request, or in Will's own words: "think
  hard", "go deep", "deep dive", "in depth", "use the big model". Only his own instruction counts
  (`asksDeep`): the phrase must be outside quotation marks, code and quoted lines, and in the first
  or last 160 characters of the message. A pasted email that says "use the cloud model" does not
  choose the model.
- A message **needs a tool** when the tool router is confident about a tool beyond the always-on
  ones (the same signal that moves a routine message to the standard tier).
- The conversation is **long** when the message and the history it is sent with are over 75% of the
  room in the local window. The room is the window less a reserve for the guide, the tools and the
  reply: 4,096 tokens, and never more than half the window (`HYBRID_THRESHOLDS`). A 4,096-token
  window has 2,048 of room. (With a flat 4,096 a small window had none, every message was "long",
  and a hybrid machine with a small model sent everything to the cloud.)
- The **tier** is the classifier's: `hard` and `code` messages go to the cloud. Delete the
  `difficulty` row to keep them here.
- "A cloud model is configured" is all the table asks of the cloud. A spent budget or a paused
  provider is applied afterwards, as in the cloud mode, and turns such a message into a local one.

### Health

Behind its boot (the server is already listening), and then on a timer in the local and hybrid
modes, Flint looks at the model server (`src/local-monitor.ts`). The looks are read-only; a turn
reads the last result, taking a fresh one first when that is older than half a second (below).
Until the first look lands, the status says "Flint is checking it." Per model:

| State | Meaning |
| --- | --- |
| `loaded` | In memory, at the context Flint sends. Ready. |
| `cold` | Installed, not in memory (or in memory at another context, which Ollama would reload). |
| `loading` | Flint's own warm-up is running, or the server says it is loading. |
| `unavailable` | The server does not answer (`unreachable`), the model is not downloaded (`not_installed`), the address was refused (`config`), or no model is chosen yet (`unsettled`: see "The local brain is always Ollama"). |

```
[local] primary muse-glimmer:30b: loaded (context 16384)
[local] provider=ollama wire=native server=ollama 0.34.4 host=127.0.0.1:11434 loopback=yes
[local] primary muse-glimmer:30b: loaded -> cold
[local] primary muse-glimmer:30b: cold -> loading (warm-up started)
[local] primary muse-glimmer:30b: loading -> loaded (context 16384, 8412 ms)
[local] primary llama3.2:3b: unavailable (not_installed). To download it, run: ollama pull llama3.2:3b
```

Flint never downloads a model. When one is missing it prints the command and Will runs it.

- **A turn is planned from a fresh look.** If the monitor's last look is older than half a second
  when a local turn arrives, the turn waits up to 400 ms for a new one (`FRESH_FOR_MS`,
  `FRESH_WAIT_MS` in `src/inference.ts`). A model that left memory since the last timer tick is
  then seen as `cold`, and the turn is not the request that loads it.
- **A main model that leaves memory is loaded again**, once, after it has answered a turn, in the
  local and hybrid modes (never by a status command, and not in the cloud mode). How long a model
  stays in memory is the server's own setting (Ollama's `OLLAMA_KEEP_ALIVE`): Flint does not pin
  it, so with a short keep-alive the model is reloaded once each time it leaves and is used.
- **Flint never asks for more context than the model has.** `OLLAMA_NUM_CTX=32768` for a model
  whose maximum is 8,192 is sent as 8,192 (Ollama's `/api/show` says the maximum). Without that the
  model was "in memory at another context" for good: cold, warmed, loaded at its maximum, cold again.

### Deadlines

A cold local model does not fail, it makes the turn wait. In the local and hybrid modes a turn
has hard deadlines instead: the server must accept the connection (`FLINT_LOCAL_CONNECT_TIMEOUT_MS`)
and the model must send a first token (`FLINT_LOCAL_FIRST_OUTPUT_TIMEOUT_MS`; reasoning counts).
Past one, the call ends with a `timeout` whose code is `first_token_timeout`. It is not retried on
the same model. The cloud mode has no such deadlines: it behaves as before.

**Every local call is under the first-token deadline, on both wires.** On Ollama's own API a
pass that is offered tools is one whole reply: the model decides on a tool before it says
anything. Flint asks for that reply as a stream and folds the pieces back into one, so it can
time the first piece. A main model that is in memory and then stalls gives way to the standby
after the first-token deadline (20 seconds by default), not after the whole request's 120. The
OpenAI-compatible wire streams every pass already.

Once a reply has begun it may not go quiet for longer than `FLINT_LOCAL_IDLE_TIMEOUT_MS` between
one piece and the next (code `idle_timeout`): a model that sent one word and then nothing used to
be bounded only by the caller. The whole call is still bounded by
`FLINT_LOCAL_REQUEST_TIMEOUT_MS` (code `request_timeout`). An error the server sends in the
middle of a stream is an error, never a reply that ended early.

### Warm start

A turn is never the thing that loads the main model. Each turn is planned once, from a fresh look
at the model server (see Health), and is only sent to a local model that is ready
(`src/local-serve.ts`):

| Main model | Standby | Local mode, or a private message | Hybrid, any other message |
| --- | --- | --- | --- |
| ready | any | main, then standby | main, then standby, then the cloud |
| not ready | installed | standby | standby, then the cloud |
| not ready | none | a sentence, never the cloud | the cloud |
| unavailable | installed | standby | standby, then the cloud |
| unavailable | none | a sentence, never the cloud | the cloud |

- **Not ready** is `cold`, `loading`, or slow to first token in the last 30 seconds.
- **The main model is loaded by the health monitor**, detached from the turn: at boot in the local
  and hybrid modes, and again whenever a turn finds it not ready. One load runs at a time. When it
  finishes, the **next** turn uses the main model.
- **No swaps mid-turn.** The plan is made once. Every pass of a turn's tool loop uses the model the
  turn started on.
- **A step gives way to the next only before anything was shown and before any tool ran**, and only
  for a failure that is the model server's own (the rule the cloud tiers follow, `mayAskAnother`).
  After that a failure is an error: a second model never starts the turn over and calls the tool again.
- **Hybrid, main model not ready:** the standby answers first, and the cloud only when no local
  model can. That order is one row, `HYBRID_WHEN_COLD` in `src/local-serve.ts`: make it
  `['cloud', 'fallback']` to prefer the cloud.
- **A private message, and every message in Local mode, has no cloud step.** With no local model
  to answer it gets a sentence, such as "Flint's local model is still loading. Try again in a moment."
- **None of this table applies in Cloud mode.** A local turn there goes to the main model, with
  no deadlines and no standby, and an eval replay measures the model it named. What is different
  in Cloud mode from before the modes existed is the list below.

### What is different in Cloud mode

Cloud mode is the default, so this is what a setup that sets nothing new gets. The requests sent
to the cloud tiers are the same, byte for byte, as before the modes existed. These things are
different:

1. **Which local model answers when none is named: no difference.** With `OLLAMA_MODEL` unset,
   Cloud mode still answers with the model Ollama has loaded, else one it has pulled. This
   machine's hardware tier chooses the model only in Local and Hybrid, where the monitor loads
   it ahead of any turn. Changing the mode chooses again.
2. **A small local window gets the compact style guide.** When the guide asked for would take
   more than half the local model's window (so at Ollama's default 4,096 tokens), the local brain
   speaks with `local-v1`, and the boot log says so.
3. **The local model is sent the history its real window holds.** At 16,384 tokens that is more
   than before; at 4,096 it is less.
4. **A local prompt is fitted to its window.** Tools give way first, the always-on ones from the
   end of their list before a tool matched to the message, then the oldest history. When the
   system prompt alone leaves no room for the question, the turn fails with `context_overflow`
   before anything is sent, where the model server used to cut the start of the prompt.
5. **After a private turn, a cloud model is not sent it as history, as memory or to be spoken.**
   One neutral exchange stands where it was, what Flint learned from it is not recalled for a
   cloud model, and `/speak` refuses its reply.
6. **A private turn is offered only tools that run on this Mac** (see "Two promises" above). It
   used to be offered every tool.
7. **A private turn is refused when the local model server is not this Mac**, unless Will
   allowed that server. It used to be sent there. The same when the local model is a cloud model
   under a plain name, which only Ollama's own listing shows.
8. **An Ollama model the tier table does not list is offered tools only when Ollama says it can
   call them.** A model nothing is known about is offered them as before.
9. **With the model server silent at boot and no model named**, a private turn gets a 503 with a
   sentence (it used to get a stream that ended in an error), a failing cloud model has no local
   fallback until the server answers, and the stand-in model is never asked (Flint used to ask
   for `qwen2.5:7b`, which made Ollama load it).
10. **A redirect from the model server is refused**, on every call to it.
11. **`FLINT_EMBED_MODEL` is checked.** A value that is not a model name, or is one of Ollama's
    cloud models, is ignored and said in the status; the tier table's embedding model is used.
12. **An error sent inside a stream is an error.** On Ollama's API and on the OpenAI-compatible
    wire, a reply used to end as complete with whatever had arrived.
13. **The breaker.** Its check asks any brain on a provider when none is usable, and `paused()`
    reads a provider's pause and a model's own.
14. **A client that is not fitted** (the cloud tiers) subtracts the system prompt and the tools
    from the room it gives the messages, never below half the window. No request changed in the
    comparison that was run.
15. **New things that are only added:** `route` on a reply's `meta` events and on `/generate`;
    `mode` and `localModelSettled` on `/health`; the `/inference` routes; `/speak` answering 409
    for a private turn's reply; `fromPrivate` on a fact learned from a private turn; new
    `[route]` fields; new boot lines; `staysHere` on a training corpus row.
16. **Behind the boot**, the server takes one look at this machine (two `sysctl` calls) and at the
    model server (about a dozen small requests in the first seconds). Nothing waits for them, and
    no timer watches the model server in Cloud mode.

**The standby model** is `FLINT_LOCAL_FALLBACK_MODEL`, or the hardware tier's standby model on an
Ollama server. `off` (or `none`) means none, a standby that is the main model is no standby, and two tiers
have none: the smallest, and the 8 GB tier (its smallest machine has no room for a second model).
On Ollama's own API it runs with thinking off, at the tier's standby context: 8,192 on the 16 GB
tier and up, 4,096 below (`FLINT_LOCAL_FALLBACK_NUM_CTX` overrides). It is
loaded at boot in the local and hybrid modes; how long it then stays in memory is the server's own
setting (Ollama's `OLLAMA_KEEP_ALIVE`). A standby that has dropped out of memory is still used: a
small model loads inside the first-token deadline. It has its own engine line, so it never claims
to be the main model, and shares the conversation store, so a conversation stays coherent
whichever answers. Flint never downloads it: when it is missing the status prints the
`ollama pull` line.

**The standby's prompt fits its window.** It used to be handed the default guide (about 3,980
tokens), a dozen tool schemas and half its window of history, in a 4,096-token window: about
twice what the window holds, and Ollama cuts the START of a prompt that does not fit, which is
the persona and the tools. Now:

- it speaks with the compact guide (`local-v1`, about 1,300 tokens), whatever the main model's;
- its prompt is sized to its window before it is sent (`fitToWindow` in @flint/core): tools give
  way, the last listed first (the core tools are listed first, so those stay), until the
  conversation has a quarter of the window; then the OLDEST history is left out. The newest turns
  and the question are always kept. Counted on the safe side (3 characters a token, 5% of the
  window left free);
- a guide that leaves no room for the question fails with `context_overflow` before anything is
  sent. Nothing is ever sent for Ollama to cut;
- the `[route]` line says what was left out, in counts (`fit`, see "Route log").

Every local model's prompt is fitted the same way. At 16,384 tokens nothing is left out.

**What a standby answer looks like.** The `/chat` meta event and the `/generate` response carry
`standby: true`, and the console tags the reply Standby. Once per conversation per day the answer
ends with one line, shown but never stored as the answer: "My standby model answered this while
my main model loads." (or "... because my main model isn't available."). The once-a-day slot is
used only when the standby actually answered. A standby answer is not written to the training
corpus.

**Three models in memory.** With a standby, the main model, the standby and the embedding model
are all loaded. Ollama holds at most three at once by default (`OLLAMA_MAX_LOADED_MODELS`), so
anything else that loads a model (a parity run, a memory model of its own, another app) pushes one
of them out. The health check then reports it `cold`; the main model is reloaded when the next
turn finds it so, and that turn is answered by the standby.

```
[local] standby llama3.2:3b: loaded (context 8192)
[local] primary muse-glimmer:30b: cold -> loading (warm-up started)
[local] primary muse-glimmer:30b: loading -> loaded (context 16384, 8412 ms)
[local] primary muse-glimmer:30b: loaded -> loading (slow to first token)
[local] the main model muse-glimmer:30b did not answer, moving on to the standby llama3.2:3b: timeout first_token_timeout
[local] the standby llama3.2:3b did not answer, moving on to the cloud: timeout first_token_timeout
```

**One place to ask "is a local model answering this turn?"** `isLocalTurn()`, exported from
`src/mode-route.ts` (it lives in `src/turn-taint.ts`). It is true inside every local model's
attempt, main or standby, in any mode, and false while a cloud model is asked, including the cloud
step of a hybrid turn. Paid helpers (the research planner, Perplexity) and anything that must only
reach a local model read it. `isPrivateTurn()` is its stricter sibling: true when Will also asked
for the turn to stay on this Mac, which is when every tool that does not run here is off for it.
`isStaysHereTurn()` is true for that turn and for any turn routed in Local mode. Whether a BRAIN
is local (for history and memory) is `brainIsLocal` in `src/policy.ts`; the two share one
definition of "local".

### Hardware tiers

Behind its boot Flint looks at the machine once (`src/hardware.ts`) and sorts it into a tier by
the memory a model can USE:

- **An NVIDIA GPU:** its VRAM (`nvidia-smi`, the largest single GPU).
- **An Apple Silicon Mac:** three quarters of its unified memory (`sysctl hw.memsize`). The rest
  is the system's and the apps': a model that takes all of a Mac's memory pushes everything else
  into swap. A 64 GB Mac has 48 GB for a model (the top tier), a 32 GB Mac 24, a 16 GB Mac 12 (the
  8 GB tier), an 8 GB Mac 6.
- **Neither, or a card too small for the smallest GPU row** (a 2 to 4 GB card): a CPU row, chosen
  by the machine's RAM. Under 8 GB, or with RAM that is not known, it is the smallest model
  alone, with no standby.
- **A check that does not answer** is a note in the status, and never a failed boot. An Apple
  Silicon Mac whose `sysctl` is silent is still tiered as one, by the memory Node itself reports
  (the same number); anywhere else, an `nvidia-smi` that is missing or silent means no GPU.

Memory rounds down to a tier, and a tier's number is reached at 93% of it: hardware sold at a size
reports a little less. A Tesla T4 (15,360 MiB) is the 16 GB tier, an A10G or L4 (about 23,030 MiB)
the 24 GB tier, an A40 (46,068 MiB) the 48 GB tier. A 12 GB card is still the 8 GB tier, and a
40 GB card the 24 GB tier.

One table maps a tier to a recommended model, the context to run it at, and a small standby model:
`HARDWARE_TIERS` in `packages/core/src/hardware-tiers.ts`. **It is the one place a local model is
named**, the embedding model included (`EMBEDDING_MODEL`, in the same file). To recommend a
different model for a class of machine, edit its row. Each row also carries the model's display
name, in brackets below: that is what the console shows. A tag appears only on the command line
and inside Copy Command; a model the table does not list gets a readable name made from its tag
("qwen3.6:35b" is shown as "Qwen 3.6 35B").

A test (`test/model-names-only-in-table.test.ts`) parses the source of the server (`src`,
`scripts`), of @flint/core and of @flint/persona with the TypeScript compiler, and fails when a
string, template or regular expression outside the table holds one of the table's tags, something
shaped like a tag, or the name of a model family. Comments may name a model. The exceptions are a
short list in that test, each with its reason: the speech-to-text program and its model file, the
word `llamacpp` (a kind of server), and the patterns that say what a family of models can do. It
does not read the other apps or the tests, and the README tables are compared with the table by
another test.

| Tier | Machine | Model | Context | Standby model | Standby context | Download | Measured |
| --- | --- | --- | --- | --- | --- | --- | --- |
| CPU, Low Memory | no usable GPU, under 8 GB of RAM | `llama3.2:1b` (Llama 3.2 1B) | 4,096 | none | none | 1.3 GB | recommended, unmeasured |
| CPU Only | no usable GPU, 8 GB of RAM or more | `llama3.2:3b` (Llama 3.2 3B) | 4,096 | `llama3.2:1b` (Llama 3.2 1B) | 4,096 | 2.0 GB + 1.3 GB | recommended, unmeasured |
| 8 GB | 6 GB to under 16 GB of usable memory | `qwen2.5:7b` (Qwen 2.5 7B) | 4,096 | none | none | 4.7 GB | recommended, unmeasured |
| 16 GB | 16 GB to under 24 GB of usable memory | `qwen2.5:14b` (Qwen 2.5 14B) | 4,096 | `llama3.2:3b` (Llama 3.2 3B) | 8,192 | 9.0 GB + 2.0 GB | recommended, unmeasured |
| 24 GB | 24 GB to under 48 GB of usable memory | `qwen3:14b` (Qwen 3 14B) | 16,384 | `llama3.2:3b` (Llama 3.2 3B) | 8,192 | 9.3 GB + 2.0 GB | recommended, unmeasured |
| 48 GB+ | 48 GB of usable memory or more | `muse-glimmer:30b` (Muse Glimmer 30B) | 16,384 | `llama3.2:3b` (Llama 3.2 3B) | 8,192 | 18.2 GB + 2.0 GB | yes |

- **Measured** means Flint's own parity harness has run that row's model on that class of
  hardware. Only the 48 GB+ row has (it is the model Will's bake-offs kept, at the context it runs
  at). The other rows are recommendations from each model's published size and capabilities:
  **recommended, unmeasured**.
- **Which model Flint uses**, in order: `FLINT_LOCAL_MODEL`, then `OLLAMA_MODEL` (Will named it);
  the tier's model when it is installed; what Ollama already has (loaded, else pulled); and
  otherwise the tier's model anyway, reported as not downloaded. `GET /health` says which as
  `localModelFrom` (`env`, `tier`, `loaded`, `pulled`, `default`).
- **Which context.** `OLLAMA_NUM_CTX` when set. Otherwise a model that is already in memory keeps
  the context it is loaded with, and the tier's model, when Flint is the one to load it, gets the
  tier's context. Memory extraction and background calls use the same number. The runtime's triage
  reads its own `OLLAMA_NUM_CTX`: set both to the same value, or Ollama reloads the model between
  them.
- **Flint never downloads a model.** One that is not installed is `unavailable (not_installed)`,
  and the boot log, the status command and Settings' Copy Command give the exact line to run:

  ```
  ollama pull <the tier's model>
  ```

- **`FLINT_HARDWARE_TIER`** (`cpu-small`, `cpu`, `8gb`, `16gb`, `24gb`, `48gb`) overrides the
  detection. Unset or `auto`: detect.
- **The main model's guide follows its window.** The default local guide is about 3,980 tokens,
  which is the whole of the 4,096-token context four of these rows run at. In a window the guide
  asked for (`FLINT_LOCAL_STYLE_VARIANT`, else `v1`) would take more than half of, the main model
  is given the compact guide (`local-v1`) instead, and the boot log says so
  (`[style] the local model's window is 4096 tokens, too small for the v1 guide: ...`). At the
  16,384 tokens the top two rows run at, the guide asked for is used. (`localStyleFor` in
  `src/style-variant.ts`.)
- **The embedding model** is one entry, the same on every tier. `FLINT_EMBED_MODEL` names
  another. The status says whether it is downloaded, with its `ollama pull` line when it is not.
- **No shell-injection path.** Detection runs two programs (`sysctl` on a Mac, `nvidia-smi`
  elsewhere) through four fixed commands: an absolute path chosen by platform, fixed arguments,
  `execFile`, no shell, an empty environment. No code builds a command from a string; the runner
  takes a key of a frozen table, and a path that is not absolute on its platform is never run.
- **A hard time limit, and never in the way of boot.** A command that has not answered in 3
  seconds is killed with `SIGKILL` and its pipes are let go of, and a clock ends the wait a
  quarter of a second later even if that never calls back. The server looks at the machine behind its boot: it is
  listening before the first command runs, and the status says "Flint is checking this machine."
  until the look lands.

```
[local] hardware: apple-silicon (Apple M5 Max), 64 GB; tier 48gb; recommended muse-glimmer:30b at context 16384
```

Every row's own files fit the smallest machine the row is given to: its model, its standby when
it has one, and the embedding model, against the least memory that reaches the row (a test checks
every row). That is why the 8 GB tier has no standby. It begins at 6 GB of usable memory (an 8 GB
Mac, a 6 GB card), where its model, a standby and the embedding model would be 6.3 GB; its model
and the embedding model are 5.0. A 16 GB Mac (12 GB usable) is on that row too, and has no
standby either: name one with `FLINT_LOCAL_FALLBACK_MODEL` if you want one there. Every row but
the last is unmeasured.

### Status

What Flint is running on, three ways over one function (`src/inference-status.ts`):

1. **The status command.**

   ```
   $ pnpm --filter server inference-status
   Flint is in Hybrid mode. Flint picks this Mac or the cloud for each message.
   This Mac's chip is Apple M5 Max, with 64 GB of memory, of which a model can use 48 GB. That is the 48 GB+ tier.
   The local model is muse-glimmer:30b with a 16,384-token context. It is ready.
   The standby model is llama3.2:3b. It is not downloaded yet.
   To download it (about 2.0 GB), run:  ollama pull llama3.2:3b
   The embedding model is nomic-embed-text. It is downloaded.
   A cloud model is configured.
   ```

   - **With Flint running** it asks the server, so the mode, the settings and the cloud side are
     the live ones. Its token is read as Flint's other commands read it: `FLINT_TOKEN`, else the
     file `~/.flint/token`.
   - **With Flint stopped, or with no token,** it still answers: it detects the hardware, reads
     the tier table, and takes one read-only look at the local model server. That answer is built
     from the settings of the shell it runs in, which may not be the running server's, and its
     last line says so: "This shows this shell's settings, not the running server's, and no cloud
     side: ...".
   - **A server that refuses the token** (401, 403) is not that case. The command says "Flint
     refused this command's token (401), so its status was not read." and stops: a wrong token is
     never mistaken for a status.
   - `-- --json` prints the object. Run it as
     `pnpm --silent --filter server inference-status -- --json`: without `--silent`, pnpm prints
     two lines of its own on stdout ahead of the object. With it, only the object is on stdout
     (every other line the command writes goes to stderr), so the output parses. The object's
     first field, `view`, says whose answer it is: `running_server`, or `this_shell` when it was
     built from the settings of the shell the command ran in.
   - `-- --mode local|hybrid|cloud|reset` switches the running server's mode, then prints the
     status. See "Modes" for the steps.
   - It never starts a model load, whatever the mode, never downloads a model, and never repeats
     an argument it did not understand (what was pasted there may be a token).
   - Its lines also carry: a mode in the environment or a saved mode that could not be read, what
     the hardware checks could not find out, each refused setting by key and reason, and the size
     of each download.
   - Exit codes: `0` done; `1` it could not be done, and the sentence on stderr says why; `2` the
     arguments were not understood.
2. **`GET /inference`** (full token): the same object.
3. **Settings, Brain** in the console: the mode, the local model and its state, the standby model
   and its state, the hardware, and anything that needs Will's attention (a refused setting, a
   mode that could not be read, a warning), each as a plain sentence. The console shows display
   names only ("Muse Glimmer 30B"), never a tag, a key or a path. The server writes every sentence
   it shows, so each is true for the mode Flint is in: the standby "answers while the main model
   loads" in the local and hybrid modes, and "Cloud mode doesn't use it." in the cloud mode. Until
   the first answer every row says "Flint is checking."; a status that cannot be loaded is one row
   with Try Again; a model that is not downloaded has a Copy Command button, which hands the
   clipboard the exact `ollama pull` line and nothing else.
   - A mode that is saved shows at once, from the save's own answer. One that could not be saved
     says so in one plain sentence ("Flint couldn’t save the mode."), never a browser's or a
     server's raw words, and the mode is then read again.
   - While Settings is open and a row is loading, being checked or not downloaded, the section
     looks again every five seconds.
   - **In Local mode the Local Only switch is on and cannot be changed**, with "Local mode keeps
     every answer on this Mac." Will's own choice is kept for when the mode changes.
   - With no cloud model set up, Hybrid and Cloud carry a notice: "No cloud model is set up, so
     this Mac answers everything." 

When the chosen model is not the tier's, the status says what the table would have chosen ("The
recommended model for this tier is ..."). Each model also carries its time to first token over
the last turns it served (`firstTokenMs`: p50, p95 and how many). It never holds the API key, a
token, or more of an address than `host:port`. Until the machine has been looked at (the first
moments after boot) it says "Flint is checking this machine.", and until a model is chosen it
names none.

`training_status` (the tool behind "what are you running on?") also reports the mode and the
local model's state.

### What the local model is told it can do

- **The history budget follows the real context.** With `OLLAMA_NUM_CTX=16384` the model's window
  is 16,384 tokens, whatever a built-in table says about its family, and the budget counts the
  system prompt and tool schemas too. (It used to be 4,096 for a model the table did not know, so
  about 2,000 tokens of history reached a 16K model.)
- **Tools only when the server says so.** A model the table does not know is `unsupported` until
  Ollama's `/api/show` says it can call tools. A model Ollama says cannot is sent none: it used to
  be sent them and answer 400 on every turn.

### Pictures and PDFs on this Mac

Two settings, **both off unless set**. Off, every request, route, refusal and status line is what
it was before they existed: a turn with a picture or a PDF goes to a cloud model that can read
it, and one that has to stay on this Mac (Local mode, Local Only, a message that asks) is
refused with a sentence. (Two things at the door changed for every turn, whatever is set: see
"What a file says is outside text" and "At the door" below.)

**`FLINT_LOCAL_VISION=on`: pictures.** On Ollama's own API, a local model its server says can
see (`vision` in `/api/show`) is sent a turn's pictures in the request's `images`, as Ollama
takes them. PNG, JPEG, GIF and WebP all go (each was checked against Ollama 0.34: the same words
were read back from all four). Which model can see is never a setting: the server is asked, a
model it has not said it of is sent none, and the standby is asked of its own model. On the
OpenAI-compatible wire a model that can see was already sent pictures; that is unchanged.

**`FLINT_LOCAL_PDF=spotlight` (or `pdftotext`): PDFs.** No local model reads a PDF, so a program
on this Mac reads its text and the local model is handed that, as a text file with the PDF's
name and a first line that says what it is (`src/pdf-text.ts`, `src/local-media.ts`):

- `spotlight` is the Mac's own PDF importer, the one Spotlight indexes PDFs with, asked for a
  test import (`/usr/bin/mdimport -t -d3 <file>`): the text is printed and nothing is stored in
  the index. Nothing is installed.
- `pdftotext` is poppler's (`brew install poppler`; Flint does not install it). It is looked for
  at `/opt/homebrew/bin/pdftotext` and `/usr/local/bin/pdftotext` and nowhere else.
- The program is run by its full path with a fixed argument list and no shell, with an empty
  environment, as the head of a process group of its own, with a cap on what it may print.
  Nothing from the PDF's name or its bytes is ever an argument. Two reads run at once and eight
  may wait.
- **Twenty seconds is how long Flint waits, not how long macOS works.** When the wait is over,
  the program Flint started is killed, with anything it started. But the Mac's importer hands
  the PDF to a system service, and that service goes on with it after Flint has stopped waiting:
  a review measured a 50,000-page PDF keep it busy for three and a half minutes, during which
  every other read timed out. So:
  - *What is plainly too much is refused before it is handed over:* a PDF over 10 MB, or with
    more than 1,000 pages by a count of its own bytes (the pages inside compressed object
    streams included). Each has its own sentence ("This PDF has more than the 1,000 pages Flint
    reads on this Mac, ..."). The importer takes about five milliseconds a page, so a thousand
    pages are about five seconds; and the local model is handed the first 32,000 characters at
    most, which is ten or twenty pages.
  - *After a read runs out of time the reader is busy:* every read is refused at once
    ("Flint's PDF reader on this Mac is busy right now, ... Try again in a moment."), nothing is
    queued behind a service that is stuck, and one small PDF of Flint's own is tried every few
    seconds until it comes back. Then reads go on. A busy reader never tells Will to send the
    PDF as text: the PDF is fine.
  - A small PDF can still hold a great deal (a compressed page that unpacks to a hundred
    megabytes). That is not seen before the read, and costs the Mac one such episode.
- The PDF is written to a folder of its own under the temp folder, readable by this user alone
  (0700, the file 0600), named so that Spotlight does not index it, and removed when the read
  ends: when it answers, fails, runs out of time or is called off, and when Flint is stopped in
  the middle of it (the folders of the reads under way are removed, and their programs ended, as
  the process exits). The one case nothing in the process can cover is the process being killed
  outright (`kill -9`, a power cut): that folder is removed the next time a PDF is read or Flint
  starts, whatever its age, because its name carries the number of the process that made it and
  that process is gone.
- **The text exists only inside the local model's request.** The stored turn keeps the PDF as
  it was sent, an outside model is handed the PDF itself or nothing, exactly as before, and the
  text is never logged, embedded or saved. A read is kept in memory for a while, by the PDF's
  contents, so the PDF is read once a turn.
- **It is sized to the model's window.** One message's PDFs share 35% of the window (22,936
  characters at a context of 16,384), and never more than 32,000 characters however large the
  window: a local model reads its prompt before it says a word, a turn waits twenty seconds for
  that word (`FLINT_LOCAL_FIRST_OUTPUT_TIMEOUT_MS`), and on this Mac 22,936 characters took about
  ten. A PDF that holds more is cut, and its first line tells the model how much it was given
  ("Only the first 22,936 of its 195,939 characters are below"), so the model can say so.
- **In Hybrid it counts toward the prompt's length.** The text a PDF comes to is part of what
  the long-context rule measures, so a long PDF on top of a long thread goes to the cloud like
  any other prompt that does not fit, unless the turn is private.
- **A PDF with no text in it is never answered blind.** A scan (pages that are pictures) has no
  text to read. A turn's PDFs are read before its route is decided, and a turn that stays here
  with one that did not come out as text is refused: "This PDF has no text in it that Flint can
  read on this Mac, and Local mode never uses the cloud. Send it as text instead." In Hybrid, a
  turn that is not private goes to a cloud model that reads PDFs, as it did.

What each mode does with a turn that carries a picture or a PDF the local model can read, with
the setting for it on:

| Mode | The turn | Who answers |
| --- | --- | --- |
| Local | any | The local model, on this Mac. |
| Hybrid | Local Only, or the message asks to stay private | The local model, on this Mac. Nothing falls through to the cloud. |
| Hybrid | any other | The rule table decides, as for a message with no file: the `media` rule no longer sends it to the cloud for being a file. It may fall through either way. |
| Cloud | Local Only, the message asks, or no cloud model is set up | The local model, on this Mac. (Off, this turn is refused.) |
| Cloud | any other | A cloud model, with the file itself, as before. A PDF is not read here for it. |

The rules a private turn already lives by hold for its files: the model server is asked what
runs on it before anything is sent, a model that is not known to run on this Mac is not asked,
and the stored turn is never handed to a brain off this Mac as history, picture and all. With a
setting on, a standby that cannot read the turn's file is not planned for it: the turn waits for
the main model with the usual sentence, or in Hybrid goes to the cloud when it may. (With
neither on, the standby is planned exactly as it always was.)

**A file's content goes only to a model server that is this Mac.** With either setting on, a
picture or a PDF's text is never sent to a local model server that is on another machine and
not vouched for, is reached through a proxy, or whose model runs on Ollama's servers whatever it
is called: on an ordinary turn as much as a private one, in every mode. The adapter then says a
file it cannot read is attached, as it did before the settings existed, the status says why
("Pictures for the local model are turned on, and the local model is not on this Mac, so none
is sent to it."), and a turn Cloud mode keeps here is refused as before. The one server Will
vouched for (`FLINT_LOCAL_ALLOW_REMOTE=1`, over https or on a network he called private) is held
exactly as a private message is held there: it is treated as this Mac, and is sent files too.

**The look at the model server is the last thing before the request.** A turn that stays here
is decided on what the model server said a moment ago. Every PDF the request will carry (this
turn's, and the ones earlier turns of the conversation still carry) is read before that look,
so the request waits for no read. If it does have to wait for one, for longer than the server's
word is good for (two seconds), the server is asked again before anything is sent, and the
request is not made if the model has been pointed elsewhere meanwhile.

**Right after a start** the model server has not yet said what its model can do. The first turn
with a file waits for that, three seconds at most, and is answered. One boot log line says
which of the two are on: `[local] on for the local model: pictures (FLINT_LOCAL_VISION), PDF
text by spotlight (FLINT_LOCAL_PDF)`.

**What the local model server says when it fails is not repeated,** with either setting on. An
error keeps its class (a timeout, a server that could not answer) and says a fixed sentence
("The local model server could not answer."): a model server's error is its own words, and a
review's stand-in put the request, picture and all, inside one, from where it was stored with
the failed turn and sent back to the client. With neither setting on an error is what it
always was.

#### What a file says is outside text

This holds whatever is set, in every mode, for local and cloud models alike, and it changed for
text files too. A text file, a PDF's text, and what a model says it saw in a picture are text
someone else may have written, exactly as a web page or an email is. A review's stand-in model
that obeyed whatever its prompt said ran `web.fetch_url` with an address from an attached PDF,
`web.web_search` and `trident.gmail_search`, and saved a "fact", with no approval, and did the
same for a `.txt` on main. So:

- **A turn that carries a file is tainted from the start** (`src/turn-taint.ts`), as a turn is
  after it reads a web page. What it leads to (anything that leaves this Mac, any write,
  `remember` included) is filed for Will's approval and does not run on the model's say-so.
  A turn he kept private keeps its own rules as well: it is offered only the tools that run here.
- **The fence around a file cannot be closed from inside it.** A file's text is sent between
  `<attached_file ...>` and `</attached_file>`. A file that held `</attached_file>` ended the
  fence early, and what followed read as Will's words. The bracket of anything that looks like
  the fence's tag is now written `&lt;` (`@flint/core` `insideFence`), for every model.
- **What follows from the mark, and should be known:**
  - *The conversation is marked too.* While that turn is in the history a later turn is handed
    (the history window, 48 hours unless set), the later turn starts tainted: a search or a
    write it asks for needs approval as well, though it carries no file.
  - *The memory extractor does not read that turn,* nor the later turns marked with it. A fact
    Will states in a message that carries a file is not learned from that message.
  - *A turn with a picture and a tool* asks first, where it did not: "search the web for what
    this screenshot shows" files the search for approval.

#### At the door

- **A PDF too large for the model that would answer is refused with the size sentence**
  (`report.pdf: larger than the 3 MB limit`, 413), in every mode. A prompt is sized at 2,000
  tokens for each 50 KB of PDF, so a model with a 200,000-token window takes about 3 to 4 MB.
  Until now such a PDF passed the door (its limit is 20 MB), and the message that carried it
  was then dropped to make the prompt fit: the cloud model was sent `"messages": []` and
  answered with an error. It is an error either way; now it is said before anything is sent.
  And the newest message is never dropped to fit any more (`@flint/core` `assembleContext`): one
  that cannot fit on its own is a `context_overflow`.
- **A text file that mentions a PDF's header is a text file.** A file is a PDF by its bytes: the
  characters `%PDF-` in its first kilobyte. A text file that held them a few lines in (notes
  about PDFs, a script that writes one) was taken for a PDF. When the header is not at the very
  start, and the file was sent as text and reads as text, it is the text file it says it is.

`pnpm --filter server inference-status` says each setting when it is on ("Pictures are sent to
the local model, which its server says can see."), and nothing about either when it is off.

**Turning them on.** Neither is on unless Will sets it. The server reads its settings at start:

```bash
grep -q '^FLINT_LOCAL_VISION=' ~/.flint/secrets.env || printf '\nFLINT_LOCAL_VISION=on\n' >> ~/.flint/secrets.env
grep -q '^FLINT_LOCAL_PDF=' ~/.flint/secrets.env || printf '\nFLINT_LOCAL_PDF=spotlight\n' >> ~/.flint/secrets.env
launchctl kickstart -k gui/$(id -u)/com.flint.server
pnpm --filter server inference-status
```

The last command asks the running server, and prints one line for each: "Pictures are sent to
the local model, which its server says can see." and "A PDF's text is read on this Mac for the
local model, by the Mac's own PDF importer." Then, in the console, turn Local Only on and attach
a picture: the line "Local Only is on, so Flint can't read images or PDFs." no longer appears,
and the answer comes from this Mac. To turn either off, remove its line from
`~/.flint/secrets.env` and kickstart again. The server's log says which are on, a line after
it starts: `grep 'on for the local model' ~/.flint/server.err.log | tail -1`.

Known limits:

- *A PDF is read as text.* Its pictures, its charts and its layout are not handed over, and a
  scan is refused. A cloud model that reads PDFs sees the pages; the local model reads the words.
- *`pdftotext` was not measured.* It is not installed on this Mac. Its arguments are the
  standard ones (`-q -enc UTF-8 -eol unix <file> -`), and it is tested with a stand-in only.
- *`spotlight` reads what the Mac's importer prints for a test import,* which is a debugging
  format. It was checked on macOS 27.0 with odd characters, a one-word PDF, a blank page, a
  sixty-page PDF and text made to look like the importer's own keys. If a later macOS prints it
  differently the read fails closed: the PDF is said to have no text, or the read to have
  failed, and the turn is refused.
- *An animated GIF is one picture* to the model server (its first frame).
- *An eval replay that names its own local model* (`localModel`, apps/parity) is asked through
  a client of its own, which sends no picture and reads no PDF. Such a replay with a file is
  refused as before; a replay on the main local model is answered with what it can read.
- *The console changes in one line.* It already attaches pictures and PDFs. Its note under an
  attached file ("Local Only is on, so Flint can't read images or PDFs.") now follows what the
  server says the local model reads (`localReads` in `GET /health`, given only when one of the
  two settings is on): no note for a file it reads, and only the other kind named for one it
  does not. With nothing set the note is the sentence it always was.

#### The vision benchmark

```bash
pnpm --filter server vision-bench                      # measure what is on this Mac, print the tables
pnpm --silent --filter server vision-bench -- --json   # the same, as JSON on stdout
pnpm --filter server vision-bench -- --help            # the options
```

It draws six pictures and writes four PDFs (synthetic: `src/synthetic-files.ts` makes them from
fixed words, so what each shows is known exactly), reads the PDFs with every PDF reader that is
already on this Mac, and puts one question a picture and one a PDF to the local model, through
the same adapter and the same wrapper a turn uses (`src/vision-bench.ts`).

What it never does:

- **It loads nothing.** Only a model that is ALREADY IN MEMORY on the model server is asked,
  at the context it is loaded with, and nothing about how long it stays loaded is sent. A model
  that is not in memory is not measured, and the output says so. The model server is looked at
  again at the end, and the output says whether the same models are in memory.
- **It downloads and installs nothing.** For a reader that is not here it prints the command.
- **It asks only a model server on this Mac**, and not through a proxy.
- **It reads nobody's file**, shows nothing and opens nothing.
- **It changes no setting.**
- **It asks no model that runs somewhere else.** Which of the server's models run on it is
  decided by the rule the server itself uses (`@flint/policy` `listedModels`): a listing row
  that says anything of a remote host or a remote model is not a model on this Mac, in memory
  or not.

The pictures, the PDFs and the results (`results.md`, `results.json`) are left in a dated folder
under `~/Library/Caches/Flint/vision-bench`, or wherever `--out` says, readable by this user
alone. Never under `~/.flint`: the nightly and the offsite backups carry that folder, so an
`--out` that is `~/.flint`, or inside it, or a link into it, is refused and nothing is written.

Measured on the Studio (Apple M5 Max, 64 GB, macOS 27.0.1, Ollama 0.34.4), 13 October 2026, with
the model that was in memory (`muse-glimmer:30b` at a context of 16,384), thinking off:

| Pictures | Right | Time to the answer | Tokens in |
| --- | --- | --- | --- |
| Six: words, two lines of words, colours, counting, a bar chart, a position | 6 of 6 | 1.3 to 2.2 s (median 1.5 s) | 225 to 314 a turn |

| PDF, read by `spotlight` | Text back | Read in |
| --- | --- | --- |
| Two pages, 174 characters | exact | 184 ms (the first read of the run) |
| One page, compressed, with quotes, brackets and a backslash | exact | 19 ms |
| Sixty pages, compressed, 195,939 characters | exact, 2,401 of 2,401 lines | 300 ms |
| One blank page | "no text", as it should be | 19 ms |

| A question about a PDF | Text given | Right | Time to the answer |
| --- | --- | --- | --- |
| The total on the two-page invoice | all 174 characters | yes | 2.8 s |
| A word from page one of the sixty pages | 22,936 of 195,939 characters (6,108 tokens) | yes | 11.0 s the first time, 2.3 s when the model server had just read the same text |

The same two models were in memory, at the same context, before and after. These are clean
synthetic pictures and PDFs: a photograph, handwriting or a dense table will do worse, and the
numbers say nothing final. No default was changed on the strength of them.

## Voice

Two small interfaces (`src/voice.ts`): `SttProvider` turns a recording into text, `TtsProvider`
turns text into audio. `/transcribe` and `/speak` call them, and which provider answers is a
setting. **The defaults are what Flint did before there was a choice: whisper.cpp hears, on this
Mac, and OpenAI speaks.** Nothing here changes either until a setting does.

| | Provider | What it is | Where the words go |
| --- | --- | --- | --- |
| Hearing (`FLINT_STT_PROVIDER`) | `whisper-cpp` (default) | whisper.cpp's `whisper-cli`, run once per recording | this Mac |
| | `local` | any OpenAI-compatible speech server (`POST …/audio/transcriptions`), such as whisper.cpp's own `whisper-server` | this Mac |
| Speaking (`FLINT_TTS_PROVIDER`) | `openai` (default) | OpenAI's speech API | **OpenAI** |
| | `local` | any OpenAI-compatible speech server (`POST …/audio/speech`) | this Mac |
| | `say` | the Mac's own voice (`/usr/bin/say`, written to a file and sent back as m4a) | this Mac |
| | `off` | no speech is made on the server: each device speaks with its own voice | nowhere |

| Setting | Default | What it is |
| --- | --- | --- |
| `FLINT_STT_PROVIDER` | `whisper-cpp` | What hears. |
| `WHISPER_BIN` / `WHISPER_MODEL` | `/opt/homebrew/bin/whisper-cli` / `~/.flint/models/ggml-base.en.bin` | whisper.cpp and its model, for `whisper-cpp`: a full path, or one that starts with `~/`. |
| `FLINT_LOCAL_STT_BASE_URL` | none | The transcription server's address, for `local` (`http://127.0.0.1:8178/v1`). |
| `FLINT_LOCAL_STT_MODEL` | `whisper-1` | The model name sent to it. |
| `FLINT_TTS_PROVIDER` | `openai` | What speaks. |
| `FLINT_TTS_MODEL` / `FLINT_TTS_VOICE` | `tts-1` / `onyx` | OpenAI's model and voice, for `openai`: plain names. |
| `FLINT_LOCAL_TTS_BASE_URL` | none | The speech server's address, for `local` (`http://127.0.0.1:8880/v1`). |
| `FLINT_LOCAL_TTS_MODEL` / `FLINT_LOCAL_TTS_VOICE` | `tts-1` / `alloy` | The model and voice names sent to it. |
| `FLINT_LOCAL_VOICE_API_KEY` | none | A key, for a speech server started with one. Never logged, never in a status. |
| `FLINT_SAY_VOICE` | the Mac's own | A voice for `say`, by its name (`Samantha`, `Daniel`). |

Every one is checked when Flint starts (`src/inference-config.ts`), and none can stop it. Each
is listed in `apps/studio/settings.manifest`: which provider and which model or voice are put
back by a rebuild, and a speech server's address and key are not (until they are set again,
what that server did is done without it: transcription runs on this Mac, and replies it spoke
are spoken by each device). A value is put back in the shape the server takes for it, so a
voice of the Mac's own keeps its brackets (`Eddy (English (US))`) and a voice on a speech
server may hold `:` and `/`.

**Four of them are older than the rest, and now apply from the settings file.** `WHISPER_BIN`,
`WHISPER_MODEL`, `FLINT_TTS_MODEL` and `FLINT_TTS_VOICE` used to be read when the server's code
loaded, which is before it reads `~/.flint/secrets.env`: a line for one of them in that file
was silently ignored, and only a LaunchAgent's value counted. They are read with every other
setting now, after that file, so a saved line applies. They are checked like the rest: a model
or a voice is a plain name, and a path is printable and bounded, so no line break or escape
of one reaches a log or a status.

**`WHISPER_BIN` and `WHISPER_MODEL` are full paths.** A path that starts with `~/` is read as
the home folder (neither the settings file nor a LaunchAgent expands `~`, and whisper.cpp
handed `~/...` fails every recording). Any other path that is not a full one (`~someone/...`,
a bare name, a relative path) is refused with a sentence, and the usual program or model is
used: a recording is never failed for a setting.

**A program or a model that is named and is not there is refused when Flint starts**, by the
name of the setting and never by its path, and the usual one is used. A program that is there
and may not be run (a file with no execute permission) is not there, for this: it fails every
recording just as a missing one does. This is the line saved
long ago: because nothing read these settings from the settings file before, one may name a
model that has since gone, and applying it would fail every recording. It is the same wherever
the value comes from, the settings file or the environment. When neither the one that was named
nor the usual one is on this Mac, `/transcribe` answers 503 with a sentence saying so
(`Flint can’t turn speech into text: its transcription model isn’t on this Mac.`), and not the
500 of a program that could not start. The program and the model are looked for at each
recording, so a model put in place while Flint runs is used by the next one. The Transcription
row in Settings follows the same look, taken when the status is built: `Flint can't turn speech
into text until its transcription model is on this Mac.` The console drops a failed
`/transcribe` quietly today (the microphone button stops, and nothing is said), so the sentence
is seen in Settings and by API clients, not under the input bar.

- **A refused setting never lands on a less private choice than the one that was meant.** A
  speech provider Flint does not know is NO speech here (`off`), never OpenAI: the default is an
  outside service, and a typo must not choose it. A transcription provider it does not know is
  whisper.cpp, on this Mac. `local` with no address, or with one that is refused, is whisper.cpp
  for hearing and `off` for speaking.
- **A local speech server is on this Mac.** Its address is `127.0.0.1`, `localhost` or `[::1]`.
  The one exception is the address of the local model server itself, when Will said that server
  is his (`FLINT_LOCAL_ALLOW_REMOTE`, over https unless he also called its network private): the
  switch vouches for that server and for no other machine, the same rule `OLLAMA_HOST` has. Any
  other machine, and an address Node's env proxy would carry the request to, is refused, and
  the refusal names no switch, because none allows it. Whether an address is proxied is one
  rule, `@flint/policy`'s (the same one the model server is held to), and it reads the no-proxy
  list as Node does: an IPv6 address needs its brackets (`[::1]`), `*` means every host only as
  the whole value, and when both `no_proxy` and `NO_PROXY` are set it is the lower-case one
  that counts. `test/process/voice-proxy.test.ts` starts a real Node for each spelling and sees
  where a request goes. The server is reached through the
  guarded fetch: its origin and its two paths only, and never a redirect. Its key is
  `FLINT_LOCAL_VOICE_API_KEY`, never part of the address, never sent over plain http to another
  machine, never sent to OpenAI, and OpenAI's key is never sent to it. Its answers are read to
  a limit and no further: 32 MB of audio, 1 MB of transcript.
- **`say` is run by `execFile`**, with an absolute path and fixed arguments, never a shell. The
  text is in a file only this user can read, never an argument, so text that starts with a
  hyphen cannot become an option; the voice's name is held to a pattern before it is one; the
  files are removed whatever happens. It always writes to a file: nothing is played on this
  Mac's speakers.
- **`say` is held to a line.** Each reply is a program of its own, so two run at a time and
  forty more may wait: the console asks sentence by sentence, as fast as a reply streams in, and
  forty holds a whole long reply. One past that is answered 429 at once, with a sentence, and
  the device speaks it itself (not 503, which a client reads as "stop asking for ten minutes").
  A client that hangs up takes its reply with it: one that is waiting leaves the line, and one
  that is being spoken has its `say` stopped and its files removed.
- **One reply, one voice.** Once the console has spoken a sentence of a reply with the device's
  own voice (the server refused it, was busy, or failed), it speaks the rest of that reply with
  the device's voice and asks the server for no more of it, even for a sentence whose audio had
  already come back. A reply changes voice at most once, and never back. The hands-free client
  asks for a reply in one request, so it has always been one voice.

**Which replies an outside service may speak has not changed, and a voice on this Mac speaks
them all** (`src/speech-route.ts`). OpenAI is never given a reply that stays on this Mac (409:
a private turn's, any turn's from Local mode, one answered with Will's goals; see "Goals in
chat"), and is not called at all in Local mode (503). A provider on this Mac (`say`, `local`)
is asked neither question, because nothing it is given leaves. The clients follow the server:
the console and the hands-free client (apps/voice) never send a reply that stays here to
`/speak`, unless the `meta` event that names the reply also says `speechHere: true`, which the
server sends only when its own speech is made on this Mac. With the defaults the event is byte
for byte what it was. `/speak` answers with the kind of audio the provider made, and the
hands-free client plays it as that kind. From OpenAI that is `audio/mpeg`, whatever OpenAI
calls its answer: mp3 is what is asked for, and what a client was always told.

**The status says what speaks and what hears** (the status command, `GET /inference`, and two
rows in Settings, Speech and Transcription): a name and a sentence each, never an address, a
path or a key. At boot one line names both: `[voice] hearing=whisper-cpp (ggml-base.en.bin)
speaking=openai (tts-1, onyx)`. A local speech server is "on this Mac" or "on the allowed model
server" in that line and in every line of a status: its address is in neither.

**To try a voice on this Mac** (nothing below is the default, and each is undone by removing the
setting and restarting Flint):

- The Mac's own voice: set `FLINT_TTS_PROVIDER=say` (and `FLINT_SAY_VOICE=Daniel` for a voice
  other than the Mac's usual one). Nothing to install.
- whisper.cpp kept in memory, which is what makes it fast (see the numbers): run its own server
  on this Mac, `whisper-server -m ~/.flint/models/ggml-small.en.bin --host 127.0.0.1 --port 8178
  --inference-path /v1/audio/transcriptions`, and set `FLINT_STT_PROVIDER=local` and
  `FLINT_LOCAL_STT_BASE_URL=http://127.0.0.1:8178/v1`. Flint does not start that server, and
  with it down a recording is not transcribed: it wants a LaunchAgent of its own, which is not
  part of this change.
- A neural voice on this Mac: any server here that answers `POST /v1/audio/speech` as OpenAI's
  does, with `FLINT_TTS_PROVIDER=local` and its address. None is installed, and none was tried.

### The voice benchmark

```bash
pnpm --filter server voice-bench                      # measure what is on this Mac, print the tables
pnpm --silent --filter server voice-bench -- --json   # the same, as JSON on stdout
pnpm --filter server voice-bench -- --help            # the options
```

It measures the engines that are ALREADY on this Mac, through the same providers the two routes
use (`src/voice-bench.ts`):

- **Hearing.** Every whisper.cpp model in the folder of `WHISPER_MODEL`, two ways: one
  `whisper-cli` run per clip (what Flint does today), and through whisper.cpp's own server,
  which the command starts on `127.0.0.1` on a free port and stops when it is done (what the
  `local` provider would use). For each: the time a clip takes, the real-time factor, and the
  word error rate against the words that were said (`src/wer.ts`).
- **Speaking.** The Mac's own voices, into files: the time to the first and to the last audio,
  the real-time factor, and the speech heard back by whisper.cpp.

What it never does:

- **It records nobody.** The clips are synthetic: ten fixed sentences written for it, spoken
  into files by `say` in three voices at two speeds.
- **It plays nothing.** `say` is only ever run with a file to write to, and no player is run.
- **It installs nothing.** For a model or an engine that is not here it prints the exact command
  and what it takes on disk, for Will to run.
- **It asks the proxy rule before it starts its own server.** The transcription server it
  starts is at `127.0.0.1`. When Node's env proxy would carry a request for that address, the
  server is not started and no clip is posted to it, which matters most with `--clips`: those
  are recordings of a person.
- **It sends nothing off this Mac, and spends nothing**, unless OpenAI's speech is named with
  `--tts say,openai` AND a cap is given with `--budget-usd`. Then the estimate is printed before
  anything is sent (the ten sentences are under one cent on `tts-1`), and without a cap that
  covers it the command stops before a clip is made.
- **It changes no setting.**

The clips, the speech and the results (`results.md`, `results.json`) are left in a dated folder
under `~/Library/Caches/Flint/voice-bench`, or wherever `--out` says. That folder and everything
in it are readable by this user alone (0700, 0600). It is never under `~/.flint`: the nightly
and the offsite backups carry that folder, and they would carry every clip of every run.

For a model that is not on this Mac it prints the line that fetches it and the setting that
uses it. The setting is the full path (`WHISPER_MODEL=/Users/<you>/.flint/models/<file>`),
because nothing expands `~` in a setting.

**A paid run is outside Flint's spend record.** OpenAI's speech, when it is named and capped,
is called by the benchmark itself: the server's budget neither counts it nor stops it, and
nothing else keeps a record of it. The command says so before it sends anything, with the
estimate, and again when it is done, with the sentences and characters it really sent and what
those cost. Inside the run it stops before the sentence that would pass the cap.

How to read it: *median* and *slowest 5%* are the time one clip or one sentence takes, start to
finish. *Real-time factor* is that time over the length of the audio: under 1 is faster than
speech, 0.1 is ten times faster. *Word error rate* is the share of words heard wrong, missed or
added. The clips are clean synthetic speech, so a real voice in a real room will do worse than
these numbers; they compare the engines with each other, and say nothing final about any of them.

Measured on the Studio (Apple M5 Max, 64 GB), 13 October 2026, 60 clips, 161.5 seconds of audio:

| Hearing | Model | Median | Slowest 5% | Real-time factor | Word error rate |
| --- | --- | --- | --- | --- | --- |
| whisper.cpp, one run per clip (today) | `ggml-base.en.bin` (today's) | 200 ms | 227 ms | 0.075 | 0.9% (6 of 654 words) |
| whisper.cpp as a server on this Mac | `ggml-base.en.bin` | 52 ms | 83 ms | 0.021 | 1.2% (8 of 654) |
| whisper.cpp, one run per clip | `ggml-small.en.bin` | 313 ms | 354 ms | 0.118 | 0.0% (0 of 654) |
| whisper.cpp as a server on this Mac | `ggml-small.en.bin` | 78 ms | 88 ms | 0.029 | 0.0% (0 of 654) |

| Speaking | Voice | To first audio | Slowest 5% | Real-time factor | Heard back |
| --- | --- | --- | --- | --- | --- |
| the Mac's own voice (`say`) | the usual one | 721 ms | 750 ms | 0.246 | 0.9% word error rate |
| | Samantha | 844 ms | 874 ms | 0.287 | 0.9% |
| | Daniel | 696 ms | 760 ms | 0.230 | 0.0% |
| | Karen | 599 ms | 655 ms | 0.207 | 2.8% |

`say` hands back a whole file, so its first audio is its last. OpenAI's speech was not measured:
it is a paid service, and the run had no cap. No default was changed on the strength of these.

Known limits:

- *Synthetic clips only, so far.* No real voice, no room, no microphone: the accuracy numbers
  are a ceiling. For clips Will records, `--clips <folder>` hears them in place of the synthetic
  ones: each `name.wav` (or m4a, mp3) beside a `name.txt` holding the words said. They are read
  where they are and never copied. Keep them outside the repo.
- *`say` is not a neural voice,* and it is spoken whole before a byte is sent. No neural voice is
  installed on this Mac, so none was measured.
- *The local transcription server is not started by Flint.* See above.

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
- **What it learns from a goals turn stays here.** A turn answered with Will's goals
  in its context (see "Goals in chat") is sent in a call of its own kind, never
  beside an ordinary turn. A fact learned from it is stored with a mark and recalled
  only for a model on this Mac, and only such a call is shown the marked facts already
  known. A pass on a model that isn't on this Mac skips those turns.
- **Logs carry ids and counts only**, never a fact, a quote or anything Will or Flint
  said. The boot log names the model (`[memory-extract] on the local model ...`), and
  each pass logs one line of counts.

### Goals and commitments from chat

Off by default (P3 part 5). With `FLINT_EXTRACT_CANDIDATES=1`, the same pass also asks the
local model for any goal Will set, with his own words quoted. One that passes the checks below
becomes a card in Approvals ("Suggest a Goal from Chat"); nothing happens until he approves
it, and each card asks on its own. An approved goal lands in the Goals panel's Suggested tab,
never active.

Commitments (the things he says he will do) have their own switch,
`FLINT_EXTRACT_COMMITMENTS=1`, off, and it does nothing without the first. With it off the
model is asked for goals only, a commitment in its reply is dropped, and no commitment card
is ever filed. It is separate because an approved commitment has nowhere to be seen or removed
yet: no panel lists it and no route forgets it. Leave it off until one does.

- **Only a model that runs on this Mac is asked, and that is checked at every pass.** The
  setting's kind is not taken for it: each pass asks the same locality rule the chat's
  stays-here turns rest on about the extractor's own model. A local name that is backed by a
  cloud model, or an Ollama on another machine, suggests nothing and files nothing; the pass
  asks for facts alone, and the log says once that the setting is waiting for a model on this
  Mac (and once more when one is there). With `FLINT_MEMORY_BRAIN=frontier` the setting does
  nothing and says so at boot: the frontier's prompt never changes, and a suggestion in its
  reply is never read. With the setting off, the prompt and the request to Ollama are byte for
  byte what they were (a test pins both by their sha256), and turning it on does not re-read
  old chats.
- **Never from a turn Will asked to keep private. From a turn taken in Local mode, yes.** Two
  notions, the same two the tools follow (`src/private-turns.ts`). A turn *stays here* when he
  asked for it to be private or Flint was in Local mode: that is what history, memory and speech
  go by. It is *explicitly private* only when he asked: the Local Only switch, or a message that
  asked to stay private. Suggestions go by the second. A call about a turn he asked to keep
  private asks for facts alone, whatever the pass asks, and a suggestion in its reply is not
  read: a suggestion is his own sentence on its way to being a goal, and his goals can be sent
  to every brain (`FLINT_GOALS_TO_FRONTIER=on`). A turn taken in Local mode is asked like any
  other. Its suggestion is filed with the runtime on this Mac and needs his signature like any
  other, and **a goal he approves is then a goal like any he typed**: it is in his goals, and
  goes wherever his goals go. Once it is approved and active, the runtime's goal review sends
  its title and description (why it matters, its checks and its steps) to the runtime's review
  model on this Mac's model server, and the runtime today checks that server's address only,
  not what the server lists.
  - *How the two are told apart once stored.* The mark is still one (`{ private: true }`). A
    turn that Local mode alone kept carries a note on it (`byMode`). The note is written only
    when the turn was handed no turn he asked to keep private: a turn of Local mode whose
    conversation still holds one in what its model reads is stored as his own word, the same
    rule as outside Local mode (its model read the private thing, and may have said it back).
    A mark with no note is read as his own word: that is also every turn marked before the note
    existed. Everything else the mark does, it does for both.
  - *In a pass that asks,* the turns he asked to keep private are sent in calls of their own,
    and a turn that is shown one of them as its context is held with it. The facts are learned
    and marked as ever, and the pass line counts the turns that were not asked
    (`suggestion-private-turn`).
  - *What a private turn held stays out of every prompt whose answer can be filed.* A call that
    asks for goals is shown no known fact that came from a turn he kept private, whatever its
    own turns are (a fact does not say which kind of private turn it came from). A call that
    asks for facts alone is shown them as before.
  - *From a turn taken in Local mode, a card holds his words of that turn and nothing else.*
    Every word of the short text must be in his own message of that turn (not half of its
    content words, as for an ordinary turn): every word, counted in any script, with no word
    too common or too short to count, so a name that is also an everyday word ("May") or a word
    in another alphabet cannot ride along from the rest of the call. A plural or an "-ing" form
    of a word he used is his word. A day is kept only when he named it there ("March 3", "3/3",
    a written date): one the model worked out is left off, and the suggestion goes on without it.
  - *The call itself is decided where it is sent.* Whether a pass asks is read when it begins;
    a call that asks is sent as text that stays here, so it goes only to a model its server,
    asked a moment before, lists as its own.
  - A turn answered with his goals is asked, as before, and every suggestion goes only to a
    runtime on this Mac.
- **The quote check comes first, and no model takes part in it.** A suggestion is kept only
  if its quote, 12 characters or more, is in Will's own message of the turn it names, as whole
  words. Curly quotes and runs of whitespace are made alike on both sides; nothing else is.
  It is never matched against Flint's answer, the earlier turn shown for context, or another
  turn of the same call. A turn that read outside text is never sent to the model at all.
- **What is filed is his whole sentence, not the model's excerpt.** The quote is widened to
  the sentence or sentences of his message that hold it, in his own characters, so a "not" a
  few words earlier, a question mark, or "Dana wrote:" before a pasted line is always on the
  card. A line under one that ends in a colon is the rest of that sentence. A sentence that
  cannot be shown whole in 300 characters is not quoted in part: the suggestion is dropped.
- **One sentence, one suggestion.** A quote that overlaps one already kept from the same turn
  is dropped, however it is worded, so three readings of one sentence cannot take the day's
  three goal cards.
- **The short text is held to his message too:** at least half of its content words (every
  word, from a turn taken in Local mode), and every number in it, are in that same message. It starts with a capital letter, is 3 to 120
  characters as a goal's title is counted, and holds no control or format character (no
  direction override, no zero-width mark).
- **A day is the model's reading, and is shown as that.** It is kept only if it is a real day,
  not before the turn and not more than ten years out; one that has passed since is left off,
  and so is one he did not name himself in a turn taken in Local mode.
  The card and the form say "Flint read the day as Mar 11, 2027.", never that he named it. A
  turn over 30 days old is not suggested from.
- **It goes to the runtime on this Mac, and nowhere else** (`src/goal-candidates.ts`):
  one request to the runtime's `/v1/goals/candidates`, with the server's own token, 5 seconds
  at most. It is never written to disk and never retried: with the runtime down the
  suggestion is dropped and counted, and the pass goes on. A runtime at any address but this
  Mac's is sent nothing. A turn answered with Will's goals may be suggested from (everything
  stays here); the server keeps nothing about a suggestion but a count.
- **No tool reaches it.** No built-in tool and no tool of the runtime connector is named for
  either action or calls that route, and a tool call that names `goal.propose` or
  `world.commitment.from_chat` is refused at the gate: nothing is queued, spooled or sent.
  The runtime refuses the two actions from anything but its own intake as well.
- **It never holds up the facts.** The suggestions step runs after a call's facts are stored.
  A failure anywhere in it is counted (`suggestion-failed`) and logged by its kind, the facts
  are kept, the turn is marked read, and the pass goes on. A `FLINT_TZ` that is no time zone
  is said once and read as the runtime reads it.
- **Counts only.** Each pass's log line says how many were proposed, kept and filed. What was
  dropped is counted by reason (`suggestion-quote`, `suggestion-long`, `suggestion-overlap`,
  `suggestion-text`, `suggestion-kind`, `suggestion-turn`, `suggestion-date`,
  `suggestion-old`, `suggestion-known`, `suggestion-capped`, `suggestion-unreachable`,
  `suggestion-failed`) in `extract-state.json`, never as text.

Known limits:

- *The short title is the model's.* The quote is Will's; the few words above it are the local
  model's reading of them, held to his words by the rule above. Half of its words being his
  does not make it mean what he meant: he sees both on the card, and the form lets him change
  the title before the goal starts.
- *His own message can hold someone else's words.* A pasted email that says "I will send the
  report by Friday" is in his message, so it can be quoted. The card shows the whole sentence
  with whatever introduces it, and it is his to reject.
- *A suggestion can be lost.* With the runtime down when a pass runs, that turn's suggestions
  are dropped: the pass has moved on and does not read the turn again. So is one whose
  sentence runs past 300 characters.
- *Only the first message of a turn is read,* up to 8,000 characters.
- *A turn he asked to keep private is not asked,* even when it sets a goal, and neither is the
  turn right after it in a call (it is shown the private one as its context), nor any turn of
  Local mode in a conversation that still holds one. He can type the goal in the Goals panel.
- *What Flint recalled, in a Local-mode turn that is asked.* A turn of Local mode in a
  conversation of its own can be answered with a fact Flint recalled from a private turn, and
  that reply is in the call. Nothing of it can reach a card (the card is his words of that
  turn, and a day he named there), and the fact itself is not in the prompt; the reply's own
  words are.

| Var | Default | Purpose |
| --- | --- | --- |
| `FLINT_MEMORY_BRAIN` | `local` | `local`; `frontier`: the primary frontier tier, metered as `extract` and paused with other background work at 80% of its vendor's cap. Only when set, and never a fallback: with no frontier configured nothing runs, and a local model that is down is not replaced by the frontier. `off`: no extraction. Anything else is logged and read as `local`. |
| `FLINT_MEMORY_MODEL` | `OLLAMA_MODEL` | Another local model for extraction. One that isn't the chat brain's (compared as Ollama does: case aside, no tag meaning `:latest`) is unloaded after each request (`keep_alive: 0`), so it never holds memory the chat model needs, at the price of a load per call. A cloud model is refused. |
| `FLINT_EXTRACT_MAX_CALLS_PER_DAY` | 48 local, 24 frontier | Calls per UTC day: GPU time on the local model, dollars on the frontier. |
| `FLINT_EXTRACT_BATCH_CHARS` | 8,000 local, 24,000 frontier | Characters of transcript per call, at most (a small context window allows fewer). |
| `FLINT_EXTRACT_INTERVAL_MS` / `FLINT_EXTRACT_BACKLOG_INTERVAL_MS` | 6 hours / 15 minutes | Time between passes, and while a backlog remains. |
| `FLINT_EXTRACT_FIRST_PASS_MS` | 90 seconds | How long after the server starts the first pass runs. (The process test shortens it, so a real pass is part of what it checks.) |
| `FLINT_EXTRACT_MAX_TURNS` | 60 | Turns per pass. |
| `FLINT_EXTRACT_SKIP_CONVERSATIONS` | `^(bulk\|grow\|seed)-` | Conversations never read: synthetic training traffic. |
| `FLINT_EXTRACT_CANDIDATES` | off | `1`: a model on this Mac is also asked for the goals Will sets in chat (see "Goals and commitments from chat"). Unset, blank or `0`: off. Anything else is logged and read as off. It does nothing with `FLINT_MEMORY_BRAIN=frontier`, and waits while the extractor's model does not run on this Mac. |
| `FLINT_EXTRACT_COMMITMENTS` | off | `1`, with `FLINT_EXTRACT_CANDIDATES=1`: the things he says he will do are asked for too. Read the same way; alone it does nothing and says so. |

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

**Which provider served a turn, and why.** Each line also carries `mode` (the routing mode the
turn was decided in), `reason` (the hybrid rule that decided: `private`, `media`,
`local_unavailable`, `cloud_unavailable`, `deep`, `tools_unsupported`, `tools`, `long_context`,
`difficulty`, `default`; or `mode_local`, `mode_cloud`, `eval`), and `provider` (the adapter that
served the answer: `ollama`, `local` for an OpenAI-compatible local server, `anthropic`, ...).
Like the rest of the line, none of it is the message.

```
[route] {"ts":"2026-10-12T15:04:05.000Z","path":"chat","mode":"hybrid","reason":"default","tier":"standard","appended":[],"turns":2,"brain":"local","answeredBy":"muse-glimmer:30b","provider":"ollama","outcome":"answered","recall":"semantic","ms":9120}
[route] {"ts":"2026-10-12T15:05:00.000Z","path":"chat","mode":"hybrid","reason":"deep","tier":"hard","appended":[],"turns":0,"brain":"frontier","answeredBy":"anthropic:claude-opus-5-5","provider":"anthropic","outcome":"answered","ms":4210}
```

To count who served, and why: `grep '^\[route\]' ~/.flint/server.err.log | cut -c9- | jq -r '[.mode, .reason, .provider] | @tsv' | sort | uniq -c`.

**Which local model, and what the turn fell to.** A turn a local model answered has `local`:
`which` (`primary`, or `fallback` for the standby), `state` (the MAIN model's state when the turn
was planned: `loaded`, `cold`, `loading` or `unavailable`, which is why the standby was used when
it was) and `firstTokenMs`. `fellTo` says what the turn fell to when its first choice did not
answer: `fallback` (the standby), `cloud` (a hybrid turn no local model could answer), or `local`
(a cloud turn the local model answered). See "Local inference", Warm start.

```
[route] {"ts":"2026-10-12T15:06:00.000Z","path":"chat","mode":"hybrid","reason":"default","tier":"standard","appended":[],"turns":0,"brain":"local","answeredBy":"qwen2.5:7b","provider":"ollama","local":{"which":"fallback","state":"loading","firstTokenMs":640},"fellTo":"fallback","outcome":"answered","ms":2310}
[route] {"ts":"2026-10-12T15:07:00.000Z","path":"chat","mode":"hybrid","reason":"default","tier":"standard","appended":[],"turns":1,"brain":"frontier","answeredBy":"anthropic:claude-sonnet-4-6","provider":"anthropic","fellTo":"cloud","outcome":"answered","ms":3980}
```

To see how often the standby answered, and why: `grep '^\[route\]' ~/.flint/server.err.log | cut -c9- | jq -r 'select(.fellTo) | [.fellTo, .local.state // "-"] | @tsv' | sort | uniq -c`.

**What a local prompt left out.** A local model's prompt is sized to its window before it is sent
(see "Local inference", Warm start). When something was left out, the line has `fit`: the window
in tokens, how many messages were `dropped` (the oldest) and `kept`, and how many tools were left
out (`toolsShed`). `full: true` means the model's own count said the window was full after all
(97% or more), so a cut is never silent. Counts only: no tool's name and nothing of the
conversation. A line with no `fit` sent everything.

**A private turn** has `private: true`: Local Only, or a message that asked to stay on this
Mac. Nothing left this Mac for it. An ordinary turn in Local mode has no `private`: its `mode` is
`local`, it used no outside AI and no paid service, and it may still have searched the web. Both
are stored with the mark that keeps them out of an outside brain's history (see "Local
inference", Modes).

**A line is built from a list of fields** (`ROUTE_FIELDS` in `src/route-log.ts`), so the message,
the prompt and the answer cannot be in one, whatever a caller puts in the record. A value is a
number, a flag or a short one-line label.

```
[route] {"ts":"2026-10-12T15:08:00.000Z","path":"chat","mode":"hybrid","reason":"private","private":true,"tier":"standard","appended":[],"turns":14,"brain":"local","answeredBy":"llama3.2:3b","provider":"ollama","local":{"which":"fallback","state":"loading","firstTokenMs":910},"fellTo":"fallback","fit":{"window":8192,"dropped":9,"kept":6,"toolsShed":2},"outcome":"answered","ms":3120}
```

To see how often history was dropped: `grep '^\[route\]' ~/.flint/server.err.log | cut -c9- | jq -r 'select(.fit) | [.answeredBy, .fit.window, .fit.dropped, .fit.toolsShed] | @tsv' | sort | uniq -c`.

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

The Suggested tab (P3 part 5) lists what Flint heard Will say in a chat: each suggestion's
short title, "You said this in a chat on Oct 8.", and his own words in quotation marks,
whole and in his own characters. A title starts with a capital letter. **Make It a Goal**
opens the New Goal form with those words in it (the title, why it matters, and the day when
it is still ahead, with "Flint read the day as Mar 11, 2027." beside it: the day is the
model's reading, never called his); he adds how he will know it is done and signs once
(`POST /goals/:id/start`). That one signature starts the goal and sets the suggestion's own
waiting card aside. **Dismiss** asks first, in the footer, and promises only what is true:
"Flint sets aside “Run a half marathon”. If you say it again in a later chat, Flint may
suggest it again." Nothing more is suggested from what he said that time.

Approval cards now carry `kind`, `templateId` and `consequential`. The console never signs a
consequential card (every goal card, a plan change that is not a review's small one, and each
suggestion from chat, which the runtime files with the mark) under an earlier prompt or in
Approve All: each asks for its own touch. Which plan card is a small
one the console reads from the card's operations as well (a status, a date moved by a week or
less, a place), never from the template's name alone. A card that turns a source on, one that
adds a triage rule, and any rule card that lets something run alone ask on their own too.

**What you sign is what you can see.** Approve signs the card's stored args, whole, so Show
Details shows all of them, without looking like a JSON file:

- the card's own sentences (a goal's checks, a plan's changes, a rule), which quote only text
  that can sit in a sentence whole and as written;
- **DETAILS**: every other field under a Title Case label, its value in full. Text is never
  clipped (it wraps; long text is all there, folded behind Show All with a line that says how
  much more). A link and a file path are whole. A moment keeps its time and zone ("Oct 12,
  10:04 PM CDT"); a day is a day;
- **REFERENCES**: ids, refs, keys and hashes, each with its exact value. Nothing is hidden for
  its shape: an order code, an IBAN or a hex string is content, and shows where it sits.

One thing is kept back: the value under a key named for a secret (`token`, `secret`,
`password`, `signature` and their kin) reads "Hidden" with its length. The card then says so
in a sentence and asks on its own, and so does a card too large to list whole (past 300
values, or 8 levels deep). A test walks every kind of card's stored args and finds each value
on the opened card, and changes each one in turn to see the card change
(test/console-card-details.test.ts).

### Goals in chat

Off by default (P3 part 4). With `FLINT_GOALS_NOW=1`, a `/chat` turn can start from Will's
active goals: a short block in the turn's context (src/goals-now.ts), from the runtime's
`GET /v1/goals/now`.

**Goal text is personal, so only a model on this Mac reads it.** The block is handed out per
ask, not per turn: every time `/chat` asks a brain (a frontier tier, the next tier, the local
model it falls back to), that brain gets the block only if it is local. Local is decided in one
place, `brainIsLocal` in src/policy.ts, and means all four of:

- the provider is a local wire: Ollama's own API, or the OpenAI-compatible local adapter (never
  Anthropic, OpenAI or Perplexity);
- the model is not named as one of Ollama's cloud models (`...-cloud`, `:cloud`);
- its server is this Mac (`127.0.0.1`, `localhost` or `::1`), and not reached through Node's
  env proxy. An Ollama server on another machine (`OLLAMA_HOST`, `FLINT_TIER_OLLAMA_HOST` or
  `FLINT_FRONTIER_BASE_URL` set elsewhere) is not local. One exception, and it is Will's own
  word: the local model server he allowed with `FLINT_LOCAL_ALLOW_REMOTE=1` is held as this Mac
  is, so with that set his goal text goes to that server too (see "Modes");
- that Ollama itself lists the model as running on it. A name is not trusted:
  `ollama cp gpt-oss:120b-cloud mine` gives a cloud model a plain name, and Ollama's own listing
  still says where it runs (the check the model picker already makes). The server asks each local
  brain's Ollama at start and once a minute (src/ollama-locality.ts). It fails closed: until
  that Ollama has answered, and as soon as someone waits for its answer and gets none, none of
  its models counts as local, and a model it does not list never does.

So a turn Claude answers never holds a goal's words, an `ollama:` tier on this Mac does, and a
frontier turn that fails over to the local model gets the block only on that last ask. A test
proves it with a canary on real clients (test/goals-now.test.ts).

**One mark for "a model on this Mac is answering".** The server already marks a turn the local
model answers (`asLocalTurn` in src/turn-taint.ts). On such a turn deep research does not send
the question to its planner, a frontier model. That is all the mark does by itself: a plain
local turn's deep research still asks Perplexity's search once. A turn that carries what stays
here goes further, below: it is offered no tool an outside AI answers at all. The goals use
that same mark: an ask is given what stays here only when its brain is on this Mac *and* the
ask runs as a local model's turn. `/chat` and `/generate` enter the mark for the local model,
as before, and now also for a tier whose brain is on this Mac (`ollama:` at a loopback
address). The one change that brings: on a turn such a tier answers, deep research plans its
searches by rule, as it does on any local model's turn. When the local model is swapped at run
time (Ollama answered late), the gate is named again for the new one. Tests:
test/goals-local-turn.test.ts.

**One module makes every one of these decisions** (src/goals-chat.ts): which history a brain
reads, each ask's context, tools and mark, which asks run as a local model's turn, what the
extractor skips, whether the research planner is asked, and what a reply may be spoken with.
`index.ts` calls it and decides none of it; the tests drive the same module through whole chat
turns (test/goals-mini.ts).

Six more things follow the block, so a goal's words don't leave by another door:

- **What the model then says stays here.** A turn whose brain was given the block is marked,
  with the turn, from the moment it begins (`context: { goals: true }` on the stored turn). A
  brain that isn't on this Mac never gets that turn back as history: its question and its
  answer are both left out, and one neutral line stands where they were ("An earlier part of
  this conversation isn't shown here.", as a placeholder exchange so every provider still gets
  alternating turns). A brain on this Mac reads the whole conversation. Memory extraction
  skips those turns too when its brain isn't on this Mac (`FLINT_MEMORY_BRAIN=frontier`, or a
  local model on another machine), and does not show one as "earlier in this conversation"
  beside the turn after it. Tests: test/goals-history.test.ts.
- **The mark follows history.** A model on this Mac reads marked turns as history, so what it
  says next may repeat them. Its turn is therefore marked too whenever a marked turn is in the
  history it is handed (the store's window: 12 turns and 48 hours by default), whether or not
  that turn was given the block: the same mark, the same tools, the same rule for the
  extractor. That holds when the block did not fit, when the runtime did not answer, when no
  goal is active any more, and with `FLINT_GOALS_NOW` or every block turned off. A conversation
  with no marked turn in its window is untouched. The read itself is tied to the turn: a model
  on this Mac is handed marked turns only for a turn that is itself stored with the mark, so a
  turn stored without it can never have read one, even when a marked turn finishes between the
  moment an ask is built and the moment it reads its history. Tests: test/goals-carry.test.ts,
  test/goals-history.test.ts.
- **Spoken replies stay here.** `/speak` is OpenAI's speech service unless Will chose a voice on
  this Mac ("Voice"), so a reply that stays on this Mac is never sent to it. Ahead of each reply the chat stream's `meta` event says whether
  it stays here and which stored turn it is; the console then speaks it with the browser's own
  voice, and the hands-free client (apps/voice) with the Mac's `say`. The server refuses on
  its side too: `/speak` takes the conversation and the turn, and answers 409 with
  `fallback: "browser"` for a marked turn. A request that names a conversation and no turn is
  about that conversation's newest turn. A request that cannot be placed (it names nothing, or
  a conversation the store does not hold, or a turn that is not that conversation's) is held
  to the strictest answer: it is refused while any conversation's newest turn is marked, or a
  marked turn is among any conversation's last 12 turns of the last 48 hours. The first half
  of that has no time limit: a conversation that ends on a marked turn holds every such
  request until an ordinary turn follows it. Both clients start each reply as one that stays
  here, and only the server's `meta` event saying it may go out clears that.
  Tests: test/goals-chat.test.ts, test/console-speech.test.ts, test/voice-client.test.ts.
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
  A marked fact is sent to the embedder only when the embedder is on this Mac: with
  `OLLAMA_HOST` on another machine it is stored without an embedding, and recall matches it by
  its words. And a brain that may not know of a marked fact is answered as if it were not
  there: `remember` on an ordinary turn says "saved", never "already known", for a marked
  fact's words. Tests: test/goals-facts.test.ts.
  **Two things `remember` can still tell an outside model**, each only for a fact's exact
  words, and neither hands out any text. A fact Will has forgotten (removed in Memory) stays
  forgotten for every brain, so saving its exact words again answers "already known" where a
  fact Flint never held answers "saved", whatever marks the forgotten fact carried: a model
  that already had the words can learn that Flint once held them and Will removed them. And a
  marked fact that a newer one replaced, saved again by an outside model under its exact words,
  answers "saved" like any new fact; it loses its marks (the words are no longer only this
  Mac's) and stays replaced, so it is still not recalled. Both are older than local inference.
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
  with no room for one goal, it is left out. That ask is then an ordinary one (every tool, no
  mark) unless a marked turn is in its history or a marked fact in its recall. A prompt Ollama
  has to cut loses its start, which is the persona and the tools. Tests: test/goals-room.test.ts.

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
It is written once Ollama has said which models run on it, a moment after start. If no brain
here is known to be local it says so, and nothing is fetched. To turn it off, remove the line
from `~/.flint/secrets.env` (or set `FLINT_CONTEXT_BLOCKS=off`) and kickstart again.

**Measured** (P3 exit criterion 8): the block's size is on each turn's `[route]` line and in
its `chat.turn` event as `ctxTokens.goals`, measured on the context as it was sent to the
model (not the size the block was meant to have); the runtime rolls it up daily
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
  neither. Nothing removes a mark; `FLINT_GOALS_TO_FRONTIER=on` lifts the goals mark, and never
  the mark of a turn Will kept private (see "Privacy covers history, memory and speech").
- *A fact Will states twice.* If the very same words are saved again from a turn that does not
  stay here, they are no longer something only this Mac holds: the one fact loses its mark. A
  rewording is stored as a second, ordinary fact beside the marked one. One answer is wrong
  here: if the marked fact had already been replaced by a newer one, saving its words again
  is answered "saved", but the old fact stays retired and is not recalled.
- *The embedder still reads each question.* Recall embeds Will's message with the embedder at
  `OLLAMA_HOST` on every turn, as it always has. With that host on another machine, the
  question of a goals turn goes there too; only the marked facts are kept from it.
- *A model's place is known a little late.* Which models run on this Mac is asked of Ollama
  once a minute, and heard again at every look the health monitor takes at the model server (a
  turn in Local or Hybrid mode takes one when the last is more than half a second old). A name
  re-pointed at a cloud model with `ollama cp` is treated as local until the next listing.
- *The training corpus keeps answers.* Each answered turn is logged for Flint's own training
  (`~/.flint/training/corpus.jsonl`, on this Mac), the marked ones included, with
  `staysHere: true`. `apps/parity` drops such a row before it builds a set for an outside model
  or a judge; anything else that read the corpus would have to do the same.
- *A small context gets a small block, or none.* At the default 4,096 tokens the prompt is
  already near its limit with the tool schemas, so the block is often shortened or left out;
  the `[route]` line's `ctxTokens.goals` says what each turn got. A local model loaded with a
  larger context gets the whole block.
- *Holes in an outside brain's history.* With goals on, every turn a local model answers with
  the block (or with a marked fact) is marked, and so is every later local turn while one of
  those is in the conversation's recent history. An outside brain that answers a later turn of
  the same conversation sees the placeholder instead. It is told something is missing, never
  what.
- *The browser's voice for those replies.* A reply that stays here is spoken by the browser or
  by the Mac's `say`, not by the neural voice. A client that does not say which reply it is
  speaking (or names one the store does not hold) gets that voice for every reply while any
  conversation ends on a marked turn, with no time limit, or has one in its recent history.
- *The sizes are estimates.* The prompt is measured at four characters a token, without the
  persona's lessons; the 256-token margin is for what that misses.
- *A 30-second cache.* Goals read up to 30 seconds ago are still served: a goal finished
  a few seconds ago can appear in one more turn.

Chat has no goal tools: nothing in a chat turn can read a goal by asking the runtime, and a
goal or plan card filed from a chat is refused by the runtime.

## Predictions

The console's Predictions panel (the chart icon) reaches the runtime's prediction routes
through src/predictions-routes.ts, with the console's full token only (a voice or eval token
reaches none of them). It is the goals proxy's twin: every key, id and body (up to 16 KB) is
checked with @flint/policy's contracts before the runtime sees it, and every answer before
the console does; the card is filed with the runtime at once and never spooled; a runtime
that is down is a 503 and nothing changed; a write the runtime doesn't answer is a 504 that
says Flint isn't sure it went through; a refusal reaches the console only as one of the
fixed sentences, by its code; and a runtime without the routes is a 501, so the console
hides its Predictions button. No read takes a query, and every answer (this proxy's and the
goals proxy's) says `Cache-Control: no-store`, so nothing is left in a browser's disk cache.

A forecast's numbers include what Flint spends and the hours on the calendar, and a
question holds a prediction's words. They pass through this proxy from the runtime to the
console and go nowhere else in the server: it keeps nothing, pushes no note, puts nothing
in chat context, and logs statuses, field paths and references only. The runtime writes
every sentence the panel shows about a number, and the contract refuses a raw value beside
the words. `/predictions` is never reported back to the runtime as a `route.error`.

## Tasks and assets

The console's Tasks panel and Settings > Assets reach the runtime's task and asset routes
through src/tasks-routes.ts, with the console's full token only (a voice or eval token
reaches none of them, and no chat tool does: a model can neither read a task nor start
one). It is the goals and predictions proxies' twin: every id and body (up to 32 KB) is
checked with @flint/policy's contracts before the runtime sees it, and every answer before
the console does; a card is filed with the runtime at once and never spooled; a runtime that
is down is a 503 and nothing changed; a write the runtime doesn't answer is a 504 that says
Flint isn't sure it went through (the same form sent again is the same task and the same
card); a refusal reaches the console only as one of the fixed task sentences, by its code;
and every answer says `Cache-Control: no-store`. The one read with a query is the tab
(`?tab=active|finished`, and nothing else).

Before a new task is sent, its `params` are checked against its own kind of task's schema,
and the checked params are what goes to the runtime. Of what comes back: an answer about a
task is refused (502) unless its id is the one the path, or the form's key, names; a 2xx that
is not JSON is a 502, "The runtime sent an answer Flint can't read."; and an answer is cut off
at 1 MB while it is read, never held whole. A field path in a log line names only fields the
contracts know (anything a client chose reads as `?`), and is capped in places, depth and
length.

Tasks ship switched off (the runtime's `FLINT_ASSETS`). While they are, the runtime answers
every one of these routes with the code `off`, and the proxy passes on its one sentence:
"Tasks are turned off on this Mac." The console then hides the header's Tasks button,
Settings > Assets says that one sentence, and nothing in the panel writes until the runtime
answers otherwise (a button that did nothing says the sentence).

A server and a runtime of different versions can meet during an update. A runtime without
these routes answers 404 on a page (the assets, a tab, the form), which is a 501 here, and
the console hides what it cannot offer. An open task's `can.again` is optional: a runtime
from before Run Again does not say, and the console reads that as no. If that runtime is
asked to run a task again anyway, its "invalid" is a 501 here ("This needs a newer
runtime."), never a mistake of Will's.

A task's title and its result are Will's words, or a watched system's. They pass through
this proxy from the runtime to the console and go nowhere else in the server: it keeps
nothing, pushes no note, puts nothing in chat context, and logs statuses, field paths and
references only. `/tasks` and `/assets` are never reported back to the runtime as a
`route.error`.

In the console, the Tasks panel (the checklist icon) lists tasks under Active and Finished:
each by its title, the runtime's sentence for where it stands, and what it is about. An open
task shows its result (marked Outside Text), each check by name with Passed, Failed or
Waiting, and its details (Runs On, Asked By, Goal, Due, Chance It Passes, Cost). A button is
there only when the runtime's view of the task says it can be done now: **Cancel Task** (asked
in place first; unsigned while the task has not gone out, else its card), **Accept Anyway**
and **Reject Anyway** (their cards), **Run Again** (a new task like it, and its card), and
**Review Card** while a card of its own waits. **New Task** offers what the runtime's form
says can run now: today that is Watch a CI Run, with the runs Flint tracks by label, an
optional goal and an optional due date. The form's key makes a form sent twice one task; a
refusal by its code made nothing, so the key is dropped and the next press starts clean
(Run Again's key the same). Run Again is offered only for a task Will asked for that the
form would still offer today. With no asset on the list says "No Asset Is On"; a form with
nothing to offer says "Nothing to Run Yet".

A card filed from the panel is read back from the Approvals list and shown there and then
in the Approvals panel's own words, with everything it holds behind Show Details; Approve
signs exactly those args, with a fresh touch. Only a waiting card about a task or an asset
is ever shown to sign in the panel. Settings > Assets lists each asset with its sentence,
On, Off or Waiting, and the one thing that can be done with it now: **Turn On** (files the
card and shows it in the Tasks panel), **Turn Off** (asked in place first; unsigned, as the
runtime allows), or **Open Approvals** while its card waits.

In the approvals list (`GET /proposals`), a task's dispatch card carries `cost: { micros }`:
the estimate in the args Will signs, in millionths of a dollar, zero included. The card
shows it as "No Cost" or "About $0.25". No other card has one. The console reads the cost
from the signed args and holds the server's reading to it: when the two differ, or the
number is one no card could hold, the Cost row says "Flint couldn't read the cost." and the
card asks on its own. Only a cost that reads exactly 0 may share a prompt.

What a card's face shows is what Will signs, with one exception that says so. A card that
holds only its task's id (cancel, accept, and the two that end a task against its checks)
names its task from a read of that task: that row is marked "Looked Up", is never part of
the title or the sentence, and Show Details (signed fields only) says in one sentence that
the row above was looked up. A title the card signs is never replaced by a looked-up one.
The names are read before a list is drawn, for at most 600 ms, and a list is drawn once:
names that land later wait for the next load. A list that is read again never draws the
card that is open a second time: it keeps its rows and its buttons where they are, and
shows a looked-up name the next time it is opened. While an approval is in flight the list
is not drawn again and no other card is opened, approved or rejected (Approve All
included); what the approval said stays with its card, also when its panel was closed
before the prompt was answered. A prompt that never answers does not hold the panel: after
two minutes the list is let go, the card says the prompt was dismissed, and the list is
read again. Approve All lets go the same way, says how many of its cards still wait, and
signs nothing more.

The list says for every card whether it is a connected server's tool (`mcp`, true or
false). Whoever runs a server chooses its tools' names, so a tool can be called
`task.check_bar` or `goal.activate`. The console gives a card the words it keeps for one of
Flint's own (a goal, a plan, a rule, a source, a nightly job, a forecast, an asset, a task)
only when the list says the card is not a tool's and its kind is the kind the runtime files
that action under. Any other card under such a name is drawn as a tool's card ("Approve a
Tool Call", with its server and tool named), asks on its own, is left out of Approve All,
lights no dot and is not signed from the Tasks panel. So is a card that does not say (a
list from an older server): several of Flint's own are filed as tool calls, and without the
server's word nothing tells them from a tool of the same name.

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

A connected server's tools are named `server.tool`, and whoever runs the server chooses
both names. One may match an action of Flint's own: a server called `backup` with a tool
called `local` is `backup.local`, the nightly backup's action. That tool works like any
other, as `mcp:backup.local`, and is never run in the action's place: when you approve a
card of Flint's own, the server does not look for a wired tool, and the runtime hands that
card to no caller. At startup the log names such a server (`[mcp] the connected server
"backup" names a tool like one of Flint's own actions…`), by the server's name only.
Nothing is blocked. Rename the server in `mcp.json` if you want the two told apart at a
glance.

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

## Tests

```bash
pnpm --filter server test           # the unit tests, and the process test with them
pnpm --filter server test:process   # the process test alone
FLINT_TEST_REAL_SAY=1 pnpm --filter server test:process   # ...with the three that run the Mac's own `say` (a Mac only)
FLINT_TEST_REAL_PDF=1 pnpm --filter server test:process   # ...with the nine that read a PDF with the Mac's own importer (a Mac only)
```

Three process tests start the real `/usr/bin/say`, twenty and forty-five at a time, and compare
how long things take (`test/process/voice.test.ts`: a client that hangs up, the line of two
running and forty waiting). They are **opt-in**, by `FLINT_TEST_REAL_SAY=1`: `pnpm --filter
server test` is what the deploy gate runs on the live Mac, and a busy moment there must not
fail a deploy. `install-server.sh` clears that name before the gate's tests, so the gate can
never be opted in. With the name set, `say` is only ever run with `-o`, a file in the test's own
folder: nothing is played. What those three show is covered in the default run without the real
program: the line, the hang-up and the signal through an injected runner, and the hang-up on a
real server through the `local` provider and a speech stand-in that never answers. Nothing in
the default run compares one length of time with another.

Nine process tests read synthetic PDFs with the real `/usr/bin/mdimport`
(`test/process/local-media.test.ts`: the real server with `FLINT_LOCAL_PDF=spotlight`, a PDF
that gives the model orders, and the reader asked directly). They are **opt-in** the same way, by `FLINT_TEST_REAL_PDF=1`, and
`install-server.sh` clears that name too: the server runs the importer by its full path, so it
cannot be a stand-in there. In the default run the same code is held with a stand-in for the
program and a recording of what the importer prints (`test/pdf-text.test.ts`,
`test/local-media.test.ts`, `test/local-vision.test.ts`), the real server is started with
pictures on and with nothing set (`test/process/local-media.test.ts`), and the benchmark is run
whole on stand-ins (`test/vision-bench.test.ts`): no model is asked and no PDF program is run.

Voice is tested without a sound: `test/voice.test.ts` and `test/voice.integration.test.ts` (each
provider, with the programs and the network replaced; a mocked OpenAI-compatible speech server on
loopback, and a second live one that a redirect points at and that stands in for OpenAI, so which
key reaches which server is seen), `test/speech-route.test.ts` (which provider is given which
reply, and the line the Mac's own voice is held to), `test/wer.test.ts` and
`test/voice-bench.test.ts` (the benchmark, whole, on stand-ins: no program runs but a stand-in for
the transcription server), `test/process/voice.test.ts` (the real server started six ways: speech
off, a speech server on this Mac, the four older settings saved in its settings file, a stale
model line, nothing to transcribe with, and a transcription program that cannot be run), and
`test/process/voice-proxy.test.ts` (a real Node for each spelling of the no-proxy list).

**The process test** (`test/process/`) starts the real `src/index.ts` as a process of its own,
on a scratch HOME and free ports, against loopback stand-ins: a model server on Ollama's own API,
an outside brain on Anthropic's wire (so the frontier is a true outside wire), and two stdio MCP
servers with the real connectors' tool names. It reads what was really put on each wire: Local
mode makes no request to the outside brain; a private turn is answered here, is offered only
tools that run here, and never goes out later as history; a scoped token gets 403 on the mode
routes; a Local-mode search is the keyless one. And the four ways a private turn used to get
out anyway: what the model saved with `remember` on it, and what a real pass of memory
extraction learned from it, are never given to the outside brain; `/speak` refuses its reply
whatever the client sends (another reply's words under an ordinary turn's name included); and
with a main model that Ollama lists as running elsewhere (a cloud model under a plain name) a
private turn and every Local-mode turn get a sentence, and that model is never asked. The same
over the OpenAI-compatible wire: with the server called a plain OpenAI-compatible one, with the
server not up when Flint booted, and as a tier (which is handed no private turn, private fact,
goals turn or goals fact, while a real local model on the same wire is handed all of them). A
name pointed at a cloud model while the server runs is caught by the next private turn on
either route. With the local model on this Mac and `OLLAMA_HOST` on a machine the remote switch
does not vouch for, that machine is sent nothing that stays here (the fence can carry an address
that stands for another machine to a stand-in on this one, `GUARD_REMAP`, so the test reads what
it would have been sent). A tool held back on a private turn answers with the private rule's
own sentence, and a Local-mode turn still running when the mode changes keeps its search
keyless. Goals from chat are run after a real restart: the first server says a goal on an
ordinary turn, with Local Only on, in Local mode, and with both; the same HOME is then started
again with the setting on, and the Local-mode turn and the ordinary one are asked and filed
while the two he asked to keep private are mined for facts alone. And a tier's name is pointed at
a cloud model on the tiers' own Ollama while the server runs: the next ordinary turn asks that
server first, and the tier is handed nothing that stays here. Seven servers are started at once,
each on its own scratch HOME, and one of them once more later. The process is fenced
(`test/process/guard.mjs`): it can reach nothing but this machine, and none of the ports a live
Flint, its runtime, Nexus, Ollama or Postgres use. It takes about five seconds.

## Run locally

```bash
FLINT_TOKEN=dev OLLAMA_MODEL=qwen2.5:14b OLLAMA_HOST=http://127.0.0.1:11434 \
  PORT=8787 pnpm --filter server start
```
