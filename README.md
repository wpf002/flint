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

## Development

```bash
pnpm install
pnpm build          # tsup → ESM + CJS + .d.ts
pnpm test           # vitest (offline, cassette-backed)
pnpm test:contracts # the cross-provider contract suite
pnpm typecheck
pnpm --filter playground start  # end-to-end consumption demo (offline mock if no key)

# local private registry (Verdaccio)
pnpm registry:start   # serve @flint/core on http://localhost:4873
pnpm publish:local    # build + publish the current version to it
```

## License

UNLICENSED — private.
