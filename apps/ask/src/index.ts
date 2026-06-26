import 'dotenv/config';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { Flint, AnthropicProvider, OllamaProvider, ActionLogObserver, type ProviderAdapter } from '@flint/core';
import {
  Persona,
  InMemoryRetriever,
  SemanticRetriever,
  OllamaEmbedder,
  reflect,
  consolidate,
  evaluateTriggers,
  FLINT_STYLE_GUIDE,
  FLINT_VOICE_EXEMPLARS,
  type Trigger,
} from '@flint/persona';
import { McpRegistry, type McpServerSpec, type Approver } from '@flint/mcp';
import { FileMemoryStore, FileLessonStore } from './stores.js';

/**
 * `ask` — a real consumer app: your personal Flint as a CLI. Proves the whole
 * vision end to end — Flint dropped into an app, running locally, with DURABLE
 * memory + lessons so it actually evolves across runs.
 *
 *   ask "<question>"        chat (memory-backed), default command
 *   ask reflect             distill nightly lessons from recent memory
 *   ask lessons             list what Flint has learned
 *   ask reset               wipe memory + lessons
 *
 * Provider: OLLAMA_MODEL (local, default 'qwen2.5:14b' if Ollama is up) or
 * ANTHROPIC_API_KEY. Data lives in ~/.flint/.
 */

const DATA_DIR = join(homedir(), '.flint');
const CONVERSATION = 'main';

function buildProvider(): { provider: ProviderAdapter; model: string } {
  const ollama = process.env.OLLAMA_MODEL?.trim();
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (ollama) {
    // Default to 127.0.0.1 (not 'localhost') — Node's fetch can resolve
    // localhost to IPv6 ::1 while Ollama binds IPv4, which surfaces as
    // "fetch failed". The explicit IPv4 host avoids it.
    return {
      provider: new OllamaProvider({ baseURL: process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434' }),
      model: ollama,
    };
  }
  if (key) return { provider: new AnthropicProvider({ apiKey: key }), model: 'claude-sonnet-4-6' };
  // Default to local Ollama with the recommended model.
  return { provider: new OllamaProvider(), model: 'qwen2.5:14b' };
}

function buildFlint() {
  const memory = new FileMemoryStore(join(DATA_DIR, 'memory.json'));
  const lessonStore = new FileLessonStore(join(DATA_DIR, 'lessons.json'));
  const { provider, model } = buildProvider();
  // Audit log: append every request/tool-call/result/error to ~/.flint/actions.jsonl.
  const actionsPath = join(DATA_DIR, 'actions.jsonl');
  const observer = new ActionLogObserver((e) => {
    try {
      appendFileSync(actionsPath, JSON.stringify(e) + '\n');
    } catch {
      /* never let logging break a turn */
    }
  });
  const flint = new Flint({ provider, defaultModel: model, memory, observer });
  return { flint, lessonStore, model, providerName: provider.name };
}

/**
 * Voice retrieval. Set FLINT_EMBED_MODEL (e.g. nomic-embed-text, pulled in
 * Ollama) for meaning-based semantic retrieval; otherwise keyword fallback.
 */
async function buildRetriever() {
  const embedModel = process.env.FLINT_EMBED_MODEL?.trim();
  if (embedModel) {
    const sem = new SemanticRetriever(
      new OllamaEmbedder({ model: embedModel, baseURL: process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434' }),
    );
    await sem.add(FLINT_VOICE_EXEMPLARS);
    return sem;
  }
  return new InMemoryRetriever(FLINT_VOICE_EXEMPLARS);
}

async function buildPersona(): Promise<{ persona: Persona; flint: ReturnType<typeof buildFlint>['flint']; lessonStore: ReturnType<typeof buildFlint>['lessonStore'] }> {
  const { flint, lessonStore } = buildFlint();
  const persona = new Persona(flint, {
    name: 'Flint',
    styleGuide: FLINT_STYLE_GUIDE,
    retriever: await buildRetriever(),
    lessonStore,
  });
  return { persona, flint, lessonStore };
}

/** MCP servers (your apps as tools) from ~/.flint/mcp.json, if present. */
function loadMcpSpecs(): McpServerSpec[] {
  const path = join(DATA_DIR, 'mcp.json');
  if (!existsSync(path)) return [];
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
    process.stderr.write(`[mcp] failed to read mcp.json: ${String(err)}\n`);
    return [];
  }
}

/**
 * The approval gate for guarded (side-effecting) tools. Default: ask in the
 * terminal. FLINT_APPROVE=all approves everything (trusted/non-interactive);
 * FLINT_APPROVE=none denies everything.
 */
function makeApprover(): Approver {
  const mode = (process.env.FLINT_APPROVE ?? 'ask').toLowerCase();
  if (mode === 'all') return () => true;
  if (mode === 'none') return () => false;
  return (req) =>
    new Promise<boolean>((resolve) => {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      const args = JSON.stringify(req.args);
      const flag = req.destructive ? ' [DESTRUCTIVE]' : '';
      rl.question(`\n⚠ Flint wants to run ${req.server}.${req.tool}(${args})${flag}. Approve? [y/N] `, (ans) => {
        rl.close();
        resolve(/^y(es)?$/i.test(ans.trim()));
      });
    });
}

async function cmdChat(message: string): Promise<void> {
  const { persona } = await buildPersona();

  // Connect any configured MCP servers (your apps) and expose their tools.
  const specs = loadMcpSpecs();
  let registry: McpRegistry | undefined;
  if (specs.length > 0) {
    registry = await McpRegistry.connect(specs, {
      approver: makeApprover(),
      onError: (server, err) => process.stderr.write(`[mcp] ${server} failed: ${String(err)}\n`),
    });
    const names = registry.connectedServers();
    if (names.length > 0) process.stderr.write(`[mcp] connected: ${names.join(', ')}\n`);
  }
  const tools = registry?.tools() ?? [];

  try {
    process.stdout.write('Flint: ');
    for await (const ev of persona.chat({
      conversationId: CONVERSATION,
      message,
      ...(tools.length > 0 ? { tools } : {}),
    })) {
      if (ev.type === 'text') process.stdout.write(ev.delta);
      if (ev.type === 'error') process.stderr.write(`\n[error: ${ev.error.kind} — ${ev.error.message}]`);
    }
    process.stdout.write('\n');
  } finally {
    await registry?.close();
  }
}

async function cmdReflect(): Promise<void> {
  const { flint, lessonStore } = buildFlint();
  const messages = await flint.store.getMessages(CONVERSATION);
  if (messages.length === 0) {
    console.log('Nothing to reflect on yet. Have a conversation first.');
    return;
  }
  process.stderr.write('reflecting on recent sessions...\n');
  const { learned } = await reflect({
    flint,
    messages,
    lessonStore,
    now: Date.now(),
    conversationId: CONVERSATION,
  });
  if (learned.length === 0) {
    console.log('No new durable lessons this time.');
    return;
  }
  console.log(`Learned ${learned.length} new lesson(s):`);
  for (const l of learned) console.log(`  • (${l.category}) ${l.text}`);
}

async function cmdConsolidate(): Promise<void> {
  const { flint, lessonStore } = buildFlint();
  process.stderr.write('consolidating lessons...\n');
  const res = await consolidate({ flint, lessonStore, now: Date.now() });
  if (!res.changed) {
    console.log(`No consolidation needed (${res.before} lesson(s)).`);
    return;
  }
  console.log(`Consolidated ${res.before} → ${res.after} lesson(s):`);
  for (const l of res.lessons) console.log(`  • (${l.category}) ${l.text}`);
}

/**
 * Proactive morning brief (Phase 5). Unprompted: pulls current state from your
 * systems (via the configured MCP connectors) and tells you what matters. Runs
 * on a schedule (launchd) or on demand. Deterministic trigger (time) — the
 * honest, solvable kind of proactivity.
 */
async function cmdBrief(): Promise<void> {
  const { persona } = await buildPersona();
  const specs = loadMcpSpecs();
  let registry: McpRegistry | undefined;
  if (specs.length > 0) {
    registry = await McpRegistry.connect(specs, {
      approver: makeApprover(),
      onError: (server, err) => process.stderr.write(`[mcp] ${server} failed: ${String(err)}\n`),
    });
  }
  const tools = registry?.tools() ?? [];

  const prompt =
    'Produce my brief. Use your tools to pull current state from my systems ' +
    '(signals, forecasts, whatever is connected). Give 3-6 tight bullets of what ' +
    'I should know right now and flag anything notable. No preamble, no filler.';

  let out = '';
  try {
    for await (const ev of persona.chat({
      conversationId: 'brief',
      message: prompt,
      ...(tools.length > 0 ? { tools } : {}),
    })) {
      if (ev.type === 'text') {
        process.stdout.write(ev.delta);
        out += ev.delta;
      }
      if (ev.type === 'error') process.stderr.write(`\n[error: ${ev.error.kind}]`);
    }
  } finally {
    await registry?.close();
  }
  process.stdout.write('\n');
  try {
    writeFileSync(join(DATA_DIR, 'brief-latest.md'), `# Flint brief\n\n${out.trim()}\n`);
  } catch {
    /* best effort */
  }
}

/**
 * Evaluate watch triggers (Phase 5) from ~/.flint/triggers.json against your
 * connected systems. Deterministic — code decides if an alert fires, not the
 * model. Schedulable like brief/reflect.
 */
async function cmdWatch(): Promise<void> {
  const path = join(DATA_DIR, 'triggers.json');
  if (!existsSync(path)) {
    console.log('No triggers. Create ~/.flint/triggers.json:');
    console.log('  {"triggers":[{"name":"bullish","tool":"meridian.bias_summary","select":"*.score","when":{"op":">","value":0.5},"alert":"Strong bullish bias"}]}');
    return;
  }
  const triggers = (JSON.parse(readFileSync(path, 'utf8')) as { triggers?: Trigger[] }).triggers ?? [];
  const specs = loadMcpSpecs();
  const registry = specs.length > 0
    ? await McpRegistry.connect(specs, {
        approver: makeApprover(),
        onError: (server, err) => process.stderr.write(`[mcp] ${server} failed: ${String(err)}\n`),
      })
    : undefined;
  try {
    const results = await evaluateTriggers(triggers, registry?.tools() ?? []);
    const fired = results.filter((r) => r.fired);
    if (fired.length === 0) {
      console.log(`Checked ${results.length} trigger(s); nothing fired.`);
    } else {
      console.log(`${fired.length} alert(s):`);
      for (const r of fired) console.log(`  ⚠ ${r.name}: ${r.alert}`);
    }
    for (const r of results.filter((r) => r.error)) {
      process.stderr.write(`  (trigger '${r.name}' error: ${r.error})\n`);
    }
  } finally {
    await registry?.close();
  }
}

/** Show the auditable action trace of the most recent run. */
async function cmdLog(): Promise<void> {
  const path = join(DATA_DIR, 'actions.jsonl');
  if (!existsSync(path)) {
    console.log('No actions logged yet.');
    return;
  }
  const entries = readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  const lastReq = [...entries].reverse().find((e) => e.type === 'request')?.requestId;
  const run = entries.filter((e) => e.requestId === lastReq);
  if (run.length === 0) {
    console.log('No actions logged yet.');
    return;
  }
  console.log(`Last run (${String(lastReq)}):`);
  for (const e of run) {
    if (e.type === 'tool_call') {
      const flag = e.idempotent ? '' : ' [side-effecting]';
      console.log(`  → ${String(e.tool)}(${JSON.stringify(e.args)})${flag}`);
    } else if (e.type === 'tool_result') {
      const r = JSON.stringify(e.result);
      console.log(`  ← ${String(e.tool)} ${e.isError ? 'ERROR' : 'ok'} (${String(e.durationMs)}ms): ${r.length > 120 ? r.slice(0, 120) + '…' : r}`);
    } else if (e.type === 'response') {
      const u = e.usage as { input: number; output: number };
      console.log(`  ✓ done: ${String(e.reason)} (in ${u.input} / out ${u.output} tok)`);
    } else if (e.type === 'error') {
      console.log(`  ✗ error: ${(e.error as { kind: string }).kind}`);
    }
  }
}

async function cmdLessons(): Promise<void> {
  const { lessonStore } = buildFlint();
  const all = await lessonStore.all();
  if (all.length === 0) {
    console.log('No lessons yet. Run `ask reflect` after some conversations.');
    return;
  }
  console.log(`Flint has learned ${all.length} lesson(s):`);
  for (const l of all) console.log(`  • (${l.category}) ${l.text}`);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);

  if (!cmd || cmd === 'help' || cmd === '--help') {
    console.log('ask "<question>" | ask brief | ask watch | ask reflect | ask consolidate | ask lessons | ask log');
    return;
  }
  if (cmd === 'reflect') return cmdReflect();
  if (cmd === 'consolidate') return cmdConsolidate();
  if (cmd === 'brief') return cmdBrief();
  if (cmd === 'watch') return cmdWatch();
  if (cmd === 'lessons') return cmdLessons();
  if (cmd === 'log') return cmdLog();

  // Anything else is treated as the message (so `ask "..."` just works).
  const message = cmd === 'chat' ? rest.join(' ') : [cmd, ...rest].join(' ');
  if (!message.trim()) {
    console.error('Usage: ask "<question>"');
    process.exit(1);
  }
  return cmdChat(message);
}

main().catch((err) => {
  console.error('ask failed:', err);
  process.exit(1);
});
