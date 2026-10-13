/**
 * How index.ts wires the P2 pieces (it runs main() on import, so this reads
 * its source): /chat turns are counted after auth and validation, never an
 * eval /generate; "World now" reaches frontier calls only (never the local
 * fallback, never /generate); a chat.turn event ends each /chat turn and no
 * /generate turn; an eval replay's 5xx is not a route.error; memory extraction
 * waits for chat on the local model and is spend-gated only on the frontier;
 * the goals panel's proxy runs after the lanes proxy, behind the full token.
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

  // P3 part 4: the context blocks are switched in one place (./context-blocks).
  it('the context blocks are switched in one place: World now is off unless FLINT_WORLD_NOW=1, and FLINT_CONTEXT_BLOCKS=off turns every block off', () => {
    // ./context-blocks reads the settings (test/context-blocks.test.ts has their rules); index.ts only obeys.
    expect(src).toContain('const blocks = readContextBlocks(process.env, (m) => console.error(m));');
    expect(src).toContain('const worldNow = blocks.world ? new WorldNow({ runtime: runtimeLink }) : undefined;');
    expect(src.match(/new WorldNow\(/g)).toHaveLength(1);
    expect(src).not.toMatch(/process\.env\.FLINT_(WORLD_NOW|GOALS_NOW|GOALS_TO_FRONTIER|CONTEXT_BLOCKS)/);
  });

  // The one source-text check on Will's goals in chat. What each of these calls DOES is tested by running it
  // (test/goals-*.test.ts drive ../src/goals-chat, the same module, through whole chat turns); what is left to
  // check here is that index.ts makes the calls, and decides nothing about what stays on this Mac itself.
  it('index.ts hands every decision about what stays on this Mac to ./goals-chat, and makes none itself', () => {
    expect(src).toContain("import { GoalsChat, SPEECH_STAYS_HERE, embedderHere, recallForAnyBrain, toolsKeptHere } from './goals-chat';");
    // It reaches none of the pieces the module is made of: not the gate, not the marks, not the tool filter, not the locality rule.
    expect(src).not.toMatch(/from '\.\/(goals-now|goals-tools|ollama-locality)'/);
    expect(src).not.toMatch(/\b(goalsForChat|GoalsNow|historyFor|staysHere|keptHere|carriedGoals|GOALS_TURN|contextOutside|withoutOutsideAi|isAiBacked|brainIsLocal|isLocalTurn|LOCAL_WIRES|onThisMachine|renderGoals|GoalsNowAnswer|windowHas)\b/);
    expect(src).not.toContain('v1/goals/now');
    // One GoalsChat, built from the context blocks before any brain is.
    expect(src).toContain('const goalsChat = new GoalsChat<Persona>({ memory, blocks, runtime: runtimeLink, log: (m) => console.error(m) });');
    expect(src.match(/new GoalsChat</g)).toHaveLength(1);
    expect(src.indexOf('const blocks = readContextBlocks(process.env')).toBeLessThan(src.indexOf('new GoalsChat<'));
    expect(src.indexOf('new GoalsChat<')).toBeLessThan(src.indexOf('new Flint('));
    // Every Flint client reads the conversation through it: the local brain, an eval candidate, each frontier tier, the adopted brain.
    expect(src).toContain('const historyOf = (p: ProviderAdapter, m: string) => goalsChat.history(p, m);');
    expect(src.match(/new Flint\(/g)).toHaveLength(4);
    expect(src.match(/new Flint\(\{[^}]*\bmemory: historyOf\([^)]*\), observer \}\)/g)).toHaveLength(4);
    // The brains are named for it after the tiers exist, and again when the local brain is swapped.
    expect(src.match(/goalsChat\.name\(\{ persona, provider, model \}, brains, keptTools\);/g)).toHaveLength(2);
    expect(src.indexOf('const brains = buildTiers<Persona>(')).toBeLessThan(src.indexOf('goalsChat.name('));
    expect(between('const adoptLocal = (next: LocalBrain): void => {', 'if (!localBrain.settled) keepPickingLocal(')).toMatch(/persona = localPersonaFor\(flint, styles\.local, model\);[\s\S]*goalsChat\.name\(/);
    // The tools an ask that stays here is offered are the module's, built from the server's own search tools, memory and gate.
    expect(src).toContain('const keptTools = toolsKeptHere({ search: mcpTools, embedder, knowledge, specs: paidToolSpecs(process.env), gate: (list) => gateBuiltins(list, tierOpts) });');
    expect(src.match(/deepResearchTool\(/g)).toHaveLength(1); // the server's own, with the frontier planner
    expect(src.match(/rememberTool\(/g)).toHaveLength(1); // the server's own, saving an ordinary fact
    // The planner's check, the extractor's rules and the embedder's are the module's.
    expect(between('complete: pausable(', 'calculateTool(),')).toMatch(/const held = goalsChat\.plannerHeld\(plannerVendor !== undefined\);\s*if \(held\) return held;/);
    expect(between('const startMemory = (): void => {', '// On the local model it reads the model that was settled')).toContain('...goalsChat.extractor({ brain: extractBrain, tainted: (cid, tid) => convTaint.isTainted(cid, tid) }),');
    expect(src).toContain("const extractBrain = memoryPlan.kind === 'local' ? { provider: 'ollama', model: memoryPlan.model.model, baseURL: memoryPlan.model.baseURL } : brains && brainOf(brains.primary.provider, brains.primary.model);");
    expect(src).toContain('{ embedderHere: () => embedderHere(embedHost) }');
    // /speak asks it before the outside speech service is called.
    const speak = between("url === '/speak'", "url === '/generate'");
    expect(speak).toContain("if (ctx.goals.speechStaysHere({ conversationId: body.conversationId, turnId: body.turnId })) return json(res, 409, { error: SPEECH_STAYS_HERE, fallback: 'browser' });");
    expect(speak.indexOf('ctx.goals.speechStaysHere(')).toBeLessThan(speak.indexOf('speakWithinBudget('));
    // /generate has no gate: recall as any brain may have it, and a tier on this Mac asked as a local model's turn.
    expect(generate).toContain('const recalled = recallForAnyBrain(await recallContext(userContext(), asText, ctx.knowledge, { skip: !rc.recall }));');
    expect(generate.match(/recallContext\(/g)).toHaveLength(1);
    expect(generate).toContain('return ctx.goals.run(b, () => answered.ask(personas.frontier(b)));');
    expect(generate.match(/\bctx\.goals\.[A-Za-z]+/g)).toEqual(['ctx.goals.run']);
    // /chat: one turn from the module, and every ask of it made with what the module gave: its context, its tools, its mark.
    expect(chat.match(/\bctx\.goals\.[A-Za-z]+/g)).toEqual(['ctx.goals.forTurn', 'ctx.goals.run']);
    expect(chat).toContain('ctx.goals.forTurn(conversationId, message),');
    expect(chat).toContain('const ctxBlock = withHistoryNote(recalled.block, history);');
    expect(chat).toContain('const outsideCtx = withHistoryNote(recalled.outside, history);');
    expect(chat).toContain('const asked = goals.ask(persona, { context, whole: ctxBlock, outside: outsideCtx, tools: selected });');
    expect(chat).toMatch(/const events = persona\.chat\(\s*\{ conversationId, message, context: asked\.context, \.\.\.\(asked\.tools\.length \? \{ tools: \[\.\.\.asked\.tools\] \} : \{\}\), \.\.\.\(attachments\.length \? \{ attachments \} : \{\}\) \},\s*\{ signal: ac\.signal, \.\.\.asked\.mark \},\s*\);/);
    expect(chat.match(/\.chat\(/g)).toHaveLength(1); // the pump's, for the persona being asked
    expect(chat.match(/\bgoals\.[A-Za-z]+/g)).toEqual(['ctx.goals.forTurn', 'goals.ask', 'ctx.goals.run'].map((c) => c.replace('ctx.', '')));
    // The turn's own tool list and recalled blocks go nowhere but into that ask.
    expect(chat.match(/\bselected\b/g)).toHaveLength(2);
    expect(chat.match(/\boutsideCtx\b/g)).toHaveLength(2);
    // The client is told, ahead of the reply, whether it stays here; and a tier on this Mac is asked as a local model's turn.
    expect(chat).toMatch(/const here = asked\.meta\(\);\s*if \(here\) res\.write\(`data: \$\{JSON\.stringify\(here\)\}\\n\\n`\);/);
    expect(chat).toMatch(/await ctx\.goals\.run\(b, async \(\) => \{\s*await pump\(b\.persona, [^;]*, frontierCtx\);[^\n]*\n\s*\}\);/);
    // What the [route] line and the chat.turn event report is the module's measure for the brain asked last.
    expect(chat.match(/goalsTokens = /g)).toEqual(['goalsTokens = ', 'goalsTokens = ']);
    expect(chat).toContain('goalsTokens = asked.tokens;');
    expect(chat).toContain('...(world || goalsTokens ? { ctxTokens: { ...(world ? { world: estimateTokens(world) } : {}), ...(goalsTokens ? { goals: goalsTokens } : {}) } } : {}),');
    expect(chat).toContain('...(goalsTokens ? { goalsTokens } : {}),');
    // The frontier's own context is built without any of it, as before.
    expect(chat).toContain('const frontierCtx = world ? `${ctxBlock}\\n\\n${world}` : ctxBlock;');
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

  it('the goals proxy (P3) runs after the lanes proxy, behind the bearer check and its scope, with the runtime link', () => {
    const goals = src.indexOf('if (await goalsRoutes(req, res, url, { runtime: ctx.runtime, errorRef })) return;');
    const inbox = src.indexOf('if (await inboxRoutes(req, res, url, { runtime: ctx.runtime, errorRef })) return;');
    expect(inbox).toBeGreaterThan(0);
    expect(goals).toBeGreaterThan(inbox);
    expect(src.indexOf('if (!scopeAllows(scope, req.method')).toBeLessThan(goals);
    expect(src.match(/goalsRoutes\(/g)).toHaveLength(1);
  });

  it('memory extraction is chosen by FLINT_MEMORY_BRAIN: on the local model it waits for chat, on the frontier it is spend-gated', () => {
    const block = between('const memoryPlan = chooseMemoryBrain(', 'const servers = registry?.connectedServers()');
    // It is told the local model as main() settled it (OLLAMA_MODEL, or what Ollama had, at its loaded window).
    expect(block).toContain('const memoryPlan = chooseMemoryBrain(localEnv, {');
    expect(src).toContain('let localEnv: Record<string, string | undefined> = { ...process.env, ...localBrain.env };');
    // On the local model it starts once the model is settled: at boot, or when Ollama answers (adoptLocal).
    expect(src).toContain("if (localBrain.settled || memoryBrainSetting(process.env, () => {}) !== 'local') startMemory();");
    expect(between('const adoptLocal = (next: LocalBrain): void => {', 'if (!localBrain.settled) keepPickingLocal(')).toContain('if (!memoryStarted) startMemory();');
    expect(src.match(/new MemoryExtractor\(/g)).toHaveLength(1);
    expect(block).toContain('new MemoryExtractor(memory, knowledge, memoryPlan.brain,');
    expect(block).toContain("memoryPlan.kind === 'local'\n        ? { chatActive }\n        : { gate: () => (extractVendor ? spend.backgroundBlocked(extractVendor) : undefined) }");
    // The chat signal is the same ChatLoad /chat counts turns with, built before it.
    expect(src.indexOf('const chatLoad = new ChatLoad()')).toBeLessThan(src.indexOf('const chatActive = liveChat(chatLoad)'));
    expect(src.match(/new ChatLoad\(/g)).toHaveLength(1);
  });

  // ---- Flint stops waiting on Claude, and never quietly falls back to it ----

  // P3 part 5. What these calls DO is tested by running them (test/goal-candidates.test.ts drives the same wiring over real sockets).
  it('goals and commitments from chat are switched in ./goal-candidates, for the brain the extractor really runs on, beside the rules for turns that stay here', () => {
    const made = between('new MemoryExtractor(memory, knowledge, memoryPlan.brain', '}).start();');
    expect(made).toContain('kind: memoryPlan.kind,');
    expect(made).toContain('...goalsChat.extractor({ brain: extractBrain, tainted: (cid, tid) => convTaint.isTainted(cid, tid) }),');
    expect(made).toContain('...candidateOptions(process.env, {');
    // The same kind the extractor was built with: on the frontier the options are empty, whatever the setting says.
    expect(made).toContain('kind: memoryPlan.kind, candidates: new GoalCandidates({ runtime: runtimeLink }),');
    expect(src.match(/candidateOptions\(/g)).toHaveLength(1);
    expect(src.match(/new MemoryExtractor\(/g)).toHaveLength(1);
    // index.ts neither reads the setting nor names the runtime's route: both live in ./goal-candidates.
    expect(src).not.toMatch(/process\.env\.FLINT_EXTRACT_CANDIDATES|env\.FLINT_EXTRACT_CANDIDATES/);
    expect(src).not.toContain('goals/candidates');
    expect(src).toContain("import { GoalCandidates, candidateOptions } from './goal-candidates';");
  });

  it('the local brain is an Ollama model whatever keys are set: index.ts never builds an Anthropic client itself', () => {
    expect(src).not.toMatch(/AnthropicProvider|FLINT_MODEL\b/);
    expect(src).toContain('const local = await chooseLocalBrain(process.env, {');
    expect(src).toContain('return { provider: new OllamaProvider(local.options), model: local.model, local };');
    expect(src).toContain('let { provider, model, local: localBrain } = await buildProvider();');
    // The legacy frontier is built by ./brains, with the client that fails fast.
    expect(src).toContain('const frontierCfg = buildFrontierProvider(process.env,');
  });

  // The review's case: the pick waited on Ollama (up to ~112 s) before the server listened, and the
  // installer's /health poll gave up first. The deploy must never fail because Ollama is slow.
  it('boot never waits on Ollama for long: it listens on a stand-in, and Ollama\'s answer is swapped in for the next turn', () => {
    // Everything main() waits for before it listens, so a fourth has to be looked at here. The two
    // that ask Ollama are cut off by the clock: the local pick (LOCAL_PICK_CAP_MS,
    // test/local-model.test.ts) and the tools' vectors (BOOT_EMBED_WAIT_MS, test/router.test.ts).
    // The MCP servers are no part of Ollama.
    const boot = between('async function main(): Promise<void> {', 'server.listen(PORT, HOST');
    const waits = boot.split('\n').filter((l) => /^ {2}\S.*\bawait\b/.test(l)).map((l) => l.trim().replace(/\(.*$/, ''));
    expect(waits).toEqual([
      'let { provider, model, local: localBrain } = await buildProvider',
      'const registry = specs.length > 0 ? await McpRegistry.connect',
      'const router = await ToolRouter.build',
    ]);
    // The swap comes after listening, and replaces everything built from the local model.
    expect(src.indexOf('server.listen(PORT, HOST')).toBeLessThan(src.indexOf('const adoptLocal = (next: LocalBrain): void => {'));
    const adopt = between('const adoptLocal = (next: LocalBrain): void => {', 'if (!localBrain.settled) keepPickingLocal(');
    for (const line of [
      'localBrain = next;',
      'provider = new OllamaProvider(next.options);',
      'model = next.model;',
      'localEnv = { ...process.env, ...next.env };',
      // Through historyOf, like every brain's: the adopted model reads the conversation by the same rule (./goals-chat).
      'flint = new Flint({ provider, defaultModel: model, memory: historyOf(provider, model), observer });',
      'persona = localPersonaFor(flint, styles.local, model);',
      'styled = makeStyled();',
      'backgroundBrain = makeBackground();',
      // ...and who may read what stays on this Mac is named again, for the new local persona.
      'goalsChat.name({ persona, provider, model }, brains, keptTools);',
      'noteLocalDefault(next);',
    ]) {
      expect(adopt, line).toContain(line);
    }
    expect(src).toContain('if (!localBrain.settled) keepPickingLocal(process.env, adoptLocal, { log: (m) => console.error(m) });');
    // "The next turn": each request reads them as it arrives, inside the request handler, so a turn
    // already running keeps the persona it started with.
    const perRequest = between('const server = createServer(safeHandler((req, res) => withTurnTaint(() => {', 'const HOST = bindHost(process.env);');
    expect(perRequest).toContain('return handle(req, res, { persona, localModels, styled, provider, model, localFrom: localBrain.from,');
    expect(src).toContain('brain: () => backgroundBrain,');
    expect(src).toContain('serving: () => ({ local: `${provider.name}:${model}`, frontier: frontierModel }),');
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
    const note = between('const noteLocalDefault = (b: LocalBrain): void => {', 'const runtimeUrl =');
    // Only a default that is settled: a stand-in while Ollama has not answered is no guess to report.
    expect(note).toContain("if (b.from !== 'default' || !b.settled) return;");
    expect(note).toContain('const note = localDefaultNote();');
    expect(note).toContain('noteLocalDefault(localBrain);');
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
    // The local-turn check itself is ./goals-chat plannerHeld (run in test/local-turn.test.ts): asked first, of an outside planner.
    expect(block).toMatch(/\(\) => \{\s*const held = goalsChat\.plannerHeld\(plannerVendor !== undefined\);\s*if \(held\) return held;\s*const paused = plannerProvider/);
  });

  it('an eval replay is not rerouted by the breaker; a local answer it gets during a pause is marked', () => {
    expect(generate).toContain('canLocal: route.localFallback && !budget.localRefusal && !evalMode');
    expect(generate).toContain('const evalPaused = () => (evalMode && plan ? pausedCode(gateChain(plan.chain, ctx.breaker).paused) : undefined);');
    expect(generate).toContain('paused ??= evalPaused();');
    expect(generate.indexOf('paused ??= evalPaused();')).toBeLessThan(generate.indexOf("brain = 'local';"));
  });

  it('every persona says which model answers: the local brain, an eval candidate, each frontier tier', () => {
    expect(src).toContain('engine: engineLineFor(provider, m),');
    expect(src).toContain('let persona = localPersonaFor(flint, styles.local, model);');
    expect(src).toContain('variant ?? styles.local, m),');
    expect(src).toContain('buildLocal: (v) => localPersonaFor(flint, v, model),');
    expect(src).toContain('engine: engineLineFor(fProvider, fModel),');
    expect(src.match(/new Persona\(/g)).toHaveLength(2);
    expect(src.match(/engine: engineLineFor\(/g)).toHaveLength(2);
  });

  it('background calls (/internal/complete) go to the local model, yielding to chat, and never to a frontier tier', () => {
    const block = between('const backgroundModel = localBackgroundModel(', 'startInternal({');
    expect(block).toContain('const backgroundModel = localBackgroundModel(localEnv, model,');
    expect(block).toContain('return backgroundModel && localBackgroundBrain(backgroundModel, { chatActive });');
    expect(block).toContain('let backgroundBrain = makeBackground();');
    expect(block).toContain('brain: () => backgroundBrain,');
    // Free calls are bounded by a count a day, read from the env beside the dollar caps.
    expect(block).toContain('const callCaps = readKindCallCaps(process.env,');
    expect(block).toContain('new CompleteGate({ guard: spend, kindCaps, callCaps, audit,');
    expect(block).not.toMatch(/frontier|brains\b|spendContext/);
    expect(src).not.toContain('backgroundFrontier');
  });
});
