import { describe, it, expect } from 'vitest';
import { LocalOpenAiProvider, localCapabilities, isLoopbackHost } from '../../src/provider/local/index.js';
import { parseBrainLabel, vendorOfProvider } from '../../src/pricing.js';
import type { Message } from '../../src/types/message.js';
import type { ToolDefinition } from '../../src/types/tool.js';

/** LocalOpenAiProvider: one adapter for any OpenAI-compatible local server. */

type Init = RequestInit & { body?: string };

function recorder(response: unknown = { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } }) {
  const calls: Array<{ url: string; init: Init; body: Record<string, unknown> }> = [];
  const fn = (async (url: string | URL, init?: Init) => {
    calls.push({ url: String(url), init: init ?? {}, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
    return new Response(JSON.stringify(response), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const user = (content: string): Message => ({ id: 'u1', role: 'user', content, timestamp: 0 });
const can = () => localCapabilities({ contextTokens: 16384, tools: true });
const cannot = () => localCapabilities({ contextTokens: 4096, tools: false });

const dotted: ToolDefinition = {
  name: 'web.web_search',
  description: 'Search the web',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
  idempotent: true,
};

describe('LocalOpenAiProvider', () => {
  it("is named 'local', which no vendor bills", () => {
    const p = new LocalOpenAiProvider({ baseURL: 'http://127.0.0.1:11434/v1', capabilities: can });
    expect(p.name).toBe('local');
    expect(vendorOfProvider(p.name)).toBeUndefined();
    expect(parseBrainLabel('local:some-model:7b')).toEqual({ provider: 'local', model: 'some-model:7b' });
  });

  it('posts to <baseURL>/chat/completions with max_tokens, a placeholder bearer and no redirects', async () => {
    const { fn, calls } = recorder();
    const p = new LocalOpenAiProvider({ baseURL: 'http://127.0.0.1:11434/v1/', capabilities: can, fetch: fn });
    const r = await p.generate({ model: 'm', messages: [user('hi')], maxTokens: 64 });
    expect(r.message.content).toBe('ok');
    expect(calls[0]!.url).toBe('http://127.0.0.1:11434/v1/chat/completions');
    expect(calls[0]!.body.max_tokens).toBe(64);
    expect('max_completion_tokens' in calls[0]!.body).toBe(false);
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer local');
    expect(calls[0]!.init.redirect).toBe('error');
  });

  it("sends a server's own key when it has one", async () => {
    const { fn, calls } = recorder();
    const p = new LocalOpenAiProvider({ baseURL: 'http://127.0.0.1:8080/v1', apiKey: 'server-key', capabilities: can, fetch: fn });
    await p.generate({ model: 'm', messages: [user('hi')] });
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer server-key');
  });

  it('offers tools to a model that can call them, with dotted names made wire-safe and mapped back', async () => {
    const { fn, calls } = recorder({
      choices: [{ message: { content: null, tool_calls: [{ id: 'call_1', function: { name: 'web__web_search', arguments: '{"query":"flint"}' } }] }, finish_reason: 'tool_calls' }],
    });
    const p = new LocalOpenAiProvider({ baseURL: 'http://127.0.0.1:11434/v1', capabilities: can, fetch: fn });
    const r = await p.generate({ model: 'm', messages: [user('search')], tools: [dotted] });
    const sent = calls[0]!.body.tools as Array<{ function: { name: string } }>;
    expect(sent[0]!.function.name).toBe('web__web_search');
    expect(r.reason).toBe('tool_call');
    expect(JSON.parse(r.message.content).toolCalls[0]).toMatchObject({ toolName: 'web.web_search', args: { query: 'flint' } });
  });

  it('never offers tools to a model that cannot call them', async () => {
    const { fn, calls } = recorder();
    const p = new LocalOpenAiProvider({ baseURL: 'http://127.0.0.1:11434/v1', capabilities: cannot, fetch: fn });
    await p.generate({ model: 'm', messages: [user('search')], tools: [dotted] });
    expect('tools' in calls[0]!.body).toBe(false);
    expect(p.getCapabilities('m').toolCalling).toBe('unsupported');
  });

  it("honours toolChoice 'none' by leaving the tools out (Ollama's /v1 has no tool_choice)", async () => {
    const { fn, calls } = recorder();
    const p = new LocalOpenAiProvider({ baseURL: 'http://127.0.0.1:11434/v1', capabilities: can, fetch: fn });
    await p.generate({ model: 'm', messages: [user('search')], tools: [dotted], toolChoice: 'none' });
    expect('tools' in calls[0]!.body).toBe(false);
    expect('tool_choice' in calls[0]!.body).toBe(false);
  });

  it('sends responseFormat as response_format, and merges extraBody', async () => {
    const { fn, calls } = recorder();
    const p = new LocalOpenAiProvider({ baseURL: 'http://127.0.0.1:11434/v1', capabilities: can, fetch: fn, extraBody: { reasoning_effort: 'none' } });
    const schema = { type: 'object', properties: { a: { type: 'string' } } };
    await p.generate({ model: 'm', messages: [user('hi')], responseFormat: { type: 'json_schema', name: 'thing', schema } });
    expect(calls[0]!.body.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'thing', schema, strict: false } });
    expect(calls[0]!.body.reasoning_effort).toBe('none');
  });

  describe('connects to this machine only, unless told otherwise', () => {
    const build = (baseURL: string, allowRemote?: boolean) =>
      new LocalOpenAiProvider({ baseURL, capabilities: can, ...(allowRemote !== undefined ? { allowRemote } : {}) });

    it('accepts 127.0.0.1, localhost and [::1]', () => {
      for (const u of ['http://127.0.0.1:11434/v1', 'http://localhost:8080/v1', 'http://[::1]:8080/v1', 'https://127.0.0.1/v1']) {
        expect(() => build(u), u).not.toThrow();
      }
    });

    it('refuses any other host, including one that only starts like a loopback address', () => {
      for (const u of ['http://192.168.1.20:11434/v1', 'http://127.0.0.1.example.com/v1', 'http://localhost.example.com/v1', 'https://api.openai.com/v1', 'http://0.0.0.0:11434/v1']) {
        expect(() => build(u), u).toThrow(/not on this machine/);
      }
    });

    it('allowRemote accepts another machine', () => {
      expect(() => build('http://192.168.1.20:11434/v1', true)).not.toThrow();
    });

    it('refuses a URL that is not http(s) or that carries credentials, and never repeats it in the error', () => {
      expect(() => build('ftp://127.0.0.1/v1')).toThrow(/http or https/);
      expect(() => build('not a url')).toThrow(/not a URL/);
      let message = '';
      try {
        build('http://will:hunter2@127.0.0.1:11434/v1');
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toMatch(/must not carry credentials/);
      expect(message).not.toMatch(/hunter2|will:/);
    });
  });
});

describe('localCapabilities', () => {
  it('reports the context it is given, and a quarter of it (at most 4096) for the reply', () => {
    expect(localCapabilities({ contextTokens: 16384, tools: true })).toEqual({
      toolCalling: 'native',
      structuredOutput: 'native',
      streaming: 'full',
      maxContextTokens: 16384,
      maxOutputTokens: 4096,
    });
    expect(localCapabilities({ contextTokens: 4096, tools: true }).maxOutputTokens).toBe(1024);
    expect(localCapabilities({ contextTokens: 131072, tools: true }).maxOutputTokens).toBe(4096);
  });

  it("tools: false is toolCalling 'unsupported', the flag a router reads", () => {
    expect(localCapabilities({ contextTokens: 4096, tools: false }).toolCalling).toBe('unsupported');
  });

  it('vision and structure are claimed only when the caller says so', () => {
    expect(localCapabilities({ contextTokens: 8192, tools: true }).vision).toBeUndefined();
    expect(localCapabilities({ contextTokens: 8192, tools: true, vision: true }).vision).toBe(true);
    expect(localCapabilities({ contextTokens: 8192, tools: true, structured: false }).structuredOutput).toBe('unreliable');
  });

  it('an explicit reply size is kept, inside the window', () => {
    expect(localCapabilities({ contextTokens: 8192, tools: true, maxOutputTokens: 512 }).maxOutputTokens).toBe(512);
    expect(localCapabilities({ contextTokens: 2048, tools: true, maxOutputTokens: 9000 }).maxOutputTokens).toBe(2048);
  });
});

describe('isLoopbackHost', () => {
  it('is exact, not a prefix test', () => {
    for (const h of ['127.0.0.1', 'localhost', 'LOCALHOST', '::1', '[::1]']) expect(isLoopbackHost(h), h).toBe(true);
    for (const h of ['127.0.0.1.evil.example', 'localhost.evil.example', '127.0.0.2', '0.0.0.0', '10.0.0.1', '', 'evil.example']) expect(isLoopbackHost(h), h).toBe(false);
  });
});
