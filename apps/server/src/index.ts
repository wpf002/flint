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
  InMemoryLessonStore,
  FLINT_STYLE_GUIDE,
  OllamaEmbedder,
  cosineSimilarity,
} from '@flint/persona';
import { McpRegistry, type McpServerSpec } from '@flint/mcp';
import { PersistentStore } from './persistent-store';
import { KnowledgeStore, rememberTool } from './knowledge';
import { ActionQueue, type PendingAction } from './actions';
import { Notifications, Watcher, type Check } from './notifications';
import { TrainingLogger } from './training';

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
 * The escalation-brain provider — the swappable bridge toward independence.
 * Today it's Claude (ANTHROPIC_API_KEY). The day a bigger LOCAL model is good
 * enough, set FLINT_FRONTIER_PROVIDER=ollama + FLINT_FRONTIER_BASE_URL (e.g. a
 * 70B on a home box) + FLINT_FRONTIER_MODEL and escalation points there instead
 * — no other code changes, and Flint is fully independent. undefined → frontier
 * off (pure local).
 */
function buildFrontierProvider(): { provider: ProviderAdapter; model: string } | undefined {
  const kind = process.env.FLINT_FRONTIER_PROVIDER?.trim().toLowerCase();
  const baseURL = process.env.FLINT_FRONTIER_BASE_URL?.trim();
  if (kind === 'ollama' || (!kind && baseURL && !process.env.ANTHROPIC_API_KEY)) {
    const model = process.env.FLINT_FRONTIER_MODEL?.trim();
    if (!model) return undefined;
    return {
      provider: new OllamaProvider({
        baseURL: baseURL ?? 'http://127.0.0.1:11434',
        defaultOptions: { num_ctx: Number(process.env.FLINT_FRONTIER_NUM_CTX ?? 8192) },
      }),
      model,
    };
  }
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (key) {
    return {
      provider: new AnthropicProvider({ apiKey: key }),
      model: process.env.FLINT_FRONTIER_MODEL?.trim() || 'claude-sonnet-4-6',
    };
  }
  return undefined;
}

/**
 * Load extra secrets from ~/.flint/secrets.env (KEY=value per line, # comments)
 * into process.env without overriding anything already set. This is where the
 * ANTHROPIC_API_KEY for frontier escalation lives — kept OUT of the launchd
 * plist (world-readable) and out of git (the file is under ~/.flint, not the
 * repo). chmod 600 it.
 */
function loadSecrets(): void {
  const path = join(homedir(), '.flint', 'secrets.env');
  if (!existsSync(path)) return;
  try {
    for (const raw of readFileSync(path, 'utf8').split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const k = line.slice(0, eq).trim();
      let v = line.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (k && process.env[k] === undefined) process.env[k] = v;
    }
  } catch (err) {
    console.error('[secrets] failed to read ~/.flint/secrets.env:', err);
  }
}

/**
 * The two brains Flint can answer with. `local` is the private, instant,
 * always-available model on this machine — the default, and the independence
 * goal. `frontier` is a BRIDGE: a hosted model (Claude) we escalate the
 * genuinely-hard reasoning/coding asks to, until the local brain is good enough
 * to retire it. Everything routes through one seam (judgeBrain) so flipping the
 * bridge off later — or repointing it at a self-hosted model — is a one-liner.
 */
type Brain = 'local' | 'frontier';

// SMART-FIRST routing. The local 7B is reliable on a narrow band — simple live
// lookups, the user's own systems, casual chat, memory recall — and fast there.
// Beyond that band it empties out or fabricates, so EVERYTHING ELSE goes to the
// frontier brain (smart AND fast). This keeps private/cheap stuff local while
// making Flint genuinely smart on any real question.

// Keep a query on the LOCAL brain only when the user explicitly asks to — the
// Local-only toggle, or phrasing like "stay local" / "keep this private". This
// is the privacy switch + offline fallback; otherwise Flint runs on Claude.
const FORCE_LOCAL_RE = /\b(stay local|keep it local|keep this local|local only|on[- ]?device|on[- ]?machine|don'?t use claude|privately|keep this private|keep it private)\b/i;

/**
 * Which brain answers. Flint IS Claude by default — equal-to-Claude capability
 * on every query. The local model is the fallback, used only when no frontier is
 * configured, the user flipped Local-only (localOnly), or the message asks to
 * stay on-device. Everything else → frontier (Claude) + Flint's personal layer
 * (memory, systems, voice, tools) on top.
 */
function judgeBrain(message: string, hasFrontier: boolean, localOnly: boolean): Brain {
  if (!hasFrontier) return 'local'; // no Claude configured → local fallback
  if (localOnly) return 'local'; // user forced everything on-device
  if (FORCE_LOCAL_RE.test(message)) return 'local'; // "stay local" / "keep this private"
  return 'frontier'; // default: Flint runs on Claude
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
/** A tool that may run without human approval: read-only, or Flint's own memory
 *  (`remember`, which only writes to local memory — never the outside world). */
function isSafeTool(tool: string): boolean {
  if (tool === 'remember') return true;
  return READ_TOOL.test(tool) && !WRITE_TOOL.test(tool);
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

/**
 * The daily-driver tools, sent on EVERY request in a stable order. Keeping this
 * core fixed means Ollama can reuse the KV cache (system + core prompt) across
 * requests → fast. Anything not here is appended only when a query clearly needs
 * it (see ToolRouter). Names are namespaced `server.tool` (matching the registry)
 * because some bare names collide — e.g. both `web` and `trident` expose
 * `web_search`. Names not currently wired are simply skipped. ~12 tools keeps the
 * prompt comfortably under the 4096-token budget the local model needs to keep
 * tool-calling reliable.
 */
const CORE_TOOL_NAMES = [
  'remember', // save a durable fact to long-term memory — always available
  'web.web_search', // current events, weather, news, scores, facts — the primary lookup
  'web.fetch_url', // read a specific URL
  'trident.perplexity_search', // deeper web research
  'trident.gcal_upcoming', // calendar
  'trident.gmail_search', // email
  'trident.gdrive_search', // drive
  'vantage.get_score', // company scores
  'vantage.top_scores', // rankings
  'vantage.list_watchlists', // watchlists
  'bellwether.recent_signals', // market signals
  'bellwether.latest_digest', // daily digest
  'meridian.get_signals', // trading signals by ticker
];

/**
 * Tool router that keeps the common case fast AND reaches everything:
 *  - a STABLE CORE (the daily tools) goes on every request → the prompt prefix is
 *    cacheable, so most queries are quick;
 *  - extra tools are APPENDED only when the query embeds close enough to them
 *    (above a relevance floor), up to a small cap — so specialized asks
 *    (forecasting, security rules, the bot fleet) still reach their tools.
 * General/conversational queries get just the core; nothing irrelevant clutters
 * the prompt to confuse the small model.
 */
class ToolRouter {
  private constructor(
    private readonly core: Tool[],
    private readonly rest: Tool[],
    private readonly restVectors: number[][],
    private readonly embedder: OllamaEmbedder,
    private readonly maxAppend: number,
    private readonly floor: number,
  ) {}

  static async build(tools: Tool[], embedder: OllamaEmbedder): Promise<ToolRouter> {
    const maxAppend = Math.max(0, Number(process.env.FLINT_TOOL_APPEND ?? 4));
    const floor = Number(process.env.FLINT_TOOL_FLOOR ?? 0.55);
    const byName = new Map(tools.map((t) => [t.definition.name, t] as const));
    const core: Tool[] = [];
    for (const n of CORE_TOOL_NAMES) {
      const t = byName.get(n);
      if (t) core.push(t);
    }
    const coreNames = new Set(core.map((t) => t.definition.name));
    const rest = tools.filter((t) => !coreNames.has(t.definition.name));
    let restVectors: number[][] = [];
    if (rest.length > 0) {
      try {
        restVectors = await embedder.embed(
          rest.map((t) => `${t.definition.name}: ${t.definition.description}`),
        );
      } catch (err) {
        console.error('[router] rest embedding failed — appends disabled:', err);
      }
    }
    // If the core didn't match anything wired, fall back to "everything is core".
    const finalCore = core.length > 0 ? core : tools;
    const finalRest = core.length > 0 ? rest : [];
    console.error(
      `[router] core=${finalCore.length} (cached) + up to ${maxAppend} of ${finalRest.length} by relevance (floor ${floor})`,
    );
    return new ToolRouter(finalCore, finalRest, restVectors, embedder, maxAppend, floor);
  }

  /** The stable core, plus any rest-tools the message clearly needs. */
  async select(message: string): Promise<Tool[]> {
    if (this.maxAppend === 0 || this.rest.length === 0 || this.restVectors.length !== this.rest.length) {
      return this.core;
    }
    let qv: number[];
    try {
      qv = (await this.embedder.embed([message.slice(0, 2000)]))[0] ?? [];
    } catch {
      return this.core;
    }
    if (qv.length === 0) return this.core;
    const appends = this.rest
      .map((t, i) => ({ t, score: cosineSimilarity(qv, this.restVectors[i] ?? []) }))
      .filter((x) => x.score >= this.floor)
      .sort((a, b) => b.score - a.score)
      .slice(0, this.maxAppend)
      .map((x) => x.t);
    return appends.length > 0 ? [...this.core, ...appends] : this.core;
  }
}

/** Pull readable text out of an MCP tool result ({content:[{text}]} or a string). */
function toolText(result: unknown): string {
  const r = result as { content?: Array<{ text?: string }> } | null;
  if (r && Array.isArray(r.content)) return r.content.map((c) => c?.text ?? '').join('\n').trim();
  return typeof result === 'string' ? result : JSON.stringify(result ?? '');
}
function hashish(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return String(h);
}
/** Human-readable event time in the user's timezone (e.g. "Sat, Jun 28, 2:00 PM").
 *  All-day events (date only, no "T") omit the clock time. */
function fmtWhen(iso: string): string {
  try {
    const timed = iso.includes('T');
    return new Date(iso).toLocaleString('en-US', {
      timeZone: USER_TZ,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      ...(timed ? { hour: 'numeric', minute: '2-digit' } : {}),
    });
  } catch {
    return iso;
  }
}

/**
 * The proactive checks the watcher runs. Cheap (direct tool calls, no LLM),
 * resilient (a failing integration just yields nothing). Each only fires for a
 * given item once (dedupe key). Tune cadence with FLINT_WATCH_MS.
 */
function buildChecks(tools: Tool[], _knowledge: KnowledgeStore): Check[] {
  const byName = new Map(tools.map((t) => [t.definition.name, t] as const));
  const call = async (name: string, args: unknown): Promise<string> => {
    const t = byName.get(name);
    if (!t) return '';
    try {
      const res = await t.handler({ id: `watch_${name}`, toolName: name, args });
      if (res && typeof res === 'object' && (res as { isError?: boolean }).isError) return '';
      const text = toolText(res);
      // Stay silent on error-ish payloads (auth failures, validation errors).
      if (/invalid_grant|"error"|isError|-32602|validation error/i.test(text)) return '';
      return text;
    } catch {
      return '';
    }
  };
  const checks: Check[] = [];

  // Calendar: remind about events starting within the next ~26h (once each),
  // formatted human-readably. Nothing when the calendar is clear.
  if (byName.has('trident.gcal_upcoming')) {
    checks.push(async () => {
      const text = await call('trident.gcal_upcoming', { days: 2 });
      if (!text) return [];
      let data: { events?: Array<{ id?: string; summary?: string; start?: string | null; location?: string | null }> };
      try {
        data = JSON.parse(text);
      } catch {
        return [];
      }
      const soon = Date.now() + 26 * 60 * 60 * 1000;
      return (data.events ?? [])
        .filter((e) => e.start && new Date(e.start).getTime() <= soon)
        .slice(0, 3)
        .map((e) => ({
          title: 'Upcoming',
          body: `${e.summary || 'Untitled event'} — ${fmtWhen(e.start as string)}${e.location ? ` · ${e.location}` : ''}`,
          kind: 'calendar',
          dedupe: `cal:${e.id || e.summary}:${e.start}`,
        }));
    });
  }

  // Market signals: ping on new market-intelligence signals (newest few, once
  // each). recent_signals works with no args; latest_digest would require an
  // industry id, so this is the better proactive source.
  if (byName.has('bellwether.recent_signals')) {
    checks.push(async () => {
      const text = await call('bellwether.recent_signals', { limit: 5 });
      if (!text) return [];
      let rows: Array<{ headline?: string }> = [];
      try {
        rows = JSON.parse(text);
      } catch {
        return [];
      }
      if (!Array.isArray(rows)) return [];
      return rows
        .filter((r) => r && r.headline)
        .slice(0, 3)
        .map((r) => ({ title: 'Market signal', body: String(r.headline).slice(0, 200), kind: 'signal', dedupe: `sig:${r.headline}` }));
    });
  }

  return checks;
}

/** Build the per-request context block, injecting any long-term memory that's
 *  relevant to this message so Flint "remembers" without bloating the prompt. */
async function contextFor(message: string, knowledge: KnowledgeStore): Promise<string> {
  const base = userContext();
  let facts: string[] = [];
  try {
    facts = await knowledge.recall(message);
  } catch {
    /* memory recall is best-effort */
  }
  if (facts.length === 0) return base;
  const block = facts.map((f) => `- ${f}`).join('\n');
  return `${base}\n[Long-term memory — things you already know about Will; use if relevant, don't recite back:\n${block}\n]`;
}

async function main(): Promise<void> {
  loadSecrets(); // pull ANTHROPIC_API_KEY (and friends) from ~/.flint/secrets.env
  const { provider, model } = buildProvider();
  // Auditable action log (bounded ring buffer), exposed at GET /actions.
  const actionLog = new ActionLogObserver(undefined, 2000);
  // Durable conversation memory — survives restarts/reboots/crashes (was RAM
  // only). Shared across both brains so a conversation stays coherent no matter
  // which one answers a given turn.
  const dataDir = join(homedir(), '.flint', 'memory');
  const memory = new PersistentStore(join(dataDir, 'conversations.json'));
  const flint = new Flint({ provider, defaultModel: model, memory, observer: actionLog });
  // No voice-exemplar retriever here on purpose: with 42 tool schemas already in
  // the prompt, injecting 3 more writing samples bloats it enough that the local
  // model degrades to empty turns. The style guide alone carries the voice.
  const persona = new Persona(flint, {
    name: 'Flint',
    styleGuide: FLINT_STYLE_GUIDE,
    lessonStore: new InMemoryLessonStore(),
  });

  const embedder = new OllamaEmbedder({
    model: process.env.FLINT_EMBED_MODEL?.trim() || 'nomic-embed-text',
    baseURL: process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434',
  });

  // Long-term compounding memory: durable facts Flint learns about Will, pulled
  // into context by relevance. The `remember` tool lets Flint save them mid-chat.
  const knowledge = new KnowledgeStore(join(dataDir, 'knowledge.json'), embedder);

  // Action approval — read-only tools run freely; any write the model attempts is
  // captured as a proposal for one-tap approval (see ActionQueue). This is what
  // turns Flint from an oracle into an assistant, without losing the safety rail.
  const actions = new ActionQueue(isSafeTool);
  const specs = loadMcpSpecs();
  const registry = specs.length > 0 ? await McpRegistry.connect(specs, { approver: actions.approver }) : undefined;
  const tools: Tool[] = [...(registry?.tools() ?? []), rememberTool(knowledge)];
  if (registry) console.error(`[mcp] connected: ${registry.connectedServers().join(', ') || '(none)'}; ${tools.length} tool(s)`);

  // Per-query tool selection — all tools stay wired; the model sees only the relevant few.
  const router = await ToolRouter.build(tools, embedder);

  // Frontier escalation — the bridge toward independence. Disabled cleanly if no
  // provider is configured (pure local). Shares memory + the router's tools with
  // the local brain, so escalated turns can still reach your systems and the web.
  const frontierCfg = buildFrontierProvider();
  let frontier: { persona: Persona; model: string } | undefined;
  if (frontierCfg) {
    const fFlint = new Flint({ provider: frontierCfg.provider, defaultModel: frontierCfg.model, memory, observer: actionLog });
    const fPersona = new Persona(fFlint, { name: 'Flint', styleGuide: FLINT_STYLE_GUIDE, lessonStore: new InMemoryLessonStore() });
    frontier = { persona: fPersona, model: frontierCfg.model };
    console.error(`[brain] frontier escalation ENABLED -> ${frontierCfg.provider.name}:${frontierCfg.model}`);
  } else {
    console.error('[brain] frontier disabled (set ANTHROPIC_API_KEY, or FLINT_FRONTIER_* for a local big model) — running local-only');
  }

  // Proactivity — a notifications feed + a watcher that surfaces things unasked.
  const notes = new Notifications(join(homedir(), '.flint', 'notifications.json'));
  new Watcher(notes, buildChecks(tools, knowledge)).start();

  // The seed of Flint's OWN brain: every interaction is captured as a training
  // example (frontier answers = the teacher to distill from). Independence is
  // built here, a little each day — see docs/INDEPENDENCE.md.
  const training = new TrainingLogger(join(homedir(), '.flint', 'training', 'corpus.jsonl'));

  const servers = registry?.connectedServers() ?? [];
  const convos: Convo[] = [];
  const server = createServer((req, res) => void handle(req, res, { persona, provider, model, tools, router, actionLog, servers, convos, frontier, knowledge, actions, notes, training }));
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
  router: ToolRouter;
  actionLog: ActionLogObserver;
  servers: string[];
  convos: Convo[];
  frontier: { persona: Persona; model: string } | undefined;
  knowledge: KnowledgeStore;
  actions: ActionQueue;
  notes: Notifications;
  training: TrainingLogger;
}

/** Tool calls executed during a turn, pulled from the action log (for training capture). */
function toolsSince(ctx: Ctx, beforeLen: number): Array<{ tool: string; outcome?: string; ms?: number }> {
  const acts = ctx.actionLog.actions();
  return acts
    .slice(beforeLen)
    .filter((a): a is Extract<typeof a, { type: 'tool_result' }> => (a as { type?: string }).type === 'tool_result')
    .map((a) => ({ tool: a.tool, outcome: a.isError ? 'error' : 'ok', ms: a.durationMs }));
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
    const localOnly = body.localOnly === true;
    const selected = await ctx.router.select(prompt);
    let brain = judgeBrain(prompt, !!ctx.frontier, localOnly);
    const ctxBlock = await contextFor(prompt, ctx.knowledge);
    const beforeActions = ctx.actions.snapshotIds();
    const beforeLog = ctx.actionLog.actions().length;
    const ask = (p: Persona) =>
      p.generate({ prompt: `${ctxBlock}\n\n${prompt}`, ...(selected.length ? { tools: selected } : {}) });
    let out;
    if (brain === 'frontier' && ctx.frontier) {
      try {
        out = await ask(ctx.frontier.persona);
      } catch (err) {
        console.error('[brain] frontier failed, falling back to local:', err);
        brain = 'local';
        out = await ask(ctx.persona);
      }
    } else {
      out = await ask(ctx.persona);
    }
    recordConvo(ctx.convos, prompt, out.text);
    ctx.training.log(
      { conversationId: 'generate', brain, model: brain === 'frontier' && ctx.frontier ? ctx.frontier.model : ctx.model, input: prompt, output: out.text, tools: toolsSince(ctx, beforeLog), usage: out.usage },
      Date.now(),
    );
    const proposed = ctx.actions.newSince(beforeActions);
    return json(res, 200, { text: out.text, usage: out.usage, reason: out.reason, brain, pending: proposed });
  }

  if (req.method === 'POST' && url === '/chat') {
    const body = await readJson(req);
    const conversationId = String(body.conversationId ?? 'default');
    const message = String(body.message ?? '');
    if (!message) return json(res, 400, { error: 'message required' });
    const localOnly = body.localOnly === true;
    const selected = await ctx.router.select(message);
    let brain = judgeBrain(message, !!ctx.frontier, localOnly);
    const ctxBlock = await contextFor(message, ctx.knowledge);
    const beforeActions = ctx.actions.snapshotIds();
    const beforeLog = ctx.actionLog.actions().length;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const ac = new AbortController();
    res.on('close', () => ac.abort());
    let answer = '';
    const pump = async (persona: Persona) => {
      for await (const ev of persona.chat(
        { conversationId, message: `${ctxBlock}\n\n${message}`, ...(selected.length ? { tools: selected } : {}) },
        { signal: ac.signal },
      )) {
        if (ev.type === 'text') answer += ev.delta;
        res.write(`data: ${JSON.stringify(ev)}\n\n`);
      }
    };
    try {
      if (brain === 'frontier' && ctx.frontier) {
        try {
          res.write(`data: ${JSON.stringify({ type: 'meta', brain })}\n\n`);
          await pump(ctx.frontier.persona);
        } catch (err) {
          // Only safe to fall back if nothing was streamed yet.
          if (answer.length === 0) {
            console.error('[brain] frontier failed pre-output, falling back to local:', err);
            brain = 'local';
            res.write(`data: ${JSON.stringify({ type: 'meta', brain })}\n\n`);
            await pump(ctx.persona);
          } else {
            throw err;
          }
        }
      } else {
        res.write(`data: ${JSON.stringify({ type: 'meta', brain })}\n\n`);
        await pump(ctx.persona);
      }
      if (answer.trim()) {
        recordConvo(ctx.convos, message, answer);
        ctx.training.log(
          { conversationId, brain, model: brain === 'frontier' && ctx.frontier ? ctx.frontier.model : ctx.model, input: message, output: answer, tools: toolsSince(ctx, beforeLog) },
          Date.now(),
        );
      }
      const proposed = ctx.actions.newSince(beforeActions);
      if (proposed.length > 0) res.write(`data: ${JSON.stringify({ type: 'pending', actions: proposed })}\n\n`);
    } catch (err) {
      res.write(`data: ${JSON.stringify({ type: 'error', error: String(err) })}\n\n`);
    }
    res.end();
    return;
  }

  // Proposed actions awaiting one-tap approval (writes Flint wanted to make).
  if (req.method === 'GET' && url.startsWith('/proposals')) {
    return json(res, 200, { proposals: ctx.actions.list() });
  }
  if (req.method === 'POST' && url === '/proposals/approve') {
    const body = await readJson(req);
    const id = String(body.id ?? '');
    const result = await ctx.actions.approve(id, ctx.tools);
    if (!result) return json(res, 404, { error: 'no such proposal' });
    if (result.status === 'done') ctx.notes.push('Action done', `${result.fullName} ✓`, 'action', `act:${result.id}`);
    return json(res, 200, { action: result });
  }
  if (req.method === 'POST' && url === '/proposals/reject') {
    const body = await readJson(req);
    return json(res, 200, { ok: ctx.actions.reject(String(body.id ?? '')) });
  }

  // Training corpus stats — the growing seed of Flint's own brain.
  if (req.method === 'GET' && url.startsWith('/training')) {
    return json(res, 200, ctx.training.stats());
  }

  // Proactive notifications feed.
  if (req.method === 'GET' && url.startsWith('/notifications')) {
    return json(res, 200, { items: ctx.notes.list(), unread: ctx.notes.unreadCount() });
  }
  if (req.method === 'POST' && url === '/notifications/read') {
    const body = await readJson(req);
    const id = body.id ? String(body.id) : '';
    if (id) ctx.notes.markRead(id);
    else ctx.notes.markAllRead();
    return json(res, 200, { ok: true, unread: ctx.notes.unreadCount() });
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
