# @flint/persona

Your AI's **identity** on top of [`@flint/core`](../core). It injects a style
guide — and, optionally, retrieved samples of your own writing — as the system
prompt on every call, so the model speaks as *you*, across every app.

Provider-agnostic by construction: the same `Persona` runs against Anthropic
today and your local Ollama model later, unchanged. This is Phase 3, Step 1 (see
[docs/PHASE3.md](../../docs/PHASE3.md)) — the highest-leverage personalization
before any fine-tuning.

## Usage

```ts
import { Flint } from '@flint/core';
import { AnthropicProvider } from '@flint/core/... // or OllamaProvider later
import { Persona, InMemoryRetriever, STARTER_STYLE_GUIDE } from '@flint/persona';

const flint = new Flint({ provider, defaultModel });

const me = new Persona(flint, {
  name: 'Will',
  styleGuide: STARTER_STYLE_GUIDE.replace(/<NAME>/g, 'Will'), // rewrite in YOUR voice
  retriever: new InMemoryRetriever([
    { id: '1', text: 'A sample of my own writing…' },
  ]),
  retrieveK: 3,
});

// Apps just call this — no system prompts or retrieval to manage.
for await (const ev of me.chat({ conversationId: 'u1', message: 'Draft a reply.' })) {
  if (ev.type === 'text') process.stdout.write(ev.delta);
}

// Teach it more of your writing over time:
await me.learn([{ id: '2', text: 'Another sample…' }]);
```

## What's yours to provide

- **The style guide** — `STARTER_STYLE_GUIDE` is a template; rewrite it concretely
  in your voice (do/don't + short examples). This is the biggest lever.
- **Your writing** — feed real samples into the retriever (`new InMemoryRetriever([...])`
  or `persona.learn([...])`). Swap `InMemoryRetriever` for an embedding-backed
  store later by implementing the `Retriever` interface.

## Flint's own guides (style variants)

Flint's style guides are exported by name in `FLINT_STYLE_VARIANTS`:

| variant | guide | what |
| --- | --- | --- |
| `v1` | `FLINT_STYLE_GUIDE` | what Flint runs on today, frontier and local |
| `v2` | `FLINT_STYLE_GUIDE_V2` | v1 with six rules revised from parity run 20260924-tiered (search only for facts that change, no provenance narration, depth by question type, calibration on contested questions, no talk of its own training off-topic, derived numbers via the calculate tool) |
| `local-v1` | `FLINT_LOCAL_STYLE_GUIDE` | a compact guide for 27-30B local models: 1,072 Qwen2.5 tokens against v1's 3,125, the same rules plus no invented specifics, at most two searches, no template phrases |

The server picks one per brain from `FLINT_STYLE_VARIANT` / `FLINT_LOCAL_STYLE_VARIANT`
(both `v1` when unset), and an eval request can name one with `styleVariant`
(`apps/parity --flint-variant`). A name means one text: every variant is pinned
by sha256 in `test/flint-variants.test.ts`. Revise a guide under a new name (`v3`,
`local-v2`), or cached parity answers for the old name stop meaning what they say.

The one exception (2026-09-25): all three were revised in place, because v1 and v2
are live and told Flint his own model retrains weekly, which it doesn't. They now say
what does carry over (long-term memory and the recent part of the conversation: the
server sends only its last turns, see `FLINT_HISTORY_TURNS`) and that what isn't in
front of Flint is said to be missing, not reconstructed; what the local open model is
for (private questions, outages), and that fine-tuning is paused until a candidate
measurably beats it. v1 and v2 no longer call true things about the engine wrong
("each conversation I start from the same base model"); they ask for what carries over
and what doesn't instead. A greeting gets a short reply with no status report, v1 now
has v2's "Stay on the question" line, old mistakes aren't volunteered, and what Will
says he doesn't care about gets dropped. Don't resume
a parity run (`--run`) started before that commit: its cached answers are from the
old texts.

## Why it's a separate package

`@flint/core` deliberately ships no personalization or retrieval (that's the
app's job). `@flint/persona` is the opt-in layer that adds them — keeping the
core provider-agnostic and lean.
