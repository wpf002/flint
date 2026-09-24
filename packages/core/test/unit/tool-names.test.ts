import { describe, it, expect } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { AnthropicProvider } from '../../src/provider/anthropic/index.js';
import { Flint } from '../../src/index.js';
import type { Tool } from '../../src/index.js';
import { resolveToolName } from '../../src/core/tool-loop.js';
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

describe('resolveToolName', () => {
  const offered = ['web.web_search', 'web.fetch_url', 'remember'];

  it('keeps an exact name', () => {
    expect(resolveToolName('remember', offered)).toBe('remember');
  });
  it('restores a dropped namespace when only one tool fits', () => {
    expect(resolveToolName('web_search', offered)).toBe('web.web_search');
  });
  it('accepts a separator in place of the dot', () => {
    expect(resolveToolName('web_web_search', offered)).toBe('web.web_search');
    expect(resolveToolName('web-fetch_url', offered)).toBe('web.fetch_url');
  });
  it('refuses to guess between two servers', () => {
    expect(resolveToolName('web_search', [...offered, 'trident.web_search'])).toBeUndefined();
  });
  it('leaves an unknown name unresolved', () => {
    expect(resolveToolName('launch_rockets', offered)).toBeUndefined();
  });
});

/** An Anthropic client that streams one scripted turn per call and records each request. */
function scripted(turns: unknown[][]) {
  const bodies: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
  let i = 0;
  const client = {
    messages: {
      stream(body: (typeof bodies)[number]) {
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

const callTool = (name: string) => [
  messageStart(10),
  toolUseBlockStart(0, 'toolu_1', name),
  inputJsonDelta(0, '{"q":"x"}'),
  blockStop(0),
  messageDelta('tool_use', 5),
  messageStop(),
];
const answer = (text: string) => [
  messageStart(10),
  textBlockStart(0),
  textDelta(0, text),
  blockStop(0),
  messageDelta('end_turn', 5),
  messageStop(),
];

const search = (seen: string[]): Tool => ({
  definition: { name: 'web.web_search', description: 'search', inputSchema: { type: 'object', properties: {} }, idempotent: true },
  handler: (call) => {
    seen.push(call.toolName);
    return 'results';
  },
});

describe('tool loop with a model that mangles tool names', () => {
  it('runs the tool the model meant and finishes the turn', async () => {
    const seen: string[] = [];
    const { provider } = scripted([callTool('web_search'), answer('done')]);
    const out = await new Flint({ provider, defaultModel: 'claude-sonnet-4-6' }).generate({ prompt: 'q', tools: [search(seen)] });
    expect(seen).toEqual(['web.web_search']);
    expect(out.text).toBe('done');
  });

  it('hands an unknown tool back to the model as an error instead of failing the turn', async () => {
    const seen: string[] = [];
    const { provider, bodies } = scripted([callTool('launch_rockets'), answer('sorry, no such tool')]);
    const out = await new Flint({ provider, defaultModel: 'claude-sonnet-4-6' }).generate({ prompt: 'q', tools: [search(seen)] });
    expect(seen).toEqual([]);
    expect(out.text).toBe('sorry, no such tool');
    const fed = JSON.stringify(bodies[1]!.messages.at(-1));
    expect(fed).toContain("Unknown tool 'launch_rockets'");
    expect(fed).toContain('web.web_search');
  });
});
