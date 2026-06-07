# Self-evolution — how Flint grows on his own

The goal: Flint isn't reset every session. He accumulates durable lessons from
past interactions and applies them going forward — autonomously, locally, no
cloud.

## The loop

```
conversations            nightly reflection           future context
(MemoryStore, @flint/core) ──► reflect() ──► lessons ──► Persona system prompt
        ▲                                  (LessonStore)        │
        └──────────────────  better answers  ◄─────────────────┘
```

1. **Live.** App talks to Flint through a `Persona`. Turns are logged to the
   `MemoryStore` (transactional, in `@flint/core`).
2. **Reflect (nightly).** `reflect()` reads a batch of logged interactions, asks
   the local model to distill durable lessons (corrections, preferences, facts,
   mistakes, insights), and writes the new ones to a `LessonStore` (deduped).
3. **Apply.** On every subsequent call, the `Persona` injects the most recent
   lessons into the system prompt under "What you've learned from past sessions."
   Behavior compounds.

Nothing here is Anthropic-specific. Reflection runs on whatever provider Flint
is configured with — i.e. your local model.

## Wiring it up

```ts
import { Flint } from '@flint/core';
import { Persona, InMemoryLessonStore, reflect, FLINT_STYLE_GUIDE } from '@flint/persona';

const lessonStore = new InMemoryLessonStore(); // swap for a durable store in prod
const flint = new Flint({ provider, defaultModel, memory: yourDurableStore });

// Apps use this — it self-applies accumulated lessons.
const me = new Persona(flint, { name: 'Flint', styleGuide: FLINT_STYLE_GUIDE, lessonStore });

// Nightly job (cron / launchd):
const messages = await flint.store.getMessages(conversationId);
const { learned } = await reflect({ flint, messages, lessonStore, now: Date.now() });
```

## Scheduling

Reflection is a unit of work; scheduling is the OS's job. On macOS, a `launchd`
plist or `cron` entry that runs the nightly script once a day is enough. The
`reflect()` call is what it runs.

## What's intentionally left to you / later

- **Durable stores.** `InMemoryLessonStore` (and `@flint/core`'s `InMemoryStore`)
  are reference impls — they vanish on restart. Production implements the
  `LessonStore` / `MemoryStore` interfaces against a real database.
- **Lesson curation.** Today reflection appends and dedupes. A maturity step is
  pruning/merging stale or conflicting lessons (a reflection pass over the
  lessons themselves).
- **Relevance over recency.** The persona injects the most *recent* lessons; a
  later step retrieves the most *relevant* ones per query (same `Retriever`
  seam).
