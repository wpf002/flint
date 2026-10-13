# Flint

One swappable AI layer for all my apps.

## What it is

Flint is a standalone, provider-agnostic AI layer. Multiple apps consume it as a
single versioned dependency (`@flint/core`) so they all share one swappable
model backend. **App code never calls a vendor SDK directly** — it calls Flint,
and the provider sits behind Flint's interface.

The prime directive: swap the provider, app code does not change. The corollary,
equally important: when Flint is wrong, an app developer can see why
(observability) and override it for a single call (escape hatches).

- Canonical, provider-independent types (`Message`, `StreamEvent`, `ToolCall`, …).
- A tool-call loop, transactional memory, and a concurrency limiter that live
  **inside** Flint, never in apps.
- Anthropic implemented as an adapter (Phase 1); Ollama planned (Phase 2).

## Install

```bash
pnpm add @flint/core@~0.1.0
```

Flint is distributed as tagged semver releases from a private registry — never as
a git branch. Pin a tight range (`~0.1.0`) during active development.

### Consuming from the local registry

Phase 1 publishes to a self-hosted [Verdaccio](https://verdaccio.org/) registry
(spec §9). To consume `@flint/core` from another app on your machine:

1. **Start the registry** (from this repo, keep it running while you install):
   ```bash
   pnpm registry:start          # serves http://localhost:4873
   ```
2. **Point your app's `@flint` scope at it** — add to your app's `.npmrc`:
   ```
   @flint:registry=http://localhost:4873/
   ```
3. **Install and pin:**
   ```bash
   pnpm add @flint/core@~0.1.0
   ```

The registry only needs to be running at **install** time — once `@flint/core`
is in your app's `node_modules`, your app runs without it. To publish an
iteration (`0.1.1`, …), bump the version and run `pnpm publish:local`.

## Quick start

```ts
import { Flint, AnthropicProvider, type Tool } from '@flint/core';

const flint = new Flint({
  provider: new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY! }),
  defaultModel: 'claude-sonnet-4-6',
});

const getTime: Tool = {
  definition: {
    name: 'get_current_time',
    description: 'Returns the current UTC time.',
    inputSchema: { type: 'object', properties: {} },
    idempotent: true, // side-effect-free → safe to auto-retry
  },
  handler: () => new Date().toISOString(),
};

for await (const ev of flint.chat(
  { conversationId: 'user-42', message: 'What time is it?', tools: [getTime] },
)) {
  if (ev.type === 'text') process.stdout.write(ev.delta);
}
```

`@flint/core` reads **no** environment variables. The consuming app passes
everything in via `FlintConfig`.

## Configuration (FlintConfig)

```ts
interface FlintConfig {
  provider: ProviderAdapter;       // the swappable backend
  defaultModel: string;            // e.g. 'claude-sonnet-4-6'
  observer?: AiObserver;           // defaults to a no-op
  memory?: MemoryStore;            // defaults to InMemoryStore
  maxConcurrent?: number;          // per-provider limiter (default 4)
  retryPolicy?: RetryPolicy;       // default for retryable failures
  contextStrategy?: ContextStrategy; // 'full' | 'truncate_oldest' | 'summarize'
}
```

Every call also takes a per-call options object (the escape hatches):
`{ model?, retryPolicy?, contextStrategy?, maxTokens?, debug?, signal?, context? }`.

## Capabilities model

Flint inspects a provider's `ModelCapabilities` to pick an internal **strategy**
(native tool-calling vs. prompted-JSON-with-repair, etc.). Apps should query
capabilities only for genuinely unbridgeable gaps:

```ts
if (flint.getCapabilities().toolCalling === 'unsupported') {
  // fall back to a non-tool flow
}
```

If your app ends up writing `if (caps.toolCalling === 'native')` everywhere, the
abstraction has failed — that branching belongs inside Flint.

## Tool calling

You register tools as `{ definition, handler }`. Flint owns the
model → tool → model loop, driven by the normalized stream `reason`. The loop
never leaks into your app.

`ToolDefinition.idempotent` is **required** and gates auto-retry:

- `idempotent: true` — side-effect-free; Flint may auto-retry on failure.
- `idempotent: false` — side-effecting; Flint runs it **once** and surfaces any
  failure to you for a manual retry decision. It is never silently re-run.

## Streaming

`flint.stream(...)` and `flint.chat(...)` return an `AsyncIterable<StreamEvent>`.
A stream always ends with exactly one terminal `done` or `error` event:

```ts
type StreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'done'; reason: 'complete' | 'tool_call' | 'max_tokens' | 'error'; usage: TokenUsage }
  | { type: 'error'; error: AiError };
```

`flint.generate(...)` runs the same loop but returns a single collected result.

## Memory

Memory is **transactional** (a locked invariant). A user message and its
assistant response are committed together or not at all — only on a successful
`done`. Every turn carries `status: 'pending' | 'complete' | 'failed'`, and the
store carries `schemaVersion`.

`@flint/core` ships the `MemoryStore` interface and one reference impl,
`InMemoryStore`. Durable persistence (Postgres, Redis, a vector DB) is the app's
job — implement `MemoryStore`. All persisted objects are zod-validated at the
boundary.

```ts
const history = await flint.store.getMessages('user-42'); // complete turns only
const turns = await flint.store.getTurns('user-42');       // any status, for debugging
```

## Observability & debugging

Flint **never** logs directly. All observability flows through an injected
`AiObserver` (default: no-op). Implement only the hooks you need:

```ts
const observer: AiObserver = {
  onRequest: (e) => metrics.count('ai.request', { model: e.model }),
  onResponse: (e) => metrics.timing('ai.latency', e.durationMs),
  onToolCall: (e) => log.info('tool', e.call.toolName),
  onError: (e) => log.error('ai.error', e.error.kind),
  onDebug: (e) => log.debug('raw', e.phase, e.raw), // only fires when debug: true
};
```

Pass `{ debug: true }` per call to capture the **unfiltered** request/response
payloads via `onDebug`.

## Providers

### Anthropic (Phase 1)

`new AnthropicProvider({ apiKey })` (or pass a pre-built `client`). Native tool
calling, native structured output, full streaming. Default model
`claude-sonnet-4-6`; opt into `claude-opus-4-8` for complex work. Always pin the
dated/canonical model string — no `-latest` aliases in production.

> **`@anthropic-ai/sdk` is an optional peer dependency** (since 0.3.0). If you
> use `AnthropicProvider`, install it in your app:
> ```bash
> pnpm add @anthropic-ai/sdk
> ```
> A local-only (Ollama) app skips this entirely — `@flint/core` loads the
> Anthropic SDK lazily and never pulls it in unless you use the provider.

### Ollama (Phase 2)

Local models over Ollama's HTTP API — no Anthropic, no cloud. Same
`ProviderAdapter`, so swapping is a one-line config change:

```ts
import { Flint, OllamaProvider } from '@flint/core';

const flint = new Flint({
  provider: new OllamaProvider({ baseURL: 'http://localhost:11434' }), // the default
  defaultModel: 'llama3.1',
});
```

Capabilities are reported **honestly** and lower than Anthropic's: local models
are `toolCalling: 'prompted'`, `structuredOutput: 'prompted' | 'unreliable'`,
with smaller context windows. Tool calling is handled by an adapter-owned
prompt protocol with JSON parse-and-repair (the model is asked to emit
`{"tool_call": {"name": ..., "arguments": ...}}`), so it works even on models
with no native tool API. The contract suite runs against Ollama to prove this.

Prereqs: a running Ollama (`ollama serve`) with the model pulled
(`ollama pull llama3.1`). Try it through the playground:

```bash
OLLAMA_MODEL=llama3.1 pnpm --filter playground start
```

The path from here to a model that is distinctively yours (prompting + retrieval
first, LoRA fine-tune only if needed) is written up in
[docs/PHASE3.md](docs/PHASE3.md).

### Local OpenAI-compatible servers

`LocalOpenAiProvider` talks to any local model server that speaks the OpenAI
chat-completions API: Ollama's `/v1`, llama.cpp's `llama-server`, and others.
One adapter; the base URL is the only thing that changes.

```ts
import { Flint, LocalOpenAiProvider, localCapabilities } from '@flint/core';

const flint = new Flint({
  provider: new LocalOpenAiProvider({
    baseURL: 'http://127.0.0.1:11434/v1',   // Ollama; llama-server: http://127.0.0.1:8080/v1
    // What each model can do. You know your model; there is no built-in table.
    capabilities: () => localCapabilities({ contextTokens: 16384, tools: true }),
    firstTokenTimeoutMs: 20_000,             // optional: never wait on a cold model
  }),
  defaultModel: 'your-model',
});
```

- **Streaming and tool calls** work as with every provider. Tools are offered
  only to a model whose capabilities say it can call them: `tools: false` gives
  `toolCalling: 'unsupported'`, the flag a router reads, and that model is never
  sent a tool. A model you have no facts for gets `tools: false`.
- **Deadlines.** A cold local model stalls instead of failing. With
  `firstTokenTimeoutMs` (and `toolPassTimeoutMs` for the call after a tool ran,
  `requestTimeoutMs` for a non-streamed call) a stalled call ends with a
  `timeout` error whose `providerCode` is `first_token_timeout`. It is not
  retryable, so your code moves to another model instead of waiting again.
- **This machine only, by default.** A `baseURL` that is not `127.0.0.1`,
  `localhost` or `[::1]` is refused when the provider is built, unless you pass
  `allowRemote: true`. Redirects are never followed.
- **What it cannot do.** Chat completions has no field for the context size, so
  the server's own setting applies (on Ollama: the model's `num_ctx`). The
  native `OllamaProvider` can set it per call, and also recovers tool calls a
  model wrote as text; prefer it on Ollama unless you need the OpenAI wire.

The server's setup, routing modes and hardware tiers are in
[apps/server/README.md](apps/server/README.md), "Local inference".

## Local inference (the server)

Flint's server (`apps/server`) treats a model on your own hardware as a first-class provider.
The full reference is [apps/server/README.md](apps/server/README.md), "Local inference"; the short
version:

**Setup.** With Ollama running, nothing needs setting: the server uses Ollama's own API at
`http://127.0.0.1:11434`, picks the model your hardware tier recommends when it is installed (or
the one you name with `OLLAMA_MODEL`), and never downloads one. To use another OpenAI-compatible
local server instead (llama.cpp's `llama-server`, Ollama's `/v1`):

```
FLINT_LOCAL_PROVIDER=openai
FLINT_LOCAL_BASE_URL=http://127.0.0.1:8080/v1
FLINT_LOCAL_MODEL=<the model's name on that server>
```

A local endpoint must be this machine (`127.0.0.1`, `localhost`, `[::1]`) unless
`FLINT_LOCAL_ALLOW_REMOTE=1`, and then it must be https (plain http to another machine also needs
`FLINT_LOCAL_ALLOW_INSECURE_REMOTE=1`, and a key is never sent over it). Every setting is checked
by a schema; a bad one is reported by name and never stops the server. See what was detected and
chosen with:

```bash
pnpm --filter server inference-status
```

It asks the running server when it can (its token: `FLINT_TOKEN`, else `~/.flint/token`), and
says so plainly when its answer is built from this shell's settings instead.

**Modes.** `FLINT_INFERENCE_MODE`, or Settings in the console (the choice is saved):

| Mode | What answers |
| --- | --- |
| `cloud` (default) | The cloud tiers; a message you keep private is answered locally. (What changed for a setup that sets nothing new is listed in `apps/server/README.md`, "What is different in Cloud mode".) |
| `local` | The local model, always. No outside AI and no paid service: no cloud model answers, and paid search tools are off. Flint may still search the web (the keyless search on your own SearXNG, the page fetch and your account tools stay). If no local model can answer, you get a clear error, never the cloud. An eval replay that would go to a cloud model is refused. |
| `hybrid` | A rule table picks per message. The first rule that holds decides: a private message stays local (and is not answered if no local model can); a file the local model cannot read, or no local model available, goes to the cloud; no cloud model configured stays local; an explicit "deep" answer, a message that needs tools, a conversation too long for the local window, and hard reasoning or code go to the cloud, with the local model as the fallback; everything else is local, with the cloud as the fallback. The rules are data in `apps/server/src/hybrid-rules.ts`. |

To switch: Settings, BRAIN, Mode in the console, or
`pnpm --filter server inference-status -- --mode local|hybrid|cloud|reset`. The choice is saved.
An environment mode Flint does not know, and a saved mode that cannot be read, both run as
`local`: a typo or a damaged file must not send a private setup to the cloud.

**Privacy.** A message you keep private (Local Only, or "keep this private") is decided before
the rule table is read, and nothing of it leaves the machine: it is offered only tools that run
on this Mac (no web search, no page fetch, no account lookup, no research), it is spoken with the
device's own voice, and it is kept from a cloud model on every later turn: as history, as
long-term memory (what Flint learns from it is recalled only for a model on this Mac), and as
speech. With a local model server that is not this Mac (and that you have not allowed), or a
local model that is really one of Ollama's cloud models under another name, it is not answered
at all. That is a stronger promise than Local mode's, which is about who answers: Local mode uses
no outside AI and no paid service, and may still search the web.

A turn never waits on a cold local model: the server watches the model's state (loaded, cold,
loading, unavailable), gives a turn hard deadlines to connect, to get a first token and between
one piece of a reply and the next, and serves it from a small standby model while the main one
loads (`FLINT_LOCAL_FALLBACK_MODEL`, or the tier's standby below). The main model is loaded in the
background and answers from the next message on; a turn is never moved to another model once it
has shown text or run a tool. In hybrid, the cloud answers only when no local model can, and never
for a private message. A local prompt is sized to the model's window before it is sent, so the
server never has to cut one.

The server is listening before it has looked at the machine or heard from the model server: both
happen behind the boot, and the status says "Flint is checking" until they land.

**Hardware tiers.** The server detects the machine and recommends a model from one table,
`packages/core/src/hardware-tiers.ts` (the only place a local model is named, the embedding model
included). A machine is sorted by the memory a model can use: an NVIDIA GPU's VRAM, or three
quarters of an Apple Silicon Mac's unified memory (a 64 GB Mac has 48 GB for a model). A tier's
number is reached at 93% of it, since a card sold as 16 GB reports 15,360 MiB. The name in
brackets is how the console shows the model; the tag is for the command line.

| Tier | Machine | Model | Context | Standby model | Standby context | Download | Measured |
| --- | --- | --- | --- | --- | --- | --- | --- |
| CPU, Low Memory | no usable GPU, under 8 GB of RAM | `llama3.2:1b` (Llama 3.2 1B) | 4,096 | none | none | 1.3 GB | recommended, unmeasured |
| CPU Only | no usable GPU, 8 GB of RAM or more | `llama3.2:3b` (Llama 3.2 3B) | 4,096 | `llama3.2:1b` (Llama 3.2 1B) | 4,096 | 2.0 GB + 1.3 GB | recommended, unmeasured |
| 8 GB | 6 GB to under 16 GB of usable memory | `qwen2.5:7b` (Qwen 2.5 7B) | 4,096 | none | none | 4.7 GB | recommended, unmeasured |
| 16 GB | 16 GB to under 24 GB of usable memory | `qwen2.5:14b` (Qwen 2.5 14B) | 4,096 | `llama3.2:3b` (Llama 3.2 3B) | 8,192 | 9.0 GB + 2.0 GB | recommended, unmeasured |
| 24 GB | 24 GB to under 48 GB of usable memory | `qwen3:14b` (Qwen 3 14B) | 16,384 | `llama3.2:3b` (Llama 3.2 3B) | 8,192 | 9.3 GB + 2.0 GB | recommended, unmeasured |
| 48 GB+ | 48 GB of usable memory or more | `muse-glimmer:30b` (Muse Glimmer 30B) | 16,384 | `llama3.2:3b` (Llama 3.2 3B) | 8,192 | 18.2 GB + 2.0 GB | yes |

"Recommended, unmeasured" rows come from each model's published size and capabilities, not from
Flint's own measurements. For a model that is not installed, the status command prints the exact
`ollama pull` line; Flint never runs it.

## Versioning & release policy

- Published as tagged semver to a private registry (GitHub Packages or
  self-hosted Verdaccio). Never `github:wpf002/flint#main`.
- Under `0.x`, breaking changes are allowed but must be deliberate and noted in
  release notes.
- Consuming apps pin tight ranges (`~0.1.0`).
- The public API surface is snapshot-tested
  ([test/api-surface.test.ts](packages/core/test/api-surface.test.ts)); an
  accidental change to the public surface fails CI.

## Contributing a new provider

1. Implement `ProviderAdapter` (`getCapabilities`, `estimateTokens`, `generate`,
   `stream`). Map native events to canonical `StreamEvent`s; always end a stream
   with `done` or `error`. Map native errors to `AiError`.
2. Report **honest** capabilities — don't claim parity you can't deliver.
3. Run the full contract suite against your adapter
   ([packages/core/test/contracts](packages/core/test/contracts)). Every gap is
   either fixed in the adapter or documented in the capability model.

## Apps

- **`apps/ask`** — a real consumer CLI: your personal Flint, running locally with
  **durable** file-backed memory + lessons (`~/.flint/`). Proves the full vision —
  voice, tools, and nightly self-evolution — end to end, no cloud. It always
  talks to the local Ollama: `OLLAMA_MODEL` names the model, and unset it uses
  the one Ollama has loaded (else the first pulled). No key makes it call a
  hosted model.
  ```bash
  OLLAMA_MODEL=qwen2.5:14b pnpm --filter ask ask "your question"
  OLLAMA_MODEL=qwen2.5:14b pnpm --filter ask ask reflect   # distill nightly lessons
  OLLAMA_MODEL=qwen2.5:14b pnpm --filter ask ask lessons   # what Flint has learned
  OLLAMA_MODEL=qwen2.5:14b pnpm --filter ask ask log       # audited trace of the last run
  OLLAMA_MODEL=qwen2.5:14b pnpm --filter ask ask brief     # proactive brief from your connected systems
  OLLAMA_MODEL=qwen2.5:14b pnpm --filter ask ask voice     # talk to Flint, it talks back (local STT+TTS)
  OLLAMA_MODEL=qwen2.5:14b pnpm --filter ask ask agent "<task>"  # autonomous run under the policy
  ```
  **Autonomous overnight runs (`ask agent`):** Flint executes a task *unattended*
  under an autonomy policy — reads + whitelisted reversible tools run on their
  own; everything else is refused and queued in `~/.flint/overnight-report.md`
  for your review. Destructive actions are never auto-approved; there's a per-run
  action cap. Configure `~/.flint/autonomy.json` (`{"allow":["vantage.add_to_watchlist"]}`)
  and `~/.flint/overnight-task.txt`. Run it by hand: the old nightly schedule
  (`install-nightly.sh`) is retired; the runtime (`apps/runtime`) is what runs
  on its own now.
  **Voice setup (one-time, all local):** `brew install whisper-cpp sox`, then
  download a model to `~/.flint/models/ggml-base.en.bin` (from
  huggingface.co/ggerganov/whisper.cpp). `ask voice` runs the live mic loop;
  `ask voice <audiofile>` processes one clip. STT = whisper.cpp, TTS = macOS `say`.
  The scheduled reflection and morning brief are retired: the runtime's 07:30
  digest (in the console) replaces the brief.

  **Watch triggers (`ask watch`):** deterministic threshold alerts over live tool
  data — no LLM in the firing decision. Define them in `~/.flint/triggers.json`:
  ```json
  { "triggers": [ { "name": "bullish", "tool": "meridian.bias_summary",
    "select": "*.score", "when": {"op": ">", "value": 0.5}, "alert": "Strong bullish bias" } ] }
  ```
  **Semantic memory (opt-in):** `ollama pull nomic-embed-text`, then set
  `FLINT_EMBED_MODEL=nomic-embed-text` to retrieve your writing/voice by meaning
  (embeddings + cosine) instead of keyword. Falls back to keyword if unset.

  **MCP tools (Phase 1):** drop a `~/.flint/mcp.json` listing your apps' MCP
  servers and `ask` exposes their tools to Flint, gated by the safety rail
  (read-only runs freely; side-effecting prompts for approval — `FLINT_APPROVE=all`
  to auto-approve, `none` to deny). Format:
  ```json
  { "servers": [ { "name": "demo", "command": "tsx", "args": ["path/to/server.ts"] } ] }
  ```
- **`apps/playground`** — in-repo demos (`start` / `voice` / `tools` / `eval` / `reflect`). They
  talk to a local Ollama model: `OLLAMA_MODEL`, or the one Ollama has loaded or pulled. An
  `ANTHROPIC_API_KEY` in the environment selects nothing by itself; for the run that compares a
  local model against Claude, ask by name: `PLAYGROUND_PROVIDER=anthropic`.

## Recovery

If Flint breaks, the runbook is [docs/RECOVERY.md](docs/RECOVERY.md): the fewest
steps for each case, written for the person who owns the Mac, not for a
developer. The short form:

| What happened | What to do |
|---|---|
| An update broke Flint | Revert the pull request on GitHub. If Flint is not back in 10 minutes, on the Studio: `~/flint/apps/studio/rollback.sh` |
| The database is damaged | On the Studio: `~/flint/apps/studio/restore_database.sh`. It shows what will be in force afterwards; then type `RESTORE`. |
| A memory, history or notes file is damaged or emptied | On the Studio: `~/flint/apps/studio/restore_file.sh memory` (or `history`, or `notifications`), then type `RESTORE`. It passes over a backup whose copy was emptied; add a day, such as `2026-10-10`, to choose the backup yourself. |
| The Mac Studio is lost, stolen or dead | On the MacBook: `cd ~/flint && git pull && ./apps/studio/rebuild.sh --to NAME@NEWMAC.local` |

Whatever one of them replaces is kept under another name. (A database restore
also removes kept databases from restores more than 14 days ago, and names them
before you confirm.) The rebuild is rehearsed every week, and in every deploy
that changes what a rebuild is made of, into a scratch folder and a scratch
database (`apps/studio/test/rebuild_rehearse.test.sh`); how it works is in
[apps/studio/README.md](apps/studio/README.md#rebuild-and-recovery).

## Development

```bash
pnpm install
pnpm build          # tsup → ESM + CJS + .d.ts
pnpm test           # vitest (offline, cassette-backed)
pnpm test:contracts # the cross-provider contract suite
pnpm typecheck
pnpm --filter playground start  # end-to-end consumption demo (a local Ollama model; the offline mock without one)

# local private registry (Verdaccio)
pnpm registry:start   # serve @flint/core on http://localhost:4873
pnpm publish:local    # build + publish the current version to it
```

## License

UNLICENSED — private.
