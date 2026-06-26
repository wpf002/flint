import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import {
  Flint,
  AnthropicProvider,
  OllamaProvider,
  InMemoryStore,
  ActionLogObserver,
  type ProviderAdapter,
  type Tool,
} from '@flint/core';
import {
  Persona,
  InMemoryRetriever,
  InMemoryLessonStore,
  FLINT_STYLE_GUIDE,
  FLINT_VOICE_EXEMPLARS,
} from '@flint/persona';
import { McpRegistry, type McpServerSpec } from '@flint/mcp';

/**
 * Hosted Flint — the always-on shared service (Railway). Wraps the Flint client
 * behind an authenticated HTTP/SSE API so your apps and devices can talk to one
 * Flint. Provider, memory, and tools all come from env, so the SAME image runs
 * with Anthropic (cloud, always-on) or a remote Ollama (rented GPU) — the local
 * model never moves here (Railway has no GPU).
 *
 * Endpoints (all but /health require `Authorization: Bearer $FLINT_TOKEN`):
 *   GET  /health   → liveness + which provider/model/tools are active
 *   POST /generate → { prompt | messages, tools? } → { text, usage, reason }
 *   POST /chat     → { conversationId, message } → SSE stream of StreamEvents
 */

const TOKEN = process.env.FLINT_TOKEN?.trim();
if (!TOKEN) {
  // Fail closed: never expose Flint unauthenticated.
  console.error('FLINT_TOKEN is required (the bearer token clients must send). Refusing to start.');
  process.exit(1);
}

const PORT = Number(process.env.PORT ?? 8080);

function buildProvider(): { provider: ProviderAdapter; model: string } {
  const ollamaModel = process.env.OLLAMA_MODEL?.trim();
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (ollamaModel) {
    return {
      provider: new OllamaProvider({ baseURL: process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434' }),
      model: ollamaModel,
    };
  }
  if (key) {
    return { provider: new AnthropicProvider({ apiKey: key }), model: process.env.FLINT_MODEL ?? 'claude-sonnet-4-6' };
  }
  console.error('No provider configured. Set OLLAMA_MODEL (+ OLLAMA_HOST) or ANTHROPIC_API_KEY.');
  process.exit(1);
}

/** Optional MCP servers (your apps/integrations) from $MCP_CONFIG (a JSON file). */
function loadMcpSpecs(): McpServerSpec[] {
  const path = process.env.MCP_CONFIG?.trim();
  if (!path || !existsSync(path)) return [];
  try {
    const cfg = JSON.parse(readFileSync(path, 'utf8')) as {
      servers?: Array<{ name: string; command: string; args?: string[]; cwd?: string; env?: Record<string, string> }>;
    };
    return (cfg.servers ?? []).map((s) => ({
      name: s.name,
      transport: 'stdio' as const,
      command: s.command,
      ...(s.args ? { args: s.args } : {}),
      ...(s.cwd ? { cwd: s.cwd } : {}),
      ...(s.env ? { env: s.env } : {}),
    }));
  } catch (err) {
    console.error('[mcp] failed to read MCP_CONFIG:', err);
    return [];
  }
}

async function main(): Promise<void> {
  const { provider, model } = buildProvider();
  // Auditable action log (bounded ring buffer), exposed at GET /actions.
  const actionLog = new ActionLogObserver(undefined, 2000);
  const flint = new Flint({ provider, defaultModel: model, memory: new InMemoryStore(), observer: actionLog });
  const persona = new Persona(flint, {
    name: 'Flint',
    styleGuide: FLINT_STYLE_GUIDE,
    retriever: new InMemoryRetriever(FLINT_VOICE_EXEMPLARS),
    lessonStore: new InMemoryLessonStore(),
  });

  // Hosted Flint runs read-only (safe) tools freely; guarded (side-effecting)
  // tools are DENIED — there's no interactive approver in a server (a hosted
  // approval flow is a later step). Fail-safe by default.
  const specs = loadMcpSpecs();
  const registry = specs.length > 0 ? await McpRegistry.connect(specs) : undefined;
  const tools: Tool[] = registry?.tools() ?? [];
  if (registry) console.error(`[mcp] connected: ${registry.connectedServers().join(', ') || '(none)'}; ${tools.length} tool(s)`);

  const server = createServer((req, res) => void handle(req, res, { persona, provider, model, tools, actionLog }));
  server.listen(PORT, () => console.error(`Flint listening on :${PORT} (provider=${provider.name}, model=${model})`));
}

interface Ctx {
  persona: Persona;
  provider: ProviderAdapter;
  model: string;
  tools: Tool[];
  actionLog: ActionLogObserver;
}

async function handle(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<void> {
  const url = req.url ?? '/';

  if (req.method === 'GET' && url === '/health') {
    return json(res, 200, {
      ok: true,
      provider: ctx.provider.name,
      model: ctx.model,
      tools: ctx.tools.length,
    });
  }

  // Auth for everything else.
  if (req.headers.authorization !== `Bearer ${TOKEN}`) {
    return json(res, 401, { error: 'unauthorized' });
  }

  if (req.method === 'GET' && url.startsWith('/actions')) {
    return json(res, 200, { actions: ctx.actionLog.actions().slice(-200) });
  }

  if (req.method === 'POST' && url === '/generate') {
    const body = await readJson(req);
    const prompt = String(body.prompt ?? '');
    if (!prompt) return json(res, 400, { error: 'prompt required' });
    const out = await ctx.persona.generate({
      prompt,
      ...(ctx.tools.length ? { tools: ctx.tools } : {}),
    });
    return json(res, 200, { text: out.text, usage: out.usage, reason: out.reason });
  }

  if (req.method === 'POST' && url === '/chat') {
    const body = await readJson(req);
    const conversationId = String(body.conversationId ?? 'default');
    const message = String(body.message ?? '');
    if (!message) return json(res, 400, { error: 'message required' });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const ac = new AbortController();
    res.on('close', () => ac.abort());
    try {
      for await (const ev of ctx.persona.chat(
        { conversationId, message, ...(ctx.tools.length ? { tools: ctx.tools } : {}) },
        { signal: ac.signal },
      )) {
        res.write(`data: ${JSON.stringify(ev)}\n\n`);
      }
    } catch (err) {
      res.write(`data: ${JSON.stringify({ type: 'error', error: String(err) })}\n\n`);
    }
    res.end();
    return;
  }

  return json(res, 404, { error: 'not found' });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload);
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try {
        resolve(data ? (JSON.parse(data) as Record<string, unknown>) : {});
      } catch {
        resolve({});
      }
    });
  });
}

main().catch((err) => {
  console.error('Flint server failed to start:', err);
  process.exit(1);
});
