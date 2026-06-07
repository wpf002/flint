import 'dotenv/config';
import { Flint, AnthropicProvider, OllamaProvider, type ProviderAdapter, type Tool } from '@flint/core';

/**
 * Tool-call check — verifies the model actually drives Flint's tool loop end to
 * end against a live provider. For local (Ollama) this exercises the prompted
 * tool protocol + JSON repair on a REAL model, which the offline contract suite
 * can't prove.
 *
 *   OLLAMA_MODEL=qwen2.5:14b pnpm --filter playground tools
 *   ANTHROPIC_API_KEY=...    pnpm --filter playground tools
 */

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

  let called = false;
  let calledArgs: unknown;
  const add: Tool = {
    definition: {
      name: 'add',
      description: 'Add two numbers and return the sum.',
      inputSchema: {
        type: 'object',
        properties: { a: { type: 'number' }, b: { type: 'number' } },
        required: ['a', 'b'],
      },
      idempotent: true,
    },
    handler: (call) => {
      called = true;
      calledArgs = call.args;
      const { a, b } = call.args as { a: number; b: number };
      return { sum: a + b };
    },
  };

  console.log(`Tool check — ${chosen.provider.name} / ${chosen.model}\n`);
  const { text, reason } = await flint.generate({
    prompt: 'What is 47 + 95? Use the add tool, then state the result.',
    tools: [add],
  });

  console.log(`tool called:   ${called ? 'YES' : 'NO'}`);
  console.log(`tool args:     ${JSON.stringify(calledArgs)}`);
  console.log(`final reason:  ${reason}`);
  console.log(`final answer:  ${text.slice(0, 200)}`);
  const ok = called && /142/.test(text);
  console.log(`\nverdict: ${ok ? 'PASS ✅ (tool driven + correct result surfaced)' : 'PARTIAL — see above'}`);
}

main().catch((err) => {
  console.error('tool-check failed:', err);
  process.exit(1);
});
