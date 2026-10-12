/**
 * How index.ts wires the P2 pieces (it runs main() on import, so this reads
 * its source): /chat turns are counted after auth and validation, never an
 * eval /generate; "World now" reaches frontier calls only (never the local
 * fallback, never /generate); a chat.turn event ends each /chat turn and no
 * /generate turn; an eval replay's 5xx is not a route.error; memory extraction
 * waits for chat on the local model and is spend-gated only on the frontier.
 *
 * And the independence pieces: the local brain is never Anthropic; the frontier
 * breaker sees every client's requests and gates both routes; each persona says
 * which model answers; background calls go to the local model.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(__dirname, '..', 'src', 'index.ts'), 'utf8');
const between = (a: string, b: string) => {
  const i = src.indexOf(a);
  const j = src.indexOf(b, i + 1);
  expect(i).toBeGreaterThan(0);
  expect(j).toBeGreaterThan(i);
  return src.slice(i, j);
};
const generate = between("url === '/generate'", "url === '/chat'");
const chat = between("url === '/chat'", "url === '/eval/tools'");

describe('index.ts wiring', () => {
  it('counts /chat turns after the bearer check and the request checks, and never /generate', () => {
    expect(src.indexOf('bearerScope(req.headers.authorization')).toBeLessThan(src.indexOf("url === '/chat'"));
    expect(chat.indexOf("if ('error' in route)")).toBeLessThan(chat.indexOf('ctx.chatLoad.run('));
    expect(chat.indexOf('ctx.chatLoad.run(')).toBeGreaterThan(0);
    expect(generate).not.toContain('chatLoad');
  });

  it('World now is off unless FLINT_WORLD_NOW=1 (it costs tokens on every frontier turn)', () => {
    expect(src).toContain("process.env.FLINT_WORLD_NOW?.trim() === '1' ? new WorldNow(");
  });

  it('asks for World now only for a planned frontier turn, and hands it only to the frontier tiers', () => {
    expect(generate).not.toMatch(/worldNow|frontierCtx/);
    expect(chat).toContain("brain === 'frontier' && plan && ctx.worldNow ? ctx.worldNow.block()");
    // The frontier chain gets it; the local brain (first choice or fallback) does not.
    expect(chat).toMatch(/await pump\(b\.persona, [^;]*, frontierCtx\)/);
    expect(chat.match(/await asLocalTurn\(\(\) => pump\(ctx\.persona\)\)/g)).toHaveLength(2);
    expect(chat.match(/pump\(ctx\.persona\)/g)).toHaveLength(2);
    expect(chat.match(/frontierCtx/g)).toHaveLength(2); // defined once, used once
  });

  it('ends each /chat turn with a chat.turn event, and no /generate turn with one', () => {
    expect(chat).toContain('ctx.events.push(chatTurnEvent(');
    expect(generate).not.toMatch(/events\.push|chatTurnEvent/);
  });

  it("reports a 5xx answer as route.error, except an eval replay's", () => {
    expect(src).toMatch(/res\.statusCode >= 500 && res\.statusCode <= 599 && route && !turn\?\.eval\) events\.push\(\{ type: 'route\.error'/);
  });

  it('a reply stopped mid-stream because no brain has budget left sends Will the reason beside the raw error', () => {
    // The refusal the stream throws is the one Will reads: set just before that throw, and only there.
    expect(chat).toMatch(/stopWords = budget\.localRefusal;\s*throw new Error\(`frontier failed: \$\{String\(err\)\}\. \$\{budget\.localRefusal\}`\);/);
    expect(chat.match(/stopWords = /g)).toHaveLength(1);
    expect(chat).toContain("res.write(`data: ${JSON.stringify({ type: 'error', error: String(err), ...(stopWords ? { message: stopWords } : {}) })}\\n\\n`);");
  });

  it('the Watcher starts only while FLINT_WATCHER is not off (P2.5)', () => {
    expect(src).toContain('if (watcherEnabled()) new Watcher(notes, buildChecks(tools, knowledge)).start();');
    expect(src.match(/new Watcher\(/g)).toHaveLength(1);
  });

  it('memory extraction is chosen by FLINT_MEMORY_BRAIN: on the local model it waits for chat, on the frontier it is spend-gated', () => {
    const block = between('const memoryPlan = chooseMemoryBrain(', 'const servers = registry?.connectedServers()');
    // It is told the local model as main() settled it (OLLAMA_MODEL, or what Ollama had, at its loaded window).
    expect(block).toContain('const memoryPlan = chooseMemoryBrain(localEnv, {');
    expect(src).toContain('const localEnv = { ...process.env, ...localBrain.env };');
    expect(src.match(/new MemoryExtractor\(/g)).toHaveLength(1);
    expect(block).toContain('new MemoryExtractor(memory, knowledge, memoryPlan.brain,');
    expect(block).toContain("memoryPlan.kind === 'local'\n        ? { chatActive }\n        : { gate: () => (extractVendor ? spend.backgroundBlocked(extractVendor) : undefined) }");
    // The chat signal is the same ChatLoad /chat counts turns with, built before it.
    expect(src.indexOf('const chatLoad = new ChatLoad()')).toBeLessThan(src.indexOf('const chatActive = liveChat(chatLoad)'));
    expect(src.match(/new ChatLoad\(/g)).toHaveLength(1);
  });

  // ---- Flint stops waiting on Claude, and never quietly falls back to it ----

  it('the local brain is an Ollama model whatever keys are set: index.ts never builds an Anthropic client itself', () => {
    expect(src).not.toMatch(/AnthropicProvider|FLINT_MODEL\b/);
    expect(src).toContain('const local = await chooseLocalBrain(process.env, {');
    expect(src).toContain('return { provider: new OllamaProvider(local.options), model: local.model, local };');
    expect(src).toContain('const { provider, model, local: localBrain } = await buildProvider();');
    // The legacy frontier is built by ./brains, with the client that fails fast.
    expect(src).toContain('const frontierCfg = buildFrontierProvider(process.env,');
  });

  it('the breaker sees every provider request: its observer is on the one observer every Flint client shares', () => {
    expect(src).toContain('const observer = combineObservers(actionLog, spendObserver(ledger), breaker.observer());');
    expect(src.match(/new FrontierBreaker\(/g)).toHaveLength(1);
    // Every Flint client main() builds is given that observer.
    const clients = src.match(/new Flint\(\{[^}]*\}\)/g)!;
    expect(clients.length).toBeGreaterThanOrEqual(3);
    for (const c of clients) expect(c, c).toMatch(/\bobserver\b/);
  });

  it('both routes ask the breaker before any call, try only the brains it left, and skip one paused mid-turn', () => {
    for (const [name, route] of [['generate', generate], ['chat', chat]] as const) {
      expect(route, name).toMatch(/const gate = gateTurn\(\{ brain: budget\.brain, chain: plan\?\.chain, canLocal: [^,]+, breaker: ctx\.breaker \}\);/);
      expect(route, name).toContain('let brain = gate.brain;');
      expect(route, name).toContain('let paused = gate.paused;');
      expect(route.indexOf('gateTurn('), name).toBeGreaterThan(route.indexOf('budgetTurn('));
      expect(route, name).toContain('gate.attempt(');
      // The spend plan's chain is only ever tried through the gate.
      expect(route, name).not.toMatch(/(answerWithFallback|runWithFallback)\(\s*plan\.chain/);
      // The [route] line and the response say what was left out, as a code.
      expect(route, name).toContain('...(paused ? { paused } : {}),');
      expect(route, name).toContain('frontierPaused: paused');
    }
    expect(generate).toMatch(/answerWithFallback\(\s*gate\.chain,\s*gate\.attempt\(/);
    expect(chat).toMatch(/const chain = gate\.chain;\s*const won = await runWithFallback\(\s*chain,\s*gate\.attempt\(/);
  });

  it('a turn the local model may not answer (an image or PDF, or a spent paid local brain) is not gated', () => {
    expect(generate).toContain('canLocal: route.localFallback && !budget.localRefusal && !evalMode');
    expect(chat).toContain('const toLocal = route.localFallback && !budget.localRefusal;');
    expect(chat).toContain('canLocal: toLocal');
  });

  it('/chat: an error from the last frontier tier goes to the local model when it may answer, as /generate\'s does', () => {
    expect(chat).toContain("if ((recoverable || (tried !== undefined && toLocal)) && ev.type === 'error' && answer.length === 0 && !acted && providerFailure(ev.error) && !ac.signal.aborted) throw new FlintError(ev.error);");
    expect(chat).toContain('if (answer.length === 0 && toLocal && mayAskAnother(err, { acted, signal: ac.signal })) {');
    // The console is told the local model is answering before its text streams.
    expect(chat).toMatch(/brain = 'local';\s*lastTried = ctx\.model;\s*res\.write\(`data: \$\{JSON\.stringify\(\{ type: 'meta', brain,/);
  });

  // test/fallback-after-tools.test.ts runs the rule; this checks index.ts applies it at every hand-off.
  it('a turn that has called a tool is never handed to another brain, on either route', () => {
    // /chat: the pump notes the tool_call, stops throwing errors on from there, and both hand-offs ask.
    expect(chat).toContain("if (ev.type === 'tool_call') acted = true;");
    expect(chat).toContain('{ signal: ac.signal, acted: () => acted, onFallback: logFallback },');
    expect(chat.match(/mayAskAnother\(err, \{ acted, signal: ac\.signal \}\)/g)).toHaveLength(2);
    // /generate: the turn's own action-log entries (TurnLog), not a concurrent turn's.
    expect(generate).toContain('{ signal: abort.signal, acted: () => turn.acted, onFallback: logFallback },');
    expect(generate).toContain('if (!route.localFallback || !mayAskAnother(err, { acted: turn.acted })) {');
    expect(generate.indexOf('!mayAskAnother(err, { acted: turn.acted })')).toBeLessThan(generate.indexOf("logToLocal('frontier failed', err);"));
  });

  it('the breaker\'s check is one token from the cheapest brain on that provider, tried once and metered', () => {
    const block = between('checkFrontier = async (p, signal, m) => {', 'console.error(`[brain] frontier escalation ENABLED');
    // ...or from the one model that was paused, when it is a model's own pause. A provider-wide
    // check never asks a brain that has a pause of its own.
    expect(block).toContain('const b = brains.cheapestOn(p, m, (brain) => !breaker.state(p, brain.model).open);');
    expect(block).toContain("await f.generate({ prompt: 'ping' }, { maxTokens: 1, signal, context: spendContext('chat'), retryPolicy: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 } });");
  });

  it('Will is told once a day, in the console only, when a provider is paused for something only he can fix', () => {
    const block = between('const breaker = new FrontierBreaker({', 'const observer = combineObservers(');
    expect(block).toContain('const note = breakerNote(e);');
    expect(block).toContain("if (note) notes.push(note.title, note.body, 'brain', `breaker:${e.provider}:${e.model ?? ''}:${e.reason}:${ledger.period().day}`, { channels: ['inapp'] });");
  });

  it('/health shows what the breaker has paused, as codes', () => {
    const health = between("url === '/health'", '// Auth for everything else');
    expect(health).toContain('frontierPaused: ctx.breaker.snapshot(),');
  });

  it('the prompt revision is in /health, on both routes\' [route] lines, and in an eval response', () => {
    const health = between("url === '/health'", '// Auth for everything else');
    expect(health).toContain('promptRevisions: { local: promptRevision(ctx.persona), ...(ctx.frontier ? { frontier: promptRevision(ctx.frontier.persona) } : {}) },');
    for (const [name, route] of [['generate', generate], ['chat', chat]] as const) {
      expect(route, name).toContain('...(lastPersona ? { promptRev: promptRevision(lastPersona) } : {}),');
    }
    // The persona named is the one each brain was really asked with.
    expect(generate).toMatch(/turn\.run\(\(\) => \{\s*lastPersona = p;/);
    expect(chat).toMatch(/const pump = async \(persona: Persona,[^)]*\) => \{\s*lastPersona = persona;/);
    expect(generate.match(/promptRev: promptRevision\(lastPersona\)/g)).toHaveLength(2); // the log line, and the eval response
  });

  it('/health says where the local model came from, and a guessed one gets one console note a day', () => {
    const health = between("url === '/health'", '// Auth for everything else');
    expect(health).toContain('localModelFrom: ctx.localFrom,');
    expect(src).toContain('localFrom: localBrain.from,');
    const note = between("if (localBrain.from === 'default') {", 'const runtimeUrl =');
    expect(note).toContain('const note = localDefaultNote(model);');
    expect(note).toContain("notes.push(note.title, note.body, 'brain', `local-default:${new Date().toISOString().slice(0, 10)}`, { channels: ['inapp'] });");
  });

  it('research planning waits while the breaker has its provider paused', () => {
    const block = between('complete: pausable(', 'calculateTool(),');
    expect(block).toContain('const paused = plannerProvider ? breaker.paused(plannerProvider) : undefined;');
    expect(src).toContain('plannerProvider = planner.provider.name;');
  });

  // test/local-turn.test.ts runs it; this checks index.ts marks every local answer and asks the planner's check.
  it('the local model\'s turn is marked wherever it answers, and the research planner stays off an outside AI there', () => {
    expect(generate.match(/await asLocalTurn\(\(\) => answered\.ask\(local\.persona\)\)/g)).toHaveLength(2);
    expect(generate.match(/answered\.ask\(local\.persona\)/g)).toHaveLength(2);
    const block = between('complete: pausable(', 'calculateTool(),');
    // The budget check is the one an eval replay is exempt from; the local turn and the breaker are for every turn.
    expect(block).toMatch(/\(\) => \(plannerVendor \? spend\.backgroundBlocked\(plannerVendor\) : undefined\),\s*\/\/ Whatever the turn, an eval replay included\./);
    expect(block).toContain("if (plannerVendor && isLocalTurn()) return 'the local model is answering this turn, so its question stays here';");
  });

  it('an eval replay is not rerouted by the breaker; a local answer it gets during a pause is marked', () => {
    expect(generate).toContain('canLocal: route.localFallback && !budget.localRefusal && !evalMode');
    expect(generate).toContain('const evalPaused = () => (evalMode && plan ? pausedCode(gateChain(plan.chain, ctx.breaker).paused) : undefined);');
    expect(generate).toContain('paused ??= evalPaused();');
    expect(generate.indexOf('paused ??= evalPaused();')).toBeLessThan(generate.indexOf("brain = 'local';"));
  });

  it('every persona says which model answers: the local brain, an eval candidate, each frontier tier', () => {
    expect(src).toContain('engine: engineLineFor(provider, m),');
    expect(src).toContain('const persona = localPersonaFor(flint, styles.local, model);');
    expect(src).toContain('variant ?? styles.local, m),');
    expect(src).toContain('buildLocal: (v) => localPersonaFor(flint, v, model),');
    expect(src).toContain('engine: engineLineFor(fProvider, fModel),');
    expect(src.match(/new Persona\(/g)).toHaveLength(2);
    expect(src.match(/engine: engineLineFor\(/g)).toHaveLength(2);
  });

  it('background calls (/internal/complete) go to the local model, yielding to chat, and never to a frontier tier', () => {
    const block = between('const backgroundModel = localBackgroundModel(', 'startInternal({');
    expect(block).toContain('const backgroundModel = localBackgroundModel(localEnv, model,');
    expect(block).toContain('const backgroundBrain = backgroundModel && localBackgroundBrain(backgroundModel, { chatActive });');
    expect(block).toContain('brain: () => backgroundBrain,');
    // Free calls are bounded by a count a day, read from the env beside the dollar caps.
    expect(block).toContain('const callCaps = readKindCallCaps(process.env,');
    expect(block).toContain('new CompleteGate({ guard: spend, kindCaps, callCaps, audit,');
    expect(block).not.toMatch(/frontier|brains\b|spendContext/);
    expect(src).not.toContain('backgroundFrontier');
  });
});
