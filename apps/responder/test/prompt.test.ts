import { describe, it, expect, vi } from 'vitest';
import { VISUAL_REVIEW } from '../src/closing.js';
import { lastRuns, parseReply, pastedFile, systemPrompt, threadContext, threadPrompt, ThreadStateSchema, MAX_FILES_PER_TURN, WORKING_SET_CHARS, workingSet } from '../src/prompt.js';
import { DEFECTS_ONLY_AFTER, measuredIn, parseVerdict, reviewRequest, withPaths, withVerdict } from '../src/visual-review.js';

const wellFormed = JSON.stringify({
  content: 'Here is the schema.',
  summary: 'Drafted the schema.',
  next: 'perplexity',
  ask: 'Check the rate limits.',
  done: false,
});

describe('parseReply', () => {
  it('accepts a clean JSON reply', () => {
    const { reply, malformed } = parseReply(wellFormed);

    expect(malformed).toBe(false);
    expect(reply.next).toBe('perplexity');
    expect(reply.ask).toBe('Check the rate limits.');
    expect(reply.remember).toEqual([]);
  });

  it('unwraps a fenced reply, which models emit often enough to matter', () => {
    const { reply, malformed } = parseReply('```json\n' + wellFormed + '\n```');

    expect(malformed).toBe(false);
    expect(reply.summary).toBe('Drafted the schema.');
  });

  it('tolerates a sentence of preamble before the object', () => {
    const { reply, malformed } = parseReply(`Sure — here you go:\n${wellFormed}`);

    expect(malformed).toBe(false);
    expect(reply.content).toBe('Here is the schema.');
  });

  it('keeps unparseable output as the turn but nominates nobody', () => {
    const { reply, malformed } = parseReply('I think we should start with the schema.');

    expect(malformed).toBe(true);
    expect(reply.content).toBe('I think we should start with the schema.');
    expect(reply.next).toBeNull();
    expect(reply.done).toBe(false);
  });

  it('records something rather than nothing when the model returns empty', () => {
    const { reply, malformed } = parseReply('   ');

    expect(malformed).toBe(true);
    expect(reply.content.length).toBeGreaterThan(0);
    expect(reply.summary.length).toBeGreaterThan(0);
  });

  it('falls back when the JSON parses but is missing required fields', () => {
    const { malformed } = parseReply(JSON.stringify({ next: 'claude' }));

    expect(malformed).toBe(true);
  });

  it('caps a runaway summary rather than sending one Nexus will reject', () => {
    const { reply } = parseReply('x'.repeat(5_000));

    expect(reply.summary.length).toBeLessThanOrEqual(300);
  });
});

describe('threadPrompt', () => {
  const state = ThreadStateSchema.parse({
    threadId: 't1',
    goal: 'Design the ingest pipeline.',
    status: 'OPEN',
    turnCount: 1,
    ask: 'Pick a queue.',
    participants: [
      { slug: 'claude', label: 'Claude', good_at: 'architecture' },
      { slug: 'gpt', label: 'GPT', good_at: 'implementation' },
    ],
    turns: [{ seq: 0, by: 'claude', content: 'We need a queue.', asked: 'Pick a queue.' }],
  });

  it('shows the other participants and what they are good at', () => {
    const context = threadContext(state, 'claude');

    expect(context).toContain('gpt (GPT): implementation');
  });

  it('leaves the speaker out of its own roster, since it cannot nominate itself', () => {
    const context = threadContext(state, 'claude');

    expect(context).not.toContain('claude (Claude)');
  });

  it('carries the goal in the stable part and the history and ask in the changing part', () => {
    expect(threadContext(state, 'gpt')).toContain('Design the ingest pipeline.');

    const prompt = threadPrompt(state, 'gpt');
    expect(prompt).toContain('[0] claude: We need a queue.');
    expect(prompt).toContain('ASKED OF YOU: Pick a queue.');
  });

  /* Listed by name, so a change to one file leaves the ones before it in the cached prefix. */
  it('lists the files in a fixed order', () => {
    const built = [
      { name: 'server.js', content: 'b', version: 1, lastBy: 'gpt' },
      { name: 'README.md', content: 'a', version: 1, lastBy: 'gpt' },
    ];
    const context = threadContext(state, 'gpt', built);
    expect(context.indexOf('--- README.md')).toBeLessThan(context.indexOf('--- server.js'));
  });

  it('says so plainly when nothing was asked', () => {
    const open = ThreadStateSchema.parse({ ...state, ask: null });

    expect(threadPrompt(open, 'gpt')).toContain('Nothing specific was asked of you');
  });
});

describe('systemPrompt', () => {
  it('names the participant and forbids self-nomination', () => {
    const prompt = systemPrompt('gpt', 'implementation');

    expect(prompt).toContain('"gpt"');
    expect(prompt).toContain('implementation');
    expect(prompt).toContain('Never nominate yourself');
  });
});

describe('replies that exceed what Nexus accepts', () => {
  /*
   * The fallback is built by hand rather than parsed, so nothing enforced the limits.
   * An over-long reply reached the append and was rejected there, losing the turn
   * outright — worse than recording a clipped one.
   */
  it('clips an over-long unstructured reply to what Nexus will take', () => {
    const { reply, malformed } = parseReply('x'.repeat(20_000));

    expect(malformed).toBe(true);
    expect(reply.content.length).toBeLessThanOrEqual(8_000);
    expect(reply.content).toMatch(/truncated/);
  });

  it('clips a well-formed reply whose content is too long, rather than dropping it', () => {
    const { reply } = parseReply(
      JSON.stringify({ content: 'y'.repeat(20_000), summary: 'long one', next: 'gpt' }),
    );

    expect(reply.content.length).toBeLessThanOrEqual(8_000);
  });

  it('says it was truncated, so a clipped turn never reads as a complete one', () => {
    const { reply } = parseReply('z'.repeat(9_000));

    expect(reply.content.endsWith('… [truncated]')).toBe(true);
  });
});

describe('replies whose content is structured rather than a string', () => {
  /*
   * A model asked for {"content": "..."} sometimes answers with content as a nested
   * object. The contribution is there and is good; rejecting it lost the whole turn
   * and recorded the raw text instead, which was strictly worse.
   */
  it('renders an object content instead of discarding the turn', () => {
    const { reply, malformed } = parseReply(
      JSON.stringify({ content: { plan: ['a', 'b'], why: 'because' }, summary: 'Drafted a plan.', next: 'claude' }),
    );

    expect(malformed).toBe(false);
    expect(reply.content).toContain('because');
    expect(reply.next).toBe('claude');
  });

  it('derives a summary when the model omits one', () => {
    const { reply, malformed } = parseReply(JSON.stringify({ content: 'First line.\nSecond line.', next: 'gpt' }));

    expect(malformed).toBe(false);
    expect(reply.summary).toBe('First line.');
  });

  it('drops a non-string nomination rather than sending Nexus something it will reject', () => {
    const { reply, malformed } = parseReply(
      JSON.stringify({ content: 'x', summary: 'y', next: { slug: 'gpt' } }),
    );

    expect(malformed).toBe(false);
    expect(reply.next).toBeNull();
  });

  it('still refuses a reply with no content at all', () => {
    const { malformed } = parseReply(JSON.stringify({ summary: 'nothing here' }));

    expect(malformed).toBe(true);
  });
});

describe('a conclusion offered to shared memory', () => {
  it('keeps a well-formed proposal', () => {
    const { reply } = parseReply(
      JSON.stringify({
        content: 'x',
        summary: 'y',
        done: true,
        canon: { key: 'queue.choice', content: 'Redis Streams', rationale: 'Replay.' },
      }),
    );

    expect(reply.canon?.key).toBe('queue.choice');
    expect(reply.canon?.rationale).toBe('Replay.');
  });

  /* Canon is the one place a half-understood write is worse than no write. */
  it('drops a proposal with no key rather than sending a broken one', () => {
    const { reply, malformed } = parseReply(
      JSON.stringify({ content: 'x', summary: 'y', done: true, canon: { content: 'no key here' } }),
    );

    expect(malformed).toBe(false);
    expect(reply.canon).toBeNull();
  });

  it('renders a structured conclusion rather than discarding it', () => {
    const { reply } = parseReply(
      JSON.stringify({
        content: 'x',
        summary: 'y',
        done: true,
        canon: { key: 'k', content: { decision: 'Redis Streams' } },
      }),
    );

    expect(reply.canon?.content).toContain('Redis Streams');
  });
});

describe("the artifact in a reply", () => {
  it("keeps a well-formed one", () => {
    const { reply } = parseReply(
      JSON.stringify({
        content: 'x',
        summary: 'y',
        artifact: { name: 'pricing.md', content: '# Pricing', note: 'Draft' },
      }),
    );

    expect(reply.artifact?.name).toBe('pricing.md');
    expect(reply.artifact?.note).toBe('Draft');
  });

  /* A half-understood artifact is worse than none: the next turn revises the wrong thing. */
  it("drops one with no name", () => {
    const { reply, malformed } = parseReply(
      JSON.stringify({ content: 'x', summary: 'y', artifact: { content: 'orphaned' } }),
    );

    expect(malformed).toBe(false);
    expect(reply.artifact).toBeNull();
  });

  it("renders a structured document rather than discarding it", () => {
    const { reply } = parseReply(
      JSON.stringify({ content: 'x', summary: 'y', artifact: { name: 'plan.json', content: { steps: ['a'] } } }),
    );

    expect(reply.artifact?.content).toContain('steps');
  });
});

/*
 * What the last turn ran used to be held in a map on whichever machine ran it. Reading it
 * off the thread is what makes a restart, a second runner and the console all see the
 * same thing.
 */
describe('lastRuns', () => {
  const state = (turns: unknown[]) =>
    ThreadStateSchema.parse({
      threadId: 't',
      goal: 'g',
      status: 'OPEN',
      turnCount: turns.length,
      participants: [],
      turns,
    });

  it('finds nothing when no turn has run anything', () => {
    expect(lastRuns(state([{ seq: 1, by: 'gpt', content: 'hi' }]))).toEqual([]);
  });

  it('takes the most recent turn that ran something', () => {
    const runs = lastRuns(
      state([
        { seq: 1, by: 'gpt', content: 'a', runs: [{ command: 'old', ok: true, output: 'x' }] },
        { seq: 2, by: 'claude', content: 'b', runs: [{ command: 'new', ok: false, output: 'y' }] },
        { seq: 3, by: 'gpt', content: 'c' },
      ]),
    );
    expect(runs).toEqual([{ command: 'new', ok: false, output: 'y' }]);
  });

  it('skips a turn that ran nothing rather than reporting none', () => {
    const runs = lastRuns(
      state([
        { seq: 1, by: 'gpt', content: 'a', runs: [{ command: 'npm test', ok: true, output: 'ok' }] },
        { seq: 2, by: 'claude', content: 'b', runs: [] },
      ]),
    );
    expect(runs).toEqual([{ command: 'npm test', ok: true, output: 'ok' }]);
  });

  it('puts what was run in front of the next speaker', () => {
    const prompt = threadPrompt(
      state([{ seq: 1, by: 'gpt', content: 'a', runs: [{ command: 'npm test', ok: false, output: '2 failing' }] }]),
      'claude',
    );
    expect(prompt).toContain('npm test');
    expect(prompt).toContain('2 failing');
  });

  /* Shown as "$ visual review", the fourth build sent it to the sandbox as a command. */
  it('shows a design review as a verdict, not as a command someone ran', () => {
    const prompt = threadPrompt(
      state([{ seq: 1, by: 'gpt', content: 'a', runs: [{ command: VISUAL_REVIEW, ok: false, output: 'Phone: the button overflows.' }] }]),
      'claude',
    );
    expect(prompt).not.toContain(`$ ${VISUAL_REVIEW}`);
    expect(prompt).toContain('not a command');
    expect(prompt).toContain('FIXES REQUESTED');
    expect(prompt).toContain('button overflows');
  });
});

/*
 * One file per turn meant a six-file app needed six turns just to exist, and the thread
 * hit its turn cap before anything was tested.
 */
describe('files in a reply', () => {
  const reply = (extra: Record<string, unknown>) => parseReply(JSON.stringify({ content: 'x', summary: 'y', ...extra }));

  it('takes several files in one turn, nested paths included', () => {
    const { reply: r } = reply({
      files: [
        { name: 'package.json', content: '{}', note: null },
        { name: 'src/index.js', content: 'export {}', note: 'entry' },
      ],
    });
    expect(r.files.map((f) => f.name)).toEqual(['package.json', 'src/index.js']);
  });

  it('folds a legacy single artifact into the list', () => {
    const { reply: r } = reply({ artifact: { name: 'README.md', content: '# App' } });
    expect(r.files.map((f) => f.name)).toEqual(['README.md']);
  });

  it('keeps the last version of a file written twice', () => {
    const { reply: r } = reply({
      files: [
        { name: 'a.js', content: 'one' },
        { name: 'a.js', content: 'two' },
      ],
    });
    expect(r.files).toHaveLength(1);
    expect(r.files[0]!.content).toBe('two');
  });

  it('drops a malformed file and keeps the rest', () => {
    const { reply: r, malformed } = reply({ files: [{ content: 'no name' }, { name: 'ok.js', content: 'fine' }] });
    expect(malformed).toBe(false);
    expect(r.files.map((f) => f.name)).toEqual(['ok.js']);
  });

  /* Past the limit the schema would reject the whole reply, losing every file. */
  it('keeps as many files as a turn may write when sent more, without losing the turn', () => {
    const files = Array.from({ length: MAX_FILES_PER_TURN + 2 }, (_, i) => ({ name: `f${i}.js`, content: 'x' }));
    const { reply: r, malformed } = reply({ files });
    expect(malformed).toBe(false);
    expect(r.files).toHaveLength(MAX_FILES_PER_TURN);
  });

  /* The first csv2md build lost its README this way, and nothing said so. */
  it('names the files it could not keep', () => {
    const files = Array.from({ length: MAX_FILES_PER_TURN + 2 }, (_, i) => ({ name: `f${i}.js`, content: 'x' }));
    expect(reply({ files }).reply.dropped).toEqual([`f${MAX_FILES_PER_TURN}.js`, `f${MAX_FILES_PER_TURN + 1}.js`]);
  });

  it('has no files when the model returns unstructured text', () => {
    expect(parseReply('just prose').reply.files).toEqual([]);
  });
});

describe('the sandbox in the system prompt', () => {
  it('is described when builds are on', () => {
    const prompt = systemPrompt('gpt-api', 'implementation', 4_000, true);
    expect(prompt).toContain('"run" executes commands');
    expect(prompt).toContain('no shell');
  });

  /* A model told it can run things when it can't would plan turns around runs that never happen. */
  it('is not mentioned when builds are off', () => {
    expect(systemPrompt('gpt-api', 'implementation', 4_000, false)).not.toContain('"run" executes commands');
  });
});

/*
 * The first real product build lost three of its first four turns here. Every reply that
 * wrote a README with a code example was cut at the fence inside its own JSON.
 */
describe('a reply whose content contains code fences', () => {
  const README = '# csv2md\n\n```bash\nnpx csv2md data.csv\n```\n\nThen:\n\n```\n| a | b |\n```\n';

  it('keeps the files, the commands and the handoff', () => {
    const raw = JSON.stringify({
      content: 'Implemented it.\n\n```js\nexport const parse = () => [];\n```',
      summary: 'built csv2md',
      next: 'claude-api',
      ask: 'Review it.',
      done: false,
      run: [['npm', 'test']],
      files: [
        { name: 'README.md', content: README, note: null },
        { name: 'src/csv.js', content: 'export const parse = () => [];', note: null },
      ],
    });
    const { reply, malformed } = parseReply(raw);

    expect(malformed).toBe(false);
    expect(reply.files.map((f) => f.name)).toEqual(['README.md', 'src/csv.js']);
    expect(reply.files[0]!.content).toBe(README);
    expect(reply.run).toEqual([['npm', 'test']]);
    expect(reply.next).toBe('claude-api');
  });

  it('still reads a reply wrapped in a json fence', () => {
    const raw = '```json\n' + JSON.stringify({ content: 'x', summary: 'y', next: null }) + '\n```';
    expect(parseReply(raw).malformed).toBe(false);
  });

  it('still reads a reply with prose before it', () => {
    const raw = 'Here is my turn:\n' + JSON.stringify({ content: 'x', summary: 'y', next: null });
    expect(parseReply(raw).malformed).toBe(false);
  });

  it('still reads a fenced reply whose own content has a fence', () => {
    const inner = JSON.stringify({ content: 'see:\n```bash\nnpm test\n```', summary: 'y', next: null });
    expect(parseReply('```json\n' + inner + '\n```').malformed).toBe(false);
  });
});

/*
 * Perplexity's sources arrive after the reply object. Parsing kept only the object, so
 * every source it ever cited was dropped before the thread saw it.
 */
describe('sources after the reply', () => {
  it('keeps them on the turn', () => {
    const raw = `${JSON.stringify({ content: 'The daily param is precipitation_probability_max.', summary: 's', next: null })}\n\nSources:\n[1] Open-Meteo Docs — https://open-meteo.com/en/docs`;
    const { reply, malformed } = parseReply(raw);
    expect(malformed).toBe(false);
    expect(reply.content).toContain('precipitation_probability_max');
    expect(reply.content).toContain('https://open-meteo.com/en/docs');
  });

  it('adds nothing when there are no sources', () => {
    const { reply } = parseReply(JSON.stringify({ content: 'Plain.', summary: 's', next: null }));
    expect(reply.content).toBe('Plain.');
  });

  it('ignores other trailing text', () => {
    const { reply } = parseReply(`${JSON.stringify({ content: 'Plain.', summary: 's', next: null })}\nthanks!`);
    expect(reply.content).toBe('Plain.');
  });
});

describe('parseVerdict', () => {
  it('reads a pass', () => {
    expect(parseVerdict('VERDICT: PASS\n- Optional: friendlier dates.')).toEqual({ pass: true, notes: '- Optional: friendlier dates.' });
  });

  it('reads a fix with its notes', () => {
    const v = parseVerdict('VERDICT: FIX\n- Phone: the button overflows the right edge.');
    expect(v.pass).toBe(false);
    expect(v.notes).toContain('button overflows');
  });

  /* A page nobody would sign off on doesn't ship. */
  it('fails a review with no verdict', () => {
    expect(parseVerdict('Looks nice overall!').pass).toBe(false);
  });
});

/* The fourth build's reviewer once came back empty, and that was recorded as a request for fixes. */
describe('withVerdict', () => {
  const replies = (...texts: string[]) => {
    const queue = [...texts];
    return vi.fn(async () => ({ text: queue.shift() ?? '', tokensOut: 10, stop: 'end_turn' }));
  };

  it('returns the first verdict without asking again', async () => {
    const ask = replies('VERDICT: PASS\n- Optional: a loading state.');
    const review = await withVerdict(ask);
    expect(review).toMatchObject({ pass: true, tokensOut: 10 });
    expect(review.unavailable).toBeUndefined();
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('asks again when a reply has no verdict, and counts both', async () => {
    const ask = replies('', 'VERDICT: FIX\n- Desktop: the form is stranded at the top.');
    const review = await withVerdict(ask);
    expect(review).toMatchObject({ pass: false, tokensOut: 20 });
    expect(review.notes).toContain('stranded');
    expect(review.unavailable).toBeUndefined();
  });

  it('says there was no review when no attempt gave a verdict', async () => {
    const review = await withVerdict(replies('', ''));
    expect(review.unavailable).toBe(true);
    expect(review.notes).toContain('end_turn');
  });
});

/*
 * Told to "reply with a JSON object" while its provider forced a tool call, Claude (API)
 * did both at once in the fifth product build: fields as text inside the call's content.
 */
describe('how the reply is asked for', () => {
  it('asks a tool-call participant to call take_turn, not to write JSON', () => {
    const prompt = systemPrompt('claude-api', 'design', 4_000, true, 'tool');
    expect(prompt).toContain('take_turn');
    expect(prompt).not.toContain('Reply with a single JSON object');
  });

  it('asks everyone else for a JSON object', () => {
    expect(systemPrompt('gpt-api', 'implementation', 4_000, true, 'schema')).toContain('Reply with a single JSON object');
    expect(systemPrompt('llama', 'implementation')).toContain('Reply with a single JSON object');
  });
});

/* The fifth build rewrote the page inside "content", where it was cut off and never written. */
describe('pastedFile', () => {
  it('spots a long fenced block', () => {
    const lines = Array.from({ length: 45 }, (_, i) => `const a${i} = ${i};`).join('\n');
    expect(pastedFile(`Here is the file:\n\`\`\`js\n${lines}\n\`\`\``)).toBe(true);
  });

  it('spots a page even when the fence was cut off', () => {
    expect(pastedFile('Applying directly:\n```html\n<!doctype html>\n<html><body>… [truncated]')).toBe(true);
  });

  it('leaves a short snippet alone', () => {
    expect(pastedFile('Change this one rule:\n```css\n.hint { flex-wrap: wrap; }\n```')).toBe(false);
  });
});

describe('withVerdict, when the reply was made of something other than text', () => {
  it('says what the blocks were', async () => {
    const review = await withVerdict(async () => ({ text: '', tokensOut: 10, stop: 'max_tokens', blocks: ['thinking'] }));
    expect(review.unavailable).toBe(true);
    expect(review.notes).toContain('blocks: thinking');
  });
});

/* A roster that hides a participant's state gets turns handed to someone who cannot take them. */
describe('threadPrompt, when a participant cannot answer', () => {
  const state = ThreadStateSchema.parse({
    threadId: 't1',
    goal: 'Build it.',
    status: 'OPEN',
    turnCount: 1,
    participants: [
      { slug: 'claude', label: 'Claude', good_at: 'design' },
      { slug: 'gpt', label: 'GPT', good_at: 'implementation' },
    ],
    turns: [],
  });

  it('says so in the roster', () => {
    const context = threadContext(state, 'claude', [], ['gpt']);
    expect(context).toContain('gpt (GPT): implementation (UNABLE TO ANSWER RIGHT NOW');
  });

  it('says nothing when everyone can', () => {
    expect(threadContext(state, 'claude')).not.toContain('UNABLE TO ANSWER');
  });
});

describe('edits in a reply', () => {
  it('keeps well-formed edits and drops malformed ones', () => {
    const { reply, malformed } = parseReply(
      JSON.stringify({
        content: 'x',
        summary: 'y',
        edits: [{ name: 'a.js', find: 'old', replace: 'new', note: null }, { name: 'b.js', replace: 'x' }, 'nope'],
      }),
    );
    expect(malformed).toBe(false);
    expect(reply.edits).toEqual([{ name: 'a.js', find: 'old', replace: 'new' }]);
  });

  it('defaults to none', () => {
    expect(parseReply(wellFormed).reply.edits).toEqual([]);
  });
});

/* Five aqi turns asked for the tests plus four screenshots, and each whole reply was thrown out with its edits. */
describe('commands over the limit', () => {
  const withRuns = (n: number) =>
    JSON.stringify({
      ...JSON.parse(wellFormed),
      edits: [{ name: 'a.js', find: 'old', replace: 'new' }],
      run: [['npm', 'test'], ...Array.from({ length: n - 1 }, (_, i) => ['screenshot', 'server.js', `/?s=${i}`])],
    });

  it('keeps the reply and its edits, and runs the first six', () => {
    const { reply, malformed } = parseReply(withRuns(7));
    expect(malformed).toBe(false);
    expect(reply.edits).toHaveLength(1);
    expect(reply.run).toHaveLength(6);
    expect(reply.droppedRuns).toEqual(['screenshot server.js /?s=5']);
  });

  it('drops nothing at the limit', () => {
    expect(parseReply(withRuns(6)).reply.droppedRuns).toEqual([]);
  });
});

/* Judged from scratch each round, the reviewer found something new every time. */
describe('reviewRequest', () => {
  const screens = [{ name: 'phone', width: 375, height: 812, base64: 'iVBOR' }];
  const text = (prior?: { fixRounds: number; notes: string | null }) =>
    reviewRequest(screens, 'a forecast page', prior)
      .flatMap((b) => (b.type === 'text' ? [b.text] : []))
      .join('\n');

  it('asks from scratch before any review', () => {
    const t = text();
    expect(t).toContain('a forecast page');
    expect(t).not.toContain('previous review');
    expect(t).not.toContain('block only on defects');
  });

  it('shows the reviewer what it asked for last time', () => {
    expect(text({ fixRounds: 1, notes: 'Phone: the button overflows.' })).toContain('Phone: the button overflows.');
  });

  it('limits the third round to defects', () => {
    expect(text({ fixRounds: 1, notes: 'x' })).not.toContain('block only on defects');
    expect(text({ fixRounds: DEFECTS_ONLY_AFTER, notes: 'x' })).toContain('block only on defects');
  });

  it('names the address a capture was taken at', () => {
    const labeled = reviewRequest([{ ...screens[0]!, path: '/?city=Denver' }], 'a page')
      .flatMap((b) => (b.type === 'text' ? [b.text] : []))
      .join('\n');
    expect(labeled).toContain('phone view of /?city=Denver, 375px wide');
  });
});

/* The fifth aqi run sent "npm test; screenshot server.js /" for several turns; it ran a binary called "test;". */
describe('commands joined the way a shell would take them', () => {
  const runs = (reply: unknown) => parseReply(JSON.stringify({ ...JSON.parse(wellFormed), run: reply })).reply.run;

  it('splits a string of commands into separate commands', () => {
    expect(runs(['npm test; screenshot server.js /'])).toEqual([
      ['npm', 'test'],
      ['screenshot', 'server.js', '/'],
    ]);
  });

  it('splits an argv array that carries the join inside it', () => {
    expect(runs([['npm', 'test', '&&', 'node', 'bin/aqi.js', 'Denver']])).toEqual([
      ['npm', 'test'],
      ['node', 'bin/aqi.js', 'Denver'],
    ]);
  });

  it('leaves a plain command alone', () => {
    expect(runs([['npm', 'test'], 'node --test'])).toEqual([
      ['npm', 'test'],
      ['node', '--test'],
    ]);
  });
});

/* The screenshots showed a 17px text field and a 2:1 button, and three reviews passed them. */
describe('measuredIn', () => {
  const outputs = [
    'Rendered /: desktop 1280x800, mobile 375x812.\nMeasured on the phone view (dark mode):\n- input#city is 17px tall; controls on a phone need to be at least 44px.\n- button#submit "Check" text is 2.1:1 against its background; it needs 4.5:1.',
    'Rendered /?city=Denver: desktop 1280x800, mobile 375x812.',
    '# tests 15',
  ];

  it('reads each measured problem with the address it was measured on', () => {
    expect(measuredIn(outputs)).toEqual([
      'On / (phone): input#city is 17px tall; controls on a phone need to be at least 44px.',
      'On / (phone): button#submit "Check" text is 2.1:1 against its background; it needs 4.5:1.',
    ]);
  });

  /* The tenth build's Convert button ran 41px out of its card at desktop width; only the phone was measured. */
  it('reads the desktop view as well as the phone view', () => {
    const both =
      'Rendered /: desktop 1280x800, mobile 375x812.\nMeasured on the desktop view (light mode):\n- button#submit "Convert" sticks out of section#form-card by 41px at 1280px wide.\nMeasured on the phone view (dark mode):\n- input#amount is 30px tall; controls on a phone need to be at least 44px.';
    expect(measuredIn([both])).toEqual([
      'On / (desktop): button#submit "Convert" sticks out of section#form-card by 41px at 1280px wide.',
      'On / (phone): input#amount is 30px tall; controls on a phone need to be at least 44px.',
    ]);
  });

  it('hands them to the reviewer as defects', () => {
    const text = reviewRequest([], 'a page', undefined, measuredIn(outputs))
      .flatMap((b) => (b.type === 'text' ? [b.text] : []))
      .join('\n');
    expect(text).toContain('These are facts, each one is a defect');
    expect(text).toContain('- On / (phone): input#city is 17px tall');
  });
});

/* Four captures of four addresses reached the reviewer under the same two names, and an empty page passed for all of them. */
describe('withPaths', () => {
  const shot = (name: string) => ({ name, width: name === 'desktop' ? 1280 : 375, height: 800, base64: 'iVBOR' });

  it('labels each shot with the address its command rendered, in order', () => {
    const images = [shot('desktop'), shot('mobile'), shot('desktop'), shot('mobile')];
    const outputs = [
      'TAP version 13\n# pass 7',
      'Rendered /: desktop 1280x800, mobile 375x812.',
      'Rendered /?city=Denver: desktop 1280x800, mobile 375x812.',
    ];
    expect(withPaths(images, outputs).map((s) => s.path)).toEqual(['/', '/', '/?city=Denver', '/?city=Denver']);
  });

  it('counts only the sizes a command actually captured', () => {
    const outputs = ['Rendered index.html: desktop 1280x800.', 'Rendered /?demo=loading: desktop 1280x800, mobile 375x812.'];
    expect(withPaths([shot('desktop'), shot('desktop'), shot('mobile')], outputs).map((s) => s.path)).toEqual([
      'index.html',
      '/?demo=loading',
      '/?demo=loading',
    ]);
  });

  it('leaves shots unlabeled when the lines and shots disagree', () => {
    const images = [shot('desktop'), shot('mobile')];
    expect(withPaths(images, ['Rendered /: desktop 1280x800.'])).toEqual(images);
  });
});

/* claude-api was reading 28k tokens a turn at twenty files; a bigger build would not fit. */
describe('the files a turn sees', () => {
  const state = (ask: string, turns: Array<{ seq: number; by: string; content?: string }> = []) =>
    ThreadStateSchema.parse({ threadId: 't', goal: 'Build ledger', status: 'OPEN', turnCount: turns.length, ask, participants: [], turns });
  const file = (name: string, size: number, lastBy = 'gpt-api') => ({ name, content: 'x'.repeat(size), version: 1, lastBy });

  it('shows every file while the build is small', () => {
    const built = [file('a.js', 100), file('b.js', 100)];
    expect(workingSet(built, state('fix a.js')).listed).toEqual([]);
  });

  it('shows what the ask and the recent turns name, and lists the rest, once the build is big', () => {
    const built = Array.from({ length: 30 }, (_, i) => file(`src/m${i}.js`, 4_000));
    const { full, listed } = workingSet(built, state('Fix src/m7.js so the test passes.', [{ seq: 1, by: 'claude-api', content: 'I changed src/m12.js.' }]));
    expect(full.map((f) => f.name)).toEqual(expect.arrayContaining(['src/m7.js', 'src/m12.js']));
    expect(full.reduce((n, f) => n + f.content.length, 0)).toBeLessThanOrEqual(WORKING_SET_CHARS);
    expect(listed.length).toBeGreaterThan(0);
  });

  it('always shows a file the turn asked to see', () => {
    const built = Array.from({ length: 30 }, (_, i) => file(`src/m${i}.js`, 4_000, 'someone'));
    expect(workingSet(built, state('carry on'), ['src/m29.js']).full.map((f) => f.name)).toContain('src/m29.js');
  });

  it('lists what it did not show, with how to ask for it', () => {
    const built = Array.from({ length: 30 }, (_, i) => file(`src/m${i}.js`, 4_000, 'someone'));
    const context = threadContext(state('carry on'), 'claude-api', built);
    expect(context).toContain('OTHER FILES IN THIS BUILD');
    expect(context).toContain('- src/m3.js — 1 lines, v1, last by someone');
  });
});
