import 'dotenv/config';
import {
  Flint,
  AnthropicProvider,
  OllamaProvider,
  type AiObserver,
  type ProviderAdapter,
  type Tool,
} from '@flint/core';
import { MockProvider } from './mock-provider.js';

/**
 * Playground — proves @flint/core works when consumed as a separate package
 * (workspace dependency). Demonstrates the three things an app actually does:
 * streaming, tool calling, and memory-backed multi-turn chat — all through
 * Flint, with the provider swappable underneath.
 *
 * Provider is chosen by env, and NOTHING below the selection changes:
 *   OLLAMA_MODEL=llama3.1   → local Ollama (no Anthropic, no cloud)
 *   ANTHROPIC_API_KEY=...   → Anthropic
 *   (neither)               → in-app mock, offline
 */

const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
const ollamaModel = process.env.OLLAMA_MODEL?.trim();

let provider: ProviderAdapter;
let defaultModel: string;
if (ollamaModel) {
  provider = new OllamaProvider({
    ...(process.env.OLLAMA_HOST ? { baseURL: process.env.OLLAMA_HOST } : {}),
  });
  defaultModel = ollamaModel;
} else if (apiKey) {
  provider = new AnthropicProvider({ apiKey });
  defaultModel = 'claude-sonnet-4-6';
} else {
  provider = new MockProvider();
  defaultModel = 'mock-model';
}

// The default observer is a no-op; here we wire a tiny console observer to show
// that ALL observability flows through the injected seam (Flint never logs).
const observer: AiObserver = {
  onToolCall: (e) => console.error(`  · [observer] tool requested: ${e.call.toolName}`),
  onError: (e) => console.error(`  · [observer] error: ${e.error.kind} — ${e.error.message}`),
};

const flint = new Flint({
  provider,
  defaultModel,
  observer,
  maxConcurrent: 4,
});

// A side-effect-free (idempotent) tool the model may call.
const getTime: Tool = {
  definition: {
    name: 'get_current_time',
    description: 'Returns the current UTC time as an ISO 8601 string.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    idempotent: true,
  },
  handler: () => new Date().toISOString(),
};

async function turn(message: string, tools?: Tool[]): Promise<void> {
  console.log(`\nUser: ${message}`);
  process.stdout.write('Assistant: ');
  for await (const ev of flint.chat(
    { conversationId: 'demo', message, system: 'You are concise and friendly.', ...(tools ? { tools } : {}) },
  )) {
    if (ev.type === 'text') process.stdout.write(ev.delta);
    if (ev.type === 'error') console.error(`\n[turn failed: ${ev.error.kind}]`);
  }
  process.stdout.write('\n');
}

async function main(): Promise<void> {
  console.log(`Flint playground — provider: ${provider.name}, model: ${defaultModel}`);
  const caps = flint.getCapabilities();
  console.log(`Capabilities: tools=${caps.toolCalling}, streaming=${caps.streaming}, ctx=${caps.maxContextTokens}`);

  // Turn 1: streaming + tool calling, committed to memory on success.
  await turn('What time is it right now?', [getTime]);

  // Turn 2: memory-backed — references the prior turn without re-sending it.
  await turn('Thanks! Can you remind me what I just asked you?');

  // Show the transactional memory state.
  const history = await flint.store.getMessages('demo');
  const turns = await flint.store.getTurns('demo');
  console.log(
    `\nMemory: ${turns.length} turns (` +
      turns.map((t) => t.status).join(', ') +
      `), ${history.length} messages in history.`,
  );
  console.log('Cross-package consumption verified ✅');
}

main().catch((err) => {
  console.error('Playground failed:', err);
  process.exit(1);
});
