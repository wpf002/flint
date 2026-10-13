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
import { AuditSink, runtimeFromDisk, type Runtime } from './audit-sink';
import { gateBuiltins, tierGate, type TierEvent, type TierOutcome } from './tier-gate';
import { RuntimePolicies, capClaimer } from './runtime-link';
import { asLocalTurn, currentTurn, historyOrigin, markEval, taintFromHistory, taintSources, turnProposals, turnTainted, turnTools, withTurnTaint } from './turn-taint';
import { ConversationTaint } from './conversation-taint';
import { Approvals, rpFromDisk } from './approvals';
import { approvalRoutes } from './approval-routes';
import { pgApproverStore } from './approver-store';
import { startInternal } from './internal';
import { RuntimeProposals } from './runtime-proposals';
import { RuntimeEvents, chatTurnEvent, routeOf, thresholdEventId } from './runtime-events';
import { WorldNow, estimateTokens } from './world-now';
import { GoalsChat, SPEECH_STAYS_HERE, embedderHere, recallForAnyBrain, toolsKeptHere } from './goals-chat';
import { readContextBlocks } from './context-blocks';
import { brainOf } from './policy';
import { inboxRoutes } from './inbox-routes';
import { goalsRoutes } from './goals-routes';
import { ChatLoad } from './chat-load';
import { CompleteGate, localBackgroundBrain, localBackgroundModel, readKindCallCaps } from './background-complete';
import { HOLD_CHECK_EVERY_MS, holdNoteDue } from './deploy-hold';
import { FrontierBreaker, FrontierPaused, breakerNote, gateChain, gateTurn, pausedCode } from './frontier-breaker';
import { errorSummary, logError } from './error-log';
import { createHash } from 'node:crypto';
import { parseMcpConfig } from './mcp-config';
import { openConversationStore, type PersistentStore } from './persistent-store';
import { listThreads, readThread } from './threads';
import { withHistoryNote } from './history-window';
import { KnowledgeStore, rememberTool } from './knowledge';
import { trainingStatusTool } from './training-status';
import { deepResearchTool } from './deep-research';
import { calculateTool } from './calculate';
import { answerWithFallback, guardAnswer, type Unanswered } from './unanswered';
import { ToolRouter } from './router';
import { attribution, chatOutcome, movedBy, routeLine, type Outcome } from './route-log';
import { ensureScopedTokens } from './scoped-tokens';
import { allowedTailnetUser, bearerScope, bindHost, scopeAllows, type Scope, bearerMatches, consoleGetsToken, hostName, tailnetAllowed } from './access';
import { safeHandler } from './safe-handler';
import { STYLE_VARIANTS, StyledPersonas, echoStyle, engineLineFor, parseStyleVariantRequest, promptRevision, readStyleDefaults, styleGuideFor, turnPersonas, type StyleVariant } from './style-variant';
import { ActionQueue } from './actions';
import { Notifications, Watcher, signalNote, upcomingNote, watcherEnabled, type Check } from './notifications';
import { stampUiVersion, uiVersionOf } from './ui-version';
import { TrainingLogger } from './training';
import { LocalPersonaCache, chooseLocalBrain, keepPickingLocal, localDefaultNote, overridePersonaCache, parseLocalModelRequest, type LocalBrain, type OverridePersona } from './local-model';
import { MemoryExtractor } from './memory-extract';
import { GoalCandidates, candidateOptions } from './goal-candidates';
import { chooseMemoryBrain, frontierExtractBrain, liveChat, memoryBrainSetting } from './memory-brain';
import {
  SpendLedger,
  SpendGuard,
  NoteOnce,
  readCaps,
  describeCaps,
  readKindCaps,
  describeKindCaps,
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
 * Hosted Flint — the always-on shared service. Wraps the Flint client behind an
 * authenticated HTTP/SSE API so your apps and devices can talk to one Flint.
 * Provider, memory, and tools all come from env. The local brain is always an
 * Ollama model (this Mac's, or a remote Ollama at OLLAMA_HOST); an outside model
 * answers only as a frontier tier Will configured, never as a default.
 *
 * Endpoints (all but /health require `Authorization: Bearer $FLINT_TOKEN`):
 *   GET  /health   → liveness + which provider/model/tools are active
 *   POST /generate → { prompt | messages, tools? } → { text, usage, reason }
 *   POST /chat     → { conversationId, message } → SSE stream of StreamEvents
 */

/** FLINT_TOKEN, read in main() after ~/.flint/secrets.env loads, so it may live there. */
let TOKEN = '';
/** The scoped clients' tokens (./access, ./scoped-tokens), made in main(). */
let SCOPED: ReadonlyArray<{ name: string; token: string; scope: Exclude<Scope, 'full'> }> = [];

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

/**
 * The Tailscale login whose devices may use Flint over the tailnet and get the
 * console's token injected (./access). Unset: tailnet requests still work with
 * the token, but the console page no longer carries it (paste it in Settings).
 */
let TAILNET_USER: string | undefined; // read in main(), after ~/.flint/secrets.env is loaded

/** Small JSON bodies (approvals, speech text); attachments go through MAX_BODY_BYTES. */
const SMALL_JSON_BYTES = 64 * 1024;
/** Recorded voice notes for /transcribe. */
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

/**
 * Log an error with a short reference, and return the reference for the client.
 * What is logged is the error's class, never a provider's words (./error-log);
 * FLINT_DEBUG_ERRORS=1 logs the whole error.
 */
function errorRef(tag: string, err: unknown): string {
  const ref = Math.random().toString(36).slice(2, 8);
  logError(`[${tag}] ref=${ref}`, err);
  return ref;
}

/**
 * The local brain: an Ollama model, always (./local-model chooseLocalBrain).
 * OLLAMA_MODEL names it; unset, Ollama is asked which chat model it has. It is
 * never Anthropic, whatever keys are present.
 */
async function buildProvider(): Promise<{ provider: ProviderAdapter; model: string; local: LocalBrain }> {
  // OLLAMA_HOST, OLLAMA_NUM_CTX (keep it at 4096, see liveOllamaOptions) and
  // OLLAMA_THINK=true|false (unset sends no `think`, as before).
  const local = await chooseLocalBrain(process.env, { log: (m) => console.error(m) });
  return { provider: new OllamaProvider(local.options), model: local.model, local };
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
    // Its class only: this is the secrets file.
    console.error(`[secrets] failed to read ~/.flint/secrets.env (${errorSummary(err)})`);
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
import { buildTiers, buildFrontierProvider, envProviderFactory, classifyMessage, runWithFallback, mayAskAnother, providerFailure, NoFallback, type BrainSet, mediaOf, canReadMedia } from './brains';

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
    // Its class only: a JSON parse error quotes the file, and an MCP config can hold tokens.
    console.error(`[mcp] failed to read MCP_CONFIG (${errorSummary(err)})`);
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
/**
 * When an event starts, in the user's timezone, as two parts for a sentence: the
 * day ("Sat, Jun 28") and the clock time ("2:00 PM"). An all-day event (a date,
 * no "T") has no time, and its date is that date wherever the user is.
 */
function fmtWhen(iso: string): { day: string; time?: string } {
  try {
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return { day: iso };
    const timed = iso.includes('T');
    const day = d.toLocaleDateString('en-US', { timeZone: timed ? USER_TZ : 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
    return timed ? { day, time: d.toLocaleTimeString('en-US', { timeZone: USER_TZ, hour: 'numeric', minute: '2-digit' }) } : { day };
  } catch {
    return { day: iso };
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
        .map((e) => {
          // "Dentist is on Tue, Oct 6 at 3:00 PM, at 123 Main St."
          return { ...upcomingNote(e, fmtWhen(e.start as string)), kind: 'calendar', dedupe: `cal:${e.id || e.summary}:${e.start}` };
        });
    });
  }

  // Market signals: ping on new market-intelligence signals (newest few, once
  // each). recent_signals works with no args; latest_digest would require an
  // industry id, so this is the better proactive source.
  // Opt-in (FLINT_WATCH_SIGNALS=1): Bellwether's database is not on this Mac, so the
  // check failed silently every 30 minutes (2026-09-30 audit).
  if (process.env.FLINT_WATCH_SIGNALS === '1' && byName.has('bellwether.recent_signals')) {
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
        .map((r) => ({ ...signalNote(String(r.headline)), kind: 'signal', dedupe: `sig:${r.headline}` }));
    });
  }

  // No Nexus checks. Will asked on 2026-09-16 for no Flint notifications about Nexus test
  // runs at all; the session running a test reports its result there.

  return checks;
}

/** Build the per-request context block, injecting any long-term memory that's
 *  relevant to this message so Flint "remembers" without bloating the prompt. */
async function contextFor(message: string, knowledge: KnowledgeStore): Promise<{ block: string; mode: string; outside: string }> {
  const r = await recallContext(userContext(), message, knowledge);
  // `outside`: the same block without the facts that stay on this Mac (./knowledge fromGoals).
  return { block: r.block, mode: r.mode, outside: r.outside.block };
}

async function main(): Promise<void> {
  loadSecrets(); // pull ANTHROPIC_API_KEY (and friends) from ~/.flint/secrets.env
  TOKEN = process.env.FLINT_TOKEN?.trim() ?? '';
  if (!TOKEN) {
    // Fail closed: never expose Flint unauthenticated.
    console.error('FLINT_TOKEN is required (the plist or ~/.flint/secrets.env). Refusing to start.');
    process.exit(1);
  }
  SCOPED = ensureScopedTokens(join(homedir(), '.flint', 'tokens'));
  console.error(`[access] scoped tokens: ${SCOPED.map((t) => `${t.name}=${t.scope}`).join(', ')} (~/.flint/tokens)`);
  TAILNET_USER = allowedTailnetUser(process.env);
  console.error(
    TAILNET_USER
      ? '[access] tailnet: only FLINT_TAILNET_USER may use Flint, and gets the console token'
      : '[access] FLINT_TAILNET_USER unset: the console carries its token only for this Mac; tailnet devices paste it in Settings',
  );
  // The local brain, as the NEXT turn uses it. These four change once at most: when Ollama did not
  // answer at boot, the server starts on a stand-in default (it never waits for Ollama before it
  // listens), and adoptLocal below swaps in Ollama's own answer when it comes.
  let { provider, model, local: localBrain } = await buildProvider();
  // The local model as it was settled (OLLAMA_MODEL, or what Ollama had, at the window it is loaded
  // with): what memory extraction and background calls read, so all three ask the same model alike.
  let localEnv: Record<string, string | undefined> = { ...process.env, ...localBrain.env };
  // Auditable action log (bounded ring buffer), exposed at GET /actions. Each entry is
  // also filed under the /generate turn that produced it (TurnLog), for eval grounding.
  const actionLog = new ActionLogObserver(recordTurnEntry, 2000);
  // Spend guard (./spend): every paid call lands in ~/.flint/spend/spend-YYYY-MM.jsonl,
  // and FLINT_BUDGET_* caps degrade Flint as they are approached (never before).
  // The notifications feed is built here so the guard can warn at 50/80/100%.
  const notes = new Notifications(join(homedir(), '.flint', 'notifications.json'));
  // Nothing was set and Ollama had no model to offer: the local brain is a guess until the next
  // restart, and Will is told once a day, in the console only. (Not when Ollama simply has not
  // answered yet: that is a stand-in for some seconds, and the log says so.)
  const noteLocalDefault = (b: LocalBrain): void => {
    if (b.from !== 'default' || !b.settled) return;
    const note = localDefaultNote();
    notes.push(note.title, note.body, 'brain', `local-default:${new Date().toISOString().slice(0, 10)}`, { channels: ['inapp'] });
  };
  noteLocalDefault(localBrain);
  // Updates paused for a day (./deploy-hold): said once per pause, in the console, with the phone's
  // content-free ping. No banner: the pause was made at this Mac, so its screen has nothing new to say.
  const noteDeployHold = (): void => {
    const note = holdNoteDue(homedir(), Date.now());
    if (note) notes.push(note.title, note.body, 'system', note.dedupe, { channels: ['inapp', 'push'] });
  };
  noteDeployHold();
  setInterval(noteDeployHold, HOLD_CHECK_EVERY_MS).unref();
  // The runtime: FLINT_RUNTIME_URL where it is moved, else its loopback default. Set
  // (and not blank) it also turns on runtime mode below. One link for everything
  // that talks to the runtime (audit, policies, events, World now, the lanes).
  const runtimeUrl = process.env.FLINT_RUNTIME_URL?.trim() || undefined;
  const runtimeLink = runtimeFromDisk(homedir(), runtimeUrl);
  // What the server tells the runtime's triage (./runtime-events): ids, enums and numbers, never text.
  const events = new RuntimeEvents({ runtime: runtimeLink, spoolDir: join(homedir(), '.flint', 'spool'), log: (m) => console.error(m) });
  events.start();
  const ledger = new SpendLedger({ dir: join(homedir(), '.flint', 'spend'), timeZone: USER_TZ, log: (m) => console.error(m) });
  const caps = readCaps(process.env, (m) => console.error(`[spend] ${m}`));
  // A threshold notice newly raised (never the boot re-check of one already raised) is also an event.
  const spend = new SpendGuard(ledger, caps, notes, {
    onThreshold: (t) => void events.push({ type: 'spend.threshold', id: thresholdEventId(t.key), vendor: t.vendor, level: t.level, period: t.period }),
  });
  console.error(`[spend] caps: ${describeCaps(caps)}`);
  // The background kinds the runtime may spend through /internal/complete: $0 until raised.
  const kindCaps = readKindCaps(process.env, (m) => console.error(`[spend] ${m}`));
  console.error(`[spend] background kinds: ${describeKindCaps(kindCaps)}`);
  spend.checkAll();
  // The frontier breaker (./frontier-breaker): an outside AI that keeps failing (no credit, a
  // rejected key, an outage) is left alone for a cool-down and the local model answers at once.
  // Its one-token check needs the tier set, which is built further down.
  let checkFrontier: (provider: string, signal: AbortSignal, model?: string) => Promise<void> = async () => {
    throw new Error('no frontier brain');
  };
  const breaker = new FrontierBreaker({
    probe: (p, signal, m) => checkFrontier(p, signal, m),
    log: (m) => console.error(m),
    // Out of credit, or a rejected key: only Will can fix it, so the console says so once a day (no banner, no ping).
    onOpen: (e) => {
      const note = breakerNote(e);
      if (note) notes.push(note.title, note.body, 'brain', `breaker:${e.provider}:${e.model ?? ''}:${e.reason}:${ledger.period().day}`, { channels: ['inapp'] });
    },
  });
  // Every Flint client shares this: the audit trail, one ledger row per paid provider pass,
  // and each provider request's outcome for the breaker.
  const observer = combineObservers(actionLog, spendObserver(ledger), breaker.observer());
  // Durable conversation memory — survives restarts/reboots/crashes (was RAM
  // only). Shared across both brains so a conversation stays coherent no matter
  // which one answers a given turn. Each turn is sent only the recent part of its
  // conversation (FLINT_HISTORY_TURNS / FLINT_HISTORY_MAX_AGE_HOURS, ./history-window);
  // everything stays stored, and a turn whose conversation has older turns is told so.
  const dataDir = join(homedir(), '.flint', 'memory');
  const memory = openConversationStore(join(dataDir, 'conversations.json'), process.env, (m) => console.error(m));
  // Which stored turns carry untrusted text, so a later turn handed them starts tainted (./conversation-taint):
  // checked when the history is read, so a turn that committed meanwhile is not missed.
  const convTaint = new ConversationTaint(join(dataDir, 'taint.json'), (m) => console.error(m));
  memory.onHistory = (cid, ids) => {
    const origin = convTaint.origin(cid, ids, Date.now(), memory.historyStats(cid).window?.maxAgeMs ?? Infinity);
    if (origin !== undefined) taintFromHistory(origin);
  };
  // The context blocks (./context-blocks): each is off until Will turns it on, and
  // FLINT_CONTEXT_BLOCKS=off turns them all off. Read here, before any brain is built: what a
  // brain may read of the conversation depends on them.
  const blocks = readContextBlocks(process.env, (m) => console.error(m));
  // What stays on this Mac in chat (./goals-chat, P3): Will's goals in chat context (FLINT_GOALS_NOW=1), the
  // turns answered with them, and the facts Flint learned from those turns. Every decision about them is a call
  // into it: a brain is given any of it per ask, only on this Mac (unless Will set FLINT_GOALS_TO_FRONTIER=on).
  // Built whether or not the block is on: the turns and the facts are held to the same rules after it is off.
  const goalsChat = new GoalsChat<Persona>({ memory, blocks, runtime: runtimeLink, log: (m) => console.error(m) });
  // The conversation as each brain may read it: all of it for a brain on this Mac; for any other, without
  // the turns that stay here.
  const historyOf = (p: ProviderAdapter, m: string) => goalsChat.history(p, m);
  let flint = new Flint({ provider, defaultModel: model, memory: historyOf(provider, model), observer });
  // No voice-exemplar retriever here on purpose: with 42 tool schemas already in
  // the prompt, injecting 3 more writing samples bloats it enough that the local
  // model degrades to empty turns. The style guide alone carries the voice.
  const lessonStore = new InMemoryLessonStore();
  // Style guide per brain (./style-variant): FLINT_STYLE_VARIANT (frontier) and
  // FLINT_LOCAL_STYLE_VARIANT (local), both "v1" (FLINT_STYLE_GUIDE) when unset.
  const styles = readStyleDefaults(process.env, (m) => console.error(m));
  // Each persona also says which model is answering (engineLineFor): the guides name Claude as
  // the engine "for most questions", and a local model must not take that for its own name.
  const localPersonaFor = (f: Flint, variant: StyleVariant, m: string) =>
    new Persona(f, {
      name: 'Flint',
      styleGuide: styleGuideFor(variant),
      engine: engineLineFor(provider, m),
      lessonStore,
    });
  let persona = localPersonaFor(flint, styles.local, model);
  // Eval-only local-model override (apps/parity --local-model / --local-think, see
  // local-model.ts): the same local persona, memory and action log, with a different
  // default model. Built lazily per (model, think, style variant); never used by normal traffic.
  // Candidates get their own Ollama client with a 16K context (evalOllamaOptions)
  // carrying that request's `think` (overridePersonaCache).
  const localModels =
    provider.name === 'ollama'
      ? overridePersonaCache(process.env, (candidate, m, variant) =>
          localPersonaFor(new Flint({ provider: candidate, defaultModel: m, memory: historyOf(candidate, m), observer }), variant ?? styles.local, m),
        )
      : undefined;

  const embedHost = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434';
  const embedder = new OllamaEmbedder({
    model: process.env.FLINT_EMBED_MODEL?.trim() || 'nomic-embed-text',
    baseURL: embedHost,
  });

  // Long-term compounding memory: durable facts Flint learns about Will, pulled
  // into context by relevance. The `remember` tool lets Flint save them mid-chat.
  // A fact that stays on this Mac is embedded only when the embedder is here too (./goals-chat embedderHere).
  const knowledge = new KnowledgeStore(join(dataDir, 'knowledge.json'), embedder, undefined, undefined, { embedderHere: () => embedderHere(embedHost) });

  // Action approval — read-only tools run freely; any write the model attempts is
  // captured as a proposal for one-tap approval (see ActionQueue). This is what
  // turns Flint from an oracle into an assistant, without losing the safety rail.
  const actions = new ActionQueue(isSafeTool);
  // The audit trail's server end (./audit-sink): spooled locally, shipped to the
  // runtime once it is installed. Every tier decision lands here (Machine plan 3.0.7).
  const audit = new AuditSink({
    spoolDir: join(homedir(), '.flint', 'spool'),
    runtime: runtimeLink,
    secrets: () => [TOKEN, ...SCOPED.map((t) => t.token)],
    // Will's day, as the runtime counts it (FLINT_TZ, else the server's FLINT_USER_TZ).
    tz: process.env.FLINT_TZ?.trim() || process.env.FLINT_USER_TZ?.trim() || 'America/Chicago',
    log: (m) => console.error(m),
  });
  audit.start();
  // launchd stops the server with SIGTERM: the counts are saved on the way out.
  process.on('exit', () => audit.saveRollups());
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.once(sig, () => process.exit(0));
  // Every tool call goes through the tier engine (./tier-gate). What it decided
  // goes to the audit trail: refusals, calls queued for Will, ALONE writes (as
  // pending, then their real outcome); reads are counted.
  const onDecision = (e: TierEvent) => {
    const { decision: d } = e;
    if (e.status === 'read') {
      audit.count(d.key, 'chat');
      return;
    }
    // A write about to run is its intent: on disk first, or it does not run (the throw refuses the call).
    audit.record({
      actor: 'flint',
      context: 'chat',
      kind: 'decision',
      action: d.key,
      tier: d.tier,
      inputs: { rule: d.rule, tainted: e.tainted, taintedBy: e.taintedBy.join(',').slice(0, 200) || null },
      reasoning: d.reason,
      decision: e.status === 'denied' ? 'deny' : e.status === 'queued' ? 'queue' : 'act',
      outcome: e.status === 'denied' ? 'denied' : 'pending',
      tainted: e.tainted,
      ...(e.correlationId ? { correlationId: e.correlationId } : {}),
    }, e.status === 'acting');
  };
  const onOutcome = (o: TierOutcome) => {
    audit.record({
      actor: 'flint', context: 'chat', kind: 'action', action: o.key, decision: 'act', outcome: o.ok ? 'ok' : 'failed',
      inputs: {}, ...(o.error ? { reasoning: o.error } : {}), correlationId: o.correlationId,
    });
  };
  // The ActionPolicy rows Will signed, and cap claims, from the runtime (./runtime-link).
  const policyRows = new RuntimePolicies({ runtime: runtimeLink, file: join(homedir(), '.flint', 'spool', 'policies.json'), log: (m) => console.error(m) });
  policyRows.start();
  // Runtime mode (rollout day 4+, FLINT_RUNTIME_URL set): approval-tier calls
  // become runtime proposals, spooled while the runtime is down, and approving
  // needs Will's signature. Unset: the RAM queue, as before.
  const proposals = runtimeUrl
    ? new RuntimeProposals({
        runtime: runtimeLink, spoolDir: join(homedir(), '.flint', 'spool'), log: (m) => console.error(m),
        // A call queued while the runtime was down, then refused when it got there.
        onRefused: (p) => audit.record({
          actor: 'flint', context: 'chat', kind: 'decision', action: p.action, tier: 'forbidden', decision: 'deny', outcome: 'denied',
          inputs: { spooled: true }, reasoning: p.reason.slice(0, 1000), tainted: p.tainted, ...(p.spoolId ? { correlationId: `spool:${p.spoolId}` } : {}),
        }),
      })
    : undefined;
  if (proposals) setInterval(() => void proposals.replay().catch(() => {}), 30_000).unref();
  const tierOpts = {
    queue: actions, onDecision, onOutcome, policies: () => policyRows.current(), claimCap: capClaimer(runtimeLink),
    taintFloor: process.env.FLINT_TAINT_FLOOR !== '0', ...(proposals ? { proposals } : {}),
  };
  // Will's approval factor (./approvals): passkeys on the tailnet HTTPS origin,
  // or the desktop app's Secure Enclave key. Needs the flint_approver database
  // role; without it, approvals stay one-tap as before.
  const approvals = process.env.FLINT_DB_APPROVER_URL
    ? new Approvals({
        store: pgApproverStore(process.env.FLINT_DB_APPROVER_URL, (m) => console.error(m)),
        enrollCodeFile: join(homedir(), '.flint', 'enroll-code'),
        ...rpFromDisk(),
        // A key added (and any revoked with it), within the audit's rules: an 'action'
        // (only a real Approval may be an 'approval' entry), short references, not raw ids.
        onEnrolled: (e) => {
          const ref = (id: string) => createHash('sha256').update(id).digest('hex').slice(0, 16);
          audit.record({
            actor: 'will:console', context: 'console', kind: 'action', action: 'approval.enroll', decision: 'act', outcome: 'ok',
            inputs: {
              key: ref(e.credentialId), factor: e.factor, via: e.via, approvalId: e.approvalId ?? null,
              revokedCount: e.revoked.length, revoked: e.revoked.map(ref).join(',').slice(0, 200) || null,
            },
            correlationId: `key:${ref(e.credentialId)}`,
          });
        },
      })
    : undefined;
  const specs = loadMcpSpecs();
  const registry = specs.length > 0 ? await McpRegistry.connect(specs, { gate: tierGate(tierOpts) }) : undefined;
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
  let plannerProvider: string | undefined; // ...and whose breaker it waits on
  // Perplexity / Tavily searches run in the MCP processes: metered per successful
  // call here, and refused with a routable error once their vendor's cap is spent.
  // deep_research gets the same wrapped tools, so its searches count too.
  const mcpTools = meterPaidTools(registry?.tools() ?? [], { guard: spend, specs: paidToolSpecs(process.env) });
  const tools: Tool[] = [
    ...mcpTools,
    ...gateBuiltins([
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
        // Whatever the turn, an eval replay included. The planner's prompt is the question itself:
        // on a turn the local model is answering (Local-only, a private question, a fallback) it
        // does not go to an outside AI, and a provider the breaker has paused is not asked.
        () => {
          const held = goalsChat.plannerHeld(plannerVendor !== undefined);
          if (held) return held;
          const paused = plannerProvider ? breaker.paused(plannerProvider) : undefined;
          return paused ? `the frontier is paused (${paused})` : undefined;
        },
      ),
    }),
    calculateTool(),
    spendStatusTool(spend),
    ], tierOpts),
  ];
  if (registry) console.error(`[mcp] connected: ${registry.connectedServers().join(', ') || '(none)'}; ${tools.length} tool(s)`);

  // Per-query tool selection — all tools stay wired; the model sees only the relevant few.
  const router = await ToolRouter.build(tools, embedder, CORE_TOOL_NAMES);

  // Frontier escalation — the bridge toward independence. Disabled cleanly if no
  // provider is configured (pure local). Shares memory + the router's tools with
  // the local brain, so escalated turns can still reach your systems and the web.
  // Tiers (./brains): judgeBrain still decides local-vs-frontier; the tier set
  // decides WHICH frontier. No FLINT_TIER_* → every tier is this legacy frontier.
  const frontierCfg = buildFrontierProvider(process.env, (m) => console.error(`[brain] ${m}`));
  let frontier: { persona: Persona; model: string; media: MediaFlags } | undefined;
  let extractFlint: Flint | undefined; // bare frontier (no persona): memory extraction, when Will opts it in (FLINT_MEMORY_BRAIN=frontier)
  const flintOf = new Map<Persona, Flint>();
  const frontierPersonaFor = (fProvider: ProviderAdapter, fModel: string, variant: StyleVariant): Persona => {
    const fFlint = new Flint({ provider: fProvider, defaultModel: fModel, memory: historyOf(fProvider, fModel), observer });
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
      // Which model this tier is (an `ollama:` tier is not Claude, and says so). The same bytes
      // on every call, so it sits inside the cached half of the prompt.
      engine: engineLineFor(fProvider, fModel),
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
  const makeStyled = () =>
    new StyledPersonas<Persona>(styles, {
      local: persona,
      buildLocal: (v) => localPersonaFor(flint, v, model),
      buildFrontier: frontierPersonaFor,
    });
  let styled = makeStyled();
  if (brains) {
    frontier = { persona: brains.primary.persona, model: brains.primary.label, media: mediaOf(brains.primary) };
    frontierModel = brains.primary.label;
    // Query planning is light work: give deep_research the routine tier's client.
    // Memory extraction, if Will opts it onto the frontier: the primary tier, bare (no persona).
    extractFlint = flintOf.get(brains.primary.persona);
    const planner = brains.chain('routine')[0] ?? brains.primary;
    frontierFlint = flintOf.get(planner.persona);
    plannerVendor = vendorOfProvider(planner.provider.name);
    plannerProvider = planner.provider.name;
    // The breaker's check after a cool-down: one token from the cheapest brain on that provider
    // (or from the one model that was paused), bare, tried once, metered like any other call.
    checkFrontier = async (p, signal, m) => {
      // A provider-wide check asks a brain with no pause of its own: one the key may not use would
      // answer 403 every time, and the provider would never be seen to be back.
      const b = brains.cheapestOn(p, m, (brain) => !breaker.state(p, brain.model).open);
      const f = b && flintOf.get(b.persona);
      if (!f) throw new Error('no brain on that provider');
      await f.generate({ prompt: 'ping' }, { maxTokens: 1, signal, context: spendContext('chat'), retryPolicy: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 } });
    };
    console.error(`[brain] frontier escalation ENABLED -> ${brains.primary.label} (tiers: ${brains.describe()})`);
  } else {
    console.error('[brain] frontier disabled (set ANTHROPIC_API_KEY, or FLINT_FRONTIER_* for a local big model) — running local-only');
  }

  // Proactivity — a notifications feed (built above) + a watcher that surfaces things unasked.
  // FLINT_WATCHER=off once the runtime's calendar source is live (P2.5): it owns the calendar.
  if (watcherEnabled()) new Watcher(notes, buildChecks(tools, knowledge)).start();
  else console.error('[watch] proactive watcher off (FLINT_WATCHER=off): the runtime has the calendar');

  // /chat turns in flight (POST /internal/load): the runtime's triage yields to
  // them, and so does memory extraction on the local model (below).
  const chatLoad = new ChatLoad();

  // Long-term memory that actually grows. `remember` alone produced 9 facts in
  // 1,421 turns, because it only fires when the model elects to call it; this
  // reads the turns Flint has already had and extracts the durable ones, with a
  // curator prompt (not the persona), under a daily call cap, and writes through
  // KnowledgeStore, so dedupe, tombstones + the ephemeral filter still apply.
  // It runs on the local model by default (./memory-brain), yielding to Will's
  // chat; on the frontier only with FLINT_MEMORY_BRAIN=frontier, where it is
  // background spend and pauses at 80% of its vendor's cap (./spend).
  const extractWith = extractFlint;
  const chatActive = liveChat(chatLoad);
  let memoryStarted = false;
  const startMemory = (): void => {
    memoryStarted = true;
    const memoryPlan = chooseMemoryBrain(localEnv, {
      frontier: extractWith && frontierExtractBrain((input) => extractWith.generate(input, { context: spendContext('extract') })),
      chatActive,
      log: (m) => console.error(m),
    });
    if (memoryPlan.kind === 'none') {
      console.error(`[memory-extract] not running: ${memoryPlan.why}`);
      return;
    }
    const extractVendor = memoryPlan.kind === 'frontier' && brains ? vendorOfProvider(brains.primary.provider.name) : undefined;
    // The brain the extractor runs on: the frontier's primary tier, or the local model at its own address (an
    // Ollama on another machine is not on this Mac either).
    const extractBrain = memoryPlan.kind === 'local' ? { provider: 'ollama', model: memoryPlan.model.model, baseURL: memoryPlan.model.baseURL } : brains && brainOf(brains.primary.provider, brains.primary.model);
    console.error(
      memoryPlan.kind === 'local'
        ? `[memory-extract] on the local model ${memoryPlan.model.model} (num_ctx ${memoryPlan.model.numCtx ?? 'unset'}); it waits for Will's chat`
        : `[memory-extract] on the frontier (${brains?.primary.label ?? 'primary tier'}), metered as extract`,
    );
    new MemoryExtractor(memory, knowledge, memoryPlan.brain, join(dataDir, 'extract-state.json'), {
      kind: memoryPlan.kind,
      ...(memoryPlan.kind === 'local'
        ? { chatActive }
        : { gate: () => (extractVendor ? spend.backgroundBlocked(extractVendor) : undefined) }),
      // A turn that stays on this Mac is skipped too when the extractor's brain may not read it, and what a brain
      // that may read it learns from it is marked (./goals-chat extractor).
      ...goalsChat.extractor({ brain: extractBrain, tainted: (cid, tid) => convTaint.isTainted(cid, tid) }),
      // The goals Will sets and the things he says he will do (./goal-candidates; FLINT_EXTRACT_CANDIDATES=1, off by
      // default): asked of the local model alone, each held to his own quoted words, and handed to the runtime on
      // this Mac, which files the card he signs. On the frontier this adds nothing: its prompt never changes.
      ...candidateOptions(process.env, {
        kind: memoryPlan.kind, candidates: new GoalCandidates({ runtime: runtimeLink }),
        tz: process.env.FLINT_TZ?.trim() || process.env.FLINT_USER_TZ?.trim() || 'America/Chicago', log: (m) => console.error(m),
      }),
    }).start();
  };
  // On the local model it reads the model that was settled, so it starts once there is one: now,
  // or when Ollama answers (adoptLocal). On the frontier, or off, the local model is no part of it.
  if (localBrain.settled || memoryBrainSetting(process.env, () => {}) !== 'local') startMemory();
  else console.error('[memory-extract] waiting for Ollama to answer before it picks the local model');

  const servers = registry?.connectedServers() ?? [];
  const convos: Convo[] = [];
  const budgetNotes = new NoteOnce(() => ledger.period().day);
  // The runtime's calls back into the server (./internal): [::1]:8081 only, with
  // the token install-runtime.sh writes; the server keeps just its digest.
  const internalTokenFile = join(homedir(), '.flint', 'tokens', 'internal.token');
  const internalSha = (() => {
    let cached: string | undefined;
    return () => {
      if (cached) return cached;
      try {
        const t = readFileSync(internalTokenFile, 'utf8').trim();
        cached = /^[0-9a-f]{64}$/.test(t) ? createHash('sha256').update(t).digest('hex') : undefined;
      } catch {
        cached = undefined;
      }
      return cached;
    };
  })();
  // The runtime's background calls (./background-complete): answered by the local model, never an
  // outside one, yielding to Will's chat like memory extraction. Every kind is off until Will raises its cap.
  const makeBackground = () => {
    const backgroundModel = localBackgroundModel(localEnv, model, (m) => console.error(m));
    return backgroundModel && localBackgroundBrain(backgroundModel, { chatActive });
  };
  let backgroundBrain = makeBackground();
  // The local model costs nothing, so a kind is bounded by its calls a day, not its dollars.
  const callCaps = readKindCallCaps(process.env, (m) => console.error(`[spend] ${m}`));
  const completeGate = new CompleteGate({ guard: spend, kindCaps, callCaps, audit, brain: () => backgroundBrain, log: (m) => console.error(m) });
  startInternal({
    tokenSha256: internalSha,
    // The runtime's words stay in the console; the phone only ever gets the content-free ping.
    notify: (n) => notes.push(n.title, n.body, 'runtime', n.dedupe, { channels: n.channels }),
    spendExternal: (t) => spend.setExternal(t),
    chatInFlight: () => chatLoad.inFlight,
    complete: (body) => completeGate.handle(body),
  }).on('error', (err) => console.error(`[internal] listener failed (${errorSummary(err)})`));
  // "World now" in frontier chat context (./world-now). It adds tokens to every
  // frontier turn, so it is off until Will turns it on (FLINT_WORLD_NOW=1).
  // (`blocks`, read above by ./context-blocks; FLINT_CONTEXT_BLOCKS=off turns every block off.)
  const worldNow = blocks.world ? new WorldNow({ runtime: runtimeLink }) : undefined;
  // An ask that carries what stays on this Mac is offered no tool an outside AI answers, and local builds of two
  // (./goals-chat toolsKeptHere): deep_research with no frontier planner and only the search tools that are left,
  // and `remember` saving what it is told as a fact that stays here.
  const keptTools = toolsKeptHere({ search: mcpTools, embedder, knowledge, specs: paidToolSpecs(process.env), gate: (list) => gateBuiltins(list, tierOpts) });
  // Every brain /chat can ask is named for the gate, as it is NOW: named again when Ollama's own answer is adopted (adoptLocal).
  goalsChat.name({ persona, provider, model }, brains, keptTools);

  // One request is one turn, with its own taint state (./turn-taint).
  const server = createServer(safeHandler((req, res) => withTurnTaint(() => {
    // A 5xx answer is a route.error event for the runtime (an eval replay's is not; nor is
    // the lanes proxy's, whose 5xx is the runtime's own failure: routeOf names none).
    const turn = currentTurn();
    const route = routeOf(req.url ?? '/');
    res.once('finish', () => {
      if (res.statusCode >= 500 && res.statusCode <= 599 && route && !turn?.eval) events.push({ type: 'route.error', route, status: res.statusCode });
    });
    return handle(req, res, { persona, localModels, styled, provider, model, localFrom: localBrain.from, tools, router, actionLog, servers, convos, frontier, brains, breaker, memory, knowledge, actions, notes, training, spend, budgetNotes, audit, approvals, proposals, convTaint, events, worldNow, goals: goalsChat, chatLoad, runtime: runtimeLink });
  })));
  // Bind loopback only: the device app reaches it via localhost and remote
  // devices reach it through Tailscale (which proxies to localhost). Nothing on
  // the LAN can hit it directly — the only door in is the private tailnet.
  // ::1, not 127.0.0.1 (./access DEFAULT_BIND_HOST): this Mac's userspace tailscaled
  // forwards any tailnet peer's connection to 127.0.0.1:<port>, headers and all.
  const HOST = bindHost(process.env);
  server.listen(PORT, HOST, () => console.error(`Flint listening on ${HOST}:${PORT} (provider=${provider.name}, model=${model})`));

  // Ollama did not answer at boot, so the local brain is a stand-in default. Nothing waited for it
  // (the server is listening, and the installer's /health poll has its answer): it is asked again
  // in the background, and its own answer becomes the local brain for the NEXT turn. Each request
  // reads these variables when it arrives, so a turn already running finishes on what it started with.
  const adoptLocal = (next: LocalBrain): void => {
    localBrain = next;
    provider = new OllamaProvider(next.options);
    model = next.model;
    localEnv = { ...process.env, ...next.env };
    flint = new Flint({ provider, defaultModel: model, memory: historyOf(provider, model), observer });
    persona = localPersonaFor(flint, styles.local, model);
    styled = makeStyled();
    backgroundBrain = makeBackground();
    // The local brain is another one now: who may read what stays here is named again (./goals-chat).
    goalsChat.name({ persona, provider, model }, brains, keptTools);
    noteLocalDefault(next);
    if (!memoryStarted) startMemory();
  };
  if (!localBrain.settled) keepPickingLocal(process.env, adoptLocal, { log: (m) => console.error(m) });
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
  /** Where the local model's name came from: `env` (OLLAMA_MODEL), or what Ollama had (`loaded`, `pulled`), or the `default` guess. */
  localFrom: LocalBrain['from'];
  tools: Tool[];
  router: ToolRouter;
  actionLog: ActionLogObserver;
  servers: string[];
  convos: Convo[];
  frontier: { persona: Persona; model: string; media: MediaFlags } | undefined;
  brains: BrainSet<Persona> | undefined;
  /** Which outside providers are paused after failures that will repeat (./frontier-breaker). */
  breaker: FrontierBreaker;
  memory: PersistentStore;
  convTaint: ConversationTaint;
  knowledge: KnowledgeStore;
  actions: ActionQueue;
  audit: AuditSink;
  approvals: Approvals | undefined;
  proposals: RuntimeProposals | undefined;
  notes: Notifications;
  training: TrainingLogger;
  /** Spend caps (./spend): /spend, /speak, and the frontier plan for each turn. */
  spend: SpendGuard;
  /** The honest "running on my local brain" line, once per conversation per day. */
  budgetNotes: NoteOnce;
  /** What the server tells the runtime (./runtime-events). */
  events: RuntimeEvents;
  /** The "World now" block for frontier chat turns; undefined unless FLINT_WORLD_NOW=1. */
  worldNow: WorldNow | undefined;
  /** What stays on this Mac in chat (./goals-chat): each ask's context, tools and mark, and what a reply may be spoken with. */
  goals: GoalsChat<Persona>;
  /** /chat turns in flight, for the runtime's triage (./chat-load). */
  chatLoad: ChatLoad;
  /** The runtime link main() builds (the lanes, ./inbox-routes). */
  runtime: () => Runtime | undefined;
}

/** Tool calls executed during a turn, pulled from the action log (for training capture). */
function toolsSince(ctx: Ctx, beforeLen: number): Array<{ tool: string; outcome?: string; ms?: number }> {
  const acts = ctx.actionLog.actions();
  return acts
    .slice(beforeLen)
    .filter((a): a is Extract<typeof a, { type: 'tool_result' }> => (a as { type?: string }).type === 'tool_result')
    .map((a) => ({ tool: a.tool, outcome: a.isError ? 'error' : 'ok', ms: a.durationMs }));
}

/**
 * One line per tier fallback, with what caused it as code words (./error-log errorSummary: the
 * AiError kind, the provider's code, the breaker's reason), or that the breaker had the brain paused.
 */
function logFallback(from: { label: string }, to: { label: string }, err: unknown): void {
  if (err instanceof FrontierPaused) console.error(`[brain] ${from.label} skipped (${err.message}) — moving on to ${to.label}`);
  else logError(`[brain] ${from.label} failed, falling back to ${to.label}:`, err);
}

/** One line when the local model takes over a frontier turn: the failure's code words, never the provider's message. */
function logToLocal(how: string, err: unknown): void {
  if (err instanceof FrontierPaused) console.error(`[brain] ${err.brain.label} is paused (${err.brain.reason}); the local model answers`);
  else logError(`[brain] ${how}, falling back to local:`, err);
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
  const host = hostName(req.headers.host);
  if (host && !ALLOWED_HOSTS.test(host)) {
    return json(res, 403, { error: 'bad host' });
  }

  // Who is asking (./access). Over the tailnet, only FLINT_TAILNET_USER once it is set.
  const facts = { remoteAddress: req.socket.remoteAddress, headers: req.headers };
  if (!tailnetAllowed(facts, TAILNET_USER)) {
    return json(res, 403, { error: 'this Tailscale login may not use Flint' });
  }

  // Serve the console UI. The bearer token is injected only for this Mac (the
  // desktop app) and for FLINT_TAILNET_USER's devices, so the installed app opens
  // already authenticated; anyone else gets the page without it (./access).
  if (req.method === 'GET' && (url === '/' || url.startsWith('/console'))) {
    if (!existsSync(CONSOLE_PATH)) return json(res, 404, { error: 'console not built' });
    // Stamped with its version, so an open console can tell when a deploy replaced it (./ui-version).
    const page = stampUiVersion(readFileSync(CONSOLE_PATH, 'utf8'));
    const html = consoleGetsToken(facts, TAILNET_USER)
      ? page.replace('</head>', `<script>window.__FLINT_TOKEN__=${JSON.stringify(TOKEN)}</script></head>`)
      : page;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  // The deployed console's version: an open console polls this and reloads itself
  // at a quiet moment once it differs from the version stamped into the page.
  if (req.method === 'GET' && url === '/ui-version') {
    if (!existsSync(CONSOLE_PATH)) return json(res, 404, { error: 'console not built' });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ version: uiVersionOf(readFileSync(CONSOLE_PATH, 'utf8')) }));
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
      // Where the local model's name came from: `env` (OLLAMA_MODEL), `loaded` or `pulled` (Ollama
      // was asked), or `default` (nothing was set and Ollama offered none: a guess until restart).
      localModelFrom: ctx.localFrom,
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
      // Which exact prompt each live brain speaks with (a hash of its style guide and engine
      // paragraph): a run can record it, and tell answers before and after a prompt change apart.
      promptRevisions: { local: promptRevision(ctx.persona), ...(ctx.frontier ? { frontier: promptRevision(ctx.frontier.persona) } : {}) },
      // The longest tool excerpt an eval /generate may ask for with `groundingChars`
      // (apps/parity tasks), and that GET /eval/tools + POST /eval/tool exist (./eval-tools).
      groundingCharsMax: GROUNDING_CHARS_MAX,
      evalDiscovery: true,
      // That an eval /generate honours `recall: false` (apps/parity tasks: answer on the
      // same data the frontier competitors get, which leaves long-term memory out).
      evalRecallOverride: true,
      // Outside providers (or one model) the breaker has paused, with a reason code and the
      // seconds to its next check (./frontier-breaker). Empty: nothing is paused.
      frontierPaused: ctx.breaker.snapshot(),
    });
  }

  // Auth for everything else, in constant time, and what the token may reach (./access).
  const scope = bearerScope(req.headers.authorization, { full: TOKEN, scoped: SCOPED });
  if (!scope) {
    return json(res, 401, { error: 'unauthorized' });
  }
  if (!scopeAllows(scope, req.method ?? 'GET', url)) {
    return json(res, 403, { error: 'this token may not call that' });
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

  // Chat history for the console's sidebar, from the conversation store (./threads):
  // the threads newest first, then one thread's turns (text only, no attachment bodies).
  if (req.method === 'GET' && (url === '/threads' || url.startsWith('/threads?'))) {
    return json(res, 200, { threads: await listThreads(ctx.memory) });
  }
  if (req.method === 'GET' && url.startsWith('/threads/')) {
    const thread = await readThread(ctx.memory, url.slice('/threads/'.length).split('?')[0] ?? '');
    return json(res, thread.status, thread.body);
  }

  // Voice input: the app records mic audio and posts it here; we transcribe with
  // whisper.cpp and hand back the text (the client then sends it as a chat).
  if (req.method === 'POST' && url === '/transcribe') {
    const raw = await readRawLimited(req, MAX_AUDIO_BYTES);
    if (raw.tooLarge) return json(res, 413, { error: 'audio too large' });
    const buf = raw.body;
    if (!buf.length) return json(res, 400, { error: 'no audio' });
    try {
      return json(res, 200, { text: await transcribeAudio(buf) });
    } catch (e) {
      return json(res, 500, { error: 'transcription failed', ref: errorRef('transcribe', e) });
    }
  }

  // Voice output: neural TTS → mp3. 503 (no key, or OpenAI's spend cap reached)
  // tells the client to use its local browser voice instead.
  if (req.method === 'POST' && url === '/speak') {
    const read = await readJsonLimited(req, SMALL_JSON_BYTES);
    if (read.tooLarge) return json(res, 413, { error: 'request too large' });
    const body = read.body;
    const text = String(body.text ?? '').trim();
    if (!text) return json(res, 400, { error: 'text required' });
    // Speech is an outside service. A reply that stays on this Mac is never sent to it (./goals-chat
    // speechStaysHere): the client names the conversation and the turn, and speaks with its own voice instead.
    // 409, not 503: a 503 tells the client the neural voice is out for the next ten minutes.
    if (ctx.goals.speechStaysHere({ conversationId: body.conversationId, turnId: body.turnId })) return json(res, 409, { error: SPEECH_STAYS_HERE, fallback: 'browser' });
    try {
      const spoken = await speakWithinBudget(text, { guard: ctx.spend, model: TTS_MODEL, maxChars: TTS_MAX_CHARS, synth: synthesizeSpeech });
      if (spoken.status === 'no-key') return json(res, 503, { error: 'no tts key' });
      if (spoken.status === 'budget') return json(res, 503, { error: spoken.message, budget: true, fallback: 'browser' });
      const audio = spoken.audio;
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': audio.length });
      res.end(audio);
    } catch (e) {
      return json(res, 502, { error: 'tts failed', ref: errorRef('speak', e) });
    }
    return;
  }

  if (req.method === 'POST' && url === '/generate') {
    const started = Date.now();
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
    // An eval-scoped token (evolve, parity) asks eval questions only: never a turn
    // that is logged as training data or can propose actions (./access).
    if (scope === 'eval' && !evalMode) return json(res, 403, { error: 'this token may only make eval calls' });
    // Nothing an eval replay asks for is ever queued or proposed (./turn-taint, ./tier-gate).
    if (evalMode) markEval();
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
    const scored = await ctx.router.selectScored(asText);
    const routed = scored.tools;
    const selected = evalMode ? routed.filter((t) => t.definition.name !== 'remember') : routed;
    // Same block contextFor builds; the facts are kept for the eval response's `grounding`.
    // A one-shot answer gets recall as ANY brain may have it: without the facts that stay on this Mac
    // (./goals-chat recallForAnyBrain). Only /chat's per-ask gate hands those out, to a brain that may read
    // them; here there is no such gate, and an eval replay's answer and grounding go on to its judges.
    const recalled = recallForAnyBrain(await recallContext(userContext(), asText, ctx.knowledge, { skip: !rc.recall }));
    const ctxBlock = recalled.block;
    const toolsLikely = ctx.router.toolsLikely(scored.appended);
    const tier = classifyMessage(prompt, { toolsLikely });
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
    // The breaker's say (./frontier-breaker gateTurn): brains whose provider is paused are left
    // out, and with none left the local model answers at once instead of after their failures.
    // An eval replay measures the tiers as configured, so it is not rerouted (as the caps do not
    // apply to it): every brain it planned is asked. If they fail and the local model answers
    // while a provider is paused, the answer is MARKED (evalPaused, `frontierPaused` in the
    // response), so apps/parity does not file a local answer under a frontier contestant.
    const gate = gateTurn({ brain: budget.brain, chain: plan?.chain, canLocal: route.localFallback && !budget.localRefusal && !evalMode, breaker: ctx.breaker });
    const evalPaused = () => (evalMode && plan ? pausedCode(gateChain(plan.chain, ctx.breaker).paused) : undefined);
    let brain = gate.brain;
    let paused = gate.paused; // also set when a brain's provider is paused while the turn runs
    let answeredBy = local.model;
    // The [route] line (./route-log): tier, what moved it, who answered. Never the prompt.
    const moved = movedBy(prompt, tier, { toolsLikely });
    let lastTried: string | undefined; // set as each brain is asked; the winner is the last one asked
    let lastPersona: Persona | undefined; // ...and the persona it spoke with, for its prompt revision
    const logRoute = (outcome: Outcome) =>
      console.error(
        routeLine({
          path: 'generate',
          tier,
          ...(moved ? { movedBy: moved } : {}),
          appended: scored.appended,
          ...(plan && plan.tier !== tier ? { planTier: plan.tier } : {}),
          brain,
          ...(paused ? { paused } : {}),
          ...attribution(outcome, lastTried),
          ...(lastPersona ? { promptRev: promptRevision(lastPersona) } : {}),
          outcome,
          recall: recalled.mode,
          ms: Date.now() - started,
          ...(evalMode ? { eval: true } : {}),
        }),
      );
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
        lastPersona = p;
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
          const won = await answerWithFallback(
            gate.chain,
            gate.attempt((b) => {
              lastTried = b.label;
              // A tier whose brain is on this Mac answers as a local model's turn here too (./goals-chat run).
              return ctx.goals.run(b, () => answered.ask(personas.frontier(b)));
            }),
            // Once this turn has called a tool, no other brain is asked to do it again.
            { signal: abort.signal, acted: () => turn.acted, onFallback: logFallback },
          );
          out = won.result;
          unanswered = won.unanswered;
          answeredBy = won.brain.label;
        } catch (err) {
          if (abort.signal.aborted) {
            logRoute('aborted');
            return; // the client is gone: nothing to answer
          }
          // An image/PDF turn has no honest fallback — the local brain can't see it. Nor does a
          // turn that already called a tool (the local brain would call it again), or one whose
          // failure is not the provider's (a tool's own error): ./brains mayAskAnother.
          if (!route.localFallback || !mayAskAnother(err, { acted: turn.acted })) {
            logRoute('error');
            return json(res, 502, { error: 'frontier failed', ref: errorRef('generate', err), ...evalFields() });
          }
          // Nor does a turn whose local brain is a paid model with its budget spent.
          if (budget.localRefusal) {
            logRoute('error');
            return json(res, 503, { error: `frontier failed. ${budget.localRefusal}`, ref: errorRef('generate', err), ...evalFields() });
          }
          logToLocal('frontier failed', err);
          if (err instanceof FrontierPaused) paused ??= pausedCode([err.brain]);
          paused ??= evalPaused(); // a replay the local model answers because the provider is paused
          brain = 'local';
          lastTried = local.model;
          out = await asLocalTurn(() => answered.ask(local.persona));
        }
      } else {
        lastTried = local.model;
        // The local model's turn: nothing it sets off sends the question to an outside AI (asLocalTurn).
        out = await asLocalTurn(() => answered.ask(local.persona));
      }
    } catch (err) {
      if (abort.signal.aborted) {
        logRoute('aborted');
        return;
      }
      logRoute('error');
      // An eval replay says what it cost even when it fails, so apps/parity can charge it.
      if (evalMode) return json(res, 500, { error: 'flint failed', ref: errorRef('generate', err), ...evalFields() });
      throw err;
    }
    logRoute(unanswered ? 'unanswered' : out.text.trim() ? 'answered' : 'empty');
    const toolsUsed = toolsSince(ctx, beforeLog);
    // An eval replay proposed nothing (and must not claim, or reject, another turn's proposals).
    const proposed = evalMode ? [] : turnProposals();
    if (evalMode) {
      return json(res, 200, {
        text: out.text,
        usage: out.usage,
        reason: out.reason,
        // 'refusal' | 'empty' when `text` is the honest "no model answered" message, so apps/parity doesn't judge it.
        ...(unanswered ? { unanswered } : {}),
        brain,
        ...(brain === 'frontier' ? { tier: plan?.tier ?? tier } : {}),
        // `provider:reason` codes when the breaker left outside brains out of this turn.
        ...(paused ? { frontierPaused: paused } : {}),
        model: answeredBy,
        // The `think` the answering persona's Ollama client sends (not the request's
        // localThink), so apps/parity can tell the flag reached Ollama, as it does for `model`.
        ...(local.think !== undefined ? { localThink: local.think } : {}),
        // The style variant of the persona that answered, read from its guide, not the
        // request (apps/parity checks it against --flint-variant).
        styleVariant: answered.styleVariant(),
        // ...and the revision of its whole prompt, engine paragraph included (promptRevision).
        ...(lastPersona ? { promptRev: promptRevision(lastPersona) } : {}),
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
      ...(paused ? { frontierPaused: paused } : {}),
      model: answeredBy,
      pending: proposed,
    });
  }

  if (req.method === 'POST' && url === '/chat') {
    const started = Date.now();
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
    // From here until the turn ends, however it ends, it is a chat turn in flight
    // (POST /internal/load): the runtime's triage leaves the local model to it.
    return ctx.chatLoad.run(async () => {
      // Router, recall, the Action Log and the training corpus see names, never file bodies.
      const asText = [message, summarizeAttachments(attachments)].filter(Boolean).join(' ');
      const scored = await ctx.router.selectScored(asText);
      const selected = scored.tools;
      // The history this turn will actually carry (windowed), not the whole stored thread:
      // its complete turns size the "deep thread" rule, and the ones left out get a context line.
      const history = ctx.memory.historyStats(conversationId);
      // (The history is checked for untrusted text when the model is handed it: memory.onHistory.)
      const turnsBefore = new Set(ctx.memory.turnIds(conversationId));
      const turns = route.brain === 'frontier' && ctx.brains?.tiered ? history.sent : 0;
      const toolsLikely = ctx.router.toolsLikely(scored.appended);
      const tier = classifyMessage(message, { turns, toolsLikely });
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
      // May the local model answer this turn if the frontier can't: no image or PDF on it, and
      // (a paid local brain) its budget not spent.
      const toLocal = route.localFallback && !budget.localRefusal;
      // The breaker's say (./frontier-breaker gateTurn): brains whose provider is paused are left
      // out, and with none left the local model answers at once instead of after their failures.
      const gate = gateTurn({ brain: budget.brain, chain: plan?.chain, canLocal: toLocal, breaker: ctx.breaker });
      let brain = gate.brain;
      let paused = gate.paused; // also set when a brain's provider is paused while the turn runs
      let answeredBy = ctx.model;
      let failed = false;
      let streamErrored = false; // a provider failure arrives as a streamed error event, not a throw
      let gaveUp = false; // every tier refused or came back empty: the reply is the honest message
      // A sentence the server wrote for Will about why the reply stopped (the budget refusal), sent with the raw error.
      let stopWords: string | undefined;
      let lastTried: string | undefined; // set as each brain is asked; the winner is the last one asked
      let lastPersona: Persona | undefined; // ...and the persona it spoke with, for its prompt revision
      const moved = movedBy(message, tier, { toolsLikely, turns });
      // "World now" (./world-now), fetched alongside recall, for frontier turns only: a local
      // turn's prompt is already at its limit with ~42 tool schemas (more text there and the
      // local model starts coming back empty, as the voice-exemplar note in main() records).
      const [recalled, world, goals] = await Promise.all([
        contextFor(asText, ctx.knowledge),
        brain === 'frontier' && plan && ctx.worldNow ? ctx.worldNow.block() : Promise.resolve(''),
        // Will's goals (./goals-chat), for whichever brain ends up asked: handed out per ask, in pump, never here.
        ctx.goals.forTurn(conversationId, message),
      ]);
      const ctxBlock = withHistoryNote(recalled.block, history);
      // The same block as a brain that is not on this Mac may have it: without the recalled facts that stay
      // here (./knowledge fromGoals). The very same text when none was recalled.
      const outsideCtx = withHistoryNote(recalled.outside, history);
      // It rides in the persona context (the system prompt's per-turn suffix): never stored in
      // the history, so the memory extractor never reads it, and a local fallback goes without.
      const frontierCtx = world ? `${ctxBlock}\n\n${world}` : ctxBlock;
      let goalsTokens = 0; // the block's size in the prompt of the brain asked last (0: it went without)
      const beforeLog = ctx.actionLog.actions().length;

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      const ac = new AbortController();
      res.on('close', () => ac.abort());
      let answer = '';
      // A tool_call went out: the turn has acted (the tool ran, or was filed for approval), so
      // from here no other brain is asked. It would start the turn over and call it again.
      let acted = false;
      const noAnswers: Unanswered[] = []; // the tiers that refused / came back empty, for the honest message's wording
      // `tried` (frontier tiers only): a refused / empty reply falls back or gets the honest message (./unanswered).
      const pump = async (persona: Persona, recoverable = false, tried?: number, context = ctxBlock) => {
        lastPersona = persona;
        // What stays on this Mac rides with an ask only if THAT persona's brain may read it (./goals-chat): one on
        // this Mac, asked as a local model's turn, or any once Will set FLINT_GOALS_TO_FRONTIER=on. Every ask in
        // /chat is made through here, so a frontier tier goes without and the local model it falls back to does
        // not. An ask that carries any of it is sized to that brain's real context, is offered only the tools that
        // keep it here, and marks its turn, which keeps the turn out of an outside brain's history and recall.
        const asked = goals.ask(persona, { context, whole: ctxBlock, outside: outsideCtx, tools: selected });
        goalsTokens = asked.tokens;
        const events = persona.chat(
          { conversationId, message, context: asked.context, ...(asked.tools.length ? { tools: [...asked.tools] } : {}), ...(attachments.length ? { attachments } : {}) },
          { signal: ac.signal, ...asked.mark },
        );
        for await (const ev of tried === undefined ? events : guardAnswer(events, { recoverable, tried, noAnswers, onUnanswered: () => (gaveUp = true) })) {
          // Ahead of the reply: whether it stays on this Mac, and which stored turn it is, for the client's voice.
          const here = asked.meta();
          if (here) res.write(`data: ${JSON.stringify(here)}\n\n`);
          // The budget note rides just ahead of `done`: shown, but never stored as the answer.
          if (note && ev.type === 'done') res.write(`data: ${JSON.stringify({ type: 'text', delta: `\n\n${note}` })}\n\n`);
          if (ev.type === 'text') answer += ev.delta;
          if (ev.type === 'tool_call') acted = true;
          // A provider error arrives as an event, not a throw. With no text out yet it is
          // thrown instead: to the next tier, or, from the last frontier tier, to the local
          // model when it may answer this turn (it used to reach Will as a stopped reply).
          // Only the provider's own failure, and only while the turn has not called a tool.
          if ((recoverable || (tried !== undefined && toLocal)) && ev.type === 'error' && answer.length === 0 && !acted && providerFailure(ev.error) && !ac.signal.aborted) throw new FlintError(ev.error);
          if (ev.type === 'error') streamErrored = true; // passed on to the client, so the turn failed
          res.write(`data: ${JSON.stringify(ev)}\n\n`);
        }
      };
      try {
        if (brain === 'frontier' && plan) {
          try {
            const chain = gate.chain;
            const won = await runWithFallback(
              chain,
              gate.attempt(async (b) => {
                lastTried = b.label;
                res.write(`data: ${JSON.stringify({ type: 'meta', brain, tier: plan.tier, model: b.label, ...budget.fields, ...(paused ? { frontierPaused: paused } : {}) })}\n\n`);
                try {
                  await ctx.goals.run(b, async () => {
                    await pump(b.persona, b !== chain[chain.length - 1], chain.indexOf(b) + 1, frontierCtx); // last tier: no answer → honest message; an error → the local model, when it may answer
                  });
                } catch (err) {
                  if (answer.length > 0) throw new NoFallback(err); // text already streamed
                  throw err;
                }
              }),
              { signal: ac.signal, acted: () => acted, onFallback: logFallback },
            );
            answeredBy = won.brain.label;
          } catch (err) {
            // Only safe to fall back if nothing was streamed yet and no tool was called, the failure is
            // the provider's, and (a paid local brain) its budget isn't spent.
            if (answer.length === 0 && toLocal && mayAskAnother(err, { acted, signal: ac.signal })) {
              logToLocal('frontier failed pre-output', err);
              if (err instanceof FrontierPaused) paused ??= pausedCode([err.brain]);
              brain = 'local';
              lastTried = ctx.model;
              res.write(`data: ${JSON.stringify({ type: 'meta', brain, ...(paused ? { frontierPaused: paused } : {}) })}\n\n`);
              await asLocalTurn(() => pump(ctx.persona));
            } else if (answer.length === 0 && route.localFallback && budget.localRefusal && mayAskAnother(err, { acted, signal: ac.signal })) {
              stopWords = budget.localRefusal;
              throw new Error(`frontier failed: ${String(err)}. ${budget.localRefusal}`);
            } else {
              throw err;
            }
          }
        } else {
          lastTried = ctx.model;
          res.write(`data: ${JSON.stringify({ type: 'meta', brain, ...budget.fields, ...(paused ? { frontierPaused: paused } : {}) })}\n\n`);
          // The local model's turn: nothing it sets off sends the question to an outside AI (asLocalTurn).
          await asLocalTurn(() => pump(ctx.persona));
        }
        if (answer.trim()) {
          recordConvo(ctx.convos, asText, answer);
          ctx.training.log(
            { conversationId, brain, model: answeredBy, input: asText, output: answer, tools: toolsSince(ctx, beforeLog) },
            Date.now(),
          );
        }
        // This turn's own proposals only (a concurrent turn's are its own).
        const proposed = turnProposals();
        if (proposed.length > 0) res.write(`data: ${JSON.stringify({ type: 'pending', actions: proposed })}\n\n`);
      } catch (err) {
        failed = true;
        // `error` is the raw detail (the console logs it); `message`, when the server wrote one, is what Will reads.
        res.write(`data: ${JSON.stringify({ type: 'error', error: String(err), ...(stopWords ? { message: stopWords } : {}) })}\n\n`);
      }
      // The [route] line (./route-log): tier, what moved it, who answered. Never the message.
      const outcome = chatOutcome({ aborted: ac.signal.aborted, failed, streamErrored, gaveUp, answer });
      console.error(
        routeLine({
          path: 'chat',
          tier,
          ...(moved ? { movedBy: moved } : {}),
          appended: scored.appended,
          turns,
          ...(plan && plan.tier !== tier ? { planTier: plan.tier } : {}),
          brain,
          ...(paused ? { paused } : {}),
          ...attribution(outcome, lastTried),
          ...(lastPersona ? { promptRev: promptRevision(lastPersona) } : {}),
          outcome,
          ...(noAnswers.length > 0 ? { declined: noAnswers.length } : {}),
          recall: recalled.mode,
          ...(world || goalsTokens ? { ctxTokens: { ...(world ? { world: estimateTokens(world) } : {}), ...(goalsTokens ? { goals: goalsTokens } : {}) } } : {}),
          ms: Date.now() - started,
        }),
      );
      // The turn, for the runtime's triage (./runtime-events): brain, outcome, tool names, time, taint.
      ctx.events.push(chatTurnEvent({
        brain, outcome, tools: turnTools(), ms: Date.now() - started, tainted: turnTainted(),
        tier: plan?.tier ?? tier, recall: recalled.mode, ...(world ? { worldTokens: estimateTokens(world) } : {}), ...(goalsTokens ? { goalsTokens } : {}),
      }));
      // A turn that ran tainted carries it on: with its own read's time, or the history's it inherited.
      if (turnTainted()) {
        const own = taintSources().some((s) => s !== 'history');
        ctx.convTaint.mark(conversationId, ctx.memory.turnIds(conversationId).filter((id) => !turnsBefore.has(id)), own ? Date.now() : (historyOrigin() ?? Date.now()));
      }
      res.end();
      return;
    });
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

  // Proposals, approvals and approval keys (./approval-routes).
  if (await approvalRoutes(req, res, url, { ...ctx, errorRef })) return;

  // The runtime's lanes, its health report, and Will's labels, acks and dismissals (./inbox-routes).
  if (await inboxRoutes(req, res, url, { runtime: ctx.runtime, errorRef })) return;

  // Will's goals, for the console's Goals panel (./goals-routes): checked both ways, never spooled.
  if (await goalsRoutes(req, res, url, { runtime: ctx.runtime, errorRef })) return;

  // Training corpus stats — the growing seed of Flint's own brain.
  if (req.method === 'GET' && url.startsWith('/training')) {
    return json(res, 200, ctx.training.stats());
  }

  // Proactive notifications feed.
  if (req.method === 'GET' && url.startsWith('/notifications')) {
    return json(res, 200, { items: ctx.notes.list(), unread: ctx.notes.unreadCount() });
  }
  if (req.method === 'POST' && url === '/notifications/read') {
    const read = await readJsonLimited(req, SMALL_JSON_BYTES);
    if (read.tooLarge) return json(res, 413, { error: 'request too large' });
    const body = read.body;
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

/** A raw body up to maxBytes; past that it is drained, not kept, and reported tooLarge. */
function readRawLimited(req: IncomingMessage, maxBytes: number): Promise<{ tooLarge: true } | { tooLarge: false; body: Buffer }> {
  return new Promise((resolve) => {
    const declared = Number(req.headers['content-length'] ?? NaN);
    let over = Number.isFinite(declared) && declared > maxBytes;
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) over = true;
      if (!over) chunks.push(c);
    });
    req.on('end', () => resolve(over ? { tooLarge: true } : { tooLarge: false, body: Buffer.concat(chunks) }));
  });
}

main().catch((err) => {
  logError('Flint server failed to start:', err);
  process.exit(1);
});
