import 'dotenv/config';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Flint, AnthropicProvider, OllamaProvider, type ProviderAdapter } from '@flint/core';
import {
  Persona,
  InMemoryRetriever,
  reflect,
  consolidate,
  FLINT_STYLE_GUIDE,
  FLINT_VOICE_EXEMPLARS,
} from '@flint/persona';
import { FileMemoryStore, FileLessonStore } from './stores.js';

/**
 * `ask` — a real consumer app: your personal Flint as a CLI. Proves the whole
 * vision end to end — Flint dropped into an app, running locally, with DURABLE
 * memory + lessons so it actually evolves across runs.
 *
 *   ask "<question>"        chat (memory-backed), default command
 *   ask reflect             distill nightly lessons from recent memory
 *   ask lessons             list what Flint has learned
 *   ask reset               wipe memory + lessons
 *
 * Provider: OLLAMA_MODEL (local, default 'qwen2.5:14b' if Ollama is up) or
 * ANTHROPIC_API_KEY. Data lives in ~/.flint/.
 */

const DATA_DIR = join(homedir(), '.flint');
const CONVERSATION = 'main';

function buildProvider(): { provider: ProviderAdapter; model: string } {
  const ollama = process.env.OLLAMA_MODEL?.trim();
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (ollama) {
    return {
      provider: new OllamaProvider(process.env.OLLAMA_HOST ? { baseURL: process.env.OLLAMA_HOST } : {}),
      model: ollama,
    };
  }
  if (key) return { provider: new AnthropicProvider({ apiKey: key }), model: 'claude-sonnet-4-6' };
  // Default to local Ollama with the recommended model.
  return { provider: new OllamaProvider(), model: 'qwen2.5:14b' };
}

function buildFlint() {
  const memory = new FileMemoryStore(join(DATA_DIR, 'memory.json'));
  const lessonStore = new FileLessonStore(join(DATA_DIR, 'lessons.json'));
  const { provider, model } = buildProvider();
  const flint = new Flint({ provider, defaultModel: model, memory });
  const persona = new Persona(flint, {
    name: 'Flint',
    styleGuide: FLINT_STYLE_GUIDE,
    retriever: new InMemoryRetriever(FLINT_VOICE_EXEMPLARS),
    lessonStore,
  });
  return { flint, persona, lessonStore, model, providerName: provider.name };
}

async function cmdChat(message: string): Promise<void> {
  const { persona } = buildFlint();
  process.stdout.write('Flint: ');
  for await (const ev of persona.chat({ conversationId: CONVERSATION, message })) {
    if (ev.type === 'text') process.stdout.write(ev.delta);
    if (ev.type === 'error') process.stderr.write(`\n[error: ${ev.error.kind} — ${ev.error.message}]`);
  }
  process.stdout.write('\n');
}

async function cmdReflect(): Promise<void> {
  const { flint, lessonStore } = buildFlint();
  const messages = await flint.store.getMessages(CONVERSATION);
  if (messages.length === 0) {
    console.log('Nothing to reflect on yet. Have a conversation first.');
    return;
  }
  process.stderr.write('reflecting on recent sessions...\n');
  const { learned } = await reflect({
    flint,
    messages,
    lessonStore,
    now: Date.now(),
    conversationId: CONVERSATION,
  });
  if (learned.length === 0) {
    console.log('No new durable lessons this time.');
    return;
  }
  console.log(`Learned ${learned.length} new lesson(s):`);
  for (const l of learned) console.log(`  • (${l.category}) ${l.text}`);
}

async function cmdConsolidate(): Promise<void> {
  const { flint, lessonStore } = buildFlint();
  process.stderr.write('consolidating lessons...\n');
  const res = await consolidate({ flint, lessonStore, now: Date.now() });
  if (!res.changed) {
    console.log(`No consolidation needed (${res.before} lesson(s)).`);
    return;
  }
  console.log(`Consolidated ${res.before} → ${res.after} lesson(s):`);
  for (const l of res.lessons) console.log(`  • (${l.category}) ${l.text}`);
}

async function cmdLessons(): Promise<void> {
  const { lessonStore } = buildFlint();
  const all = await lessonStore.all();
  if (all.length === 0) {
    console.log('No lessons yet. Run `ask reflect` after some conversations.');
    return;
  }
  console.log(`Flint has learned ${all.length} lesson(s):`);
  for (const l of all) console.log(`  • (${l.category}) ${l.text}`);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);

  if (!cmd || cmd === 'help' || cmd === '--help') {
    console.log('ask "<question>" | ask reflect | ask consolidate | ask lessons');
    return;
  }
  if (cmd === 'reflect') return cmdReflect();
  if (cmd === 'consolidate') return cmdConsolidate();
  if (cmd === 'lessons') return cmdLessons();

  // Anything else is treated as the message (so `ask "..."` just works).
  const message = cmd === 'chat' ? rest.join(' ') : [cmd, ...rest].join(' ');
  if (!message.trim()) {
    console.error('Usage: ask "<question>"');
    process.exit(1);
  }
  return cmdChat(message);
}

main().catch((err) => {
  console.error('ask failed:', err);
  process.exit(1);
});
