/**
 * Loopback stand-ins for the process test: a model server that speaks Ollama's
 * own API, and an outside brain that speaks Anthropic's Messages API. They talk
 * to nothing, answer with fixed text, and keep every request they were sent:
 * what the real server put on the wire is what the test reads.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (d: Buffer) => chunks.push(d));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
const listen = (server: Server): Promise<number> => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
const close = (server: Server): Promise<void> =>
  new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
const parse = (raw: string): Record<string, unknown> | undefined => {
  try {
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
  } catch {
    return { _unparsed: raw.slice(0, 200) };
  }
};

export interface StubRequest {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
}

export interface OllamaModel {
  loaded?: boolean;
  contextLength?: number;
  family?: string;
  /**
   * The model runs on Ollama's own servers whatever it is called here (a cloud
   * model copied under a plain name): the listing gives it this `remote_host`,
   * as Ollama's does.
   */
  remoteHost?: string;
}

interface ChatMessage {
  role: string;
  content?: unknown;
}

export interface OllamaStub {
  origin: string;
  requests: StubRequest[];
  /** The chat requests, in order. */
  chats(): StubRequest[];
  /** Which tool, if any, the "model" calls for a request: decided by the test, from the words of the last user message. */
  toolFor: ((lastUserMessage: string, offered: string[]) => { name: string; args: Record<string, unknown> } | undefined) | undefined;
  /** What the "model" says for a request, when the test has something particular for it (the reply to a memory-extraction prompt). */
  replyFor: ((body: Record<string, unknown>, lastUserMessage: string) => string | undefined) | undefined;
  close(): Promise<void>;
}

/** The last thing the user said in a chat request, and the names of the tools it offered. */
export function chatFacts(body: Record<string, unknown> | undefined): { last: string; offered: string[]; system: string; text: string; toolResults: string[] } {
  const messages = (Array.isArray(body?.messages) ? body.messages : []) as ChatMessage[];
  const last = [...messages].reverse().find((m) => m.role === 'user');
  const tools = (Array.isArray(body?.tools) ? body.tools : []) as Array<{ function?: { name?: string } }>;
  return {
    last: String(last?.content ?? ''),
    offered: tools.map((t) => String(t.function?.name ?? '')),
    system: messages.filter((m) => m.role === 'system').map((m) => String(m.content ?? '')).join('\n'),
    text: JSON.stringify(messages),
    toolResults: messages.filter((m) => m.role === 'tool').map((m) => String(m.content ?? '')),
  };
}

/**
 * A model server on Ollama's own API: version, tags, ps, show, a load, the
 * embedding calls and chat (whole or streamed). Its reply names the model, so a
 * test can tell who answered: `LOCAL(<model>) reply.`
 */
export async function startOllamaStub(models: Record<string, OllamaModel>): Promise<OllamaStub> {
  const requests: StubRequest[] = [];
  // Words hashed into 96 buckets: texts that share words are close, so tool routing and recall behave as with a real embedder.
  const vector = (text: string): number[] => {
    const v = new Array<number>(96).fill(0);
    for (const w of text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) v[createHash('md5').update(w).digest()[0]! % 96]! += 1;
    if (v.every((x) => x === 0)) v[0] = 1;
    return v;
  };
  const stub: OllamaStub = {
    origin: '',
    requests,
    chats: () => requests.filter((r) => r.path === '/api/chat'),
    toolFor: undefined,
    replyFor: undefined,
    close: () => close(server),
  };
  const server = createServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0]!;
    const body = parse(await readBody(req));
    requests.push({ method: req.method ?? 'GET', path, body });
    const json = (status: number, b: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(b));
    };
    const named = (name: unknown): OllamaModel | undefined => (typeof name === 'string' ? models[name] : undefined);
    if (req.method === 'GET' && path === '/api/version') return json(200, { version: '0.34.4' });
    if (req.method === 'GET' && path === '/api/tags') {
      return json(200, {
        models: Object.entries(models).map(([name, m]) => ({ name, model: name, size: 1, details: { family: m.family ?? 'test' }, ...(m.remoteHost ? { remote_host: m.remoteHost, remote_model: 'cloud-model:120b' } : {}) })),
      });
    }
    if (req.method === 'GET' && path === '/api/ps') {
      return json(200, { models: Object.entries(models).filter(([, m]) => m.loaded).map(([name, m]) => ({ name, model: name, context_length: m.contextLength ?? 4096, expires_at: '2099-01-01T00:00:00Z', details: { family: m.family ?? 'test' } })) });
    }
    if (req.method === 'POST' && path === '/api/show') {
      const m = named(body?.model ?? body?.name);
      return m ? json(200, { capabilities: ['completion', 'tools'], model_info: { 'test.context_length': 131072 }, details: { family: m.family ?? 'test' } }) : json(404, { error: 'model not found' });
    }
    if (req.method === 'POST' && path === '/api/generate') {
      const m = named(body?.model);
      if (!m) return json(404, { error: 'model not found' });
      m.loaded = true;
      return json(200, { model: body!.model, done: true, done_reason: 'load' });
    }
    if (req.method === 'POST' && path === '/api/embeddings') return json(200, { embedding: vector(String(body?.prompt ?? '')) });
    if (req.method === 'POST' && path === '/api/embed') return json(200, { embeddings: (Array.isArray(body?.input) ? body.input : [body?.input ?? '']).map((t) => vector(String(t))) });
    if (req.method === 'POST' && path === '/api/chat') {
      const m = named(body?.model);
      if (!m) return json(404, { error: 'model not found' });
      m.loaded = true;
      const facts = chatFacts(body);
      // One tool call a turn at most: once a result is in the messages, the "model" answers.
      const call = facts.toolResults.length === 0 && facts.offered.length >= 0 ? stub.toolFor?.(facts.last, facts.offered) : undefined;
      const said = call ? undefined : stub.replyFor?.(body!, facts.last);
      const message = call ? { role: 'assistant', content: '', tool_calls: [{ function: { name: call.name, arguments: call.args } }] } : { role: 'assistant', content: said ?? `LOCAL(${String(body!.model)}) reply.` };
      const tail = { model: body!.model, done: true, done_reason: 'stop', prompt_eval_count: Math.ceil(facts.text.length / 4), eval_count: 5 };
      if (body?.stream) {
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        res.write(`${JSON.stringify({ model: body.model, message, done: false })}\n`);
        return res.end(`${JSON.stringify({ ...tail, message: { role: 'assistant', content: '' } })}\n`);
      }
      return json(200, { ...tail, message });
    }
    return json(404, { error: 'not found' });
  });
  stub.origin = `http://127.0.0.1:${await listen(server)}`;
  return stub;
}

export interface CloudStub {
  origin: string;
  requests: StubRequest[];
  /** Does anything this stub was sent, from request `from` on, contain `needle`? */
  saw(needle: string, from?: number): boolean;
  close(): Promise<void>;
}

/**
 * An outside brain on Anthropic's Messages API (the server reaches it through
 * ANTHROPIC_BASE_URL, so to the server it is the real, outside wire). It
 * answers `CLOUD(<model>) reply.`, whole or streamed.
 */
export async function startCloudStub(): Promise<CloudStub> {
  const requests: StubRequest[] = [];
  const server = createServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0]!;
    const body = parse(await readBody(req));
    requests.push({ method: req.method ?? 'GET', path, body });
    if (req.method !== 'POST' || path !== '/v1/messages') {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'not found' } }));
    }
    const text = `CLOUD(${String(body?.model)}) reply.`;
    const usage = { input_tokens: Math.ceil(JSON.stringify(body?.messages ?? []).length / 4), output_tokens: 5 };
    if (body?.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const ev = (name: string, data: unknown): boolean => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
      ev('message_start', { type: 'message_start', message: { id: 'msg_stub', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } });
      ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
      ev('content_block_stop', { type: 'content_block_stop', index: 0 });
      ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } });
      ev('message_stop', { type: 'message_stop' });
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'msg_stub', type: 'message', role: 'assistant', model: body?.model, content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage }));
  });
  const origin = `http://127.0.0.1:${await listen(server)}`;
  return { origin, requests, saw: (needle, from = 0) => requests.slice(from).some((r) => JSON.stringify(r.body ?? '').includes(needle)), close: () => close(server) };
}
