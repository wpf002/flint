# Contract suite

These tests define what "all providers behave the same" means. In Phase 1 they
run against Anthropic only; in Phase 2 the **same** suite runs against Ollama.
Any test that passes for one provider and fails for the other is either fixed in
the adapter or documented as a capability gap.

## Offline by default (cost / flakiness rule)

The suite runs offline, deterministic, and free. Provider responses are recorded
as **cassettes** (VCR-style fixtures) and replayed through the *real* adapter via
[`harness.ts`](./harness.ts) — only the network is faked, so the adapter's own
mapping/normalization logic is exercised.

CI never hits the live API.

## The tests

| File | Guarantees |
| --- | --- |
| `generate-basic` | plain completion → well-formed `Message` |
| `generate-with-tools` | tool definition → `ToolCall` with parsed args |
| `stream-basic` | text deltas, then exactly one terminal `done` |
| `stream-tool-call` | stream yields `tool_call`, then `done.reason === 'tool_call'` |
| `stream-interruption` | abort mid-stream → `error`, memory **not** committed |
| `memory-transaction` | a failed turn leaves no orphaned user message |
| `error-normalization` | provider errors map to the correct `AiError.kind` |
| `idempotency` | a non-idempotent tool failure is not auto-retried |

## Refreshing cassettes (live run)

A separate, **manually-triggered** run hits the real API to refresh fixtures and
catch drift. It is never part of CI.

```bash
# requires a real key; intended to be run by a human, occasionally
ANTHROPIC_API_KEY=sk-... FLINT_LIVE=1 pnpm --filter @flint/core test:contracts
```

> Live recording is a Phase-1 seam: the harness is structured so a live mode can
> capture real `RawMessageStreamEvent`s and serialize them back into the
> fixtures here. Until that recorder lands, fixtures are authored from the
> documented Anthropic event shapes (`message_start` → `content_block_*` →
> `message_delta` → `message_stop`).
