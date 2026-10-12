import 'dotenv/config';
import { Flint } from '@flint/core';
import { NO_LIVE_MODEL, pickProvider } from './provider.js';
import {
  Persona,
  InMemoryRetriever,
  FLINT_STYLE_GUIDE,
  FLINT_VOICE_EXEMPLARS,
  checkVoice,
} from '@flint/persona';

/**
 * Voice check — runs a fixed prompt set through the Flint persona against
 * whatever provider is configured, and scores each answer against Flint's hard
 * voice rules. This is the "measure honestly" gate (docs/PHASE3.md): run it on a
 * local model and on Anthropic, compare the scores, and you know whether a weak
 * result is the model's fault or the style guide's.
 *
 *   OLLAMA_MODEL=llama3.1   pnpm --filter playground voice
 *   PLAYGROUND_PROVIDER=anthropic ANTHROPIC_API_KEY=... pnpm --filter playground voice
 */

const PROMPTS = [
  'Should I use Kafka or SQS for a small app?',
  'Is it worth migrating our monolith to microservices right now?',
  'Explain what a race condition is.',
  'My startup idea is an AI that books dentist appointments. Thoughts?',
  'What were the main causes of the 2008 financial crisis?',
];

async function main(): Promise<void> {
  const chosen = await pickProvider();
  if (!chosen) {
    console.error(NO_LIVE_MODEL);
    process.exit(1);
  }

  const flint = new Flint({ provider: chosen.provider, defaultModel: chosen.model });
  const me = new Persona(flint, {
    name: 'Flint',
    styleGuide: FLINT_STYLE_GUIDE,
    retriever: new InMemoryRetriever(FLINT_VOICE_EXEMPLARS),
    retrieveK: 2,
  });

  console.log(`Voice check — ${chosen.provider.name} / ${chosen.model}\n`);
  let total = 0;
  for (const prompt of PROMPTS) {
    const { text } = await me.generate({ prompt });
    const v = checkVoice(text);
    total += v.score;
    console.log(`Q: ${prompt}`);
    console.log(`A: ${text.split('\n')[0]?.slice(0, 160)}…`);
    console.log(
      `   voice ${(v.score * 100).toFixed(0)}%` +
        (v.violations.length ? ` — ${v.violations.map((x) => x.detail).join('; ')}` : ' ✅'),
    );
    console.log('');
  }
  console.log(`Average voice score: ${((total / PROMPTS.length) * 100).toFixed(0)}%`);
  console.log('Run this on local AND Anthropic; the gap tells you what to fix.');
}

main().catch((err) => {
  console.error('voice-check failed:', err);
  process.exit(1);
});
