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

  // An app that holds a tool back on purpose can say why (FlintConfig.unknownTool).
  it('with unknownTool, the app says what the model is told about a tool that was not offered, and nothing runs', async () => {
    const seen: string[] = [];
    const asked: Array<{ name: string; offered: readonly string[] }> = [];
    const { provider, bodies } = scripted([callTool('trident.gmail_search'), answer('I cannot look at mail for this one')]);
    const flint = new Flint({
      provider,
      defaultModel: 'claude-sonnet-4-6',
      unknownTool: (call, offered) => {
        asked.push({ name: call.toolName, offered });
        return { isError: true, content: 'This message is private, so nothing outside this Mac is asked.' };
      },
    });
    const out = await flint.generate({ prompt: 'q', tools: [search(seen)] });
    expect(seen).toEqual([]);
    expect(out.text).toBe('I cannot look at mail for this one');
    expect(asked).toEqual([{ name: 'trident.gmail_search', offered: ['web.web_search'] }]);
    const fed = JSON.stringify(bodies[1]!.messages.at(-1));
    expect(fed).toContain('This message is private, so nothing outside this Mac is asked.');
    expect(fed).not.toContain('Unknown tool');
  });

  it('unknownTool that returns undefined, or throws, leaves the default; a tool that WAS offered is never asked about', async () => {
    for (const unknownTool of [() => undefined, () => { throw new Error('the app has its own trouble'); }]) {
      const { provider, bodies } = scripted([callTool('launch_rockets'), answer('sorry')]);
      await new Flint({ provider, defaultModel: 'claude-sonnet-4-6', unknownTool }).generate({ prompt: 'q', tools: [search([])] });
      expect(JSON.stringify(bodies[1]!.messages.at(-1))).toContain("Unknown tool 'launch_rockets'");
    }
    let asked = 0;
    const seen: string[] = [];
    const { provider } = scripted([callTool('web_search'), answer('done')]);
    await new Flint({ provider, defaultModel: 'claude-sonnet-4-6', unknownTool: () => void asked++ }).generate({ prompt: 'q', tools: [search(seen)] });
    expect(asked).toBe(0);
    expect(seen).toHaveLength(1);
  });
});
