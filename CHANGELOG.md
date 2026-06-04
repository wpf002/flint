# Changelog

All notable changes to `@flint/core`. Under `0.x`, breaking changes are allowed
but are called out explicitly here.

## 0.1.0 — Phase 1 (unreleased)

Initial release. Provider-agnostic AI layer with the Anthropic adapter.

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
