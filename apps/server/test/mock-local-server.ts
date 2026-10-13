/**
 * A local model server for tests: a real HTTP server on 127.0.0.1 (port 0)
 * that speaks what Flint asks a local server.
 *
 *  - OpenAI-compatible: GET /v1/models, POST /v1/chat/completions (JSON and
 *    SSE), in the shapes Ollama 0.34.4 sends (recorded 2026-10-12).
 *  - Ollama's own routes the health probes use: /api/version, /api/tags,
 *    /api/ps, /api/show, /api/generate (a load, when there is no prompt), and
 *    /api/chat (NDJSON) for the native adapter.
 *  - llama.cpp's /health.
 *
 * Each model is scripted: installed or not, in memory or not, how long it takes
 * to load, how long before its first token (or never), and what it says. Every
 * request is recorded, so a test can check what was asked and of which model.
 *
 * It never talks to anything, and it is closed by the test that started it.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockModel {
  installed?: boolean;
  loaded?: boolean;
  /** The context it is loaded with (reported by /api/ps). */
  contextLength?: number;
  /** /api/show capabilities. Default: completion and tools. */
  capabilities?: string[];
  /** The model's own maximum context (/api/show `model_info.*.context_length`). Default 32768. A load asked for more is clamped to it, as Ollama does. */
  maxContext?: number;
  /** ms a load takes (an /api/generate with no prompt, or the first chat of a cold model). */
  loadMs?: number;
  /** ms before the first token of every answer. */
  firstTokenMs?: number;
  /** Never answer a chat: the request hangs until the client gives up. */
  stall?: boolean;
  /** What it answers, one entry per call (the last repeats). Default: text naming the model. */
  replies?: MockReply[];
  /**
   * The model runs on Ollama's own servers, whatever it is called here (a cloud
   * model, or one copied under a plain name): /api/tags lists it with this
   * `remote_host`, as Ollama does.
   */
  remoteHost?: string;
}

export type MockReply = { text: string } | { tool: { name: string; args: Record<string, unknown> } } | { status: number; message: string };

export interface RecordedRequest {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
  /** The `model` field of the body, when there was one. */
  model?: string;
}

export interface MockLocalServer {
  origin: string;
  /** `${origin}/v1` */
  baseURL: string;
  models: Map<string, MockModel>;
  requests: RecordedRequest[];
  /** Requests to the two chat routes. */
  chats(): RecordedRequest[];
  /** Load requests (an /api/generate with no prompt), by model. */
  warms(): string[];
  /** The kind of server it pretends to be: which probe routes answer. */
  kind: 'ollama' | 'llamacpp' | 'openai';
  /** llama.cpp only: /health answers 503 while true. */
  loading: boolean;
  /** Answer every request with a redirect to this URL. */
  redirectTo: string | undefined;
  /** What a model answers to one chat request, when the test decides it from the request itself; undefined: its scripted `replies`. */
  replyFor: ((request: RecordedRequest) => MockReply | undefined) | undefined;
  close(): Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function startMockLocalServer(init: { kind?: MockLocalServer['kind']; models?: Record<string, MockModel> } = {}): Promise<MockLocalServer> {
  const models = new Map<string, MockModel>(Object.entries(init.models ?? {}));
  const requests: RecordedRequest[] = [];
  const calls = new Map<string, number>();
  const state = { kind: init.kind ?? 'ollama', loading: false, redirectTo: undefined as string | undefined, replyFor: undefined as MockLocalServer['replyFor'] };
  const open = new Set<ServerResponse>();

  const json = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const read = (req: IncomingMessage): Promise<Record<string, unknown> | undefined> =>
    new Promise((resolve) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        try {
          resolve(chunks.length ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>) : undefined);
        } catch {
          resolve(undefined);
        }
      });
    });
  const nextReply = (name: string, m: MockModel): MockReply => {
    const n = calls.get(name) ?? 0;
    calls.set(name, n + 1);
    const list = m.replies ?? [{ text: `reply from ${name}` }];
    return list[Math.min(n, list.length - 1)]!;
  };
  /** A chat turns a cold model into a loaded one, as a real server does. */
  const loadFor = async (m: MockModel, numCtx?: number): Promise<void> => {
    if (m.loaded) return;
    if (m.loadMs) await sleep(m.loadMs);
    m.loaded = true;
    if (numCtx !== undefined) m.contextLength = Math.min(numCtx, m.maxContext ?? Infinity);
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? '/').split('?')[0]!;
      const method = req.method ?? 'GET';
      const body = method === 'POST' ? await read(req) : undefined;
      const model = typeof body?.model === 'string' ? body.model : undefined;
      requests.push({ method, path, body, ...(model ? { model } : {}) });
      open.add(res);
      res.on('close', () => open.delete(res));

      if (state.redirectTo) {
        res.writeHead(302, { location: state.redirectTo });
        res.end();
        return;
      }

      // --- probes -----------------------------------------------------------
      if (method === 'GET' && path === '/api/version') return state.kind === 'ollama' ? json(res, 200, { version: '0.34.4' }) : json(res, 404, { error: 'not found' });
      if (method === 'GET' && path === '/api/tags' && state.kind === 'ollama') {
        return json(res, 200, { models: [...models].filter(([, m]) => m.installed !== false).map(([name, m]) => ({ name, model: name, details: { family: 'test' }, ...(m.remoteHost ? { remote_host: m.remoteHost, remote_model: 'cloud-model:120b' } : {}) })) });
      }
      if (method === 'GET' && path === '/api/ps' && state.kind === 'ollama') {
        return json(res, 200, {
          models: [...models].filter(([, m]) => m.installed !== false && m.loaded).map(([name, m]) => ({ name, model: name, context_length: m.contextLength ?? 4096, expires_at: '2319-01-01T00:00:00Z' })),
        });
      }
      if (method === 'POST' && path === '/api/show' && state.kind === 'ollama') {
        const m = model ? models.get(model) : undefined;
        if (!m || m.installed === false) return json(res, 404, { error: `model '${model ?? ''}' not found` });
        return json(res, 200, { capabilities: m.capabilities ?? ['completion', 'tools'], model_info: { 'test.context_length': m.maxContext ?? 32768 }, details: { family: 'test' } });
      }
      if (method === 'GET' && path === '/health' && state.kind === 'llamacpp') {
        return state.loading ? json(res, 503, { error: { message: 'Loading model', type: 'unavailable_error', code: 503 } }) : json(res, 200, { status: 'ok' });
      }
      if (method === 'GET' && path === '/v1/models') {
        return json(res, 200, { object: 'list', data: [...models].filter(([, m]) => m.installed !== false).map(([id]) => ({ id, object: 'model', owned_by: 'library' })) });
      }

      // --- a load: /api/generate with no prompt ------------------------------
      if (method === 'POST' && path === '/api/generate' && state.kind === 'ollama') {
        const m = model ? models.get(model) : undefined;
        if (!m || m.installed === false) return json(res, 404, { error: `model '${model ?? ''}' not found` });
        if (body?.keep_alive === 0) {
          m.loaded = false;
          return json(res, 200, { model, response: '', done: true, done_reason: 'unload' });
        }
        const numCtx = (body?.options as { num_ctx?: number } | undefined)?.num_ctx;
        m.loaded = false; // asked with a context: it is (re)loaded at that one
        await loadFor(m, numCtx ?? m.contextLength ?? 4096);
        return json(res, 200, { model, response: '', done: true, done_reason: 'load' });
      }

      // --- chat ---------------------------------------------------------------
      const openAi = method === 'POST' && path === '/v1/chat/completions';
      const native = method === 'POST' && path === '/api/chat' && state.kind === 'ollama';
      if (openAi || native) {
        const m = model ? models.get(model) : undefined;
        if (!m || m.installed === false) {
          return openAi
            ? json(res, 404, { error: { message: `model '${model ?? ''}' not found`, type: 'not_found_error', param: null, code: null } })
            : json(res, 404, { error: `model '${model ?? ''}' not found` });
        }
        if (state.kind === 'llamacpp' && state.loading) return json(res, 503, { error: { message: 'Loading model', type: 'unavailable_error', code: 503 } });
        if (m.stall) return; // held open: only the client ends it
        await loadFor(m, native ? (body?.options as { num_ctx?: number } | undefined)?.num_ctx : undefined);
        if (m.firstTokenMs) await sleep(m.firstTokenMs);
        if (res.destroyed) return;
        const reply = state.replyFor?.({ method, path, body, model: model! }) ?? nextReply(model!, m);
        if ('status' in reply) return json(res, reply.status, openAi ? { error: { message: reply.message, type: 'server_error' } } : { error: reply.message });
        const stream = body?.stream === true;
        if (openAi) return answerOpenAi(res, model!, reply, stream);
        return answerNative(res, model!, reply, stream);
      }

      json(res, 404, { error: 'not found' });
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    baseURL: `${origin}/v1`,
    models,
    requests,
    chats: () => requests.filter((r) => r.path === '/v1/chat/completions' || r.path === '/api/chat'),
    warms: () => requests.filter((r) => r.path === '/api/generate' && r.body?.prompt === undefined && r.body?.keep_alive !== 0).map((r) => r.model ?? ''),
    get kind() {
      return state.kind;
    },
    set kind(k) {
      state.kind = k;
    },
    get loading() {
      return state.loading;
    },
    set loading(v) {
      state.loading = v;
    },
    get redirectTo() {
      return state.redirectTo;
    },
    set redirectTo(v) {
      state.redirectTo = v;
    },
    get replyFor() {
      return state.replyFor;
    },
    set replyFor(f) {
      state.replyFor = f;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const r of open) r.destroy();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function answerOpenAi(res: ServerResponse, model: string, reply: Exclude<MockReply, { status: number }>, stream: boolean): void {
  const base = { id: 'chatcmpl-1', created: 1791818566, model, system_fingerprint: 'fp_ollama' };
  const usage = { prompt_tokens: 35, prompt_tokens_details: { cached_tokens: 0 }, completion_tokens: 4, total_tokens: 39 };
  if (!stream) {
    const message = 'text' in reply
      ? { role: 'assistant', content: reply.text }
      : { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', index: 0, type: 'function', function: { name: reply.tool.name, arguments: JSON.stringify(reply.tool.args) } }] };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ...base, object: 'chat.completion', choices: [{ index: 0, message, finish_reason: 'text' in reply ? 'stop' : 'tool_calls' }], usage }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = (choices: unknown[], extra: Record<string, unknown> = {}): void => {
    res.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices, ...extra })}\n\n`);
  };
  if ('text' in reply) {
    const words = reply.text.split(/(?<= )/);
    words.forEach((w, i) => send([{ index: 0, delta: i === 0 ? { role: 'assistant', content: w } : { content: w }, finish_reason: null }]));
    send([{ index: 0, delta: {}, finish_reason: 'stop' }]);
  } else {
    send([
      {
        index: 0,
        delta: { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', index: 0, type: 'function', function: { name: reply.tool.name, arguments: JSON.stringify(reply.tool.args) } }] },
        finish_reason: null,
      },
    ]);
    send([{ index: 0, delta: {}, finish_reason: 'tool_calls' }]);
  }
  send([], { usage });
  res.end('data: [DONE]\n\n');
}

function answerNative(res: ServerResponse, model: string, reply: Exclude<MockReply, { status: number }>, stream: boolean): void {
  const message = 'text' in reply ? { role: 'assistant', content: reply.text } : { role: 'assistant', content: '', tool_calls: [{ function: { name: reply.tool.name, arguments: reply.tool.args } }] };
  const done = { model, done: true, done_reason: 'stop', prompt_eval_count: 35, eval_count: 4 };
  if (!stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ...done, message }));
    return;
  }
  res.writeHead(200, { 'content-type': 'application/x-ndjson' });
  if ('text' in reply) for (const w of reply.text.split(/(?<= )/)) res.write(`${JSON.stringify({ model, message: { role: 'assistant', content: w }, done: false })}\n`);
  else res.write(`${JSON.stringify({ model, message, done: false })}\n`);
  res.end(`${JSON.stringify({ ...done, message: { role: 'assistant', content: '' } })}\n`);
}
