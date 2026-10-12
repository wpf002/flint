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

  // P3 part 4: the context blocks are switched in one place (./context-blocks), and Will's goals reach a
  // prompt only through the per-ask gate in /chat's pump (./goals-now): never /generate, never a context
  // built for the frontier.
  it('the context blocks are switched in one place: World now is off unless FLINT_WORLD_NOW=1, and FLINT_CONTEXT_BLOCKS=off turns every block off', () => {
    // ./context-blocks reads the settings (test/context-blocks.test.ts has their rules); index.ts only obeys.
    expect(src).toContain('const blocks = readContextBlocks(process.env, (m) => console.error(m));');
    expect(src).toContain('const worldNow = blocks.world ? new WorldNow({ runtime: runtimeLink }) : undefined;');
    expect(src.match(/new WorldNow\(/g)).toHaveLength(1);
    expect(src).not.toMatch(/process\.env\.FLINT_(WORLD_NOW|GOALS_NOW|GOALS_TO_FRONTIER|CONTEXT_BLOCKS)/);
  });

  it('what stays on this Mac has one gate (P3), always built, with every brain /chat can ask named for it, and named again when the local brain is swapped', () => {
    const wiring = between('// What stays on this Mac in chat (./goals-now, P3)', '// One request is one turn');
    // Built whether or not the goals block is on (`on`): the turns and the facts are held to the same rules after it is turned off.
    expect(wiring).toMatch(/const makeGoals = \(\) =>\s*goalsForChat\(\{\s*on: blocks\.goals, runtime: runtimeLink, local: \{ persona, provider, model \}, tiers: brains, toFrontier: blocks\.goalsToFrontier,\s*tools: withoutOutsideAi\(\{ specs: paidSpecs, local: localBuilds \}\), localTurn: isLocalTurn, log: \(m\) => console\.error\(m\),\s*\}\);\s*GOALS = makeGoals\(\);/);
    expect(src.match(/goalsForChat\(/g)).toHaveLength(1);
    // Twice: at boot, and when Ollama's own answer is adopted (#62's adoptLocal swaps provider, model, flint and persona).
    expect(src.match(/\bGOALS = /g)).toEqual(['GOALS = ', 'GOALS = ']);
    const adopt = between('const adoptLocal = (next: LocalBrain): void => {', 'if (!localBrain.settled) keepPickingLocal(');
    expect(adopt).toMatch(/flint = new Flint\(\{ provider, defaultModel: model, memory: historyOf\(provider, model\), observer \}\);\s*persona = localPersonaFor\(flint, styles\.local, model\);[\s\S]*GOALS = makeGoals\(\);/);
    // After the tiers exist: a tier built later would be a persona the gate does not know (it would go without, never with).
    expect(src.indexOf('const brains = buildTiers<Persona>(')).toBeLessThan(src.indexOf('goalsForChat('));
    // index.ts holds no renderer, no contract and no route of its own: it cannot put a goal's words anywhere itself.
    expect(src).not.toMatch(/renderGoals|GoalsNowAnswer|v1\/goals\/now|new GoalsNow/);
  });

  it('an ask that carries what stays here is offered no tool an outside AI answers, and local builds of two: deep_research with no planner, and `remember` saving a fact that stays here', () => {
    const wiring = between('// What stays on this Mac in chat (./goals-now, P3)', '// One request is one turn');
    // The local builds: the same tools, gated like every built-in. deep_research over the tools that are left, and with no `complete` (no frontier planner).
    expect(wiring).toContain('const paidSpecs = paidToolSpecs(process.env);');
    expect(wiring).toMatch(/const localBuilds = gateBuiltins\(\[\s*deepResearchTool\(\{ tools: mcpTools\.filter\(\(t\) => !isAiBacked\(t\.definition\.name, paidSpecs\)\), embedder \}\),\s*rememberTool\(knowledge, \{ fromGoals: true \}\),\s*\], tierOpts\);/);
    expect(wiring).not.toContain('complete');
    // The server's own tools are the ones with the frontier planner and the ordinary fact: there is one of each.
    expect(src.match(/deepResearchTool\(/g)).toHaveLength(2);
    expect(src.match(/complete: pausable\(/g)).toHaveLength(1);
    expect(src.match(/rememberTool\(/g)).toEqual(['rememberTool(', 'rememberTool(']);
    expect(src).toContain('    rememberTool(knowledge),');
  });

  it('each brain reads the conversation through historyFor: the turns answered with Will’s goals never go back out to a brain that is not on this Mac', () => {
    // Decided from the same settings, read once, before any brain is built.
    expect(src.match(/readContextBlocks\(/g)).toHaveLength(1);
    expect(src.indexOf('const blocks = readContextBlocks(process.env')).toBeLessThan(src.indexOf('let flint = new Flint('));
    expect(src).toContain('const historyOf = (p: ProviderAdapter, m: string) => historyFor(memory, brainOf(p, m), blocks.goalsToFrontier);');
    // The local brain (an Ollama on another machine, or a cloud model, is not local), the one adopted later, and every frontier tier's.
    expect(src).toContain('let flint = new Flint({ provider, defaultModel: model, memory: historyOf(provider, model), observer });');
    expect(src.match(/flint = new Flint\(\{ provider, defaultModel: model, memory: historyOf\(provider, model\), observer \}\);/g)).toHaveLength(2);
    expect(src).toContain('const fFlint = new Flint({ provider: fProvider, defaultModel: fModel, memory: historyOf(fProvider, fModel), observer });');
    // No /chat brain is built on the whole store: the only other client is the eval override's, which never chats.
    expect(src.match(/new Flint\(\{[^}]*\bmemory, observer \}\)/g)).toEqual(['new Flint({ provider: candidate, defaultModel: m, memory, observer })']);
    expect(src.match(/new Flint\(/g)).toHaveLength(4);
  });

  it('memory extraction marks what it learns from a goals turn, and a brain that may not read such a turn never mines one', () => {
    const start = between('const startMemory = (): void => {', '// On the local model it reads the model that was settled');
    // The extractor's own brain, by the one rule (staysHere): the frontier's primary tier, or the local model at ITS address.
    expect(start).toMatch(/const extractHere = staysHere\(\s*memoryPlan\.kind === 'local' \? \{ provider: 'ollama', model: memoryPlan\.model\.model, baseURL: memoryPlan\.model\.baseURL \} : brains && brainOf\(brains\.primary\.provider, brains\.primary\.model\),\s*blocks\.goalsToFrontier,\s*\);/);
    expect(start).toContain('isTainted: (cid, tid) => convTaint.isTainted(cid, tid) || (!extractHere && memory.matches(cid, tid, carriedGoals)),');
    expect(start).toContain('carriedGoals: (cid, tid) => memory.matches(cid, tid, carriedGoals),');
  });

  it('what stays here reaches a prompt only through the per-ask gate in /chat’s pump: never /generate, never the frontier’s own context', () => {
    expect(generate).not.toMatch(/GOALS|goalsTokens|\bgoals\b/);
    // /generate has no gate, so it is given recall as any brain may have it, and its eval grounding is that same list.
    expect(generate).toContain('const recalled = { ...recall.outside, mode: recall.mode };');
    expect(generate.match(/\brecall\.[a-z]+/g)).toEqual(['recall.outside', 'recall.mode']);
    // Fetched once a turn, for whichever brain ends up asked...
    expect(chat.match(/GOALS\?\.forTurn\(\)/g)).toHaveLength(1);
    expect(src.match(/\bGOALS\b[?.]/g)).toHaveLength(1);
    // ...and read in exactly one place, naming the persona that is about to be asked, with what the rest of its prompt takes.
    expect(chat.match(/\bgoals\??\.[A-Za-z]+/g)).toEqual(['goals.ask', 'goals?.onThisMac']);
    expect(chat).toContain('const restChars = message.length + ctx.memory.historyChars(conversationId);');
    // The whole recalled block is the gate's to hand out: every ask is first given its outside twin.
    expect(chat).toContain('const ctxBlock = withHistoryNote(recalled.block, history);');
    expect(chat).toContain('const outsideCtx = withHistoryNote(recalled.outside, history);');
    expect(chat).toMatch(/const chatArgs = \(persona: Persona, context: string\): Parameters<Persona\['chat'\]> => \{\s*\/\/[^\n]*\n\s*const open = contextOutside\(context, ctxBlock, outsideCtx\);\s*const asked = goals\s*\? goals\.ask\(persona, \{ context: open, here: context, tools: selected, promptChars: persona\.styleGuide\.length \+ \(persona\.engine\?\.length \?\? 0\) \+ restChars \}\)\s*: \{ context: open, tools: selected, tokens: 0, mark: \{\} \};\s*goalsTokens = asked\.tokens;/);
    // What the ask is made with is all the gate's: its context, its tools, and the mark that goes with the turn.
    expect(chat).toContain("{ conversationId, message, context: asked.context, ...(asked.tools.length ? { tools: [...asked.tools] } : {}), ...(attachments.length ? { attachments } : {}) },");
    expect(chat).toContain('{ signal: ac.signal, ...asked.mark },');
    // Every ask in /chat is the pump's one persona.chat, made with those arguments, for the persona being asked.
    expect(chat.match(/\.chat\(/g)).toHaveLength(1);
    expect(chat).toMatch(/const events = persona\.chat\(\s*\.\.\.chatArgs\(persona, context\),\s*\);/);
    expect(chat.match(/chatArgs\(/g)).toHaveLength(1);
    // The turn's own tool list is read nowhere else in /chat: an ask cannot be offered tools the gate did not pass.
    expect(chat.match(/\bselected\b/g)).toHaveLength(3);
    // The frontier's context is built without them, as before.
    expect(chat).toContain('const frontierCtx = world ? `${ctxBlock}\\n\\n${world}` : ctxBlock;');
  });

  it('a model on this Mac answering is one mark: #62’s local turn, entered for the local persona and for a tier whose brain is on this Mac, and asked by the gate', () => {
    // The gate is told the mark (it gives what stays here only inside one)...
    expect(src).toContain('localTurn: isLocalTurn,');
    // ...and a tier on this Mac is asked inside it, by the fact the gate itself holds (./policy brainIsLocal, through onThisMac).
    expect(chat).toContain('const asHere = <T>(persona: Persona, ask: () => T): T => (goals?.onThisMac(persona) ? asLocalTurn(ask) : ask());');
    expect(chat).toMatch(/await asHere\(b\.persona, async \(\) => \{\s*await pump\(b\.persona, [^;]*, frontierCtx\);[^\n]*\n\s*\}\);/);
    expect(chat.match(/asHere\(/g)).toHaveLength(1);
    // The local persona's two asks are #62's own, unchanged.
    expect(chat.match(/await asLocalTurn\(\(\) => pump\(ctx\.persona\)\)/g)).toHaveLength(2);
    // index.ts decides locality nowhere itself.
    expect(src).not.toMatch(/brainIsLocal\(|\bbrainIsLocal,|LOCAL_WIRES|onThisMachine/);
  });

  it('the [route] line and the chat.turn event report the goals block’s size only when the brain asked last was given it', () => {
    expect(chat).toContain('...(world || goalsTokens ? { ctxTokens: { ...(world ? { world: estimateTokens(world) } : {}), ...(goalsTokens ? { goals: goalsTokens } : {}) } } : {}),');
    expect(chat).toContain('...(goalsTokens ? { goalsTokens } : {}),');
    // Set to 0, then by each ask: a frontier tier that went without resets what an earlier ask reported.
    expect(chat.match(/goalsTokens = /g)).toHaveLength(2);
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
      // Through historyOf, like every brain's: the adopted model reads the conversation by the same rule (./goals-now).
      'flint = new Flint({ provider, defaultModel: model, memory: historyOf(provider, model), observer });',
      'persona = localPersonaFor(flint, styles.local, model);',
      'styled = makeStyled();',
      'backgroundBrain = makeBackground();',
      // ...and who may read what stays on this Mac is named again, for the new local persona.
      'GOALS = makeGoals();',
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
