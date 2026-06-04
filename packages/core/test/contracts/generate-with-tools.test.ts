import { describe, it, expect } from 'vitest';
import { providerFromCassette, generatedMessage } from './harness.js';
import { decodeToolCalls } from '../../src/index.js';
import type { ToolDefinition } from '../../src/index.js';

const getWeather: ToolDefinition = {
  name: 'get_weather',
  description: 'Get the weather for a city',
  inputSchema: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
  },
  idempotent: true,
};

describe('contract: generate-with-tools', () => {
  it('surfaces a tool_use response as a ToolCall with parsed args', async () => {
    const provider = providerFromCassette({
      kind: 'generate',
      response: generatedMessage({
        toolUses: [{ id: 'toolu_1', name: 'get_weather', input: { city: 'Paris' } }],
        stopReason: 'tool_use',
        inputTokens: 30,
        outputTokens: 15,
      }),
    });

    const result = await provider.generate({
      model: 'claude-sonnet-4-6',
      messages: [{ id: 'u1', role: 'user', content: 'Weather in Paris?', timestamp: 0 }],
      tools: [getWeather],
    });

    expect(result.reason).toBe('tool_call');

    const calls = decodeToolCalls(result.message);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.toolName).toBe('get_weather');
    expect(calls[0]?.args).toEqual({ city: 'Paris' });
  });
});
