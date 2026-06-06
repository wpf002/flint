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

## Why it's a separate package

`@flint/core` deliberately ships no personalization or retrieval (that's the
app's job). `@flint/persona` is the opt-in layer that adds them — keeping the
core provider-agnostic and lean.
