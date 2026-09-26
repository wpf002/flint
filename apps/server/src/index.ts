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
const TTS_MAX_CHARS = 4000;
async function synthesizeSpeech(text: string): Promise<Buffer | null> {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) return null;
  const r = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: TTS_MODEL, voice: TTS_VOICE, input: text.slice(0, TTS_MAX_CHARS), response_format: 'mp3' }),
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
  FlintError,
  combineObservers,
  vendorOfProvider,
  type ProviderAdapter,
  type Tool,
} from '@flint/core';
import {
  Persona,
  InMemoryLessonStore,
  OllamaEmbedder,
} from '@flint/persona';
import { McpRegistry, type McpServerSpec } from '@flint/mcp';
import { parseMcpConfig } from './mcp-config';
import { PersistentStore } from './persistent-store';
import { describeHistoryWindow, readHistoryWindow } from './history-window';
import { KnowledgeStore, rememberTool } from './knowledge';
import { trainingStatusTool } from './training-status';
import { deepResearchTool } from './deep-research';
import { calculateTool } from './calculate';
import { answerWithFallback, guardAnswer, type Unanswered } from './unanswered';
import { ToolRouter } from './router';
import { safeHandler } from './safe-handler';
import { STYLE_VARIANTS, StyledPersonas, echoStyle, parseStyleVariantRequest, readStyleDefaults, styleGuideFor, turnPersonas, type StyleVariant } from './style-variant';
import { ActionQueue, type PendingAction } from './actions';
import { Notifications, Watcher, type Check } from './notifications';
import { TrainingLogger } from './training';
import { LocalPersonaCache, liveOllamaOptions, overridePersonaCache, parseLocalModelRequest, type OverridePersona } from './local-model';
import { MemoryExtractor } from './memory-extract';
import {
  SpendLedger,
  SpendGuard,
  NoteOnce,
  readCaps,
  describeCaps,
  spendObserver,
  spendContext,
  paidToolSpecs,
  meterPaidTools,
  budgetTurn,
  TurnSpend,
  describePlan,
  speakWithinBudget,
  spendStatusTool,
  pausable,
  type FrontierPlan,
} from './spend';
import { TurnLog, recallContext, recordTurnEntry } from './grounding';
import { GROUNDING_CHARS_MAX, parseGroundingCharsRequest, parseRecallRequest, runDiscoveryTool, wiredToolNames } from './eval-tools';
import {
  parseAttachments,
  readJsonLimited,
  mediaNeeds,
  summarizeAttachments,
  MAX_BODY_BYTES,
} from './attachments';

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

/**
 * Hosts this server will answer to. Blocks DNS rebinding — a page on evil.com
 * cannot point that name at 127.0.0.1 and become same-origin with Flint, because
 * `evil.com` is not in this set. Covers loopback, Tailscale MagicDNS short names
 * (`studio`) and *.ts.net, and tailnet 100.x addresses. Override with
 * FLINT_ALLOWED_HOSTS (a regex source) if you front Flint with another name.
 */
const ALLOWED_HOSTS = process.env.FLINT_ALLOWED_HOSTS?.trim()
  ? new RegExp(process.env.FLINT_ALLOWED_HOSTS.trim(), 'i')
  : /^(localhost|127\.0\.0\.1|\[?::1\]?|0\.0\.0\.0|[a-z0-9-]+|.*\.ts\.net|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+)$/i;

function buildProvider(): { provider: ProviderAdapter; model: string } {
  const ollamaModel = process.env.OLLAMA_MODEL?.trim();
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (ollamaModel) {
    return {
      // OLLAMA_HOST, OLLAMA_NUM_CTX (keep it at 4096, see liveOllamaOptions) and
      // OLLAMA_THINK=true|false (unset sends no `think`, as before).
      provider: new OllamaProvider(liveOllamaOptions(process.env)),
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
import { routeTurn, isSafeTool, type Brain, type MediaFlags } from './policy';
import { buildTiers, envProviderFactory, classifyMessage, runWithFallback, describeError, NoFallback, type BrainSet, mediaOf, canReadMedia } from './brains';

// SMART-FIRST routing. The local 7B is reliable on a narrow band — simple live
// lookups, the user's own systems, casual chat, memory recall — and fast there.
// Beyond that band it empties out or fabricates, so EVERYTHING ELSE goes to the
// frontier brain (smart AND fast). This keeps private/cheap stuff local while
// making Flint genuinely smart on any real question.

// Routing + auto-approval policy live in ./policy.ts so they can be unit-tested
// (this module calls main() at import time, so nothing here is importable).

/** Optional MCP servers (your apps/integrations) from $MCP_CONFIG (a JSON file), local or remote. */
function loadMcpSpecs(): McpServerSpec[] {
  const path = process.env.MCP_CONFIG?.trim();
  if (!path || !existsSync(path)) return [];
  try {
    const { specs, problems } = parseMcpConfig(readFileSync(path, 'utf8'));
    for (const problem of problems) console.error(`[mcp] ${problem}`);
    return specs;
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
  // Flint's own training run/evals. Core, not appended: a training run unloads
  // ollama, so the embedder the router appends by is down exactly when Will asks.
  'training_status',
  // Multi-query search + page reads + rerank → a numbered evidence pack. Core so
  // it's always reachable (the router's embedder is down during training), and
  // its description is one short line to respect the local 4096-token budget.
  'deep_research',
  'calculate', // arithmetic by a parser, not in the model's head (./calculate)
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

  // No Nexus checks. Will asked on 2026-09-16 for no Flint notifications about Nexus test
  // runs at all; the session running a test reports its result there.

  return checks;
}

/** Build the per-request context block, injecting any long-term memory that's
 *  relevant to this message so Flint "remembers" without bloating the prompt. */
async function contextFor(message: string, knowledge: KnowledgeStore): Promise<string> {
  return (await recallContext(userContext(), message, knowledge)).block;
}

async function main(): Promise<void> {
  loadSecrets(); // pull ANTHROPIC_API_KEY (and friends) from ~/.flint/secrets.env
  const { provider, model } = buildProvider();
  // Auditable action log (bounded ring buffer), exposed at GET /actions. Each entry is
  // also filed under the /generate turn that produced it (TurnLog), for eval grounding.
  const actionLog = new ActionLogObserver(recordTurnEntry, 2000);
  // Spend guard (./spend): every paid call lands in ~/.flint/spend/spend-YYYY-MM.jsonl,
  // and FLINT_BUDGET_* caps degrade Flint as they are approached (never before).
  // The notifications feed is built here so the guard can warn at 50/80/100%.
  const notes = new Notifications(join(homedir(), '.flint', 'notifications.json'));
  const ledger = new SpendLedger({ dir: join(homedir(), '.flint', 'spend'), timeZone: USER_TZ, log: (m) => console.error(m) });
  const caps = readCaps(process.env, (m) => console.error(`[spend] ${m}`));
  const spend = new SpendGuard(ledger, caps, notes);
  console.error(`[spend] caps: ${describeCaps(caps)}`);
  spend.checkAll();
  // Every Flint client shares this: the audit trail, plus one ledger row per paid provider pass.
  const observer = combineObservers(actionLog, spendObserver(ledger));
  // Durable conversation memory — survives restarts/reboots/crashes (was RAM
  // only). Shared across both brains so a conversation stays coherent no matter
  // which one answers a given turn. Each turn is sent only the recent part of its
  // conversation (FLINT_HISTORY_TURNS / FLINT_HISTORY_MAX_AGE_HOURS, ./history-window);
  // everything stays stored, and older context comes back through memory recall.
  const dataDir = join(homedir(), '.flint', 'memory');
  const history = readHistoryWindow(process.env, (m) => console.error(m));
  console.error(`[memory] chat history window: ${describeHistoryWindow(history)}`);
  const memory = new PersistentStore(join(dataDir, 'conversations.json'), { history });
  const flint = new Flint({ provider, defaultModel: model, memory, observer });
  // No voice-exemplar retriever here on purpose: with 42 tool schemas already in
  // the prompt, injecting 3 more writing samples bloats it enough that the local
  // model degrades to empty turns. The style guide alone carries the voice.
  const lessonStore = new InMemoryLessonStore();
  // Style guide per brain (./style-variant): FLINT_STYLE_VARIANT (frontier) and
  // FLINT_LOCAL_STYLE_VARIANT (local), both "v1" (FLINT_STYLE_GUIDE) when unset.
  const styles = readStyleDefaults(process.env, (m) => console.error(m));
  const localPersonaFor = (f: Flint, variant: StyleVariant) =>
    new Persona(f, {
      name: 'Flint',
      styleGuide: styleGuideFor(variant),
      lessonStore,
    });
  const persona = localPersonaFor(flint, styles.local);
  // Eval-only local-model override (apps/parity --local-model / --local-think, see
  // local-model.ts): the same local persona, memory and action log, with a different
  // default model. Built lazily per (model, think, style variant); never used by normal traffic.
  // Candidates get their own Ollama client with a 16K context (evalOllamaOptions)
  // carrying that request's `think` (overridePersonaCache).
  const localModels =
    provider.name === 'ollama'
      ? overridePersonaCache(process.env, (candidate, m, variant) =>
          localPersonaFor(new Flint({ provider: candidate, defaultModel: m, memory, observer }), variant ?? styles.local),
        )
      : undefined;

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
  // The seed of Flint's OWN brain: every interaction is captured as a training
  // example (frontier answers = the teacher to distill from). Independence is
  // built here, a little each day — see docs/INDEPENDENCE.md.
  const training = new TrainingLogger(join(homedir(), '.flint', 'training', 'corpus.jsonl'));

  // Set once the frontier is built below; training_status reads it at call time.
  let frontierModel: string | undefined;
  // deep_research plans its queries with the frontier brain when there is one
  // (bare generate — no persona/style guide, a few hundred tokens); heuristics otherwise.
  let frontierFlint: Flint | undefined;
  let plannerVendor: ReturnType<typeof vendorOfProvider>; // whose budget frontierFlint spends
  // Perplexity / Tavily searches run in the MCP processes: metered per successful
  // call here, and refused with a routable error once their vendor's cap is spent.
  // deep_research gets the same wrapped tools, so its searches count too.
  const mcpTools = meterPaidTools(registry?.tools() ?? [], { guard: spend, specs: paidToolSpecs(process.env) });
  const tools: Tool[] = [
    ...mcpTools,
    rememberTool(knowledge),
    trainingStatusTool({
      brainDir: join(homedir(), '.flint', 'brain'),
      corpus: () => training.stats(),
      serving: () => ({ local: `${provider.name}:${model}`, frontier: frontierModel }),
    }),
    deepResearchTool({
      tools: mcpTools,
      embedder,
      // Planning is optional (heuristic queries are the fallback): it waits at 80% of the cap.
      complete: pausable(
        async (prompt) => {
          if (!frontierFlint) throw new Error('no frontier brain');
          return (await frontierFlint.generate({ prompt }, { context: spendContext('plan') })).text;
        },
        () => (plannerVendor ? spend.backgroundBlocked(plannerVendor) : undefined),
      ),
    }),
    calculateTool(),
    spendStatusTool(spend),
  ];
  if (registry) console.error(`[mcp] connected: ${registry.connectedServers().join(', ') || '(none)'}; ${tools.length} tool(s)`);

  // Per-query tool selection — all tools stay wired; the model sees only the relevant few.
  const router = await ToolRouter.build(tools, embedder, CORE_TOOL_NAMES);

  // Frontier escalation — the bridge toward independence. Disabled cleanly if no
  // provider is configured (pure local). Shares memory + the router's tools with
  // the local brain, so escalated turns can still reach your systems and the web.
  // Tiers (./brains): judgeBrain still decides local-vs-frontier; the tier set
  // decides WHICH frontier. No FLINT_TIER_* → every tier is this legacy frontier.
  const frontierCfg = buildFrontierProvider();
  let frontier: { persona: Persona; model: string; media: MediaFlags } | undefined;
  let extractFlint: Flint | undefined; // bare frontier (no persona) for background jobs like memory extraction
  const flintOf = new Map<Persona, Flint>();
  const frontierPersonaFor = (fProvider: ProviderAdapter, fModel: string, variant: StyleVariant): Persona => {
    const fFlint = new Flint({ provider: fProvider, defaultModel: fModel, memory, observer });
    // Prompt caching, frontier ONLY (the local brain is free, and Ollama has its
    // own KV cache). Two breakpoints: one on the last CORE tool, one at the end
    // of the style guide. Everything before them is byte-identical on every
    // request, so inside the cache's 5-minute window — a tool loop, a multi-turn
    // chat, a bulk_seed burst — those thousands of input tokens are billed at the
    // cache-read rate instead of full price, over and over. The per-turn context
    // block (which carries the clock) stays outside the breakpoint, so nothing
    // the model reads changes.
    // Caching is Anthropic-only; every other adapter would ignore the hint anyway.
    const fPersona = new Persona(fFlint, {
      name: 'Flint',
      styleGuide: styleGuideFor(variant),
      lessonStore: new InMemoryLessonStore(),
      ...(fProvider.name === 'anthropic'
        ? { cache: { system: true, ...(router.coreLength > 0 ? { toolsThrough: router.coreLength - 1 } : {}) } }
        : {}),
    });
    flintOf.set(fPersona, fFlint);
    return fPersona;
  };
  const brains = buildTiers<Persona>({
    env: process.env,
    factory: envProviderFactory(process.env),
    legacy: frontierCfg,
    log: (m) => console.error(m),
    makePersona: (fProvider, fModel) => frontierPersonaFor(fProvider, fModel, styles.frontier),
  });
  // Eval requests may name another style variant; built per (brain, variant) on first use.
  const styled = new StyledPersonas<Persona>(styles, {
    local: persona,
    buildLocal: (v) => localPersonaFor(flint, v),
    buildFrontier: frontierPersonaFor,
  });
  if (brains) {
    frontier = { persona: brains.primary.persona, model: brains.primary.label, media: mediaOf(brains.primary) };
    frontierModel = brains.primary.label;
    // Query planning is light work: give deep_research the routine tier's client.
    // Memory extraction is judgment work: the primary tier, bare (no persona).
    extractFlint = flintOf.get(brains.primary.persona);
    const planner = brains.chain('routine')[0] ?? brains.primary;
    frontierFlint = flintOf.get(planner.persona);
    plannerVendor = vendorOfProvider(planner.provider.name);
    console.error(`[brain] frontier escalation ENABLED -> ${brains.primary.label} (tiers: ${brains.describe()})`);
  } else {
    console.error('[brain] frontier disabled (set ANTHROPIC_API_KEY, or FLINT_FRONTIER_* for a local big model) — running local-only');
  }

  // Proactivity — a notifications feed (built above) + a watcher that surfaces things unasked.
  new Watcher(notes, buildChecks(tools, knowledge)).start();

  // Long-term memory that actually grows. `remember` alone produced 9 facts in
  // 1,421 turns, because it only fires when the model elects to call it; this
  // reads the turns Flint has already had and extracts the durable ones. Uses
  // the bare frontier model with a curator prompt, not the persona (skips entirely
  // if none is configured), under a daily call cap, and writes through
  // KnowledgeStore, so dedupe, tombstones + the ephemeral filter still apply.
  // Background work: it pauses at 80% of its vendor's spend cap (./spend).
  const extractVendor = brains ? vendorOfProvider(brains.primary.provider.name) : undefined;
  new MemoryExtractor(
    memory,
    knowledge,
    () => {
      const f = extractFlint;
      return f && { generate: (input: { system: string; prompt: string }) => f.generate(input, { context: spendContext('extract') }) };
    },
    join(dataDir, 'extract-state.json'),
    { gate: () => (extractVendor ? spend.backgroundBlocked(extractVendor) : undefined) },
  ).start();

  const servers = registry?.connectedServers() ?? [];
  const convos: Convo[] = [];
  const budgetNotes = new NoteOnce(() => ledger.period().day);
  const server = createServer(safeHandler((req, res) => handle(req, res, { persona, localModels, styled, provider, model, tools, router, actionLog, servers, convos, frontier, brains, memory, knowledge, actions, notes, training, spend, budgetNotes })));
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
  /** Eval-only local-model override personas; undefined when the local brain isn't Ollama. */
  localModels: LocalPersonaCache<OverridePersona<Persona>> | undefined;
  /** Personas per style variant (eval `styleVariant`), and each brain's live default. */
  styled: StyledPersonas<Persona>;
  provider: ProviderAdapter;
  model: string;
  tools: Tool[];
  router: ToolRouter;
  actionLog: ActionLogObserver;
  servers: string[];
  convos: Convo[];
  frontier: { persona: Persona; model: string; media: MediaFlags } | undefined;
  brains: BrainSet<Persona> | undefined;
  memory: PersistentStore;
  knowledge: KnowledgeStore;
  actions: ActionQueue;
  notes: Notifications;
  training: TrainingLogger;
  /** Spend caps (./spend): /spend, /speak, and the frontier plan for each turn. */
  spend: SpendGuard;
  /** The honest "running on my local brain" line, once per conversation per day. */
  budgetNotes: NoteOnce;
}

/** Tool calls executed during a turn, pulled from the action log (for training capture). */
function toolsSince(ctx: Ctx, beforeLen: number): Array<{ tool: string; outcome?: string; ms?: number }> {
  const acts = ctx.actionLog.actions();
  return acts
    .slice(beforeLen)
    .filter((a): a is Extract<typeof a, { type: 'tool_result' }> => (a as { type?: string }).type === 'tool_result')
    .map((a) => ({ tool: a.tool, outcome: a.isError ? 'error' : 'ok', ms: a.durationMs }));
}

/** One line per tier fallback, with the AiError kind that caused it. */
function logFallback(from: { label: string }, to: { label: string }, err: unknown): void {
  console.error(`[brain] ${from.label} failed (${describeError(err)}) — falling back to ${to.label}`);
}

/** One log line when the spend guard changed a turn's route (./spend). */
function logPlan(plan: FrontierPlan<Persona>): void {
  const line = describePlan(plan);
  if (line) console.error(`[spend] ${line}`);
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

  // NO CORS headers, deliberately. The console is served by this same server, so
  // it is same-origin and needs none. A wildcard Access-Control-Allow-Origin used
  // to be set here, which let ANY page open in the browser read GET / — and that
  // response carries the injected bearer token, i.e. any website could scrape the
  // token and then drive the whole API from inside the loopback. Without CORS
  // headers a cross-origin fetch is still sent but its response is unreadable,
  // and the Authorization header can't be set cross-origin without a preflight.
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // DNS-rebinding guard: an attacker can point a hostname at 127.0.0.1 to make
  // their page same-origin with us. Only serve requests addressed to a host we
  // expect (loopback, or the tailnet name Flint is reached by).
  const host = (req.headers.host ?? '').split(':')[0]?.toLowerCase() ?? '';
  if (host && !ALLOWED_HOSTS.test(host)) {
    return json(res, 403, { error: 'bad host' });
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
      // Lets apps/eval check, BEFORE sending anything, that /generate honours
      // `eval: true` (an older server would log the replays as training data).
      evalMode: true,
      // Lets apps/parity --local-model check that /generate honours `localModel`.
      localModelOverride: !!ctx.localModels,
      // ...and `localThink` (apps/parity --local-think).
      localThinkOverride: !!ctx.localModels,
      // The `styleVariant`s /generate accepts (apps/parity --flint-variant).
      styleVariants: STYLE_VARIANTS,
      // The longest tool excerpt an eval /generate may ask for with `groundingChars`
      // (apps/parity tasks), and that GET /eval/tools + POST /eval/tool exist (./eval-tools).
      groundingCharsMax: GROUNDING_CHARS_MAX,
      evalDiscovery: true,
      // That an eval /generate honours `recall: false` (apps/parity tasks: answer on the
      // same data the frontier competitors get, which leaves long-term memory out).
      evalRecallOverride: true,
    });
  }

  // Auth for everything else.
  if (req.headers.authorization !== `Bearer ${TOKEN}`) {
    return json(res, 401, { error: 'unauthorized' });
  }

  // Paid API spend today / this month per vendor, against the FLINT_BUDGET_* caps (./spend).
  if (req.method === 'GET' && (url === '/spend' || url.startsWith('/spend?'))) {
    return json(res, 200, ctx.spend.snapshot());
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

  // Voice output: neural TTS → mp3. 503 (no key, or OpenAI's spend cap reached)
  // tells the client to use its local browser voice instead.
  if (req.method === 'POST' && url === '/speak') {
    const body = await readJson(req);
    const text = String(body.text ?? '').trim();
    if (!text) return json(res, 400, { error: 'text required' });
    try {
      const spoken = await speakWithinBudget(text, { guard: ctx.spend, model: TTS_MODEL, maxChars: TTS_MAX_CHARS, synth: synthesizeSpeech });
      if (spoken.status === 'no-key') return json(res, 503, { error: 'no tts key' });
      if (spoken.status === 'budget') return json(res, 503, { error: spoken.message, budget: true, fallback: 'browser' });
      const audio = spoken.audio;
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': audio.length });
      res.end(audio);
    } catch (e) {
      return json(res, 502, { error: `tts failed: ${String(e)}` });
    }
    return;
  }

  if (req.method === 'POST' && url === '/generate') {
    const read = await readJsonLimited(req, MAX_BODY_BYTES);
    if (read.tooLarge) return json(res, 413, { error: 'request too large' });
    const body = read.body;
    const prompt = String(body.prompt ?? '');
    const att = parseAttachments(body.attachments);
    if (!att.ok) return json(res, att.status, { error: att.error });
    const attachments = att.attachments;
    if (!prompt && attachments.length === 0) return json(res, 400, { error: 'prompt required' });
    const localOnly = body.localOnly === true;
    // Eval mode (apps/parity, the parity harness): replaying Will's past prompts
    // must not feed the answers back into the training corpus (the eval would
    // leak into what it measures), must not save facts to long-term memory, and
    // must not leave write proposals in the approval queue. The answer itself is
    // produced exactly as a normal turn would be.
    const evalMode = body.eval === true;
    // Eval-only: answer with a different Ollama model (bake-offs), optionally with
    // `think` set. 400 unless eval + localOnly (and localThink only with localModel).
    const lm = parseLocalModelRequest(body);
    if (!lm.ok) return json(res, lm.status, { error: lm.error });
    // Eval-only: answer with another style guide (apps/parity --flint-variant). 400
    // unless eval: true and a known variant; without it each brain uses its live one.
    const sv = parseStyleVariantRequest(body);
    if (!sv.ok) return json(res, sv.status, { error: sv.error });
    // Eval-only: longer tool excerpts in the response's `grounding` (apps/parity tasks,
    // which hands competitors the data Flint read). 400 unless eval: true and in range.
    const gc = parseGroundingCharsRequest(body);
    if (!gc.ok) return json(res, gc.status, { error: gc.error });
    // Eval-only: `recall: false` answers without long-term memory (apps/parity tasks,
    // whose competitors get exactly Flint's data). 400 unless eval: true and a boolean.
    const rc = parseRecallRequest(body);
    if (!rc.ok) return json(res, rc.status, { error: rc.error });
    const personas = turnPersonas({ styleVariant: sv.variant, localModel: lm.model, localThink: lm.think }, ctx);
    if (!personas.ok) return json(res, personas.status, { error: personas.error });
    const local = personas.local;
    const route = routeTurn({ message: prompt, hasFrontier: !!ctx.frontier, localOnly, needs: mediaNeeds(attachments), frontierCan: ctx.frontier?.media ?? {} });
    if ('error' in route) return json(res, 422, { error: route.error });
    const asText = [prompt, summarizeAttachments(attachments)].filter(Boolean).join(' ');
    const routed = await ctx.router.select(asText);
    const selected = evalMode ? routed.filter((t) => t.definition.name !== 'remember') : routed;
    // Same block contextFor builds; the facts are kept for the eval response's `grounding`.
    const recalled = await recallContext(userContext(), asText, ctx.knowledge, { skip: !rc.recall });
    const ctxBlock = recalled.block;
    const tier = classifyMessage(prompt, { toolsLikely: routed.length > ctx.router.coreLength });
    // Everything the spend caps decide about this turn, before any call (./spend budgetTurn).
    // Eval replays are exempt (the eval harness budgets them) and their calls are tagged `eval`.
    const budget = budgetTurn({
      brains: ctx.brains,
      tier,
      guard: ctx.spend,
      route,
      localProvider: ctx.provider.name,
      localModel: ctx.model,
      evalMode,
      canRead: canReadMedia(mediaNeeds(attachments)),
    });
    if (!budget.ok) return json(res, budget.status, { error: budget.error });
    const { plan, note } = budget; // /generate is one-shot: each answer carries the note
    if (plan) logPlan(plan);
    let brain = budget.brain;
    let answeredBy = local.model;
    const beforeActions = ctx.actions.snapshotIds();
    const beforeLog = ctx.actionLog.actions().length;
    // This turn's own action-log entries (not a concurrent /chat's), for the eval response's `grounding`.
    const turn = new TurnLog();
    // An eval replay's paid calls (models, tools, the research planner): tallied, so the
    // response says what the replay cost whether or not it answered (apps/parity charges it).
    const evalSpend = evalMode ? new TurnSpend('eval') : undefined;
    const evalFields = () => (evalSpend ? { eval: true, ...evalSpend.fields() } : {});
    // A client that hangs up (apps/parity's timeout, a stopped run) cancels the turn, as /chat does.
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    const callOpts = { ...budget.callOpts, signal: abort.signal };
    const ask = (p: Persona) =>
      turn.run(() => {
        const call = () => p.generate({ prompt, context: ctxBlock, ...(selected.length ? { tools: selected } : {}), ...(attachments.length ? { attachments } : {}) }, callOpts);
        return evalSpend ? evalSpend.run(call) : call();
      });
    // Every persona call goes through `answered`, so the eval echo names the style
    // guide of the persona whose answer this is (./style-variant echoStyle).
    const answered = echoStyle(ask);
    let out;
    let unanswered: Unanswered | undefined; // set when `out.text` is the honest message, not an answer
    try {
      if (brain === 'frontier' && plan) {
        try {
          // A refused / empty reply moves down the chain too; if the last one is, the honest message (./unanswered).
          const won = await answerWithFallback(plan.chain, (b) => answered.ask(personas.frontier(b)), { signal: abort.signal, onFallback: logFallback });
          out = won.result;
          unanswered = won.unanswered;
          answeredBy = won.brain.label;
        } catch (err) {
          if (abort.signal.aborted) return; // the client is gone: nothing to answer
          // An image/PDF turn has no honest fallback — the local brain can't see it.
          if (!route.localFallback) return json(res, 502, { error: `frontier failed: ${String(err)}`, ...evalFields() });
          // Nor does a turn whose local brain is a paid model with its budget spent.
          if (budget.localRefusal) return json(res, 503, { error: `frontier failed: ${String(err)}. ${budget.localRefusal}`, ...evalFields() });
          console.error('[brain] frontier failed, falling back to local:', err);
          brain = 'local';
          out = await answered.ask(local.persona);
        }
      } else {
        out = await answered.ask(local.persona);
      }
    } catch (err) {
      if (abort.signal.aborted) return;
      // An eval replay says what it cost even when it fails, so apps/parity can charge it.
      if (evalMode) return json(res, 500, { error: `flint failed: ${String(err)}`, ...evalFields() });
      throw err;
    }
    const toolsUsed = toolsSince(ctx, beforeLog);
    const proposed = ctx.actions.newSince(beforeActions);
    if (evalMode) {
      // Nothing an eval replay proposes should ever be approvable.
      for (const p of proposed) ctx.actions.reject(p.id);
      return json(res, 200, {
        text: out.text,
        usage: out.usage,
        reason: out.reason,
        // 'refusal' | 'empty' when `text` is the honest "no model answered" message, so apps/parity doesn't judge it.
        ...(unanswered ? { unanswered } : {}),
        brain,
        ...(brain === 'frontier' ? { tier: plan?.tier ?? tier } : {}),
        model: answeredBy,
        // The `think` the answering persona's Ollama client sends (not the request's
        // localThink), so apps/parity can tell the flag reached Ollama, as it does for `model`.
        ...(local.think !== undefined ? { localThink: local.think } : {}),
        // The style variant of the persona that answered, read from its guide, not the
        // request (apps/parity checks it against --flint-variant).
        styleVariant: answered.styleVariant(),
        tools: toolsUsed,
        // What the turn was grounded on (recalled memory, tool results), for apps/parity --judge-grounding.
        grounding: turn.grounding(recalled.facts, gc.chars),
        // The excerpt length used, echoed only when asked for (apps/parity checks it).
        ...(gc.chars !== undefined ? { groundingChars: gc.chars } : {}),
        // Echoed only when asked for (apps/parity checks that memory really was skipped).
        ...(rc.asked ? { recall: rc.recall } : {}),
        proposed: proposed.map((p) => p.fullName),
        // eval: true, plus what the replay cost (costUsd, costByVendor, paidCalls) and
        // budgetBlocked when a paid tool was refused for budget (./spend TurnSpend).
        ...evalFields(),
      });
    }
    recordConvo(ctx.convos, asText, out.text);
    ctx.training.log(
      { conversationId: 'generate', brain, model: answeredBy, input: asText, output: out.text, tools: toolsUsed, usage: out.usage },
      Date.now(),
    );
    return json(res, 200, {
      text: note ? `${out.text}\n\n${note}` : out.text,
      usage: out.usage,
      reason: out.reason,
      brain,
      ...(brain === 'frontier' ? { tier: plan?.tier ?? tier } : {}),
      ...budget.fields,
      model: answeredBy,
      pending: proposed,
    });
  }

  if (req.method === 'POST' && url === '/chat') {
    const read = await readJsonLimited(req, MAX_BODY_BYTES);
    if (read.tooLarge) return json(res, 413, { error: 'request too large' });
    const body = read.body;
    const conversationId = String(body.conversationId ?? 'default');
    const message = String(body.message ?? '');
    const att = parseAttachments(body.attachments);
    if (!att.ok) return json(res, att.status, { error: att.error });
    const attachments = att.attachments;
    if (!message && attachments.length === 0) return json(res, 400, { error: 'message required' });
    const localOnly = body.localOnly === true;
    // Image/PDF turns must reach a frontier that can see them — or be refused, never answered blind.
    const route = routeTurn({ message, hasFrontier: !!ctx.frontier, localOnly, needs: mediaNeeds(attachments), frontierCan: ctx.frontier?.media ?? {} });
    if ('error' in route) return json(res, 422, { error: route.error });
    // Router, recall, the Action Log and the training corpus see names, never file bodies.
    const asText = [message, summarizeAttachments(attachments)].filter(Boolean).join(' ');
    const selected = await ctx.router.select(asText);
    // The history this turn will actually carry (windowed), not the whole stored thread.
    const turns = route.brain === 'frontier' && ctx.brains?.tiered ? (await ctx.memory.getMessages(conversationId).catch(() => [])).length : 0;
    const tier = classifyMessage(message, { turns, toolsLikely: selected.length > ctx.router.coreLength });
    // Everything the spend caps decide about this turn, before anything streams (./spend budgetTurn);
    // the honest note once per conversation per day.
    const budget = budgetTurn({
      brains: ctx.brains,
      tier,
      guard: ctx.spend,
      route,
      localProvider: ctx.provider.name,
      localModel: ctx.model,
      canRead: canReadMedia(mediaNeeds(attachments)),
      once: { notes: ctx.budgetNotes, conversationId },
    });
    if (!budget.ok) return json(res, budget.status, { error: budget.error });
    const { plan, note } = budget;
    if (plan) logPlan(plan);
    let brain = budget.brain;
    let answeredBy = ctx.model;
    const ctxBlock = await contextFor(asText, ctx.knowledge);
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
    const noAnswers: Unanswered[] = []; // the tiers that refused / came back empty, for the honest message's wording
    // `tried` (frontier tiers only): a refused / empty reply falls back or gets the honest message (./unanswered).
    const pump = async (persona: Persona, recoverable = false, tried?: number) => {
      const events = persona.chat(
        { conversationId, message, context: ctxBlock, ...(selected.length ? { tools: selected } : {}), ...(attachments.length ? { attachments } : {}) },
        { signal: ac.signal },
      );
      for await (const ev of tried === undefined ? events : guardAnswer(events, { recoverable, tried, noAnswers })) {
        // The budget note rides just ahead of `done`: shown, but never stored as the answer.
        if (note && ev.type === 'done') res.write(`data: ${JSON.stringify({ type: 'text', delta: `\n\n${note}` })}\n\n`);
        if (ev.type === 'text') answer += ev.delta;
        // A provider error arrives as an event, not a throw. When another tier is
        // left to try and no text has gone out, throw it to the tier fallback.
        if (recoverable && ev.type === 'error' && answer.length === 0 && !ac.signal.aborted) throw new FlintError(ev.error);
        res.write(`data: ${JSON.stringify(ev)}\n\n`);
      }
    };
    try {
      if (brain === 'frontier' && plan) {
        try {
          const chain = plan.chain;
          const won = await runWithFallback(
            chain,
            async (b) => {
              res.write(`data: ${JSON.stringify({ type: 'meta', brain, tier: plan.tier, model: b.label, ...budget.fields })}\n\n`);
              try {
                await pump(b.persona, b !== chain[chain.length - 1], chain.indexOf(b) + 1); // last tier: errors as before, no answer → honest message
              } catch (err) {
                if (answer.length > 0) throw new NoFallback(err); // text already streamed
                throw err;
              }
            },
            { signal: ac.signal, onFallback: logFallback },
          );
          answeredBy = won.brain.label;
        } catch (err) {
          // Only safe to fall back if nothing was streamed yet, and (a paid local brain) its budget isn't spent.
          if (answer.length === 0 && route.localFallback && !ac.signal.aborted && !budget.localRefusal) {
            console.error('[brain] frontier failed pre-output, falling back to local:', err);
            brain = 'local';
            res.write(`data: ${JSON.stringify({ type: 'meta', brain })}\n\n`);
            await pump(ctx.persona);
          } else if (answer.length === 0 && route.localFallback && !ac.signal.aborted && budget.localRefusal) {
            throw new Error(`frontier failed: ${String(err)}. ${budget.localRefusal}`);
          } else {
            throw err;
          }
        }
      } else {
        res.write(`data: ${JSON.stringify({ type: 'meta', brain, ...budget.fields })}\n\n`);
        await pump(ctx.persona);
      }
      if (answer.trim()) {
        recordConvo(ctx.convos, asText, answer);
        ctx.training.log(
          { conversationId, brain, model: answeredBy, input: asText, output: answer, tools: toolsSince(ctx, beforeLog) },
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

  // Eval-only discovery for apps/parity tasks (./eval-tools): the wired tool names, and
  // one call to a fixed read-only allowlist. Audited in the action log like any tool call.
  if (req.method === 'GET' && url === '/eval/tools') {
    return json(res, 200, { tools: wiredToolNames(ctx.tools) });
  }
  if (req.method === 'POST' && url === '/eval/tool') {
    const read = await readJsonLimited(req, MAX_BODY_BYTES);
    if (read.tooLarge) return json(res, 413, { error: 'request too large' });
    const out = await runDiscoveryTool({
      tools: ctx.tools,
      body: read.body,
      audit: (e) => {
        const requestId = `eval-discovery-${Date.now()}`;
        const base = { requestId, provider: 'eval-discovery', model: '-', timestamp: Date.now() };
        ctx.actionLog.onToolCall({ ...base, call: { id: requestId, toolName: e.name, args: e.args }, idempotent: true });
        ctx.actionLog.onToolResult({ ...base, toolCallId: requestId, toolName: e.name, result: e.result, isError: e.isError, durationMs: e.durationMs });
      },
    });
    return json(res, out.status, out.body);
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
