# Changelog

All notable changes to `@flint/core`. Under `0.x`, breaking changes are allowed
but are called out explicitly here.

## Unreleased

### Added

- **`refusal` done reason.** Anthropic's `stop_reason: "refusal"` and OpenAI's
  `refusal` field / `content_filter` finish now end a stream with
  `done.reason === 'refusal'` instead of `complete`. A chat turn that ends this
  way is failed, not committed, so the question doesn't sit in history with an
  empty reply. Additive, but an exhaustive `switch` over `StreamDoneReason`
  needs the new case.
- **`toolChoice: 'none'`** in `GenerateArgs`: tools stay defined, calling them
  is forbidden (Anthropic `{type:'none'}`, OpenAI `'none'`; Ollama drops the tools).

### Changed

- **The tool loop no longer fails a turn at its iteration limit outright.** It
  makes one more call with `toolChoice: 'none'` and a note asking for an answer
  from the tool results so far; only if that call fails or comes back empty does
  the turn end in the old "exceeded N iterations" error.
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
