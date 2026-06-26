import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
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

  const servers = registry?.connectedServers() ?? [];
  const convos: Convo[] = [];
  const server = createServer((req, res) => void handle(req, res, { persona, provider, model, tools, actionLog, servers, convos }));
  server.listen(PORT, () => console.error(`Flint listening on :${PORT} (provider=${provider.name}, model=${model})`));
}

/** One completed exchange — what the Action Log shows, click-to-read the full text. */
interface Convo {
  id: number;
  ts: number;
  question: string;
  answer: string;
}

interface Ctx {
  persona: Persona;
  provider: ProviderAdapter;
  model: string;
  tools: Tool[];
  actionLog: ActionLogObserver;
  servers: string[];
  convos: Convo[];
}

/** Record a finished exchange (bounded ring buffer). */
function recordConvo(convos: Convo[], question: string, answer: string): void {
  convos.push({ id: convos.length + 1, ts: Date.now(), question, answer: answer.trim() });
  if (convos.length > 500) convos.splice(0, convos.length - 500);
}

/** Who/where/when context injected into every turn so Flint knows the user's
 *  location and the real current time (the model has neither on its own). */
const USER_LOCATION = process.env.FLINT_USER_LOCATION?.trim() || 'Dallas, Texas, USA';
const USER_TZ = process.env.FLINT_USER_TZ?.trim() || 'America/Chicago';
function userContext(): string {
  const now = new Date().toLocaleString('en-US', {
    timeZone: USER_TZ,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
  return `[Context — not a user message: Right now it is ${now}. Will is located in ${USER_LOCATION}. Use this for any question about the time, date, day, the user's location, or local weather. Never say you lack access to the current time or to the user's location — you have both here.]`;
}

/** The Flint console (the black-and-gold Jarvis UI). $CONSOLE_PATH overrides the
 *  repo-relative default so a bundled server (e.g. ~/.flint/server.mjs) can still
 *  find it. */
const CONSOLE_PATH =
  process.env.CONSOLE_PATH?.trim() ||
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'console', 'index.html');

/** App icons / manifest live here ($ASSETS_DIR for the bundled server). */
const ASSETS_DIR =
  process.env.ASSETS_DIR?.trim() ||
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'console', 'app-assets');

const PNG_ASSETS: Record<string, true> = {
  '/icon-192.png': true,
  '/icon-512.png': true,
  '/apple-touch-icon.png': true,
};

async function handle(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<void> {
  const url = req.url ?? '/';

  // CORS — let the console (any origin) call the API with the bearer token.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Serve the console UI. We inject the bearer token so the installed app (Mac
  // dock / iPhone home screen) opens already authenticated — no URL, no sign-in.
  // This is safe because Flint is only reachable over the private tailnet.
  if (req.method === 'GET' && (url === '/' || url.startsWith('/console'))) {
    if (!existsSync(CONSOLE_PATH)) return json(res, 404, { error: 'console not built' });
    const html = readFileSync(CONSOLE_PATH, 'utf8').replace(
      '</head>',
      `<script>window.__FLINT_TOKEN__=${JSON.stringify(TOKEN)}</script></head>`,
    );
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  // PWA manifest — makes the console installable as an app.
  if (req.method === 'GET' && url === '/manifest.webmanifest') {
    res.writeHead(200, { 'Content-Type': 'application/manifest+json' });
    res.end(
      JSON.stringify({
        name: 'Flint',
        short_name: 'Flint',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#050505',
        theme_color: '#050505',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      }),
    );
    return;
  }

  // App icons.
  if (req.method === 'GET' && PNG_ASSETS[url]) {
    const p = join(ASSETS_DIR, url);
    if (!existsSync(p)) return json(res, 404, { error: 'asset missing' });
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
    res.end(readFileSync(p));
    return;
  }

  if (req.method === 'GET' && url === '/health') {
    return json(res, 200, {
      ok: true,
      provider: ctx.provider.name,
      model: ctx.model,
      tools: ctx.tools.length,
      servers: ctx.servers,
    });
  }

  // Auth for everything else.
  if (req.headers.authorization !== `Bearer ${TOKEN}`) {
    return json(res, 401, { error: 'unauthorized' });
  }

  if (req.method === 'GET' && url.startsWith('/actions')) {
    return json(res, 200, { actions: ctx.actionLog.actions().slice(-200) });
  }

  // Conversation history — the Action Log reads this; each entry is a full
  // question/answer the user can click to re-read.
  if (req.method === 'GET' && url.startsWith('/conversations')) {
    return json(res, 200, { conversations: ctx.convos.slice(-100) });
  }

  if (req.method === 'POST' && url === '/generate') {
    const body = await readJson(req);
    const prompt = String(body.prompt ?? '');
    if (!prompt) return json(res, 400, { error: 'prompt required' });
    const out = await ctx.persona.generate({
      prompt: `${userContext()}\n\n${prompt}`,
      ...(ctx.tools.length ? { tools: ctx.tools } : {}),
    });
    recordConvo(ctx.convos, prompt, out.text);
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
    let answer = '';
    try {
      for await (const ev of ctx.persona.chat(
        { conversationId, message: `${userContext()}\n\n${message}`, ...(ctx.tools.length ? { tools: ctx.tools } : {}) },
        { signal: ac.signal },
      )) {
        if (ev.type === 'text') answer += ev.delta;
        res.write(`data: ${JSON.stringify(ev)}\n\n`);
      }
      if (answer.trim()) recordConvo(ctx.convos, message, answer);
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
