import 'dotenv/config';
import { Flint, AnthropicProvider, OllamaProvider, type ProviderAdapter } from '@flint/core';
import {
  Persona,
  InMemoryLessonStore,
  InMemoryRetriever,
  reflect,
  FLINT_STYLE_GUIDE,
  FLINT_VOICE_EXEMPLARS,
} from '@flint/persona';

/**
 * Nightly-reflection demo — shows Flint learning from a session and applying it.
 *
 *   OLLAMA_MODEL=qwen2.5:14b pnpm --filter playground reflect
 *   ANTHROPIC_API_KEY=...    pnpm --filter playground reflect
 *
 * Needs a real model (the mock can't reflect). Uses a fixed timestamp so the run
 * is deterministic.
 */

const NOW = 1_700_000_000_000;

function pickProvider(): { provider: ProviderAdapter; model: string } | null {
  const ollama = process.env.OLLAMA_MODEL?.trim();
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (ollama) {
    return {
      provider: new OllamaProvider(process.env.OLLAMA_HOST ? { baseURL: process.env.OLLAMA_HOST } : {}),
      model: ollama,
    };
  }
  if (key) return { provider: new AnthropicProvider({ apiKey: key }), model: 'claude-sonnet-4-6' };
  return null;
}

async function main(): Promise<void> {
  const chosen = pickProvider();
  if (!chosen) {
    console.error('No live model. Set OLLAMA_MODEL or ANTHROPIC_API_KEY.');
    process.exit(1);
  }
  const flint = new Flint({ provider: chosen.provider, defaultModel: chosen.model });
  const lessonStore = new InMemoryLessonStore();
  const me = new Persona(flint, {
    name: 'Flint',
    styleGuide: FLINT_STYLE_GUIDE,
    retriever: new InMemoryRetriever(FLINT_VOICE_EXEMPLARS),
    lessonStore,
  });

  console.log(`Reflection demo — ${chosen.provider.name} / ${chosen.model}\n`);

  // 1) A short "day": the user reveals preferences and a correction.
  const cid = 'day-1';
  const utterances = [
    'Quick context for how I like to work: for small services always default to SQS, never Kafka. And I hate the word "robust" — never use it.',
    'Also, when I ask for a recommendation, commit to one. Don\'t give me a both-sides answer.',
  ];
  for (const u of utterances) {
    process.stdout.write(`You: ${u}\nFlint: `);
    for await (const ev of me.chat({ conversationId: cid, message: u })) {
      if (ev.type === 'text') process.stdout.write(ev.delta);
    }
    process.stdout.write('\n\n');
  }

  // 2) Nightly reflection over the day's logged messages.
  const messages = await flint.store.getMessages(cid);
  const { learned } = await reflect({ flint, messages, lessonStore, now: NOW, conversationId: cid });
  console.log(`--- reflection learned ${learned.length} lesson(s) ---`);
  for (const l of learned) console.log(`  • (${l.category}) ${l.text}`);

  // 3) Prove it stuck: those lessons now ride in the persona's context.
  console.log('\nNext session, these are injected into Flint\'s system prompt automatically.');
  console.log('Flint has evolved — no retraining, no cloud.');
}

main().catch((err) => {
  console.error('reflect-demo failed:', err);
  process.exit(1);
});
