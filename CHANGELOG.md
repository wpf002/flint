# Changelog

All notable changes to `@flint/core`. Under `0.x`, breaking changes are allowed
but are called out explicitly here.

## Unreleased

### Added

- **`FlintConfig.unknownTool`**: what to tell the model when it calls a tool
  the call did not offer, in place of the default "Unknown tool 'x'. Available
  tools: ...". An app that holds a tool back on purpose can say why. Nothing is
  run for such a call either way; unset, or returning undefined, nothing
  changes.
- **`OllamaProvider.baseURL`** is readable: the server every request goes to,
  without a trailing slash. An app can tell a model on this machine from one on
  a server elsewhere before it decides what to send it. Nothing else changes.
- **`OllamaProvider.numCtx`** is readable: the `num_ctx` this client sends on
  every call, or undefined when it sets none. An app can size what it adds to a
  prompt to the window the model will really have.
- **`refusal` done reason.** Anthropic's `stop_reason: "refusal"` and OpenAI's
  `refusal` field / `content_filter` finish now end a stream with
  `done.reason === 'refusal'` instead of `complete`. A chat turn that ends this
  way is failed, not committed, so the question doesn't sit in history with an
  empty reply. Additive, but an exhaustive `switch` over `StreamDoneReason`
  needs the new case.
- **`toolChoice: 'none'`** in `GenerateArgs`: tools stay defined, calling them
  is forbidden (Anthropic `{type:'none'}`, OpenAI `'none'`; Ollama drops the tools).
- **`maxRetries` and `timeoutMs`** in `AnthropicProviderOptions`, passed to the
  SDK client: its own retries of a failed request (default 2) and how long it
  waits for a response to start (default 10 minutes). Unset, nothing changes.
  Flint's tool loop already retries a retryable failure, so an app that wants
  a failing call to fail fast sets `maxRetries: 0`.
- **`pickOllamaModel`, `isOllamaCloudModel`, `DEFAULT_OLLAMA_MODEL`**: the model
  an app uses when none is named. It asks Ollama (`/api/ps`, then `/api/tags`)
  for the chat model already loaded, else the first one pulled, skipping
  embedders and cloud models; never a hosted model. The result says where the
  model came from (`from`), the context size a loaded model has (`numCtx`, so
  asking it does not make Ollama reload it), and whether Ollama answered at all
  (`answered`, to tell "down" from "empty"). `skip` names models never to pick:
  a helper model the caller loads itself is in Ollama's memory too.
- **`LocalOpenAiProvider`, `localCapabilities`, `isLoopbackHost`**: one adapter
  for any OpenAI-compatible local model server (Ollama's `/v1`, llama.cpp's
  `llama-server`). The caller supplies each model's capabilities; a model with
  `tools: false` is `toolCalling: 'unsupported'` and is never offered tools.
  It connects to this machine only unless `allowRemote` is set, and never
  follows a redirect.
- **Deadlines on the chat-completions wire** (`ChatWire.firstTokenTimeoutMs`,
  `toolPassTimeoutMs`, `requestTimeoutMs`): a stalled call ends with a
  non-retryable `timeout` whose `providerCode` is `FIRST_TOKEN_TIMEOUT` or
  `REQUEST_TIMEOUT`. Also `toolChoiceNone: 'drop_tools'` and `refuseRedirects`.
  All optional; unset, requests are unchanged. A deadline is a number or a
  function read on every call (`DeadlineMs`).
- **The same deadlines on `OllamaProvider`** (`firstTokenTimeoutMs`,
  `toolPassTimeoutMs`, `requestTimeoutMs`). A thinking model's reasoning counts
  as a first token. The tool-decision pass is not streamed, so it is under the
  request deadline, and a stalled one is asked once, not three times.
- **`HARDWARE_TIERS`, `hardwareTierFor`, `hardwareTier`,
  `hardwareTiersMarkdown`**: one table from a class of machine to a recommended
  local model, its context length and a small standby model.
  `DEFAULT_OLLAMA_MODEL` reads its 8 GB row. A machine is sorted by the memory
  a model can use (`usableMemoryGb`): an NVIDIA GPU's VRAM, or three quarters
  of an Apple Silicon Mac's unified memory (`APPLE_USABLE_FRACTION`). A tier is
  reached at 93% of its number (`TIER_TOLERANCE`), since a card sold as 16 GB
  reports 15,360 MiB. A machine with no usable GPU is one of two CPU rows,
  chosen by its RAM (`TierMachine.systemMemoryGb`).
- **`modelDisplayName`, `derivedModelName`, `modelDownloadGb`,
  `EMBEDDING_MODEL`, `isTopTier`**: each row names its model for a screen
  ("Qwen 2.5 7B") as well as by tag; a tag the table does not list gets a
  readable name derived from it. The embedding model is named in the same
  file, with its download size.
- **`FlintConfig.fitToWindow`**: size the whole prompt to the model's window,
  for a model whose window is small enough to matter. Tools give way (the last
  listed first) until the messages keep a quarter of the input window, the
  messages get exactly what is left, and a system prompt that leaves no room
  for the question fails with `context_overflow` before anything is sent. A
  fitted prompt is counted on the safe side (each tool as it goes on the wire,
  at 3 characters a token, and 5% of the window left free). Off by default.
- **`AiObserver.onContext`** (`ContextEvent`): once per call, how the prompt was
  sized: the window, the reply's reserve, the fixed part, how many messages
  were kept and dropped, which tools were left out. Numbers and tool names.
- **`OllamaProvider`'s window is bounded by the model's own maximum** when the
  caller's `capabilities` gives it as `maxContextTokens`: Ollama gives a model
  no more than that, whatever `num_ctx` asks.
- **`idleTimeoutMs`** on the OpenAI-compatible wire, `LocalOpenAiProvider` and
  `OllamaProvider`: how long a reply may go quiet once it has begun
  (`providerCode: 'idle_timeout'`, exported as `IDLE_TIMEOUT`). A model that
  sent one delta and then nothing was bounded only by the caller.
- **`OllamaProviderOptions.onFirstOutput`**: called when a request's first sign
  of output arrives, for a caller that measures time to first token.
- **`OllamaProvider.baseURL` and `.numCtx`, `LocalOpenAiProvider.baseURL`** are
  readable: the server every request goes to, and the context window the
  client asks for on every call. A caller can tell a model on this machine
  from one elsewhere, and size a prompt to the window the model really has.
- **`TokenUsage.lastInput`**: the input tokens of the last request when a
  call made more than one of its own (Ollama's constrained replies are asked
  for again, up to three times, when the JSON does not parse). `input` stays
  the sum. A caller that compares the prompt with the model's window reads
  `lastInput ?? input`. Optional; absent when the call made one request.

### Changed

- **`OllamaProvider`'s first-token deadline covers the calls that answer
  whole.** The tool-decision pass (tools offered, no tool result yet, which is
  the first pass of nearly every chat turn), a constrained reply and
  `generate()` were bounded only by `requestTimeoutMs`. With
  `firstTokenTimeoutMs` set they are sent `stream: true`, timed on their first
  line, and folded back into the one object a non-streamed call returns, so
  nothing changes for the caller. Without it they are the non-streamed calls
  they were.
- **An error object inside a 200 stream is a failure**, on both wires. It was
  read as a chunk with nothing in it, and the turn ended `complete` with
  whatever had arrived.
- **Two tool calls that share an index, or have none, are two tool calls** on
  the OpenAI-compatible wire. Keyed by index alone, the second overwrote the
  first.
- **The message budget follows the window the model really runs with.**
  `OllamaProvider.getCapabilities` reports `defaultOptions.num_ctx` as the
  context window when it is set (that is what every call asks Ollama for), in
  place of the built-in table's per-family guess, and holds the reply's reserve
  to a quarter of it. The client's budget now also counts the system prompt and
  the tool schemas, which share the window with the messages (never more than
  half of it, so a large prompt on a small window still leaves room for the
  newest messages). An app that sets no `num_ctx` sees the table, as before.
- **An Ollama model the table has never heard of is `toolCalling:
  'unsupported'`**, not `'native'`. Requests do not change (the adapter sends
  the tools it is given, as before); the capability a router reads is now
  honest. `OllamaProviderOptions.capabilities` lets the caller say what it
  knows (Ollama's own `/api/show`); a model it marks `unsupported` is not sent
  tools.
- **Ollama calls never follow a redirect** (`redirect: 'error'` on the chat
  calls, the model list and the embedder). A redirect is reported as a
  `validation` error with `providerCode: 'redirect'`.

- **The tool loop no longer fails a turn at its iteration limit outright.** It
  makes one more call with `toolChoice: 'none'` and a note asking for an answer
  from the tool results so far; only if that call fails or comes back empty does
  the turn end in the old "exceeded N iterations" error. On Ollama (which gets
  no tools on that call, so doesn't parse tool calls either) a call the model
  writes as text anyway (JSON, `<tool_call>` markup or `name(...)`) is recovered
  against the caller's tools and dropped, so it ends the turn as empty rather
  than coming back as the answer.
- **A tool handler that returns `{ isError: true, ... }`** (what `@flint/mcp`
  returns for an MCP error result) is now recorded as `ToolResult.isError`, so
  the model gets `is_error` and observers see a failure instead of `ok`.

## 0.3.0 — Anthropic becomes optional

Flint can now run with **zero Anthropic** at the dependency level — the payoff
of the provider-agnostic design.

### Changed (breaking under 0.x)

- `@anthropic-ai/sdk` moved from a hard `dependency` to an **optional
  `peerDependency`**. A local-only (Ollama) app installs `@flint/core` and never
  pulls in Anthropic. Apps that use `AnthropicProvider` now install the SDK
  themselves: `pnpm add @anthropic-ai/sdk`.
- `AnthropicProvider` loads the SDK **lazily** (dynamic `import()` on first use),
  so merely importing `@flint/core` — or using `OllamaProvider` — never resolves
  the Anthropic package. If the SDK is missing when you do use Anthropic, you get
  a clear error telling you to install it.

### Verified

- Clean-room install of `@flint/core@~0.3.0` with NO `@anthropic-ai/sdk` present:
  imports fine, runs a full turn through a non-Anthropic provider, and
  `AnthropicProvider` fails gracefully with an install hint.

## 0.2.0 — Phase 2: Ollama provider

Local models, no Anthropic, no cloud. Adds a second provider behind the same
`ProviderAdapter` — flipping `provider:` in `FlintConfig` is the only change an
app makes.

### Added

- **`OllamaProvider`** — talks to Ollama's local HTTP API (`/api/chat`, NDJSON
  streaming). Injectable `fetch` for offline testing.
- **Honest capability tiers** — local models report `toolCalling: 'prompted'`,
  `structuredOutput: 'prompted' | 'unreliable'`, and smaller context windows.
  No false parity with Anthropic.
- **Prompted tool-calling protocol** — the adapter owns the prompt contract and
  a tolerant JSON parser/repair (code fences, surrounding prose, trailing
  commas, single quotes). Proven by the contract suite.
- **Ollama contract tests** — the same contracts as Anthropic, run offline
  against the real adapter with a faked `fetch`.
- Playground selects provider by env (`OLLAMA_MODEL` / `ANTHROPIC_API_KEY` /
  mock) with no other code change — the swap, demonstrated.

### Notes

- During a tool-eligible turn, the prompted regime buffers instead of streaming
  token-by-token (the text might *be* the tool-call JSON). Plain-text turns
  stream live.

## 0.1.0 — Phase 1

Initial release. Provider-agnostic AI layer with the Anthropic adapter.
Published to the self-hosted Verdaccio registry (`pnpm publish:local`); verified
installable as `@flint/core@~0.1.0` from a clean-room consumer.

### Added

- **Canonical contracts** — provider-independent `Message`, `StreamEvent`,
  `ToolDefinition`, `ToolCall`, `AiError`, `ModelCapabilities`, with zod schemas
  for every persisted/boundary type.
- **`ProviderAdapter`** interface — the only surface `core/` knows about a
  provider.
- **`AnthropicProvider`** (Phase 1) — implements the adapter against
  `@anthropic-ai/sdk` (pinned `0.100.1`). Native tool calling + streaming;
  normalized stream events and error taxonomy.
- **Tool-call loop** — model → tool → model, driven by the stream `reason`;
  enforces the idempotency rule (non-idempotent tools are never auto-retried).
- **Transactional memory** — `MemoryStore` interface + `InMemoryStore`. Turns
  are committed only on a successful `done`; `status` per turn, `schemaVersion`
  on the store.
- **Concurrency limiter** — per-provider FIFO queue honoring `maxConcurrent`.
- **`AiObserver`** — all observability through an injected seam (no-op default);
  `onRequest` / `onResponse` / `onError` / `onToolCall` / `onDebug`.
- **Per-call escape hatches** — `{ model, retryPolicy, contextStrategy,
  maxTokens, debug, signal, context }` on every method.
- **Context assembly** — explicit `full | truncate_oldest | summarize`
  strategies (never silently stuffs the window).
- **Contract test suite** — cassette-backed, offline, runs against every
  provider.
- **API surface snapshot** — guards the public surface in CI.
- **`playground`** app — proves cross-package consumption end to end.
