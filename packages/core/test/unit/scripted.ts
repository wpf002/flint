import type Anthropic from '@anthropic-ai/sdk';
import { AnthropicProvider } from '../../src/provider/anthropic/index.js';
import type { GenerateArgs, ProviderAdapter } from '../../src/provider/adapter.js';
import type { StreamEvent } from '../../src/types/stream.js';
import type { Tool } from '../../src/index.js';
import {
  messageStart,
  toolUseBlockStart,
  inputJsonDelta,
  blockStop,
  messageDelta,
  messageStop,
  textBlockStart,
  textDelta,
} from '../contracts/harness.js';

/** The Anthropic request body as the SDK client received it. */
export interface AnthropicBody {
  messages: Array<{ role: string; content: unknown }>;
  tools?: Array<{ name: string }>;
  tool_choice?: unknown;
}

/**
 * An Anthropic client that streams one scripted turn per call and records each
 * request. The last turn repeats if the loop calls more often than scripted.
 */
export function scriptedAnthropic(turns: unknown[][]) {
  const bodies: AnthropicBody[] = [];
  let i = 0;
  const client = {
    messages: {
      stream(body: AnthropicBody) {
        bodies.push(JSON.parse(JSON.stringify(body)));
        const events = turns[Math.min(i++, turns.length - 1)]!;
        return (async function* () {
          for (const e of events) yield e;
        })();
      },
      async create() {
        throw new Error('stream only');
      },
    },
  };
  return { provider: new AnthropicProvider({ client: client as unknown as Anthropic }), bodies };
}

/** Raw Anthropic events: one tool_use block, stop_reason tool_use. */
export const callTool = (name: string, id = 'toolu_1') => [
  messageStart(10),
  toolUseBlockStart(0, id, name),
  inputJsonDelta(0, '{"q":"x"}'),
  blockStop(0),
  messageDelta('tool_use', 5),
  messageStop(),
];

/** Raw Anthropic events: one text block (or none when `text` is empty), then `stop`. */
export const answer = (text: string, stop: Anthropic.StopReason = 'end_turn') => [
  messageStart(10),
  ...(text ? [textBlockStart(0), textDelta(0, text), blockStop(0)] : []),
  messageDelta(stop, 5),
  messageStop(),
];

/** A search tool that records every call it runs. */
export const searchTool = (seen: string[], result: unknown = 'results'): Tool => ({
  definition: {
    name: 'web.web_search',
    description: 'search',
    inputSchema: { type: 'object', properties: {} },
    idempotent: true,
  },
  handler: (call) => {
    seen.push(call.toolName);
    return result;
  },
});

/**
 * A provider-agnostic stub that plays canonical StreamEvents, one scripted turn
 * per call (the last repeats), and records the args of every call.
 */
export function scriptedEvents(turns: StreamEvent[][]) {
  const calls: GenerateArgs[] = [];
  let i = 0;
  const provider: ProviderAdapter = {
    name: 'stub',
    getCapabilities: () => ({
      toolCalling: 'native',
      structuredOutput: 'native',
      streaming: 'full',
      maxContextTokens: 100_000,
      maxOutputTokens: 1_000,
    }),
    estimateTokens: () => 1,
    generate: () => Promise.reject(new Error('stream only')),
    async *stream(args) {
      calls.push(args);
      for (const e of turns[Math.min(i++, turns.length - 1)]!) yield e;
    },
  };
  return { provider, calls };
}

const usage = { input: 1, output: 1 };

/** Canonical events: one tool call. */
export const eventsCallTool = (id = 'c1'): StreamEvent[] => [
  { type: 'tool_call', call: { id, toolName: 'web.web_search', args: { q: 'x' } } },
  { type: 'done', reason: 'tool_call', usage },
];

/** Canonical events: some text, then `done` with `reason`. */
export const eventsAnswer = (text: string, reason: 'complete' | 'refusal' | 'max_tokens' = 'complete'): StreamEvent[] => [
  ...(text ? [{ type: 'text' as const, delta: text }] : []),
  { type: 'done', reason, usage },
];
