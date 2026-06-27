import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
/** Speech-to-text via whisper.cpp (the same pipeline the CLI voice mode uses). */
const WHISPER_BIN = process.env.WHISPER_BIN?.trim() || '/opt/homebrew/bin/whisper-cli';
const WHISPER_MODEL =
  process.env.WHISPER_MODEL?.trim() || join(homedir(), '.flint', 'models', 'ggml-base.en.bin');
async function transcribeAudio(buf: Buffer): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'flint-stt-'));
  try {
    const inFile = join(dir, 'in');
    const wav = join(dir, 'out.wav');
    writeFileSync(inFile, buf);
    // MediaRecorder gives mp4/m4a in WebKit; afconvert → 16 kHz mono WAV for whisper.
    await execFileP('/usr/bin/afconvert', [inFile, wav, '-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1']);
    const { stdout } = await execFileP(WHISPER_BIN, ['-m', WHISPER_MODEL, '-f', wav, '-nt', '-np'], {
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout.replace(/\s+/g, ' ').trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Neural text-to-speech for a human voice (OpenAI). Falls back to the browser's
 *  local voice client-side when no key is set. */
const TTS_MODEL = process.env.FLINT_TTS_MODEL?.trim() || 'tts-1';
const TTS_VOICE = process.env.FLINT_TTS_VOICE?.trim() || 'onyx';
async function synthesizeSpeech(text: string): Promise<Buffer | null> {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) return null;
  const r = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: TTS_MODEL, voice: TTS_VOICE, input: text.slice(0, 4000), response_format: 'mp3' }),
  });
  if (!r.ok) throw new Error(`tts HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}
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
      provider: new OllamaProvider({
        baseURL: process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434',
        // IMPORTANT: keep num_ctx at 4096. Above ~6k, qwen2.5:14b's native
        // tool-calling silently breaks — the model returns an EMPTY turn instead
        // of emitting tool_calls (verified by bisection). 4096 keeps tool-calling
        // reliable; the trade-off is a tighter window (curate the tool set so the
        // prompt + tool results fit).
        defaultOptions: { num_ctx: Number(process.env.OLLAMA_NUM_CTX ?? 4096) },
      }),
      model: ollamaModel,
    };
  }
  if (key) {
    return { provider: new AnthropicProvider({ apiKey: key }), model: process.env.FLINT_MODEL ?? 'claude-sonnet-4-6' };
  }
  console.error('No provider configured. Set OLLAMA_MODEL (+ OLLAMA_HOST) or ANTHROPIC_API_KEY.');
  process.exit(1);
}

/**
 * Always-on approval policy for GUARDED (non-read-only) tools — e.g. Trident's
 * calendar/email/drive. There's no human in the loop here, so we DEFAULT-DENY
 * and only auto-approve tools whose name reads as a query/lookup. Anything that
 * sends, creates, edits, deletes, moves money, or otherwise has consequences
 * stays denied until there's an interactive/whitelisted approval path. Read-only
 * connectors never reach this (they're classified safe and run freely).
 */
// Read verbs can appear anywhere in the name (e.g. gmail_search, gcal_upcoming).
const READ_TOOL = /(search|list|read|get|fetch|lookup|find|query|upcoming|forecast|model|recent|summary|view|status|count|coverage|bias|quote|position|market|account|order|worker|\bbot|industr|digest|signal|score|ticker|detail|snapshot|trade|job|rule|recommend|health|latest|\btop|best)/i;
// Anything that writes/sends/acts is denied (no human in the loop here).
const WRITE_TOOL = /(send|create|update|delete|remove|trash|cancel|reply|draft|compose|schedule|book|insert|\bpost\b|\bput\b|transfer|\bpay\b|buy|sell|place_order|enable|disable|start_|stop_|move_|write_|add_to|set_)/i;
async function readOnlyApprover(req: { server: string; tool: string }): Promise<boolean> {
  const t = req.tool || '';
  return READ_TOOL.test(t) && !WRITE_TOOL.test(t);
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
  // No voice-exemplar retriever here on purpose: with 42 tool schemas already in
  // the prompt, injecting 3 more writing samples bloats it enough that the local
  // model degrades to empty turns. The style guide alone carries the voice.
  const persona = new Persona(flint, {
    name: 'Flint',
    styleGuide: FLINT_STYLE_GUIDE,
    lessonStore: new InMemoryLessonStore(),
  });

  // Hosted Flint runs read-only (safe) tools freely; guarded (side-effecting)
  // tools are DENIED — there's no interactive approver in a server (a hosted
  // approval flow is a later step). Fail-safe by default.
  const specs = loadMcpSpecs();
  const registry = specs.length > 0 ? await McpRegistry.connect(specs, { approver: readOnlyApprover }) : undefined;
  const tools: Tool[] = registry?.tools() ?? [];
  if (registry) console.error(`[mcp] connected: ${registry.connectedServers().join(', ') || '(none)'}; ${tools.length} tool(s)`);

  const servers = registry?.connectedServers() ?? [];
  const convos: Convo[] = [];
  const server = createServer((req, res) => void handle(req, res, { persona, provider, model, tools, actionLog, servers, convos }));
  // Bind loopback only: the device app reaches it via localhost and remote
  // devices reach it through Tailscale (which proxies to localhost). Nothing on
  // the LAN can hit it directly — the only door in is the private tailnet.
  const HOST = process.env.BIND_HOST?.trim() || '127.0.0.1';
  server.listen(PORT, HOST, () => console.error(`Flint listening on ${HOST}:${PORT} (provider=${provider.name}, model=${model})`));
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
  return `[Context — not a user message: Right now it is ${now}. Will is located in ${USER_LOCATION}. Use this ONLY for the current time/date and the user's location. It does NOT contain weather, news, prices, or scores — for any of those, call web_search (e.g. "weather in ${USER_LOCATION} today"). Never say you lack the current time or the user's location — you have both here.]`;
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

  // Voice input: the app records mic audio and posts it here; we transcribe with
  // whisper.cpp and hand back the text (the client then sends it as a chat).
  if (req.method === 'POST' && url === '/transcribe') {
    const buf = await readRawBody(req);
    if (!buf.length) return json(res, 400, { error: 'no audio' });
    try {
      return json(res, 200, { text: await transcribeAudio(buf) });
    } catch (e) {
      return json(res, 500, { error: `transcription failed: ${String(e)}` });
    }
  }

  // Voice output: neural TTS → mp3. 503 (no key) tells the client to use its
  // local browser voice instead.
  if (req.method === 'POST' && url === '/speak') {
    const body = await readJson(req);
    const text = String(body.text ?? '').trim();
    if (!text) return json(res, 400, { error: 'text required' });
    try {
      const audio = await synthesizeSpeech(text);
      if (!audio) return json(res, 503, { error: 'no tts key' });
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': audio.length });
      res.end(audio);
    } catch (e) {
      return json(res, 502, { error: `tts failed: ${String(e)}` });
    }
    return;
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

function readRawBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
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
