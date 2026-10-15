/**
 * How index.ts wires the P2 pieces (it runs main() on import, so this reads
 * its source): /chat turns are counted after auth and validation, never an
 * eval /generate; "World now" reaches frontier calls only (never the local
 * fallback, never /generate); a chat.turn event ends each /chat turn and no
 * /generate turn; an eval replay's 5xx is not a route.error; memory extraction
 * waits for chat on the local model and is spend-gated only on the frontier;
 * the goals panel's proxy runs after the lanes proxy, behind the full token,
 * and the predictions panel's after it.
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
    // Every refusal the route can make (a file no model here can read, in any mode) comes before the turn is counted.
    expect(chat.indexOf("if ('error' in pre)")).toBeGreaterThan(0);
    expect(chat.indexOf("if ('error' in pre)")).toBeLessThan(chat.indexOf('ctx.chatLoad.run('));
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
    expect(src).toContain("import { GoalsChat, SPEECH_STAYS_HERE, embedderHere, keptText, recallForAnyBrain, toolsKeptHere } from './goals-chat';");
    // It reaches none of the pieces the module is made of: not the gate, not the marks, not the tool filter, not the locality rule.
    expect(src).not.toMatch(/from '\.\/(goals-now|goals-tools|ollama-locality|private-turns)'/);
    expect(src).not.toMatch(/\b(goalsForChat|GoalsNow|historyFor|staysHere|keptHere|carriedGoals|GOALS_TURN|contextOutside|withoutOutsideAi|isAiBacked|brainIsLocal|isLocalTurn|LOCAL_WIRES|onThisMachine|renderGoals|GoalsNowAnswer|windowHas)\b/);
    // Nor the pieces that keep a private turn here (./private-turns, the same module's): the mark, its test, who may read it.
    expect(src).not.toMatch(/\b(PRIVATE_TURN|wasPrivate|turnStaysHere|keptStrictly|keepsPrivate|stayMark|placedHere|setPlaceRules|LOCALITY)\b/);
    expect(src).not.toContain('v1/goals/now');
    // One GoalsChat, built from the context blocks before any brain is.
    expect(src).toContain('const goalsChat = new GoalsChat<Persona>({ memory, blocks, runtime: runtimeLink, log: (m) => console.error(m) });');
    expect(src.match(/new GoalsChat</g)).toHaveLength(1);
    expect(src.indexOf('const blocks = readContextBlocks(process.env')).toBeLessThan(src.indexOf('new GoalsChat<'));
    expect(src.indexOf('new GoalsChat<')).toBeLessThan(src.indexOf('new Flint('));
    // Every Flint client reads the conversation through it: the local brain, the standby local model, an eval
    // candidate, each frontier tier, the adopted brain. (A local model's client also sizes its prompt to its window.)
    expect(src).toContain('const historyOf = (p: ProviderAdapter, m: string) => goalsChat.history(p, m);');
    expect(src.match(/new Flint\(/g)).toHaveLength(5);
    expect(src.match(/new Flint\(\{[^}]*\bmemory: historyOf\([^)]*\), observer(, fitToWindow: true, unknownTool: notOffered)? \}\)/g)).toHaveLength(5);
    // The brains are named for it after the tiers exist, and again when the local brain is swapped: the local
    // brain, the tiers, and the standby local model when there is one (it answers while the main one loads).
    expect(src.match(/goalsChat\.name\(\{ persona, provider, model \}, brains, keptTools, standby \? \[standby\] : \[\]\);/g)).toHaveLength(2);
    expect(src.match(/goalsChat\.name\(/g)).toHaveLength(2);
    expect(src.indexOf('const brains = buildTiers<Persona>(')).toBeLessThan(src.indexOf('goalsChat.name('));
    // ...and BEFORE anything can ask for a turn: a turn has no rule to be marked by until they are named
    // (GoalsChat.forTurn refuses one; test/goals-chat.test.ts), so no request is taken before that.
    expect(src.indexOf('goalsChat.name(')).toBeLessThan(src.indexOf('const server = createServer('));
    expect(src.indexOf('const server = createServer(')).toBeLessThan(src.indexOf('server.listen('));
    expect(src.match(/createServer\(/g)).toHaveLength(1);
    expect(src).toContain('provider: inference.standby.provider,');
    expect(between('const adoptLocal = (): void => {', 'inference.onAdopt(adoptLocal);')).toMatch(/persona = nextPersona;\s*standby = nextStandby;[\s\S]*goalsChat\.name\(/);
    // The tools an ask that stays here is offered are the module's, built from the server's own search tools, memory and gate.
    expect(src).toContain('const keptTools = toolsKeptHere({ search: mcpTools, embedder, knowledge, specs: paidToolSpecs(process.env), gate: (list) => gateBuiltins(list, tierOpts) });');
    expect(src.match(/deepResearchTool\(/g)).toHaveLength(1); // the server's own, with the frontier planner
    expect(src.match(/rememberTool\(/g)).toHaveLength(1); // the server's own, saving an ordinary fact
    // The planner's check, the extractor's rules and the embedder's are the module's.
    expect(between('complete: pausable(', 'calculateTool(),')).toMatch(/const held = goalsChat\.plannerHeld\(plannerVendor !== undefined\);\s*if \(held\) return held;/);
    expect(between('const startMemory = (): void => {', '// On the local model it reads the model that was settled')).toContain('...goalsChat.extractor({ brain: extractBrain, tainted: (cid, tid) => convTaint.isTainted(cid, tid) }),');
    expect(src).toContain("const extractBrain = memoryPlan.kind === 'local' ? { provider: 'ollama', model: memoryPlan.model.model, baseURL: memoryPlan.model.baseURL } : brains && brainOf(brains.primary.provider, brains.primary.model);");
    // The embedder is "here" on its own model's listing, which is watched from boot like any local brain's.
    // ...and such a fact is handed to the embedder as a request that carries one, so the rule is read again where it is sent.
    expect(src).toContain('{ embedderHere: () => embedderHere(embedHost, inference.embedModel), kept: keptText }');
    expect(src).toContain("goalsChat.hears({ provider: 'ollama', model: inference.embedModel, baseURL: embedHost });");
    // What a turn streams is kept as its own words, for the one question /speak asks of a text (the reply and its note).
    expect(chat.match(/asked\.said\(/g)).toHaveLength(2);
    // /speak hands that question to the rule that decides which replies an outside speech service may be given
    // (../src/speech-route asks it, with the conversation, the turn and the text, before any such service is called:
    // test/speech-route.test.ts. A turn that may be spoken vouches only for its own words, test/goals-chat.test.ts.)
    const speak = between("url === '/speak'", "url === '/generate'");
    expect(speak).toContain('mustStay: (said) => ctx.goals.speechStaysHere(said),');
    expect(speak).toContain('mustStaySentence: SPEECH_STAYS_HERE,');
    expect(src.match(/speechStaysHere\(/g)).toHaveLength(1);
    // /generate has no gate: recall as any brain may have it, and a tier on this Mac asked as a local model's turn.
    expect(generate).toContain('const recalled = recallForAnyBrain(await recallContext(userContext(), asText, ctx.knowledge, { skip: !rc.recall }));');
    expect(generate.match(/recallContext\(/g)).toHaveLength(1);
    expect(generate).toContain('return ctx.goals.run(b, () => answered.ask(personas.frontier(b)));');
    // ...and, on a route that stays here, the tools that keep the answer here (what `remember` saves is marked) and
    // the mark on its entry in the training corpus.
    // (`run` twice: the cloud tiers a Hybrid turn falls through to are asked the same way as on the cloud-first path.)
    expect(generate.match(/\bctx\.goals\.[A-Za-z]+/g)).toEqual(['ctx.goals.oneShotTools', 'ctx.goals.run', 'ctx.goals.run', 'ctx.goals.corpus']);
    expect(generate).toContain('const routed = ctx.goals.oneShotTools(pre, ctx.inference.offer(scored.tools, pre));');
    // /chat: one turn from the module, and every ask of it made with what the module gave: its context, its tools, its mark.
    // The module is told the turn's route: one Will kept private, and every turn of Local mode, stays here whichever brain answers.
    expect(chat.match(/\bctx\.goals\.[A-Za-z]+/g)).toEqual(['ctx.goals.forTurn', 'ctx.goals.run', 'ctx.goals.run']);
    expect(chat).toContain('ctx.goals.forTurn(conversationId, message, route),');
    // (The sentence a private turn's model is told rides at the end of each of the three blocks: ./outside-ai.)
    expect(chat).toContain('const ctxBlock = ctx.inference.withPrivateNote(withHistoryNote(recalled.block, history), route);');
    expect(chat).toContain('const outsideCtx = ctx.inference.withPrivateNote(withHistoryNote(recalled.outside, history), route);');
    expect(chat).toContain('const liftedCtx = ctx.inference.withPrivateNote(withHistoryNote(recalled.lifted, history), route);');
    expect(chat).toContain('const asked = goals.ask(persona, { context, whole: ctxBlock, outside: outsideCtx, lifted: liftedCtx, tools: selected });');
    expect(chat).toMatch(/const events = persona\.chat\(\s*\{ conversationId, message, context: asked\.context, \.\.\.\(asked\.tools\.length \? \{ tools: \[\.\.\.asked\.tools\] \} : \{\}\), \.\.\.\(attachments\.length \? \{ attachments \} : \{\}\) \},\s*\{ signal: ac\.signal, \.\.\.asked\.mark \},\s*\);/);
    expect(chat.match(/\.chat\(/g)).toHaveLength(1); // the pump's, for the persona being asked
    // (...and, once it is answered, the mark its entry in the training corpus carries.)
    expect(chat.match(/\bgoals\.[A-Za-z]+/g)).toEqual(['ctx.goals.forTurn', 'goals.ask', 'ctx.goals.run', 'ctx.goals.run', 'goals.corpus'].map((c) => c.replace('ctx.', '')));
    // Every place /chat asks a cloud tier does it through `run`: the cloud-first chain, and the cloud step of a Hybrid turn.
    expect(chat).toContain('await ctx.goals.run(b, () => pump(b.persona, b !== chain[chain.length - 1], chain.indexOf(b) + 1));');
    // The turn's own tool list and recalled blocks go nowhere but into that ask.
    expect(chat.match(/\bselected\b/g)).toHaveLength(2);
    expect(chat.match(/\boutsideCtx\b/g)).toHaveLength(2);
    expect(chat.match(/\bliftedCtx\b/g)).toHaveLength(2);
    // The client is told, ahead of the reply, whether it stays here; and a tier on this Mac is asked as a local model's turn.
    // (When the server's own speech is made on this Mac the event says that too: the case below.)
    expect(chat).toMatch(/const here = asked\.meta\(\);\s*if \(here\) res\.write\(`data: \$\{JSON\.stringify\(speechMadeHere\(ctx\.voice\.tts\) \? \{ \.\.\.here, speechHere: true \} : here\)\}\\n\\n`\);/);
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
    // A local model (the main one or the standby, first choice or fallback) is pumped in one place, without it;
    // so is the cloud step of a hybrid turn that fell through from the local side.
    expect(chat.match(/await pump\(step\.persona, !last\);/g)).toHaveLength(1);
    expect(chat.match(/await askLocal\(/g)).toHaveLength(2);
    expect(chat).toContain('pump(b.persona, b !== chain[chain.length - 1], chain.indexOf(b) + 1));'); // no World now there
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
    // ...and a cloud window too small for the turn, which the local model is not asked after (./brains outgrewTheCloud).
    expect(chat).toContain('if (answer.length === 0 && outgrew(err)) stopWords = TOO_LONG_FOR_THE_CLOUD;');
    expect(chat.match(/stopWords = /g)).toHaveLength(2);
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

  it('the predictions proxy (P4) runs after the goals proxy, behind the bearer check and its scope, with the runtime link and nothing else', () => {
    const predictions = src.indexOf('if (await predictionsRoutes(req, res, url, { runtime: ctx.runtime, errorRef })) return;');
    const goals = src.indexOf('if (await goalsRoutes(req, res, url, { runtime: ctx.runtime, errorRef })) return;');
    expect(goals).toBeGreaterThan(0);
    expect(predictions).toBeGreaterThan(goals);
    expect(src.indexOf('if (!scopeAllows(scope, req.method')).toBeLessThan(predictions);
    expect(src.match(/predictionsRoutes\(/g)).toHaveLength(1);
    expect(src).toContain("import { predictionsRoutes } from './predictions-routes';");
    // A forecast's numbers pass through the proxy and go nowhere else in the server: index.ts reads no predictions
    // route of the runtime's itself (no chat block, no note, no check is made from one).
    expect(src).not.toContain('/v1/predictions');
    expect(src).not.toMatch(/from '\.\.\/\.\.\/runtime|predict\/view|predict\/phrasing/);
  });

  it('the tasks proxy (P5) runs after the predictions proxy, behind the bearer check and its scope, with the runtime link and nothing else', () => {
    const tasks = src.indexOf('if (await tasksRoutes(req, res, url, { runtime: ctx.runtime, errorRef })) return;');
    const predictions = src.indexOf('if (await predictionsRoutes(req, res, url, { runtime: ctx.runtime, errorRef })) return;');
    expect(predictions).toBeGreaterThan(0);
    expect(tasks).toBeGreaterThan(predictions);
    expect(src.indexOf('if (!scopeAllows(scope, req.method')).toBeLessThan(tasks);
    expect(src.match(/tasksRoutes\(/g)).toHaveLength(1);
    expect(src).toContain("import { tasksRoutes } from './tasks-routes';");
    // A task's words and its result pass through the proxy and go nowhere else in the server: index.ts reads no task or
    // asset route of the runtime's itself (no chat block, no tool, no note is made from one), and imports nothing of its code.
    expect(src).not.toMatch(/\/v1\/(tasks|assets|task-form)/);
    expect(src).not.toMatch(/tasks\/view|tasks\/service|assets\/view/);
  });

  it('memory extraction is chosen by FLINT_MEMORY_BRAIN: on the local model it waits for chat, on the frontier it is spend-gated', () => {
    const block = between('const memoryPlan = chooseMemoryBrain(', 'const servers = registry?.connectedServers()');
    // It is told the local model as main() settled it (OLLAMA_MODEL, or what Ollama had, at its loaded window).
    expect(block).toContain('const memoryPlan = chooseMemoryBrain(localEnv, {');
    expect(src).toContain('let localEnv: Record<string, string | undefined> = { ...process.env, ...localBrain.env };');
    // On the local model it starts once the model is settled: at boot when Will named it (nothing can replace
    // it), else when the first pass behind the boot is over, or when the model server answers (adoptLocal).
    expect(src).toContain("if (memoryBrainSetting(process.env, () => {}) !== 'local' || (localBrain.settled && localBrain.from === 'env')) startMemory();");
    expect(between('const adoptLocal = (): void => {', 'inference.onAdopt(adoptLocal);')).toContain('if (!memoryStarted && localBrain.settled) startMemory();');
    expect(between('inference.onAdopt(adoptLocal);', '/** One completed exchange')).toMatch(/void inference\.ready\.then\(\(\) => \{\s*if \(!memoryStarted && localBrain\.settled\) startMemory\(\);\s*\}\);/);
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
    // The same kind and the very brain the extractor was built with: on the frontier the options are empty, and on
    // the local wire the locality rule is asked about this brain, not about a setting.
    expect(made).toContain('kind: memoryPlan.kind, brain: extractBrain, candidates: new GoalCandidates({ runtime: runtimeLink }),');
    expect(made).toContain('tz: serverZone(process.env, (m) => console.error(m)),');
    expect(src.match(/candidateOptions\(/g)).toHaveLength(1);
    expect(src.match(/new MemoryExtractor\(/g)).toHaveLength(1);
    // index.ts neither reads the setting nor names the runtime's route: both live in ./goal-candidates.
    expect(src).not.toMatch(/env\.FLINT_EXTRACT_(CANDIDATES|COMMITMENTS)/);
    expect(src).not.toContain('goals/candidates');
    expect(src).toContain("import { GoalCandidates, candidateOptions, serverZone } from './goal-candidates';");
  });

  it("the local brain is a model on Will's hardware whatever keys are set: index.ts never builds a model client itself", () => {
    expect(src).not.toMatch(/AnthropicProvider|FLINT_MODEL\b/);
    // It comes from ./inference in one call (the wire, the model and the server's health: ./local-brains).
    expect(src).toContain("const inference = await buildInference({ env: process.env, modeFile: join(homedir(), '.flint', 'inference.json'), log: (m) => console.error(m) });");
    expect(src).toContain('let { provider, model } = inference.primary;');
    expect(src).toContain('let localBrain = inference.primary;');
    expect(src).not.toMatch(/new (OllamaProvider|LocalOpenAiProvider|OpenAiProvider|PerplexityProvider)\(/);
    // ./local-brains builds the two local adapters and nothing else, and names the model with chooseLocalBrain.
    const localBrains = readFileSync(join(__dirname, '..', 'src', 'local-brains.ts'), 'utf8');
    expect(localBrains).toMatch(/new OllamaProvider\(/);
    expect(localBrains).toMatch(/new LocalOpenAiProvider\(/);
    expect(localBrains).not.toMatch(/AnthropicProvider|\bOpenAiProvider\b|PerplexityProvider|ANTHROPIC_API_KEY|OPENAI_API_KEY/);
    expect(localBrains).toContain('await chooseLocalBrain(');
    // The legacy frontier is built by ./brains, with the client that fails fast.
    expect(src).toContain('const frontierCfg = buildFrontierProvider(process.env,');
  });

  // The review's case: the pick waited on Ollama (up to ~112 s) before the server listened, and the
  // installer's /health poll gave up first. The deploy must never fail because Ollama is slow.
  it('boot never waits on Ollama for long: it listens on a stand-in, and what lands behind the boot is swapped in for the next turn', () => {
    // Everything main() waits for before it listens, so a fourth has to be looked at here. The two
    // that ask Ollama are cut off by the clock: the local pick inside buildInference
    // (LOCAL_PICK_CAP_MS, test/local-model.test.ts; test/local-brains.test.ts "behind the boot"
    // and test/inference.test.ts check that it waits for nothing else: not the machine, not the
    // server's kind, not the first look at it) and the tools' vectors (BOOT_EMBED_WAIT_MS,
    // test/router.test.ts). The MCP servers are no part of Ollama.
    const boot = between('async function main(): Promise<void> {', 'server.listen(PORT, HOST');
    const waits = boot.split('\n').filter((l) => /^ {2}\S.*\bawait\b/.test(l)).map((l) => l.trim().replace(/\(.*$/, ''));
    expect(waits).toEqual([
      'const inference = await buildInference',
      'const registry = specs.length > 0 ? await McpRegistry.connect',
      'const router = await ToolRouter.build',
    ]);
    // The swap comes after listening, and replaces everything built from the local model.
    expect(src.indexOf('server.listen(PORT, HOST')).toBeLessThan(src.indexOf('const adoptLocal = (): void => {'));
    const adopt = between('const adoptLocal = (): void => {', 'inference.onAdopt(adoptLocal);');
    // The adopted brain is the facade's own: built by ./local-brains like the first (the guarded fetch, the
    // deadlines, the server's word on tools, the watcher, the monitor's slot). Never a bare client.
    // The final review's L5: it is BUILT first, into names of its own, from the new brain and nothing else...
    const built = [
      'const seen = inference.local;',
      'const next = inference.primary;',
      'const nextEnv = { ...process.env, ...next.env };',
      'const nextFlint = new Flint({ provider: next.provider, defaultModel: next.model, memory: historyOf(next.provider, next.model), observer, fitToWindow: true, unknownTool: notOffered });',
      'const nextGuide = localGuideFor(next.provider, next.model, next.settled);',
      'const nextPersona = localPersonaFor(nextFlint, nextGuide, next.model, next.provider);',
      'const nextStandby = makeStandby();',
      'const nextStyled = makeStyled({ guide: nextGuide, persona: nextPersona, flint: nextFlint, model: next.model, provider: next.provider });',
      'const nextBackground = makeBackground({ settled: next.settled, env: nextEnv, model: next.model });',
    ];
    // ...and only then assigned, all of it together: plain assignments of those names, which cannot throw.
    const assigned = [
      'localSeen = seen;',
      'localBrain = next;',
      'provider = next.provider;',
      'model = next.model;',
      'localEnv = nextEnv;',
      'flint = nextFlint;',
      'localGuide = nextGuide;',
      'persona = nextPersona;',
      'standby = nextStandby;',
      'styled = nextStyled;',
      'backgroundBrain = nextBackground;',
    ];
    const lines = adopt.split('\n').map((l) => l.trim());
    const at = (line: string): number => lines.indexOf(line);
    for (const line of [...built, ...assigned, 'noteLocalDefault(localBrain);']) expect(at(line), line).toBeGreaterThan(-1);
    // Every build comes before the first assignment, and the assignments are one unbroken run.
    for (const b of built) expect(at(b), b).toBeLessThan(at(assigned[0]!));
    expect(assigned.map(at)).toEqual(assigned.map((_, i) => at(assigned[0]!) + i));
    // Nothing that is built reads a variable the swap assigns: each is given the new brain's own parts.
    for (const b of built.slice(2)) expect(b, b).not.toMatch(/[(, ](provider|model|flint|persona|localGuide|localEnv|localBrain)[,)]/);
    expect(src).not.toMatch(/new OllamaProvider\(/);
    expect(src).not.toMatch(/keepPickingLocal\(/); // ./local-brains asks again, through its own guarded fetch
    // Something that landed while main() was still booting is not missed.
    expect(between('inference.onAdopt(adoptLocal);', '/** One completed exchange')).toContain('if (inference.local !== localSeen) adoptLocal();');
    // "The next turn": each request reads them as it arrives, inside the request handler, so a turn
    // already running keeps the persona it started with.
    const perRequest = between('const server = createServer(safeHandler((req, res) => withTurnTaint(() => {', 'const HOST = bindHost(process.env);');
    expect(perRequest).toContain('return handle(req, res, { inference, standby, standbyNotes, persona, localModels, styled, provider, model, localFrom: localBrain.from,');
    expect(src).toContain('brain: () => inference.helperBrain(backgroundBrain),');
  });

  it('the breaker sees every provider request: its observer is on the one observer every Flint client shares', () => {
    expect(src).toContain('const observer = combineObservers(actionLog, spendObserver(ledger), breaker.observer(), fitObserver(isLocalWire, noteFit, noteFitInput));');
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
    // ...nor is one with no local model there to answer it (./local-serve: the plan has no local step).
    for (const route of [generate, chat]) expect(route).toContain("const toLocal = route.localFallback && !budget.localRefusal && localPlan.steps.some((s) => s.kind === 'local');");
    expect(generate).toContain('canLocal: toLocal && !evalMode');
    expect(chat).toContain('canLocal: toLocal');
  });

  it('/chat: an error from the last frontier tier goes to the local model when it may answer, as /generate\'s does', () => {
    expect(chat).toContain("if ((recoverable || (tried !== undefined && toLocal)) && ev.type === 'error' && answer.length === 0 && !acted && providerFailure(ev.error) && !ac.signal.aborted) throw new FlintError(ev.error);");
    expect(chat).toContain('if (answer.length === 0 && toLocal && mayAskAnother(err, { acted, signal: ac.signal }) && !outgrew(err)) {');
    // The console is told a local model is answering (and when it is the standby) before its text streams.
    expect(chat).toMatch(/brain = 'local';\s*await askLocal\(\{ \.\.\.\(paused \? \{ frontierPaused: paused \} : \{\}\) \}\);/);
    const askLocal = chat.slice(chat.indexOf('const askLocal = async (meta'), chat.indexOf("if (brain === 'frontier' && plan) {"));
    expect(askLocal).toMatch(/res\.write\(`data: \$\{JSON\.stringify\(\{ type: 'meta', brain, \.\.\.meta, \.\.\.\(byStandby \? \{ standby: true \} : \{\}\), route: ctx\.inference\.routeFields\(route\) \}\)\}\\n\\n`\);\s*await pump\(step\.persona, !last\);/);
  });

  // test/fallback-after-tools.test.ts runs the rule; this checks index.ts applies it at every hand-off.
  it('a turn that has called a tool is never handed to another brain, on either route', () => {
    // /chat: the pump notes the tool_call, stops throwing errors on from there, and both hand-offs ask.
    expect(chat).toContain("if (ev.type === 'tool_call') acted = true;");
    expect(chat).toContain('{ signal: ac.signal, acted: () => acted, onFallback: logFallback },');
    expect(chat.match(/mayAskAnother\(err, \{ acted, signal: ac\.signal \}\)/g)).toHaveLength(2);
    // /generate: the turn's own action-log entries (TurnLog), not a concurrent turn's.
    expect(generate).toContain('{ signal: abort.signal, acted: () => turn.acted, onFallback: logFallback },');
    expect(generate).toContain('if (!route.localFallback || localPlan.steps.length === 0 || !mayAskAnother(err, { acted: turn.acted }) || outgrew(err)) {');
    // The local side follows the same rule (./local-serve runLocalPlan asks mayAskAnother): a step gives way to the
    // next only while nothing was shown and no tool was called.
    expect(chat).toContain('{ signal: ac.signal, progressed: () => answer.length > 0 || acted, onMove: logLocalMove, ...ctx.inference.keeping(route) },');
    expect(generate).toContain('{ signal: abort.signal, progressed: () => turn.acted, onMove: logLocalMove, ...ctx.inference.keeping(route) },');
    const serve = readFileSync(join(__dirname, '..', 'src', 'local-serve.ts'), 'utf8');
    expect(serve).toContain('if (!next || !mayAskAnother(err, { acted: opts.progressed(), signal: opts.signal })) throw err;');
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
    const note = between('const noteLocalDefault = (b: { from: ModelSource; settled: boolean }): void => {', 'const runtimeUrl =');
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
    // Every local answer, on both routes, goes through the local plan, and its runner is the ONE place that marks
    // a local model's turn: each local step runs inside asLocalTurn, and a cloud step does not.
    expect(generate.match(/out = await askLocal\(\);/g)).toHaveLength(2);
    expect(generate.match(/return answered\.ask\(step\.persona\);/g)).toHaveLength(1);
    expect(src).not.toMatch(/asLocalTurn\(/);
    const serve = readFileSync(join(__dirname, '..', 'src', 'local-serve.ts'), 'utf8');
    // ...and there a private turn's local steps are marked private, and a turn that stays here marked so
    // (./turn-taint isPrivateTurn, isStaysHereTurn): two notions, kept apart.
    expect(serve).toContain('const result = meter ? await asLocalTurn(() => meters.run(meter, () => attempt(step, last)), { private: opts.private === true, staysHere: opts.staysHere === true }) : await attempt(step, last);');
    const block = between('complete: pausable(', 'calculateTool(),');
    // The budget check is the one an eval replay is exempt from; the local turn and the breaker are for every turn.
    expect(block).toMatch(/\(\) => \(plannerVendor \? spend\.backgroundBlocked\(plannerVendor\) : undefined\),\s*\/\/ Whatever the turn, an eval replay included\./);
    // The local-turn check itself is ./goals-chat plannerHeld (run in test/local-turn.test.ts): asked first, of an outside planner.
    expect(block).toMatch(/\(\) => \{\s*const held = goalsChat\.plannerHeld\(plannerVendor !== undefined\);\s*if \(held\) return held;\s*const localMode = inference\.cloudRefused\('plan'\);[^\n]*\n\s*if \(localMode\) return localMode;\s*const paused = plannerProvider/);
  });

  it('an eval replay is not rerouted by the breaker; a local answer it gets during a pause is marked', () => {
    expect(generate).toContain('canLocal: toLocal && !evalMode');
    expect(generate).toContain('const evalPaused = () => (evalMode && plan ? pausedCode(gateChain(plan.chain, ctx.breaker).paused) : undefined);');
    expect(generate).toContain('paused ??= evalPaused();');
    expect(generate.indexOf('paused ??= evalPaused();')).toBeLessThan(generate.indexOf("brain = 'local';"));
  });

  it("the main local model's guide follows its window: decided where the brain is built, again when it changes, and what an eval is told is the default follows it", () => {
    // The guide asked for where it leaves the window room to work, the compact one in a small window (./style-variant localStyleFor).
    expect(src).toContain('const guide = localStyleFor(styles.local, window);');
    expect(src).toContain('let localGuide = localGuideFor(provider, model, localBrain.settled);');
    // L12: nothing is said of a stand-in's guide (it is never asked), so the line is not printed for each of its names.
    expect(src).toContain('if (settled && guide !== styles.local && said !== saidGuide) {');
    expect(src).toContain('let persona = localPersonaFor(flint, localGuide, model);');
    // An eval that names no variant gets the live persona, and one that names the default gets the same one: the default is the guide in use.
    expect(src).toContain('new StyledPersonas<Persona>({ ...styles, local: b.guide }, {');
    expect(src).toContain("const makeStyled = (b: { guide: StyleVariant; persona: Persona; flint: Flint; model: string; provider: ProviderAdapter } = { guide: localGuide, persona, flint, model, provider }) =>");
    // No local persona is built with the bare setting any more.
    expect(src).not.toContain('localPersonaFor(flint, styles.local, model)');
  });

  it('every persona says which model answers: the local brain, an eval candidate, each frontier tier', () => {
    // (`p` is the local brain's provider unless a brain that is not in use yet is being built: the adoption passes its own.)
    expect(src).toContain('const localPersonaFor = (f: Flint, variant: StyleVariant, m: string, p: ProviderAdapter = provider) =>');
    expect(src).toContain('engine: engineLineFor(p, m),');
    expect(src).toContain('let persona = localPersonaFor(flint, localGuide, model);');
    expect(src).toContain('variant ?? localStyleFor(styles.local, candidate.getCapabilities(m).maxContextTokens), m),');
    expect(src).toContain('buildLocal: (v) => localPersonaFor(b.flint, v, b.model, b.provider),');
    expect(src).toContain('engine: engineLineFor(fProvider, fModel),');
    expect(src.match(/new Persona\(/g)).toHaveLength(2);
    expect(src.match(/engine: engineLineFor\(/g)).toHaveLength(2);
  });

  it('background calls (/internal/complete) go to the local model, yielding to chat, and never to a frontier tier', () => {
    const block = between('const backgroundModel = localBackgroundModel(', 'startInternal({');
    expect(block).toContain('const backgroundModel = localBackgroundModel(b.env, b.model,');
    // Each request is decided again where it is sent, on a listing two seconds old at most (test/inference.test.ts helperFetch).
    expect(block).toContain("return backgroundModel && localBackgroundBrain(backgroundModel, { chatActive, fetch: inference.helperFetch('background') });");
    expect(block).toContain('let backgroundBrain = makeBackground();');
    // The model a background call asks is one Ollama's own listing says runs on it (test/inference.test.ts helperBrain).
    expect(block).toContain('brain: () => inference.helperBrain(backgroundBrain),');
    // Free calls are bounded by a count a day, read from the env beside the dollar caps.
    expect(block).toContain('const callCaps = readKindCallCaps(process.env,');
    expect(block).toContain('new CompleteGate({ guard: spend, kindCaps, callCaps, audit,');
    expect(block).not.toMatch(/frontier|brains\b|spendContext/);
    expect(src).not.toContain('backgroundFrontier');
  });

  // ---- The routing modes: local, cloud, hybrid (./mode-route, ./inference) ----

  it('both routes are routed by the mode: routeFirst before anything else, finishRoute once the tier is known, and no routeTurn left here', () => {
    expect(src).not.toMatch(/\brouteTurn\(/);
    for (const [name, route] of [['generate', generate], ['chat', chat]] as const) {
      expect(route, name).toMatch(/const pre = await ctx\.inference\.routeFirst\(\{ message(: prompt)?, localOnly, deep: body\.deep === true, evalMode(: false)?, hasFrontier: !!ctx\.frontier, needs: mediaNeeds\(attachments\), frontierCan: ctx\.frontier\?\.media \?\? \{\}, attachments(, ownLocalModel: lm\.model !== undefined|, earlier: ctx\.memory\.windowAttachments\(conversationId\))? \}\);/);
      // (The turn's files go with it: a PDF is read on this Mac before the route is decided, when that is turned on.)
      expect(route, name).toContain("if ('error' in pre) return json(res, pre.status, { error: pre.error });");
      expect(route.indexOf('const tier = classifyMessage('), name).toBeLessThan(route.indexOf('const route = ctx.inference.finishRoute(pre, { tier, toolsLikely,'));
      // The spend plan and the breaker are handed the finished route, as before.
      expect(route.indexOf('const route = ctx.inference.finishRoute('), name).toBeLessThan(route.indexOf('budgetTurn('));
      expect(route.match(/const route = /g), name).toHaveLength(1);
    }
    // /generate is an eval replay when the body says so; /chat never is.
    expect(generate).toContain('deep: body.deep === true, evalMode, hasFrontier');
    expect(chat).toContain('deep: body.deep === true, evalMode: false, hasFrontier');
    // A hybrid turn may still go to the cloud, so the "deep thread" rule counts its history as a frontier turn's.
    expect(chat).toContain('const turns = mayUseCloud(pre) && ctx.brains?.tiered ? history.sent : 0;');
    // The long-context rule is sized with the message, its text files and the history it is sent with.
    // (A PDF the local model would be handed as text is part of it too, when PDFs are read here: ./inference pdfTextChars.)
    expect(chat).toContain('promptChars: asText.length + textChars(attachments) + ctx.inference.pdfTextChars(attachments) + ctx.memory.historyChars(conversationId) });');
    expect(generate).toContain('promptChars: asText.length + textChars(attachments) + ctx.inference.pdfTextChars(attachments) });');
    // An eval replay that names its own local model is asked through a client of its own: nothing is said to be readable by it.
    expect(generate).toContain('frontierCan: ctx.frontier?.media ?? {}, attachments, ownLocalModel: lm.model !== undefined });');
    expect(chat).not.toContain('ownLocalModel');
    // /chat hands the route the files the conversation's earlier turns still carry: a PDF among them is read before
    // the route's look at the model server, so the request that follows waits for no read. (/generate has no history.)
    expect(chat).toContain('frontierCan: ctx.frontier?.media ?? {}, attachments, earlier: ctx.memory.windowAttachments(conversationId) });');
    expect(generate).not.toContain('windowAttachments');
  });

  // What a file says is outside text (a review's obedient stand-in ran web.fetch_url, web.web_search and
  // trident.gmail_search on the say-so of a PDF, and of a .txt, with no approval). Both routes mark the turn at the
  // door, before it is routed, for every kind of file and whichever brain answers.
  it('a turn that carries a file is tainted from the start, on both routes, before it is routed', () => {
    expect(src).toContain("const ATTACHMENT_TAINT = 'attachment';");
    for (const [name, route] of [['generate', generate], ['chat', chat]] as const) {
      const marked = route.indexOf('if (attachments.length > 0) markTainted(ATTACHMENT_TAINT);');
      expect(marked, name).toBeGreaterThan(-1);
      expect(marked, name).toBeGreaterThan(route.indexOf('const attachments = att.attachments;'));
      expect(marked, name).toBeLessThan(route.indexOf('ctx.inference.routeFirst('));
      expect(route.match(/markTainted\(/g), name).toHaveLength(1);
    }
    // No condition on the mode, the brain or the kind of file stands between the files and the mark.
    expect(src.match(/if \(attachments\.length > 0\) markTainted\(ATTACHMENT_TAINT\);/g)).toHaveLength(2);
  });

  // A PDF too large for every model that would be asked used to be sent on with no message at all.
  it('a PDF too large for every cloud model that would be asked is refused with the size sentence, on both routes, before any call', () => {
    for (const [name, route] of [['generate', generate], ['chat', chat]] as const) {
      const check = route.indexOf("const tooBig = budget.brain === 'frontier' && plan && !toLocal ? pdfTooBigFor(attachments, plan.chain.map((b) => b.provider.getCapabilities(b.model))) : undefined;");
      expect(check, name).toBeGreaterThan(-1);
      // The cloud's size, and why this Mac could not read it when it tried first (a Hybrid turn).
      expect(route.slice(check), name).toMatch(/^[^\n]*\n\s*if \(tooBig\) \{\n\s*\/\/ [^\n]*\n\s*const here = route\.mode === 'hybrid' \? ctx\.inference\.pdfRefusedHere\(\[tooBig\.pdf\]\) : undefined;\n\s*return json\(res, 413, \{ error: tooBigSentence\(tooBig, here && pdfUnreadClause\(here\)\) \}\);/);
      expect(check, name).toBeLessThan(route.indexOf('const gate = gateTurn('));
      expect(check, name).toBeGreaterThan(route.indexOf('const toLocal = '));
    }
  });

  it('a turn that must be local with no local model to answer it gets a 503 with a sentence, before any call and before anything streams', () => {
    for (const [name, route] of [['generate', generate], ['chat', chat]] as const) {
      expect(route, name).toMatch(/const localPlan = ctx\.inference\.planLocal\(route, \{ primary: [^;]+, standby: ctx\.standby(?:, evalOwnModel: lm\.model !== undefined)?, needs: mediaNeeds\(attachments\) \}\);\s*if \(route\.brain === 'local' && localPlan\.steps\.length === 0\) return json\(res, 503, \{ error: localPlan\.refusal \}\);/);
      expect(route.indexOf('ctx.inference.planLocal(route'), name).toBeLessThan(route.indexOf('budgetTurn('));
      // The plan is made once per turn, before anything is asked: no mid-turn swaps.
      expect(route.match(/planLocal\(/g), name).toHaveLength(1);
    }
    expect(chat.indexOf('ctx.inference.planLocal(route')).toBeLessThan(chat.indexOf("res.writeHead(200, {"));
    // /generate plans with the turn's own local persona (a style variant, an eval candidate); /chat with the live one.
    // (`needs`: a standby that cannot read the turn's picture or PDF is not planned.)
    expect(generate).toContain('ctx.inference.planLocal(route, { primary: local, standby: ctx.standby, evalOwnModel: lm.model !== undefined, needs: mediaNeeds(attachments) });');
    expect(chat).toContain('ctx.inference.planLocal(route, { primary: { persona: ctx.persona, model: ctx.model }, standby: ctx.standby, needs: mediaNeeds(attachments) });');
  });

  it('Local mode and a private turn reach no outside service: not offered, and switched off where the tool is called, whoever calls it', () => {
    expect(generate).toContain('ctx.inference.offer(scored.tools, pre)');
    expect(chat).toContain('const selected = ctx.inference.offer(scored.tools, pre);');
    // The switch is on the tools main() hands out, which deep_research calls too. It is read on every call.
    const wired = between('const wiredMcp = registry?.tools() ?? [];', 'const tools: Tool[] = [');
    expect(wired).toContain('inference.declareTools(wiredMcp);');
    // Two wrappers, the private one outermost: on a private turn a tool that does not run on this Mac refuses before
    // the meter is asked anything, whoever calls it; the meter then keeps Local mode off every paid service.
    // The private rule is one object, read by the tools' own refusal and by the answer for a tool that was not offered.
    expect(src).toContain('const privately = { isPrivate: isPrivateTurn, allowedRemote: () => inference.allowedRemote(), onRefused: (name: string) => inference.outsideRefused(name, OUTSIDE_OFF_PRIVATE) };');
    expect(wired).toContain('const heldOnPrivate = <T extends Tool>(list: readonly T[]): T[] => keptHereOnPrivate(list, privately);');
    // A local model that names a tool the private turn was not offered is told why, in the rule's own sentence (run
    // in test/outside-ai.test.ts and, against the real server, test/process/behaviour.test.ts). Every local client
    // has it; the names it knows are every tool the server wired.
    expect(src).toContain('const notOffered = (call: { toolName: string }) => notOfferedOnPrivate(call.toolName, wiredNames, privately);');
    expect(src).toContain('wiredNames.push(...tools.map((t) => t.definition.name));');
    expect(src.match(/unknownTool: notOffered/g)).toHaveLength(4);
    expect(wired).toMatch(/const mcpTools = heldOnPrivate\(\s*meterPaidTools\(wiredMcp, \{\s*guard: spend,\s*specs: paidToolSpecs\(process\.env\),\s*outsideOff: \(\) => inference\.outsideOff\(\),\s*onOutsideRefused: \(name, why\) => inference\.outsideRefused\(name, why\),\s*\}\),\s*\);/);
    expect(src.indexOf('const mcpTools = heldOnPrivate(')).toBeLessThan(src.indexOf('deepResearchTool({'));
    expect(between('deepResearchTool({', 'calculateTool(),')).toContain('tools: mcpTools,');
    // The built-ins go through the same wrapper: deep_research refuses on a private turn, the ones that run here do not.
    expect(src).toContain('...heldOnPrivate(gateBuiltins([');
    // A private turn's local steps are marked, so both switches reach everything they set off; "stays here" rides
    // beside it, so a turn routed in Local mode keeps that mode's rule after the mode changes.
    for (const [name, route] of [['generate', generate], ['chat', chat]] as const) expect(route, name).toContain('onMove: logLocalMove, ...ctx.inference.keeping(route) }');
    // A private turn's model is told in one sentence that nothing outside is asked for it (the facade knows where
    // the message stays: this Mac, or this Mac or the model server Will allowed).
    expect(chat).toContain('const ctxBlock = ctx.inference.withPrivateNote(withHistoryNote(recalled.block, history), route);');
    expect(generate).toContain('const ctxBlock = ctx.inference.withPrivateNote(recalled.block, pre);');
    // The response says when a turn was private, so a client keeps the reply off any outside service of its own.
    expect(src.match(/route: ctx\.inference\.routeFields\(route\)/g)!.length).toBeGreaterThanOrEqual(5);
  });

  // The final review's H2. The server decides which reply stays here, from the turn it stored (./goals-chat
  // speechStaysHere: a private turn's, any turn's from Local mode, a goals turn's): never from the client's own word.
  // What the rule DOES is tested by running it (test/speech-route.test.ts drives ../src/speech-route with every
  // provider; test/goals-chat.test.ts drives speechStaysHere): what is checked here is that /speak hands it the
  // server's own answers and decides nothing itself.
  it('/speak hands the rule the provider, the mode and the stored turn, and decides nothing itself: no speech is made around it', () => {
    const speak = between("url === '/speak'", "url === '/generate'");
    expect(speak).toMatch(
      /const spoken = await speak\(read\.body, \{\s*tts: ctx\.voice\.tts,\s*localMode: \(\) => ctx\.inference\.cloudRefused\('tts'\),\s*mustStay: \(said\) => ctx\.goals\.speechStaysHere\(said\),\s*mustStaySentence: SPEECH_STAYS_HERE,\s*guard: ctx\.spend,\s*signal: gone\.signal,\s*\}\);/,
    );
    // A client that hangs up before its answer: the rule is handed a signal that fires then, and only then (a
    // response that ended is not a hang-up). What a provider does with it is the seam's (test/voice.test.ts).
    expect(speak).toContain('const gone = new AbortController();');
    expect(speak).toMatch(/const hungUp = \(\): void => \{\s*if \(!res\.writableEnded\) gone\.abort\(\);\s*\};\s*res\.once\('close', hungUp\);/);
    expect(speak).toContain("res.off('close', hungUp);");
    // Speech on this Mac that was stopped that way is not a failure, and nobody is there to be told. An outside
    // provider's failure is answered and logged as it always was, whoever is still listening.
    expect(speak).toContain('if (gone.signal.aborted && speechMadeHere(ctx.voice.tts)) return;');
    expect(speak).toContain('if (spoken.status !== 200) return json(res, spoken.status, spoken.body);');
    // The audio goes out as the kind the provider made (mp3 from OpenAI, as before; m4a from this Mac's own voice).
    expect(speak).toContain("res.writeHead(200, { 'Content-Type': spoken.contentType, 'Content-Length': spoken.audio.length });");
    // One call: nothing else in the route makes speech, reads the mode, or asks the client whether its reply is private.
    expect(speak.match(/await speak\(/g)).toHaveLength(1);
    expect(speak).not.toMatch(/synthesize\(|speakWithinBudget\(|ctx\.voice\.tts\.[a-z]/);
    expect(speak.match(/cloudRefused\(/g)).toHaveLength(1);
    expect(speak).not.toContain('body.private');
    // ...and nowhere in index.ts is a speech or transcription engine named or run: the seam is the only way to one.
    expect(src).not.toMatch(/api\.openai\.com\/v1\/audio|afconvert|whisper-cli|WHISPER_BIN|WHISPER_MODEL|FLINT_TTS_|execFile/);
    expect(src.match(/ctx\.voice\.(stt|tts)\b/g)).toEqual(['ctx.voice.stt', 'ctx.voice.tts', 'ctx.voice.tts', 'ctx.voice.tts']);
    expect(between("url === '/transcribe'", "url === '/speak'")).toContain('return json(res, 200, { text: (await ctx.voice.stt.transcribe(buf)).text });');
    // Nothing on this Mac can transcribe (no program, or no model): the provider's own sentence, as a 503, and no
    // reference to a failure, because nothing was run. Anything else is the failure it always was.
    expect(between("url === '/transcribe'", "url === '/speak'")).toMatch(
      /\} catch \(e\) \{\s*(\/\/[^\n]*\s*)*if \(e instanceof CannotTranscribe\) return json\(res, 503, \{ error: e\.message \}\);\s*return json\(res, 500, \{ error: 'transcription failed', ref: errorRef\('transcribe', e\) \}\);/,
    );
    // The providers are built once, at boot, from what config decided, and the boot line names them.
    expect(src).toContain('const voice = buildVoice(inference.voicePlan, { env: process.env, connectTimeoutMs: inference.cfg.local.connectTimeoutMs });');
    expect(src).toContain('console.error(voiceLine(inference.voicePlan));');
    expect(src.match(/buildVoice\(/g)).toHaveLength(1);
  });

  // The review's H1. main read WHISPER_BIN, WHISPER_MODEL, FLINT_TTS_MODEL and FLINT_TTS_VOICE into constants when
  // the file loaded, which is BEFORE main() reads ~/.flint/secrets.env: a line for one of them in that file was
  // silently ignored. They are read by config now, from the environment as it is after the settings file was read
  // into it, so such a line applies. (What they come to is tested where it is decided: test/voice.test.ts; and
  // on a real server with the four in its settings file: test/process.)
  it('the four older voice settings are read after the saved settings are: nothing reads them when the file loads', () => {
    const main = src.slice(src.indexOf('async function main()'));
    const saved = main.indexOf('loadSecrets();');
    const planned = main.indexOf('const inference = await buildInference({ env: process.env,');
    const built = main.indexOf('const voice = buildVoice(inference.voicePlan,');
    expect(saved).toBeGreaterThan(-1);
    expect(planned).toBeGreaterThan(saved);
    expect(built).toBeGreaterThan(planned);
    // No constant of the file's own holds one of them: every one of the four is a name index.ts never writes.
    expect(src).not.toMatch(/WHISPER_BIN|WHISPER_MODEL|FLINT_TTS_MODEL|FLINT_TTS_VOICE/);
    // ...and the plan is made from what config read: ./inference hands config, and the same environment, to ./voice.
    expect(readFileSync(join(__dirname, '..', 'src', 'inference.ts'), 'utf8')).toContain('voice: planVoice(cfg, deps.env)');
    const voice = readFileSync(join(__dirname, '..', 'src', 'voice.ts'), 'utf8');
    expect(voice).not.toMatch(/env\.(WHISPER_BIN|WHISPER_MODEL|FLINT_TTS_MODEL|FLINT_TTS_VOICE)/);
    expect(voice.match(/env\.[A-Z_]+/g)).toEqual(['env.OPENAI_API_KEY', 'env.OPENAI_API_KEY']);
  });

  // A reply that stays here may be sent to /speak only when the speech is made on this Mac, and the server says
  // which is the case: the client starts from "it is not" (test/console-speech.test.ts).
  it('the meta event says when the server speaks on this Mac, and is what it always was when it does not', () => {
    expect(chat).toContain('if (here) res.write(`data: ${JSON.stringify(speechMadeHere(ctx.voice.tts) ? { ...here, speechHere: true } : here)}\\n\\n`);');
    expect(src.match(/speechHere/g)).toHaveLength(1);
  });

  it('every cloud call that is not a chat turn reads the mode where it is made: research planning, frontier memory extraction, speech', () => {
    const planner = between('complete: pausable(', 'calculateTool(),');
    expect(planner).toMatch(/const localMode = inference\.cloudRefused\('plan'\);[^\n]*\n\s*if \(localMode\) return localMode;/);
    expect(planner.indexOf("inference.cloudRefused('plan')")).toBeLessThan(planner.indexOf('breaker.paused(plannerProvider)'));
    expect(src).toContain("frontier: extractWith && frontierExtractBrain(inference.cloudOnly('extract', (input: { system: string; prompt: string }) => extractWith.generate(input, { context: spendContext('extract') }))),");
    // Speech: the mode is read inside the rule, for a provider that is an outside service (test/speech-route.test.ts).
    expect(between("url === '/speak'", "url === '/generate'")).toContain("localMode: () => ctx.inference.cloudRefused('tts'),");
  });

  it('the [route] line says which mode, which rule and which provider, on both routes; responses carry the mode and rule', () => {
    for (const [name, route] of [['generate', generate], ['chat', chat]] as const) {
      expect(route, name).toContain('...ctx.inference.routeFields(route),');
      expect(route, name).toContain('...servedBy(outcome, brain, lastTried, ctx.provider.name),');
    }
    expect(generate.match(/route: ctx\.inference\.routeFields\(route\)/g)).toHaveLength(2); // the eval answer and the normal one
    expect(chat.match(/route: ctx\.inference\.routeFields\(route\) \}\)\}/g)).toHaveLength(3); // each meta event
  });

  it('the mode routes are registered behind the bearer check, are not model tools, and a change is audited', () => {
    expect(src.indexOf('bearerScope(req.headers.authorization')).toBeLessThan(src.indexOf('await inferenceRoutes(req, res, url, {'));
    const block = between('await inferenceRoutes(req, res, url, {', 'if (req.method === \'GET\' && url.startsWith(\'/training\'))');
    expect(block).toContain('mode: ctx.inference.mode,');
    expect(block).toContain("ctx.audit.record({ actor: `will:${c.by}`, context: 'console', kind: 'action', action: 'inference.mode', decision: 'act', outcome: 'ok', inputs: { from: c.from, to: c.to, reset: c.reset } }),");
    // No tool is built from the mode store: only a route can change it.
    expect(src).not.toMatch(/modeTool|inferenceTool|mode\.set\(/);
    expect(src).toContain('mode: ctx.inference.mode.current(),'); // GET /health
  });

  // ---- The breaker's last review: F1 (a stand-in is never asked) and F7 (an adoption that throws) ----

  it('F1: while the local brain is not settled, the background gate has no local model, a local /generate says which model it named, and /health says so', () => {
    const bg = between('const makeBackground = (b: { settled: boolean; env: Record<string, string | undefined>; model: string } = { settled: localBrain.settled, env: localEnv, model }) => {', 'let backgroundBrain = makeBackground();');
    expect(bg).toMatch(/if \(!b\.settled\) return undefined;\s*const backgroundModel = localBackgroundModel\(b\.env, b\.model,/);
    // The gate answers 503 no_local_model for a brain that is undefined (test/background-complete.test.ts).
    expect(src).toContain('brain: () => inference.helperBrain(backgroundBrain),');
    // An eval replay that names its own local model is that model's turn, not the stand-in's.
    expect(generate).toContain('const localPlan = ctx.inference.planLocal(route, { primary: local, standby: ctx.standby, evalOwnModel: lm.model !== undefined, needs: mediaNeeds(attachments) });');
    // A local turn with nothing to answer it is a 503 with the plan's sentence, on both routes, before anything is asked.
    for (const [name, route] of [['generate', generate], ['chat', chat]] as const) {
      expect(route, name).toContain("if (route.brain === 'local' && localPlan.steps.length === 0) return json(res, 503, { error: localPlan.refusal });");
    }
    expect(between("url === '/health'", '// Auth for everything else')).toContain('localModelSettled: ctx.inference.primary.settled,');
    // Memory extraction on the local model never starts on a stand-in.
    expect(src).not.toMatch(/if \(!memoryStarted\) startMemory\(\);/);
  });

  it('F7: an adoption that throws is caught and logged by class, never an unhandled rejection', () => {
    const adopt = between('const adoptLocal = (): void => {', 'inference.onAdopt(adoptLocal);');
    expect(adopt).toMatch(/^const adoptLocal = \(\): void => \{\s*try \{/);
    expect(adopt).toMatch(/\} catch \(err\) \{[\s\S]*logError\('\[brain\] the local brain that was settled could not be adopted:', err\);\s*\}\s*\};\s*$/);
    // Everything it replaces is inside the try.
    expect(adopt.indexOf('try {')).toBeLessThan(adopt.indexOf('const seen = inference.local;'));
    expect(adopt.indexOf('backgroundBrain = nextBackground;')).toBeLessThan(adopt.indexOf('} catch (err) {'));
    expect(adopt.indexOf('if (!memoryStarted && localBrain.settled) startMemory();')).toBeLessThan(adopt.indexOf('} catch (err) {'));
  });

  it('a turn looks at the model server again before it is planned, when the last look is more than a moment old', () => {
    for (const [name, route] of [['generate', generate], ['chat', chat]] as const) {
      // (It is told the route: in Cloud mode it looks only for a turn the local model is to answer, and only to
      // hear where its model runs. test/inference.test.ts runs it.)
      expect(route, name).toMatch(/await ctx\.inference\.freshen\(route\);\s*const localPlan = ctx\.inference\.planLocal\(/);
      expect(route.match(/inference\.freshen\(/g), name).toHaveLength(1);
    }
    // /chat: before anything streams.
    expect(chat.indexOf('await ctx.inference.freshen(route);')).toBeLessThan(chat.indexOf("res.writeHead(200, {"));
    // A turn that stays here takes its own look WHERE it is routed, on both routes: before it is refused, before the
    // router or recall embeds a word of it, and before the plan (test/inference.test.ts N5 runs it; the process
    // test re-points a name while the server runs). Nothing routes a turn any other way.
    for (const [name, route] of [['generate', generate], ['chat', chat]] as const) {
      expect(route.match(/ctx\.inference\.routeFirst\(/g), name).toHaveLength(1);
      expect(route.indexOf('await ctx.inference.routeFirst('), name).toBeLessThan(route.indexOf('ctx.router.selectScored('));
    }
    expect(src).not.toMatch(/ctx\.inference\.preRoute\(/);
    expect(generate.indexOf('ctx.inference.routeFirst(')).toBeLessThan(generate.indexOf('recallContext('));
    expect(chat.indexOf('ctx.inference.routeFirst(')).toBeLessThan(chat.indexOf('ctx.chatLoad.run('));
  });

  it('a local model\'s prompt is sized to its real window, and what was left out is on the [route] line; a cloud brain\'s is as it was', () => {
    // Every client on a LOCAL model fits the whole prompt: the main brain (twice: at boot, and when adopted), the
    // standby and an eval candidate. The frontier's does not: its windows are large, and its requests are unchanged.
    const clients = [...src.matchAll(/new Flint\(\{[^}]*\}\)/g)].map((m) => m[0]);
    expect(clients.filter((c) => c.includes('fitToWindow: true'))).toHaveLength(4);
    expect(clients.find((c) => c.includes('provider: fProvider'))).not.toContain('fitToWindow');
    for (const [name, route] of [['generate', generate], ['chat', chat]] as const) {
      expect(route, name).toMatch(/\.\.\.routeLocal\(localRun, localPlan, route\.brain === 'frontier'\),\s*\.\.\.fitFields\(turnFit\(\)\),/);
    }
  });

  it('the helpers that always talk to Ollama (the embedder, local memory extraction, background calls) send nothing to another machine in a mode that keeps things here', () => {
    // One fetch, read on every request, for the embedder and the local memory brain.
    // (It reads the model each request names too: a cloud model under a plain name is not "here", test/inference.test.ts.)
    // (Built by the facade: it asks Ollama what runs on it when its word is more than two seconds old, reads the
    // model each request names, and decides where the request is sent: test/inference.test.ts helperFetch runs it.)
    expect(src).toContain("const helperFetch = inference.helperFetch('helper');");
    expect(src).not.toMatch(/inference\.helpersOff\(/);
    expect(between('const embedder = new OllamaEmbedder({', 'const knowledge = new KnowledgeStore(')).toContain('fetch: helperFetch,');
    expect(between('const memoryPlan = chooseMemoryBrain(localEnv, {', "if (memoryPlan.kind === 'none') {")).toContain('fetch: helperFetch,');
    // The runtime's background calls have no local model to ask then.
    expect(src).toContain('brain: () => inference.helperBrain(backgroundBrain),');
    expect(src.match(/new OllamaEmbedder\(/g)).toHaveLength(1);
  });

  // ---- Privacy covers history (./private-turns) ----

  it('every brain reads the conversation through its own view of the store, and a private turn is marked where it is stored', () => {
    // One view for every mark that keeps a turn here (./goals-chat history): this branch has no second one.
    expect(src).toContain('const historyOf = (p: ProviderAdapter, m: string) => goalsChat.history(p, m);');
    expect(src).not.toMatch(/inference\.historyFor\(/);
    // Every Flint client that can hold a conversation is built on a view: the local brain's, the standby's, an
    // eval candidate's, each frontier brain's, and the one adopted behind the boot. None is handed the bare store.
    const clients = [...src.matchAll(/new Flint\(\{[^}]*\}\)/g)].map((m) => m[0]);
    expect(clients).toHaveLength(5);
    for (const c of clients) expect(c).toMatch(/memory: historyOf\([^)]+\), observer(, fitToWindow: true, unknownTool: notOffered)? \}\)$/);
    expect(src).not.toMatch(/new Flint\(\{[^}]*\bmemory,/);
    // /chat marks the turn in its call context, which the store keeps with the turn from the moment it begins. The
    // mark is the module's (Local Only, the private rule, any turn in Local mode, Will's goals: test/private-turns.test.ts
    // runs it): /chat tells it the route and passes on what it is given.
    expect(chat).toContain('ctx.goals.forTurn(conversationId, message, route),');
    expect(chat).toContain('{ signal: ac.signal, ...asked.mark },');
    expect(chat.match(/persona\.chat\(/g)).toHaveLength(1); // every brain's ask of the turn goes through this one call
    // Memory extraction never reads a turn that stays here on a brain that is off this Mac: the module's rule, for
    // the brain the extractor runs on (the frontier's, or the local kind's at its own address).
    expect(src).toContain('...goalsChat.extractor({ brain: extractBrain, tainted: (cid, tid) => convTaint.isTainted(cid, tid) }),');
    expect(src).not.toMatch(/extractOutside/);
  });

  it('a turn that stays on this Mac is written to the training corpus with the mark, on both routes', () => {
    expect(chat).toContain("{ conversationId, brain, model: answeredBy, input: asText, output: answer, tools: toolsSince(ctx, beforeLog), ...goals.corpus() },");
    expect(generate).toContain("{ conversationId: 'generate', brain, model: answeredBy, input: asText, output: out.text, tools: toolsUsed, usage: out.usage, ...ctx.goals.corpus(route) },");
    // Those are the only two writers.
    expect(src.match(/ctx\.training\.log\(/g)).toHaveLength(2);
  });

  // ---- Hardware tiers (./hardware, @flint/core HARDWARE_TIERS) ----

  it('index.ts names no local model: the tier table does, through ./inference', () => {
    expect(src).not.toMatch(/HARDWARE_TIERS|hardwareTier\(|detectHardware\(/); // detection and the table are behind buildInference
    expect(src).toContain('let localBrain = inference.primary;');
    // /health says where the model's name came from, the hardware tier included.
    expect(src).toContain('localFrom: localBrain.from,');
    expect(src).toContain('localFrom: ModelSource;');
  });

  it('training_status says the mode and the local model\'s state too', () => {
    expect(src).toContain('serving: () => ({ local: `${provider.name}:${model}`, frontier: frontierModel, ...inference.serving() }),');
  });

  // ---- Warm-start fallback (./local-serve) ----

  it('the standby model has its own Flint client and persona on the shared store, and its own engine line', () => {
    const block = between('const makeStandby = () =>', 'const localModels =');
    // The compact guide whatever the main model's (its window is small), and a prompt sized to its window.
    expect(block).toContain('persona: localPersonaFor(new Flint({ provider: inference.standby.provider, defaultModel: inference.standby.model, memory: historyOf(inference.standby.provider, inference.standby.model), observer, fitToWindow: true, unknownTool: notOffered }), STANDBY_STYLE, inference.standby.model),');
    // Built again when the local brain changes behind the boot (the tier's standby lands with the tier).
    expect(block).toContain('let standby = makeStandby();');
    expect(src).toContain('return handle(req, res, { inference, standby, standbyNotes, persona,');
  });

  it("a hybrid turn no local model could answer falls through to the cloud tiers, worked out only when that step is reached", () => {
    for (const [name, route] of [['generate', generate], ['chat', chat]] as const) {
      expect(route, name).toContain("if (step.kind === 'cloud') {");
      expect(route, name).toContain('const cloud = ctx.inference.cloudChain({ brains: ctx.brains, tier, guard: ctx.spend, breaker: ctx.breaker, canRead: canReadMedia(mediaNeeds(attachments)) });');
      // Asked through the breaker's gate, like any cloud tier, and under the no-second-brain-after-a-tool rule.
      expect(route, name).toContain('gated(ctx.breaker,');
      expect(route.match(/cloudChain\(/g), name).toHaveLength(1);
    }
  });

  it("a standby answer says so, is tagged for the console, and stays out of the training corpus", () => {
    // /chat: once per conversation per day, and only on the standby's own answer (each step starts with the turn's own note).
    expect(chat).toMatch(/\/\/ Each step starts with the turn's own note: a standby's line never rides on another model's answer\.\n\s+note = budget\.note;/);
    expect(chat).toContain('if (byStandby) standbyLine = standbyNote(localPlan);');
    // The day's one line is used where the standby's answer ends, so a standby that failed uses up nothing.
    expect(chat).toContain("if (ev.type === 'done' && !note && standbyLine && answer.trim() && ctx.standbyNotes.take(conversationId)) note = standbyLine;");
    expect(chat).toContain('standbyLine = undefined;');
    expect(chat).toContain("...(byStandby ? { standby: true } : {}), route: ctx.inference.routeFields(route) })}");
    // /generate is one-shot: each standby answer carries the note.
    expect(generate).toContain("if (localRun.step.kind === 'local' && localRun.step.which === 'fallback') note ??= standbyNote(localPlan);");
    expect(generate).toContain('...(byStandby ? { standby: true } : {}),');
    for (const [name, route] of [['generate', generate], ['chat', chat]] as const) {
      expect(route, name).toMatch(/const byStandby = localRun\?\.step\.kind === 'local' && localRun\.step\.which === 'fallback';\s*if \(!byStandby\) \{\s*ctx\.training\.log\(/);
      expect(route.match(/ctx\.training\.log\(/g), name).toHaveLength(1);
      // The [route] line says which local model answered, the main model's state, and what the turn fell to.
      expect(route, name).toContain("...routeLocal(localRun, localPlan, route.brain === 'frontier'),");
    }
  });
});
