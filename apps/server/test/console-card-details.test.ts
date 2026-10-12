/**
 * Show Details on every kind of approval card (apps/console/index.html,
 * <script id="approvals-js">, and the card a chat shows in its thread): what
 * the card would do, as sentences and labelled facts. An approval card never
 * looks like a JSON file.
 *
 *  - A kind the panel has words for says them: a goal's checks and timing, a
 *    plan's changes one by one, the people a card adds, a rule's limit.
 *  - Whatever else a card holds is a Title Case label and a plain value: a
 *    date as a date, a list joined with commas, long text clipped with an
 *    ellipsis, a stored name as words. Never a brace, a quoted key, an id or
 *    a path.
 *  - Every string is held to the notes' own standard (@flint/policy
 *    noteProblems). A fact is read as its label (a title) and as its line.
 *  - It is display only: Approve still hands the stored args, untouched, to
 *    the signed path that checks their digest.
 *
 * Each kind is opened in a small fake DOM (no innerHTML) and read as text.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { noteProblems, shownProblems } from '@flint/policy';

const html = readFileSync(join(__dirname, '..', '..', 'console', 'index.html'), 'utf8');
const apprJs = /<script id="approvals-js">([\s\S]*?)<\/script>/.exec(html)![1]!;
const goalsJs = /<script id="goals-js">([\s\S]*?)<\/script>/.exec(html)![1]!;
const mainJs = /<script>\n\/\* ---------- config ---------- \*\/([\s\S]*?)<\/script>/.exec(html)![1]!;
const chatCardJs = /\nfunction renderProposals\([\s\S]*?\n(?=\/\* -{10} Will.s approval key)/.exec(mainJs)![0];
// The Goals panel's words for an item's condition ("is merged"), which a goal card's details use when that panel is loaded.
const goalWords = `${/\nvar GOAL_WORDS=\{[\s\S]*?\};\n/.exec(goalsJs)![0]}${/\nfunction gWords\([^\n]*\n/.exec(goalsJs)![0]}`;

class El {
  className = '';
  children: El[] = [];
  style: Record<string, string> = {};
  onclick: (() => void) | null = null;
  hidden = false;
  disabled = false;
  private text = '';
  private attrs: Record<string, string> = {};
  private readonly classes = new Set<string>();
  constructor(readonly tagName: string, readonly id = '') {}
  readonly classList = {
    add: (c: string) => void this.classes.add(c),
    remove: (c: string) => void this.classes.delete(c),
    toggle: (c: string, on?: boolean) => void ((on ?? !this.classes.has(c)) ? this.classes.add(c) : this.classes.delete(c)),
    contains: (c: string) => this.classes.has(c),
  };
  get firstChild(): El | undefined {
    return this.children[0];
  }
  get textContent(): string {
    return this.text + this.children.map((c) => c.textContent).join('');
  }
  set textContent(v: string) {
    this.children = [];
    this.text = String(v);
  }
  set innerHTML(_v: string) {
    throw new Error('innerHTML is not allowed on an approval card');
  }
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
  }
  appendChild(c: El): El {
    this.children.push(c);
    return c;
  }
  all(): El[] {
    return this.children.flatMap((c) => [c, ...c.all()]);
  }
  /** Every piece of text under this element, hidden or not: what could ever reach the screen. */
  texts(): string[] {
    return [this.text, ...this.children.flatMap((c) => c.texts())].filter(Boolean);
  }
}

interface Panel {
  run: (code: string) => unknown;
  list: El;
  approved: Array<{ id: string; args: unknown }>;
}

/** The Approvals panel in a fake DOM, with these cards waiting. `withGoals`: the Goals panel's condition words are loaded too. */
function panel(cards: object[], withGoals = true): Panel {
  const ids: Record<string, El> = Object.fromEntries(
    ['approvals', 'apprlist', 'apprhelp', 'apprbadge', 'apprseg', 'apprtab-waiting', 'apprtab-approved', 'apprn-waiting', 'apprn-approved', 'apprfoot', 'apprnote', 'apprall', 'thread'].map((id) => [id, new El('div', id)]),
  );
  const approved: Panel['approved'] = [];
  const ctx: Record<string, unknown> = {
    console, BASE: '', TOKEN: 'tok', auth: () => ({}), setInterval: () => 0, setTimeout: () => 0,
    document: {
      getElementById: (id: string) => ids[id] ?? null,
      createElement: (tag: string) => new El(tag),
      createTextNode: (t: string) => Object.assign(new El('#text'), { textContent: t }),
      querySelectorAll: () => [],
    },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ proposals: cards, signed: true }) }),
    svgi: () => new El('svg'), laneAgo: () => '1h', showPanel: () => {}, canEnclave: () => true, canPasskey: () => false, loadCreds: () => {},
    approveLabel: () => 'Approve with Touch ID', starters: () => {}, openSettings: () => {}, errText: (e: Error) => e.message,
    approveAction: (id: string, _card: El, o: { args: unknown }) => (approved.push({ id, args: o.args }), Promise.resolve({ action: { status: 'pending' } })),
    rejectAction: () => {},
  };
  createContext(ctx);
  if (withGoals) runInContext(goalWords, ctx);
  runInContext(apprJs, ctx);
  const run = (code: string) => runInContext(code, ctx);
  // The panel as it is with these cards loaded (no network, no timers).
  run(`APPR.pending=${JSON.stringify(cards)};APPR.signed=true;`);
  return { run, list: ids.apprlist!, approved };
}

/** Open one card, press Show Details, and read everything it shows. */
function opened(p: Panel, id: string) {
  p.run(`APPR.open=${JSON.stringify(id)};apprRender();`);
  const card = p.list.all().find((e) => e.className.split(' ').includes('card') && e.className.split(' ').includes('open'))!;
  card.all().find((e) => e.tagName === 'button' && e.textContent === 'Show Details')!.onclick!();
  const details = card.all().find((e) => e.className === 'details')!;
  return {
    card,
    details,
    /** The details' own lines: its sentences, then its facts as [label, value]. */
    lines: details.children.filter((c) => c.tagName === 'p').map((c) => c.textContent),
    facts: details.all().filter((c) => c.tagName === 'dt').map((dt, i) => [dt.textContent, details.all().filter((c) => c.tagName === 'dd')[i]!.textContent] as [string, string]),
    approve: () => card.all().find((e) => e.tagName === 'button' && e.textContent === 'Approve with Touch ID')!.onclick!(),
  };
}

const GOAL = 'go1finishbuildingflint00';
const ITEM = 'en8f3k2m9x7q1w5z4c6v0b1n';
const OTHER = 'en1a2b3c4d5e6f7g8h9i0j1k';
const UNTIL = '2027-04-05T00:00:00.000Z';
const base = (over: Record<string, unknown>) => ({ id: 'pr1', tainted: false, status: 'pending', origin: 'console', ts: Date.now() - 3600_000, expiresAt: '2026-10-27T18:00:00.000Z', destructive: false, ...over });
const checks = [
  { id: 'c1', text: 'The goals work is merged', check: { kind: 'item', entityId: ITEM, key: 'state', value: 'merged' } },
  { id: 'c2', text: 'The planner runs on its own', check: { kind: 'steps', keys: ['s1', 's2'] } },
  { id: 'c3', text: 'A week passes with no outage', check: { kind: 'manual' } },
];
const rules = (rows: Array<[string, number?]>) => ({ rows: rows.map(([pattern, dailyCap]) => ({ pattern, tier: 'alone', ...(dailyCap ? { dailyCap } : {}), reason: 'promotion table, after the shadow week', expiresAt: UNTIL })) });
const P2: Array<[string, number?]> = [['triage.rule'], ['triage.local_model'], ['notify.inapp'], ['notify.banner'], ['notify.push', 3], ['health.check'], ['health.report'], ['digest.daily'], ['maintenance.retention'],
  ['inbox_recent'], ['escalations_open'], ['explain_decision'], ['world.sync.deploy'], ['world.sync.knowledge'], ['world.sync.nexus_inbox']];
const LONG = 'The badge says a review is late when it only waited for the Mac to wake, and it should count the time Flint was reviewing, as the health check does, so that a night asleep is never shown as a late review on the goal.';

/** One card of every kind the panel can show. Ids, paths, links and JSON-shaped text are in the args on purpose. */
const CARDS: Record<string, Record<string, unknown>> = {
  'the older rules card': base({ fullName: 'policy.change', kind: 'policy', origin: 'cli', consequential: true, reason: 'This lets Flint sort events, send its notes and run its upkeep without asking until Apr 5, 2027. Lately 1.4 items a day were important.', args: rules(P2) }),
  'a rules card with two rules': base({ fullName: 'policy.change', kind: 'policy', origin: 'cli', consequential: true, args: rules([['world.sync.google_calendar'], ['world.person.create', 20]]) }),
  'a new goal': base({
    fullName: 'goal.activate', kind: 'goal', consequential: true, reason: 'Approving starts this goal.',
    args: {
      goalId: GOAL, owner: 'will', origin: 'will', sensitivity: 'personal', tainted: false, nexusProjectId: null, title: 'Finish Building Flint',
      description: 'Flint should do the work it was built for, end to end.', successCriteria: checks, horizonAt: '2026-12-01T18:00:00.000Z', reviewCadence: 'P1W',
      links: [{ entityId: ITEM, role: 'target', watchPaths: ['state'] }],
      plan: { ops: [
        { op: 'add', key: 's1', step: { ordinal: 100, title: 'Ship goal reviews', kind: 'will_task', tier: 'approval', dueAt: '2026-10-16T18:00:00.000Z', dependsOn: [] } },
        { op: 'add', key: 's2', step: { ordinal: 200, title: 'Turn on the planner', kind: 'will_task', tier: 'approval', dueAt: null, dependsOn: ['s1'] } },
      ] },
    },
  }),
  'a goal Flint suggested, about money': base({
    fullName: 'goal.activate', kind: 'goal', consequential: true, origin: 'runtime:goals', reason: 'Approving starts this goal.',
    args: { goalId: GOAL, owner: 'will', origin: 'flint', sensitivity: 'financial', tainted: false, nexusProjectId: 'nx-project-7', title: 'Close the Books Each Month', description: '', successCriteria: [checks[2]], horizonAt: null, reviewCadence: 'P1M', links: [], plan: null },
  }),
  'what counts as done changes': base({
    fullName: 'goal.criteria_change', kind: 'goal', consequential: true, reason: 'Approving changes what counts as done.',
    args: {
      goalId: GOAL, title: 'Finish Building Flint This Year', description: 'Flint should run on its own by the new year.', successCriteria: checks.slice(0, 2), links: [],
      from: { title: 'Finish Building Flint', description: 'Flint should do the work it was built for, end to end.', successCriteria: checks, links: [{ entityId: ITEM, role: 'target', watchPaths: ['state'] }] },
    },
  }),
  'a goal’s timing changes': base({
    fullName: 'goal.horizon_change', kind: 'goal', consequential: true, reason: 'Approving changes its timing.',
    args: { goalId: GOAL, goalTitle: 'Finish Building Flint', horizonAt: '2027-02-01T18:00:00.000Z', reviewCadence: 'P2W', from: { horizonAt: '2026-12-01T18:00:00.000Z', reviewCadence: 'P1W' } },
  }),
  'a goal is marked done': base({ fullName: 'goal.done', kind: 'goal', consequential: true, reason: 'Approving marks this goal done.', args: { goalId: GOAL, goalTitle: 'Finish Building Flint' } }),
  'a goal is abandoned': base({ fullName: 'goal.abandon', kind: 'goal', consequential: true, reason: 'Approving abandons this goal.', args: { goalId: GOAL, goalTitle: 'Finish Building Flint' } }),
  'a review’s small plan changes': base({
    fullName: 'plan.change', kind: 'plan', origin: 'runtime:goals', templateId: 'plan.diff.minor', consequential: false, reason: 'Flint suggests this change to the plan.',
    args: { goalId: GOAL, goalTitle: 'Finish Building Flint', ops: [
      { op: 'set', key: 's1', from: { title: 'Ship goal reviews', status: 'todo' }, to: { status: 'blocked' } },
      { op: 'set', key: 's2', from: { title: 'Turn on the planner', dueAt: '2026-10-23T18:00:00.000Z' }, to: { dueAt: '2026-10-27T18:00:00.000Z' } },
    ] },
  }),
  'a bigger plan change': base({
    fullName: 'plan.change', kind: 'plan', origin: 'console', consequential: true, reason: 'Approving changes this goal’s plan.',
    args: { goalId: GOAL, goalTitle: 'Finish Building Flint', ops: [
      { op: 'add', key: 's4', step: { ordinal: 400, title: 'Write the trial week notes', kind: 'will_task', tier: 'approval', dueAt: '2026-10-30T18:00:00.000Z', dependsOn: [] } },
      { op: 'add', key: 's5', step: { ordinal: 500, title: 'Check the nightly backup', kind: 'flint_action', tier: 'approval', dueAt: null, dependsOn: [] } },
      { op: 'set', key: 's3', from: { title: 'Review the trial week', status: 'todo' }, to: { status: 'skipped' } },
      { op: 'set', key: 's2', from: { title: 'Turn on the planner', dueAt: '2026-10-23T18:00:00.000Z', ordinal: 200, dependsOn: [] }, to: { dueAt: null, ordinal: 50, dependsOn: ['s1'], title: 'Turn on the planner for good' } },
      { op: 'set', key: 's1', from: { title: 'Ship goal reviews', status: 'blocked' }, to: { status: 'in_progress' } },
    ] },
  }),
  'a goal suggested from chat': base({ fullName: 'goal.propose', kind: 'goal', origin: 'chat:c1', consequential: true, args: { title: 'Run a Half Marathon', quote: 'I want to run a half marathon by spring', conversationId: 'c8f3k2m9x7q1w5z4c6v0b1n2', turnId: 't1790000000000' } }),
  'a commitment from chat': base({ fullName: 'world.commitment.from_chat', kind: 'world', origin: 'chat:c1', consequential: true, args: { quote: 'I will send Dana the draft by Friday', dueAt: '2026-10-16T18:00:00.000Z', personEntityId: OTHER } }),
  'people from the calendar': base({ fullName: 'world.person.create', kind: 'world', origin: 'runtime:google_calendar', args: { source: 'google_calendar', people: [{ name: 'Ada Lovelace', email: 'ada@example.com' }, { name: 'grace@example.com', email: 'grace@example.com' }] } }),
  'a source to turn on': base({ fullName: 'world.source.enable', kind: 'world', origin: 'cli', args: { source: 'deploy' } }),
  'a triage rule': base({ fullName: 'triage.rule.create', kind: 'triage', origin: 'cli', args: { rule: { name: 'CI Is Red on Main', lane: 'relevant', match: { source: 'github', type: 'ci_failed' }, notify: true, quietHours: ['22:00', '07:00'] } } }),
  'a link between two items': base({ fullName: 'world.relation.write', kind: 'world', origin: 'runtime:knowledge', args: { fromEntityId: ITEM, toEntityId: OTHER, relation: 'blocks', confidence: 0.8 } }),
  'tonight’s backup': base({ fullName: 'backup.local', kind: 'backup', origin: 'runtime:backup', args: {} }),
  'a tool call: look up one item': base({ fullName: 'runtime.world_entity', kind: 'tool', origin: 'chat:c1', args: { ref: 'pull_request#24ehza' } }),
  'a tool call: record a prediction': base({ fullName: 'runtime.ledger_record_prediction', kind: 'tool', origin: 'chat:c1', args: { claim: 'The goals work is merged before November', probability: 0.7, resolveBy: '2026-11-01T18:00:00.000Z', domain: 'goals', subjectEntityId: ITEM } }),
  'a tool call: read what triage decided': base({ fullName: 'runtime.inbox_recent', kind: 'tool', origin: 'chat:c1', args: { lane: 'relevant', limit: 20, since: '2026-10-11' } }),
  'a tool this panel has no words for': base({
    fullName: 'github.create_issue', kind: 'tool', origin: 'chat:c1',
    args: {
      repo: 'Flint', title: 'Fix the "late" badge {urgent}', body: LONG, labels: ['Bug', 'Goals'], assignees: [], draft: false, milestone: null,
      url: 'https://github.com/wpf002/flint/issues/new?template=bug', attachment: '/Users/willfoti/Documents/notes/Late Badge.png', requestId: '9f8e7d6c5b4a39281706f5e4d3c2b1a0', state: 'in_progress',
      options: { notifyWatchers: true, dueOn: '2026-10-20' },
    },
  }),
};
const KINDS = Object.keys(CARDS);
const ALL: Array<Record<string, unknown> & { id: string }> = KINDS.map((k, i) => ({ ...CARDS[k]!, id: `pr${i}` }));
const cardOf = (kind: string) => ALL[KINDS.indexOf(kind)]!;

const p = panel(ALL);
const day = (iso: string) => p.run(`apprDate(${JSON.stringify(iso)})`) as string;
/** A fact as a line, for the notes' standard: its value closed with a stop when it has none. */
const asLine = (label: string, value: string) => `${label}: ${value}${/[.!?…]$/.test(value) ? '' : '.'}`;

describe('no card shows its stored args', () => {
  it.each(KINDS)('%s: no brace, no straight quotation mark, no id and no path reaches its text, hidden or shown', (kind) => {
    const c = cardOf(kind);
    const o = opened(p, c.id as string);
    const text = o.card.texts().join('\n');
    expect(text).not.toMatch(/[{}"]/);
    expect(text).not.toMatch(/\[\s*["{[]/);
    for (const id of [GOAL, ITEM, OTHER, 'c8f3k2m9x7q1w5z4c6v0b1n2', 't1790000000000', '9f8e7d6c5b4a39281706f5e4d3c2b1a0', '24ehza', 'nx-project-7', c.id as string]) expect(text, id).not.toContain(id);
    expect(text).not.toMatch(/\/Users\/|https?:\/\/|\bs[0-9]{1,3}\b|\bc[0-9]\b/);
    // Nor a stored key or an action's internal name.
    expect(text).not.toMatch(/goalId|entityId|successCriteria|horizonAt|reviewCadence|dependsOn|watchPaths|expiresAt|dailyCap|fullName|will_task|in_progress|\b(goal|plan|policy|world|runtime|backup)\.[a-z_]|create_issue/);
    // There is no preformatted block anywhere on a card.
    expect(o.card.all().some((e) => e.tagName === 'pre')).toBe(false);
  });

  it.each(KINDS)('%s: every line of its details is a sentence and every fact a Title Case label with a plain value, by the notes’ own standard', (kind) => {
    const o = opened(p, cardOf(kind).id as string);
    expect(o.lines.length + o.facts.length, 'something to show').toBeGreaterThan(0);
    for (const line of o.lines) expect(noteProblems('Details', line), line).toEqual([]);
    for (const [label, value] of o.facts) {
      expect(noteProblems(label, asLine(label, value)), `${label}: ${value}`).toEqual([]);
      expect(shownProblems(value), value).toEqual([]);
      expect(value.length).toBeLessThanOrEqual(240);
    }
  });

  it.each(KINDS)('%s: Approve hands the signed path the stored args themselves, untouched by any of this', (kind) => {
    const c = cardOf(kind);
    const before = JSON.stringify(c.args);
    const fresh = panel(ALL);
    opened(fresh, c.id as string).approve();
    expect(fresh.approved).toHaveLength(1);
    expect(fresh.approved[0]!.id).toBe(c.id);
    // The very args the server listed: same keys, same values, same order.
    expect(JSON.stringify(fresh.approved[0]!.args)).toBe(before);
    expect(JSON.stringify(c.args)).toBe(before);
  });
});

describe('what each kind says', () => {
  const says = (kind: string) => opened(p, cardOf(kind).id as string);

  it('a new goal: what it is, when, each check and how it is made, what it watches, and its first steps', () => {
    const o = says('a new goal');
    expect(o.lines).toEqual([
      'Approving starts this goal.',
      'The goal is “Finish Building Flint”.',
      // (Its own stop ends the sentence: Flint adds none after it.)
      'Its description is “Flint should do the work it was built for, end to end.”',
      `It should be done by ${day('2026-12-01T18:00:00.000Z')}.`,
      'Flint reviews it every week.',
      'Check 1 is “The goals work is merged”. Flint checks this when an item it tracks is merged.',
      'Check 2 is “The planner runs on its own”. Flint checks this when its 2 steps are done.',
      'Check 3 is “A week passes with no outage”. You mark this one.',
      'It watches 1 item for changes.',
      'Its plan starts with 2 steps.',
      `Add the step “Ship goal reviews”, due ${day('2026-10-16T18:00:00.000Z')}.`,
      'Add the step “Turn on the planner”.',
    ]);
    expect(o.facts).toEqual([]);
  });

  it('without the Goals panel’s words for a condition, a check an item makes still reads as a sentence', () => {
    const bare = panel(ALL, false);
    expect(opened(bare, cardOf('a new goal').id as string).lines).toContain('Check 1 is “The goals work is merged”. Flint checks this when an item it tracks changes.');
  });

  it('a goal Flint suggested says so, with no finish date, its own cadence and its mark', () => {
    expect(says('a goal Flint suggested, about money').lines).toEqual([
      'Approving starts this goal.', 'The goal is “Close the Books Each Month”.', 'Flint suggested it.', 'It has no finish date.', 'Flint reviews it every month.',
      'Check 1 is “A week passes with no outage”. You mark this one.', 'It’s marked as financial.',
    ]);
  });

  it('a change to what counts as done says what changes, from what', () => {
    expect(says('what counts as done changes').lines).toEqual([
      'Approving changes what counts as done.',
      'Its title changes from “Finish Building Flint” to “Finish Building Flint This Year”.',
      'Its description changes to “Flint should run on its own by the new year.”',
      'It will have 2 checks, and it has 3 now.',
      'Check 1 is “The goals work is merged”. Flint checks this when an item it tracks is merged.',
      'Check 2 is “The planner runs on its own”. Flint checks this when its 2 steps are done.',
      'It will watch 0 items for changes, and it watches 1 now.',
    ]);
  });

  it('a change of timing says the dates and the cadence, old and new', () => {
    expect(says('a goal’s timing changes').lines).toEqual([
      'Approving changes its timing.', 'The goal is “Finish Building Flint”.',
      `Its finish date moves from ${day('2026-12-01T18:00:00.000Z')} to ${day('2027-02-01T18:00:00.000Z')}.`,
      'Flint will review it every 2 weeks, and it is every week now.',
    ]);
    // A date taken off, a date given where there was none, and a card that changes only the cadence.
    const timing = (to: string | null, was: string | null) => (p.run(`apprDetails(${JSON.stringify({ fullName: 'goal.horizon_change', args: { goalTitle: 'A', horizonAt: to, reviewCadence: 'P1W', from: { horizonAt: was, reviewCadence: 'P1W' } } })}).says`) as string[]).slice(1).join(' ');
    expect(timing(null, '2026-12-01T18:00:00.000Z')).toBe('Its finish date is taken off.');
    expect(timing('2027-02-01T18:00:00.000Z', null)).toBe(`It gets a finish date of ${day('2027-02-01T18:00:00.000Z')}.`);
    expect(timing(null, null)).toBe('');
  });

  it('done and abandoned name the goal', () => {
    expect(says('a goal is marked done').lines).toEqual(['Approving marks this goal done.', 'The goal is “Finish Building Flint”.']);
    expect(says('a goal is abandoned').lines).toEqual(['Approving abandons this goal.', 'The goal is “Finish Building Flint”.']);
  });

  it('a plan change says each change as the Goals panel says a suggestion, naming each step by its title', () => {
    expect(says('a review’s small plan changes').lines).toEqual([
      'Flint suggests this change to the plan.', 'The goal is “Finish Building Flint”.',
      'Mark “Ship goal reviews” blocked.',
      `Move “Turn on the planner” to ${day('2026-10-27T18:00:00.000Z')}.`,
    ]);
    expect(says('a bigger plan change').lines).toEqual([
      'Approving changes this goal’s plan.', 'The goal is “Finish Building Flint”.',
      `Add the step “Write the trial week notes”, due ${day('2026-10-30T18:00:00.000Z')}.`,
      'Add the step “Check the nightly backup”. Flint would do this step.',
      'Skip “Review the trial week”.',
      'Take the due date off “Turn on the planner”. Rename “Turn on the planner” to “Turn on the planner for good”. Move “Turn on the planner” to another place in the plan. Change what “Turn on the planner” waits on.',
      'Mark “Ship goal reviews” in progress.',
    ]);
    // The words for a step's status are the Goals panel's own: one table each, kept the same.
    expect(/\nvar APPR_STEP_WORDS=(\{[^\n]*\});/.exec(apprJs)![1]).toBe(/\nvar GOAL_STEP_WORDS=(\{[^\n]*\});/.exec(goalsJs)![1]);
  });

  it('what chat suggested says the words of Will’s it rests on, never where it heard them', () => {
    expect(says('a goal suggested from chat').lines).toEqual(['The goal would be “Run a Half Marathon”.', 'You said “I want to run a half marathon by spring”.']);
    expect(says('a goal suggested from chat').facts).toEqual([]);
    expect(says('a commitment from chat').lines).toEqual(['You said “I will send Dana the draft by Friday”.', `It’s due ${day('2026-10-16T18:00:00.000Z')}.`]);
    expect(says('a commitment from chat').facts).toEqual([]);
  });

  it('a person card names each person and where they come from', () => {
    expect(says('people from the calendar').lines).toEqual(['Flint adds Ada Lovelace, whose address is ada@example.com.', 'Flint adds the person at grace@example.com.', 'They come from Google Calendar.']);
  });

  it('a rule card says each rule; over 6 rules, the Limits fact counts them and the details list them', () => {
    const older = says('the older rules card');
    expect(older.lines).toHaveLength(16);
    expect(older.lines[1]).toBe('Triage rules may run on their own until Apr 5, 2027.');
    expect(older.lines[5]).toBe('Phone pings may be sent on their own, up to 3 a day, until Apr 5, 2027.');
    const facts = (kind: string) => JSON.parse(JSON.stringify(p.run(`apprFacts(${JSON.stringify(cardOf(kind))})`))) as Array<[string, string]>;
    expect(facts('the older rules card')).toEqual([['Until', 'Apr 5, 2027'], ['Limits', '15 actions, listed under Show Details.'], ['Filed By', 'You']]);
    expect(noteProblems('Limits', '15 actions, listed under Show Details.')).toEqual([]);
    expect(facts('a rules card with two rules')).toEqual([['Until', 'Apr 5, 2027'], ['Limits', 'Google Calendar Reads · People from Your Calendar 20 a Day'], ['Filed By', 'You']]);
    // Six is still a list; seven is a count.
    const limits = (n: number) => p.run(`apprLimits(${JSON.stringify(rules(P2.slice(0, n)).rows)})`) as string;
    expect(limits(6)).toBe('Triage Rules · Local Model Triage · In-App Notes · Banners · Phone Pings 3 a Day · Health Checks');
    expect(limits(7)).toBe('7 actions, listed under Show Details.');
  });

  it('a card with nothing more to it says so, in a sentence', () => {
    expect(says('tonight’s backup').lines).toEqual(['This card holds nothing more.']);
  });
});

describe('a card this panel has no words for: labelled facts', () => {
  const facts = (kind: string) => opened(p, cardOf(kind).id as string).facts;

  it('each key is a Title Case label and each value is plain: a date as a date, a list with commas, a stored name as words, yes or no', () => {
    expect(facts('a tool this panel has no words for')).toEqual([
      ['Repo', 'Flint'],
      ['Title', 'Fix the “late” badge urgent'],
      ['Body', 'The badge says a review is late when it only waited for the Mac to wake, and it should count the time Flint was reviewing, as the health check does, so that a…'],
      ['Labels', 'Bug, Goals'],
      ['Draft', 'No'],
      ['Url', 'github.com'],
      ['Attachment', 'Late Badge.png'],
      ['State', 'In Progress'],
      ['Options Notify Watchers', 'Yes'],
      ['Options Due On', day('2026-10-20T00:00:00.000Z')],
    ]);
    expect(facts('a triage rule')).toEqual([['Rule Name', 'CI Is Red on Main'], ['Rule Lane', 'Relevant'], ['Rule Match Source', 'Github'], ['Rule Match Type', 'Ci Failed'], ['Rule Notify', 'Yes'], ['Rule Quiet Hours', '22:00, 07:00']]);
    expect(facts('a source to turn on')).toEqual([['Source', 'Deploy']]);
  });

  it('an id is never shown: a key that holds one is left out, and an item’s ref is said as its kind', () => {
    expect(facts('a link between two items')).toEqual([['Relation', 'Blocks'], ['Confidence', '0.8']]);
    expect(facts('a tool call: look up one item')).toEqual([['Item', 'One Pull Request']]);
    expect(facts('a tool call: record a prediction')).toEqual([['Claim', 'The goals work is merged before November'], ['Probability', '0.7'], ['Resolve By', day('2026-11-01T18:00:00.000Z')], ['Domain', 'Goals']]);
    expect(facts('a tool call: read what triage decided')).toEqual([['Lane', 'Relevant'], ['Limit', '20'], ['Since', day('2026-10-11T00:00:00.000Z')]]);
  });

  it('the formatter, value by value', () => {
    const plain = (v: unknown) => p.run(`apprPlain(${JSON.stringify(v)})`) as string;
    expect([true, false, 3, 0, null, '', '   '].map(plain)).toEqual(['Yes', 'No', '3', '0', '', '', '']);
    expect(plain('P1W')).toBe('Week');
    expect(plain('issue#24ehza')).toBe('One Issue');
    expect(plain('https://user:secret@example.com:8443/a/b?c=d#e')).toBe('example.com');
    expect(plain('~/flint/apps/server/README.md')).toBe('README.md');
    // A file's own name is someone's, and is shown as it is written (the notes' check for such a name: shownProblems).
    expect(plain('/Users/willfoti/Documents/notes/late-badge.png')).toBe('late-badge.png');
    expect(shownProblems('late-badge.png')).toEqual([]);
    expect(plain('/private/tmp/')).toBe('tmp');
    expect(plain('in_progress')).toBe('In Progress');
    expect(plain('example.com')).toBe('example.com');
    expect(plain('ada@example.com')).toBe('ada@example.com');
    // An id, whatever key holds it: a long run of letters and digits, a hex string, a UUID.
    expect([GOAL, '9f8e7d6c5b4a39281706f5e4d3c2b1a0', '3f2a9c1', '0b9d6a52-7c1e-4a3b-9f2d-1c2e3f4a5b6c'].map(plain)).toEqual(['', '', '', '']);
    // Someone's text: one line, typographic quotation marks, no braces, clipped at a word with an ellipsis.
    expect(plain('He said "ship it"\n{now}')).toBe('He said “ship it” now');
    expect(plain(`${'word '.repeat(60)}`).length).toBeLessThanOrEqual(160);
    expect(plain(`${'word '.repeat(60)}`)).toMatch(/word…$/);
    // Labels: camel case, snake case and dots are words; short joining words stay lower case inside.
    const label = (k: string) => p.run(`apprLabel(${JSON.stringify(k)})`) as string;
    expect(['resolveBy', 'resolve_by', 'kindOfThing', 'max.results', 'URL', 'a'].map(label)).toEqual(['Resolve By', 'Resolve By', 'Kind of Thing', 'Max Results', 'Url', 'A']);
    for (const k of ['resolveBy', 'kindOfThing', 'max.results', 'dueOn']) expect(noteProblems(label(k), '')).toEqual([]);
    // Which keys hold an id: by their name, in any of the ways names are written. "valid" and "monkey" do not.
    const idKey = (k: string) => p.run(`apprIdKey(${JSON.stringify(k)})`) as boolean;
    expect(['id', 'goalId', 'entity_id', 'approvalId', 'argsDigest', 'key', 'keys', 'ref', 'requestId', 'subjectEntityId', 'api-token'].map(idKey)).toEqual(Array(11).fill(true));
    expect(['valid', 'monkey', 'paid', 'hybrid', 'title', 'keyboard', 'preference'].map(idKey)).toEqual(Array(7).fill(false));
  });

  it('a card that holds a great deal shows the first of it and says there is more', () => {
    const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`field${i}`, `Value ${i}`]));
    const d = JSON.parse(JSON.stringify(p.run(`apprDetails(${JSON.stringify({ fullName: 'some.tool', args: many })})`))) as { says: string[]; facts: unknown[]; more: boolean };
    expect(d.facts).toHaveLength(24);
    expect(d.more).toBe(true);
    const big = panel([base({ id: 'prbig', fullName: 'some.tool', args: { ...many, deep: { a: { b: { c: { d: { e: 'too deep' } } } } }, list: Array.from({ length: 20 }, (_, i) => `Item ${i}`) } })]);
    const o = opened(big, 'prbig');
    expect(o.lines).toEqual(['This card holds more than is shown here.']);
    expect(o.card.texts().join(' ')).not.toMatch(/[{}"]/);
    // Args that are not an object at all (a card whose args were cleared) show nothing of them.
    expect(JSON.parse(JSON.stringify(p.run(`apprDetails(${JSON.stringify({ fullName: 'some.tool', args: null })})`)))).toEqual({ says: ['This card holds nothing more.'], facts: [], more: false });
  });

  it('text from outside is shown as text, with nothing of it run or parsed', () => {
    const hostile = panel([base({ id: 'prx', fullName: 'world.person.create', tainted: true, origin: 'runtime:google_calendar', args: { people: [{ name: '<img src=x onerror=alert(1)>{"a":1}', email: 'x@example.com' }] } })]);
    const o = opened(hostile, 'prx');
    expect(o.lines[0]).toBe('Flint adds <img src=x onerror=alert(1)>“a”:1, whose address is x@example.com.');
    expect(o.details.texts().join(' ')).not.toMatch(/[{}"]/);
  });
});

describe('the card a chat shows in its thread', () => {
  function chatCard(action: object) {
    const host = new El('div');
    const approved: unknown[] = [];
    const ctx: Record<string, unknown> = {
      console, BASE: '', TOKEN: '', auth: () => ({}), setInterval: () => 0, setTimeout: () => 0,
      document: { getElementById: () => null, createElement: (tag: string) => new El(tag), createTextNode: (t: string) => Object.assign(new El('#text'), { textContent: t }), querySelectorAll: () => [] },
      fetch: async () => ({ ok: false, status: 401, json: async () => ({}) }),
      $: () => ({ scrollTop: 0 }),
      el: (tag: string, cls?: string, text?: string) => {
        const e = new El(tag);
        if (cls) e.className = cls;
        if (text !== undefined && text !== null) e.textContent = String(text);
        return e;
      },
      approveLabel: () => 'Approve', approveAction: (_id: string, _card: El, o: { args: unknown }) => void approved.push(o.args), rejectAction: () => {},
    };
    createContext(ctx);
    runInContext(apprJs, ctx);
    runInContext(chatCardJs, ctx);
    (ctx.renderProposals as (a: unknown[], b: unknown) => void)([action], { parentNode: host });
    const card = host.children[0]!;
    return { card, details: card.children.find((c) => c.className === 'pargs')!, approved, approve: () => card.all().find((e) => e.className === 'ok')!.onclick!() };
  }

  it('says the same lines behind Show Details, and never the stored args', () => {
    const tool = chatCard(CARDS['a tool this panel has no words for']!);
    const facts = tool.details.all().filter((c) => c.tagName === 'dt').map((dt) => dt.textContent);
    expect(facts).toEqual(['Repo', 'Title', 'Body', 'Labels', 'Draft', 'Url', 'Attachment', 'State', 'Options Notify Watchers', 'Options Due On']);
    expect(tool.card.texts().join('\n')).not.toMatch(/[{}"]|\/Users\/|https?:\/\/|9f8e7d6c5b4a39281706f5e4d3c2b1a0/);
    const plan = chatCard(CARDS['a review’s small plan changes']!);
    expect(plan.details.children.map((c) => c.textContent)).toEqual(['The goal is “Finish Building Flint”.', 'Mark “Ship goal reviews” blocked.', `Move “Turn on the planner” to ${day('2026-10-27T18:00:00.000Z')}.`]);
    // Approve signs the stored args, as they were listed.
    tool.approve();
    expect(JSON.stringify(tool.approved[0])).toBe(JSON.stringify(CARDS['a tool this panel has no words for']!.args));
  });
});
