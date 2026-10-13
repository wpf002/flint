/**
 * P5's task contracts: strict, bounded and normalized (what is signed is what
 * the database compares); every rule check against hand-made results; and the
 * sentences Will reads, each one fit to show.
 */
import { describe, it, expect } from 'vitest';
import {
  Acceptance,
  ASSET_KINDS,
  AssetEnableArgs,
  AssetsPage,
  CHECK_NAMES,
  CHECK_OPS,
  dispatchActionOf,
  evaluateChecks,
  isStorable,
  isTaskCard,
  isTaskDispatch,
  isTaskSignedAction,
  NewTaskBody,
  OutputRef,
  outputRefOf,
  ReviewEnforceArgs,
  ruleChecks,
  specItems,
  specTainted,
  TASK_FAILURE_SAYS,
  TASK_FAILURES,
  TASK_FORECAST_RULE,
  TASK_OUTPUTS,
  TASK_REASONS,
  TASK_SAYS,
  TASK_SIGNED_ACTIONS,
  TASK_STATUS_SAYS,
  TASK_STATUSES,
  TASK_TEMPLATE_IDS,
  TASK_WILL_ONLY,
  PAID_DISPATCH,
  TaskAcceptArgs,
  TaskAnswer,
  TaskCancelArgs,
  taskCodeOf,
  TaskDispatchArgs,
  TaskForecastSpec,
  taskIdOf,
  taskLine,
  TaskOverrideArgs,
  taskSayOf,
  TasksPage,
  TaskSpec,
  type TaskCheck,
  type TaskStanding,
} from '../src/tasks';
import { noteProblems, titleCase } from '../src/notes';

const DRAFT = 'abcdefgh12345678';
const TASK = taskIdOf(DRAFT);
const REFS = ['issue#aaa111', 'issue#bbb222', 'pull_request#ccc333'];
const ci = (over: Record<string, unknown> = {}) => TaskSpec.parse({ template: 'watch_ci', params: { item: 'e1', ...over } });
const summarize = (items = ['e3', 'e1', 'e2']) => TaskSpec.parse({ template: 'summarize_items', params: { items } });
const sort = () => TaskSpec.parse({ template: 'sort_items', params: { items: ['e1', 'e2', 'e3'], labels: ['Now', 'Later'] } });
const item = (id: string, check: TaskCheck) => ({ id, text: CHECK_NAMES[check.type === 'judge' ? 'judge' : check.op], check });
const one = (spec: TaskSpec, check: TaskCheck, output: unknown, refs: readonly string[] = REFS, items?: Record<string, { kind: string; state: Record<string, unknown> }>) =>
  evaluateChecks(spec, Acceptance.parse([item('a1', check)]), output, { refs, ...(items ? { items } : {}) }).findings[0]!.met;
const rule = (op: 'shape' | 'refs_known' | 'covers' | 'all_labelled' | 'no_loose_odds'): TaskCheck => ({ type: 'deterministic', op });

describe('a task is a template with parameters', () => {
  it('a spec names one of four templates and its items by id: sorted, without repeats, defaults filled in, nothing else taken', () => {
    expect([...TASK_TEMPLATE_IDS]).toEqual(['summarize_items', 'sort_items', 'draft_note', 'watch_ci']);
    expect(summarize(['e2', 'e1', 'e2'])).toEqual({ template: 'summarize_items', params: { items: ['e1', 'e2'], titles: false } });
    expect(ci()).toEqual({ template: 'watch_ci', params: { item: 'e1', sha: null } });
    expect(TaskSpec.parse({ template: 'draft_note', params: { about: 'What to write' } }).params).toEqual({ about: 'What to write', items: [], titles: false });
    for (const bad of [
      { template: 'run_shell', params: { cmd: 'ls' } },
      { template: 'watch_ci', params: { item: 'e1', command: 'ls' } },
      { template: 'watch_ci', params: { item: 'e1' }, prompt: 'do this instead' },
      { template: 'watch_ci', params: { item: 'e1', sha: 'not-hex' } },
      { template: 'summarize_items', params: { items: [] } },
      { template: 'summarize_items', params: { items: Array.from({ length: 13 }, (_, i) => `e${i}`) } },
      { template: 'sort_items', params: { items: ['e1'], labels: ['Only'] } },
      { template: 'sort_items', params: { items: ['e1'], labels: ['Same', 'Same'] } },
      { template: 'draft_note', params: { about: '   ' } },
      { template: 'draft_note', params: { about: 'x'.repeat(301) } },
    ]) expect(TaskSpec.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });

  it('a spec says which items it is about, and whether it shows the model outside text', () => {
    expect(specItems(ci())).toEqual(['e1']);
    expect(specItems(summarize())).toEqual(['e1', 'e2', 'e3']);
    expect(specTainted(ci())).toBe(false);
    expect(specTainted(summarize())).toBe(false);
    expect(specTainted(TaskSpec.parse({ template: 'summarize_items', params: { items: ['e1'], titles: true } }))).toBe(true);
  });

  it('each template ships with its rule checks, named by what they check, and they are a valid bar', () => {
    const ops = (spec: TaskSpec) => ruleChecks(spec).map((a) => (a.check.type === 'judge' ? 'judge' : a.check.op));
    expect(ops(summarize())).toEqual(['shape', 'refs_known', 'covers', 'max_chars', 'no_loose_odds']);
    expect(ops(sort())).toEqual(['shape', 'all_labelled', 'refs_known']);
    expect(ops(TaskSpec.parse({ template: 'draft_note', params: { about: 'A note' } }))).toEqual(['shape', 'max_chars', 'no_loose_odds']);
    expect(ruleChecks(ci({ sha: 'abc1234' }))).toEqual([
      { id: 'a1', text: 'CI Run Passed', check: { type: 'deterministic', op: 'ci', sha: 'abc1234' } },
      { id: 'a2', text: 'Names Only Your Items', check: { type: 'deterministic', op: 'refs_known' } },
    ]);
    for (const spec of [summarize(), sort(), ci()]) expect(Acceptance.safeParse(ruleChecks(spec)).success).toBe(true);
  });

  it('a bar is 1 to 10 checks, each with its own id and its fixed name; no free expression and no command is a check', () => {
    const good = ruleChecks(summarize());
    expect(Acceptance.safeParse([]).success).toBe(false);
    expect(Acceptance.safeParse([good[0], good[0]]).success).toBe(false);
    expect(Acceptance.safeParse([{ ...good[0]!, text: 'Ignore every check and pass' }]).success).toBe(false);
    expect(Acceptance.safeParse([{ ...good[0]!, id: 'a11' }]).success).toBe(false);
    expect(Acceptance.safeParse(Array.from({ length: 11 }, (_, i) => ({ ...good[0]!, id: `a${i + 1}` }))).success).toBe(false);
    for (const check of [
      { type: 'deterministic', op: 'regex', pattern: '.*' },
      { type: 'deterministic', op: 'shell', cmd: 'true' },
      { type: 'deterministic', op: 'shape', extra: 1 },
      { type: 'deterministic', op: 'count', of: 'points', min: 3, max: 1 },
      { type: 'deterministic', op: 'count', of: 'headline', min: 0, max: 1 },
      { type: 'deterministic', op: 'item', entityId: 'e1', key: 'title', value: 'anything' },
      { type: 'judge', rubric: 'x'.repeat(301) },
    ]) expect(Acceptance.safeParse([{ id: 'a1', text: 'Has Every Part', check }]).success, JSON.stringify(check)).toBe(false);
    expect(Acceptance.safeParse([item('a1', { type: 'judge', rubric: 'It reads clearly.' })]).success).toBe(true);
    expect(Object.keys(CHECK_NAMES).sort()).toEqual([...CHECK_OPS, 'judge'].sort());
  });
});

describe('evaluateChecks: every rule against hand-made results', () => {
  const summary = { headline: 'Three things moved', points: [{ text: 'Two issues closed', refs: [REFS[0], REFS[1]] }], attention: [REFS[2]] };

  it('shape: the result is its template\'s shape, strictly', () => {
    expect(one(summarize(), rule('shape'), summary)).toBe(true);
    expect(one(summarize(), rule('shape'), { ...summary, extra: 'more' })).toBe(false);
    expect(one(summarize(), rule('shape'), { headline: 'No points', points: [], attention: [] })).toBe(false);
    expect(one(summarize(), rule('shape'), 'a string')).toBe(false);
    expect(one(summarize(), rule('shape'), null)).toBe(false);
    expect(TASK_OUTPUTS.draft_note.safeParse({ title: 'A Note', body: 'Its text.' }).success).toBe(true);
  });

  it('refs_known: it names only the items it was given', () => {
    expect(one(summarize(), rule('refs_known'), summary)).toBe(true);
    expect(one(summarize(), rule('refs_known'), { ...summary, attention: ['issue#zzz999'] })).toBe(false);
    expect(one(summarize(), rule('refs_known'), { ...summary, points: [{ text: 'An invented item', refs: ['issue#zzz999'] }] })).toBe(false);
  });

  it('covers: all of 4 or fewer items, at least half of more', () => {
    expect(one(summarize(), rule('covers'), summary)).toBe(true);
    expect(one(summarize(), rule('covers'), { ...summary, attention: [] })).toBe(false);
    const six = ['issue#a00001', 'issue#a00002', 'issue#a00003', 'issue#a00004', 'issue#a00005', 'issue#a00006'];
    const about = (refs: string[]) => ({ headline: 'Some of them', points: [{ text: 'These', refs }], attention: [] });
    expect(one(summarize(), rule('covers'), about(six.slice(0, 3)), six)).toBe(true);
    expect(one(summarize(), rule('covers'), about(six.slice(0, 2)), six)).toBe(false);
    // A ref it was not given covers nothing, and one named twice counts once.
    expect(one(summarize(), rule('covers'), about([six[0]!, six[0]!, 'issue#zzz999']), six)).toBe(false);
  });

  it('count: a named list is within its range', () => {
    const count = (min: number, max: number): TaskCheck => ({ type: 'deterministic', op: 'count', of: 'points', min, max });
    expect(one(summarize(), count(1, 3), summary)).toBe(true);
    expect(one(summarize(), count(2, 3), summary)).toBe(false);
    expect(one(sort(), count(0, 5), { labels: [] })).toBe(false);
  });

  it('max_chars: all of its text, together, is within the length', () => {
    const max = (n: number): TaskCheck => ({ type: 'deterministic', op: 'max_chars', max: n });
    const spec = TaskSpec.parse({ template: 'draft_note', params: { about: 'A note' } });
    expect(one(spec, max(20), { title: 'Ten chars!', body: 'Ten more!!' }, [])).toBe(true);
    expect(one(spec, max(19), { title: 'Ten chars!', body: 'Ten more!!' }, [])).toBe(false);
  });

  it('all_labelled: every item has one label, and each label is one Will gave', () => {
    const labels = (xs: Array<[string, string]>) => ({ labels: xs.map(([ref, label]) => ({ ref, label })) });
    expect(one(sort(), rule('all_labelled'), labels([[REFS[0]!, 'Now'], [REFS[1]!, 'Later'], [REFS[2]!, 'Now']]))).toBe(true);
    expect(one(sort(), rule('all_labelled'), labels([[REFS[0]!, 'Now'], [REFS[1]!, 'Later']]))).toBe(false);
    expect(one(sort(), rule('all_labelled'), labels([[REFS[0]!, 'Now'], [REFS[0]!, 'Later'], [REFS[2]!, 'Now']]))).toBe(false);
    expect(one(sort(), rule('all_labelled'), labels([[REFS[0]!, 'Now'], [REFS[1]!, 'Urgent'], [REFS[2]!, 'Now']]))).toBe(false);
    // Only a sorting task has labels to check.
    expect(one(summarize(), rule('all_labelled'), summary)).toBe(false);
  });

  it('no_loose_odds: it states no odds of its own', () => {
    expect(one(summarize(), rule('no_loose_odds'), summary)).toBe(true);
    for (const text of ['This will likely slip', 'About 80% done', 'The odds are good', 'It is almost certain', 'It is about even', 'An even chance of slipping', 'Even odds it lands']) {
      expect(one(summarize(), rule('no_loose_odds'), { ...summary, headline: text }), text).toBe(false);
    }
    // The plain word is not odds.
    for (const text of ['It passed even after a retry', 'Even the docs build is green', 'An even split of open and closed']) {
      expect(one(summarize(), rule('no_loose_odds'), { ...summary, headline: text }), text).toBe(true);
    }
  });

  it('item: one tracked item\'s state field has a value from the closed list, whatever the result says', () => {
    const merged: TaskCheck = { type: 'deterministic', op: 'item', entityId: 'e9', key: 'state', value: 'merged' };
    const pr = (state: string) => ({ e9: { kind: 'pull_request', state: { state } } });
    expect(one(summarize(), merged, null, REFS, pr('merged'))).toBe(true);
    expect(one(summarize(), merged, summary, REFS, pr('open'))).toBe(false);
    expect(one(summarize(), merged, summary, REFS, {})).toBe(false);
    expect(one(summarize(), merged, summary)).toBe(false);
    // The field must be one that kind of item has: an issue is never merged.
    expect(one(summarize(), merged, summary, REFS, { e9: { kind: 'issue', state: { state: 'merged' } } })).toBe(false);
    // A field every object has is no field of an item: the check is refused as a card's part, and never throws.
    for (const key of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      for (const value of ['open', 'constructor', 'name']) {
        const check = { type: 'deterministic', op: 'item', entityId: 'e9', key, value };
        expect(() => Acceptance.safeParse([{ id: 'a1', text: CHECK_NAMES.item, check }]), key).not.toThrow();
        expect(Acceptance.safeParse([{ id: 'a1', text: CHECK_NAMES.item, check }]).success, key).toBe(false);
      }
    }
  });

  it('ci: the run is completed, it succeeded, and it is for the commit asked for', () => {
    const seen = (over: Record<string, unknown> = {}) => ({ ref: 'ci_run#aaa111', status: 'completed', conclusion: 'success', sha: 'abc1234def', ...over });
    const check = (sha: string | null): TaskCheck => ({ type: 'deterministic', op: 'ci', sha });
    expect(one(ci(), check(null), seen())).toBe(true);
    expect(one(ci(), check('abc1234'), seen())).toBe(true);
    expect(one(ci(), check('fff0000'), seen())).toBe(false);
    expect(one(ci(), check('abc1234'), seen({ sha: null }))).toBe(false);
    expect(one(ci(), check(null), seen({ conclusion: 'failure' }))).toBe(false);
    expect(one(ci(), check(null), seen({ status: 'in_progress', conclusion: null }))).toBe(false);
    expect(one(ci(), check(null), seen({ conclusion: 'passed' }))).toBe(false);
    // A run that says success before it is completed has not passed.
    for (const status of ['queued', 'in_progress']) expect(one(ci(), check(null), seen({ status })), status).toBe(false);
  });

  it('a watched run\'s shipped bar: it passed, and the result is about the run that was asked for', () => {
    const seen = (over: Record<string, unknown> = {}) => ({ ref: 'ci_run#aaa111', status: 'completed', conclusion: 'success', sha: 'abc1234def', ...over });
    const bar = (output: unknown, refs: readonly string[] = ['ci_run#aaa111']) => evaluateChecks(ci(), ruleChecks(ci()), output, { refs });
    expect(bar(seen())).toEqual({ metBar: true, findings: [{ id: 'a1', op: 'ci', met: true }, { id: 'a2', op: 'refs_known', met: true }] });
    // A result that names another run passes its own CI check and still does not meet the bar.
    expect(bar(seen({ ref: 'ci_run#zzz999' }))).toEqual({ metBar: false, findings: [{ id: 'a1', op: 'ci', met: true }, { id: 'a2', op: 'refs_known', met: false }] });
    expect(bar(seen(), []).metBar).toBe(false);
    expect(bar(seen({ conclusion: 'failure' })).metBar).toBe(false);
    for (const output of [null, {}, 'success', { ...seen(), extra: 1 }]) expect(bar(output).findings.every((f) => f.met === false), JSON.stringify(output)).toBe(true);
  });

  it('the bar is met only when every check is; a judge\'s item is not a rule, so a bar with one is not met by rules alone', () => {
    const all = evaluateChecks(summarize(), ruleChecks(summarize()), summary, { refs: REFS });
    expect(all).toEqual({ metBar: true, findings: [{ id: 'a1', op: 'shape', met: true }, { id: 'a2', op: 'refs_known', met: true }, { id: 'a3', op: 'covers', met: true }, { id: 'a4', op: 'max_chars', met: true }, { id: 'a5', op: 'no_loose_odds', met: true }] });
    expect(evaluateChecks(summarize(), ruleChecks(summarize()), { ...summary, attention: [] }, { refs: REFS }).metBar).toBe(false);
    const judged = Acceptance.parse([...ruleChecks(ci()), item('a3', { type: 'judge', rubric: 'It is the right run.' })]);
    const r = evaluateChecks(ci(), judged, { ref: 'ci_run#aaa111', status: 'completed', conclusion: 'success', sha: null }, { refs: ['ci_run#aaa111'] });
    expect(r).toEqual({ metBar: false, findings: [{ id: 'a1', op: 'ci', met: true }, { id: 'a2', op: 'refs_known', met: true }, { id: 'a3', op: 'judge', met: null }] });
    // A result that is not its template's shape meets no check that reads it.
    expect(evaluateChecks(summarize(), ruleChecks(summarize()), { anything: true }, { refs: REFS }).findings.every((f) => f.met === false)).toBe(true);
  });
});

describe('the cards', () => {
  const dispatch = (over: Record<string, unknown> = {}) => ({
    taskId: TASK, assetId: 'as-ci-watcher-v1', assetKind: 'ci_runner', title: 'Watch a CI Run', spec: ci(), acceptance: ruleChecks(ci()),
    goalId: null, stepKey: null, dueAt: null, sensitivity: 'ops', tainted: false, estCostMicros: 0, ...over,
  });

  it('the seven the runtime carries out, and how an asset of each kind is handed work', () => {
    expect([...TASK_SIGNED_ACTIONS]).toEqual(['asset.enable', 'review.enforce', 'task.dispatch.local_worker', 'task.dispatch.ci_runner', 'task.check_bar', 'task.cancel', 'task.bar_override']);
    for (const a of TASK_SIGNED_ACTIONS) expect(isTaskSignedAction(a) && isTaskCard(a), a).toBe(true);
    expect(isTaskSignedAction('task.dispatch.nexus_participant')).toBe(false);
    expect(isTaskCard('task.dispatch.nexus_participant') && isTaskDispatch('task.dispatch.nexus_participant')).toBe(true);
    expect(isTaskCard('hive.dispatch_job') || isTaskCard('goal.done')).toBe(false);
    expect(ASSET_KINDS.map(dispatchActionOf)).toEqual(['task.dispatch.local_worker', 'review.local', 'task.dispatch.ci_runner', 'task.dispatch.nexus_participant', 'review.trident_panel', 'hive.dispatch_job']);
    expect(taskIdOf(DRAFT)).toBe(`tk${DRAFT}`);
    // What only Will files: the two switches, stopping and overruling, and a dispatch that spends.
    expect([...TASK_WILL_ONLY].sort()).toEqual(['asset.enable', 'review.enforce', 'task.bar_override', 'task.cancel', 'task.dispatch.nexus_participant']);
    expect(TASK_WILL_ONLY.has(PAID_DISPATCH)).toBe(true);
  });

  it('a dispatch card is the whole task, strictly: money a whole number in hundreds, a step only with its goal, a time to the millisecond', () => {
    expect(TaskDispatchArgs.safeParse(dispatch()).success).toBe(true);
    expect(TaskDispatchArgs.safeParse(dispatch({ estCostMicros: 250_000, dueAt: '2026-11-01T00:00:00.000Z', goalId: 'goabcdef12', stepKey: 's3' })).success).toBe(true);
    for (const over of [
      { estCostMicros: 0.5 }, { estCostMicros: 150 }, { estCostMicros: -100 }, { stepKey: 's3' }, { dueAt: '2026-11-01T00:00:00Z' }, { dueAt: 'tomorrow' },
      { taskId: 'task1' }, { assetKind: 'hive_bot' }, { assetKind: 'local_reviewer' }, { title: ' ' }, { sensitivity: 'secret' }, { note: 'also do this' },
      { spec: { template: 'watch_ci', params: { item: 'e1', sha: null }, prompt: 'x' } }, { acceptance: [] },
    ]) expect(TaskDispatchArgs.safeParse(dispatch(over)).success, JSON.stringify(over)).toBe(false);
    const without = (key: string) => Object.fromEntries(Object.entries(dispatch()).filter(([k]) => k !== key));
    for (const key of Object.keys(dispatch())) expect(TaskDispatchArgs.safeParse(without(key)).success, key).toBe(false);
  });

  it('the other cards are ids, counts and a switch: nothing else is taken', () => {
    const asset = { assetId: 'as-ci-watcher-v1', kind: 'ci_runner', externalRef: 'github:ci:v1', name: 'CI Watcher', capabilities: ['watch_ci'], dispatchAction: 'task.dispatch.ci_runner', spends: false, entityId: null };
    expect(AssetEnableArgs.safeParse(asset).success).toBe(true);
    // The item it stands for is always said (null for none): the database compares it with the asset's row.
    expect(AssetEnableArgs.safeParse({ ...asset, entityId: 'en1' }).success).toBe(true);
    expect(AssetEnableArgs.safeParse((({ entityId: _none, ...rest }) => rest)(asset)).success).toBe(false);
    expect(AssetEnableArgs.safeParse({ ...asset, entityId: 'not an id' }).success).toBe(false);
    expect(AssetEnableArgs.safeParse({ ...asset, dispatchAction: 'task.dispatch.local_worker' }).success).toBe(false);
    expect(AssetEnableArgs.safeParse({ ...asset, capabilities: ['Run Anything'] }).success).toBe(false);
    expect(AssetEnableArgs.safeParse({ ...asset, enabled: true }).success).toBe(false);
    expect(ReviewEnforceArgs.safeParse({ gate: 'proposal', enforced: true }).success).toBe(true);
    expect(ReviewEnforceArgs.safeParse({ gate: 'task', enforced: true }).success).toBe(false);
    // The accept card names the result it accepts, by the start of its output's digest, and that it met its bar.
    const accept = { taskId: TASK, outputRef: outputRefOf('ab12'.repeat(16)), metBar: true, checks: 3, met: 3, by: 'flint:rule' };
    expect(accept.outputRef).toBe('out:ab12ab12ab12ab12');
    expect(TaskAcceptArgs.safeParse(accept).success).toBe(true);
    expect(TaskAcceptArgs.safeParse({ ...accept, met: 2 }).success).toBe(false);
    expect(TaskAcceptArgs.safeParse({ ...accept, by: 'will' }).success).toBe(false);
    expect(TaskAcceptArgs.safeParse({ ...accept, title: 'x' }).success).toBe(false);
    expect(TaskAcceptArgs.safeParse({ ...accept, metBar: false }).success).toBe(false);
    for (const outputRef of ['out:ab12', 'job:ab12ab12ab12ab12', 'out:AB12AB12AB12AB12', `out:${'a'.repeat(65)}`, null]) expect(TaskAcceptArgs.safeParse({ ...accept, outputRef }).success, String(outputRef)).toBe(false);
    for (const key of ['outputRef', 'metBar']) expect(TaskAcceptArgs.safeParse(Object.fromEntries(Object.entries(accept).filter(([k]) => k !== key))).success, key).toBe(false);
    for (const n of [12, 16, 64]) expect(OutputRef.safeParse(`out:${'0'.repeat(n)}`).success, String(n)).toBe(true);
    expect(TaskCancelArgs.safeParse({ taskId: TASK }).success).toBe(true);
    expect(TaskCancelArgs.safeParse({ taskId: TASK, reason: 'x' }).success).toBe(false);
    expect(TaskOverrideArgs.safeParse({ taskId: TASK, to: 'accepted' }).success).toBe(true);
    expect(TaskOverrideArgs.safeParse({ taskId: TASK, to: 'cancelled' }).success).toBe(false);
  });

  it('a task\'s forecast names its task and its rule, and nothing else', () => {
    expect(TaskForecastSpec.parse({ taskId: TASK, rule: TASK_FORECAST_RULE })).toEqual({ taskId: TASK, rule: 'task_meets_bar' });
    for (const bad of [{ taskId: TASK }, { rule: 'task_meets_bar' }, { taskId: TASK, rule: 'goal_done_by' }, { taskId: 'task1', rule: 'task_meets_bar' }, { taskId: TASK, rule: 'task_meets_bar', owner: 'runtime:tasks' }]) {
      expect(TaskForecastSpec.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('text that the database cannot store is refused where Will signs it, never changed', () => {
    for (const s of ['plain words', 'an emoji \u{1F600} is a whole pair', 'tab\tand newline\n are fine']) expect(isStorable(s), s).toBe(true);
    for (const s of ['a nul \u0000 inside', 'half a pair \uD83D at the end', '\uDE00 the other half first']) expect(isStorable(s), JSON.stringify(s)).toBe(false);
    expect(TaskSpec.safeParse({ template: 'draft_note', params: { about: 'What to write\u0000' } }).success).toBe(false);
    expect(TaskSpec.safeParse({ template: 'sort_items', params: { items: ['e1'], labels: ['Now', 'Later\uD83D'] } }).success).toBe(false);
    expect(TaskDispatchArgs.safeParse(dispatch({ title: 'Watch a CI Run\u0000' })).success).toBe(false);
  });

  it('the panel\'s wire is strict too', () => {
    expect(NewTaskBody.parse({ draftKey: DRAFT, template: 'watch_ci', params: { item: 'e1' } })).toEqual({ draftKey: DRAFT, template: 'watch_ci', params: { item: 'e1' }, goalId: null, dueAt: null, ownCheck: null });
    expect(NewTaskBody.safeParse({ draftKey: DRAFT, template: 'watch_ci', params: {}, taskId: TASK }).success).toBe(false);
    expect(NewTaskBody.safeParse({ draftKey: 'short', template: 'watch_ci', params: {} }).success).toBe(false);
    const row = { id: TASK, title: 'Watch a CI Run', about: 'wpf002/flint CI', status: 'queued', line: 'It’s next in line.', runsOn: 'CI Watcher', outside: false, costs: false, createdAt: '2026-10-12T10:00:00.000Z' };
    expect(TasksPage.safeParse({ tasks: [row], more: false }).success).toBe(true);
    expect(TasksPage.safeParse({ tasks: [{ ...row, spec: {} }], more: false }).success).toBe(false);
    const open = { ...row, result: null, checks: [{ id: 'a1', name: 'CI Run Passed', state: 'waiting' }], checkedBy: null, askedBy: 'you', goalId: null, dueAt: null, chance: { likelihood: 'about_even', percent: 50 }, cost: null, card: null, can: { cancel: true, accept: false, reject: false } };
    expect(TaskAnswer.safeParse({ task: open }).success).toBe(true);
    expect(TaskAnswer.safeParse({ task: { ...open, output: { raw: true } } }).success).toBe(false);
    const asset = { id: 'as-ci-watcher-v1', name: 'CI Watcher', kind: 'ci_runner', on: false, waiting: false, line: 'Flint reports how your CI runs end.', canTurnOn: true, costs: false };
    expect(AssetsPage.safeParse({ assets: [asset], reviewsRequired: false }).success).toBe(true);
    expect(AssetsPage.safeParse({ assets: [{ ...asset, approvalId: 'ap1' }], reviewsRequired: false }).success).toBe(false);
  });
});

describe('what Will reads', () => {
  const standing = (over: Partial<TaskStanding>): TaskStanding => ({ status: 'queued', assetKind: 'ci_runner', failure: null, checks: null, overridden: false, waitingForWill: false, declined: false, ...over });

  it('a task\'s line says where it stands, from counts and classes alone', () => {
    expect(taskLine(standing({ status: 'proposed' }))).toBe('It’s waiting for your approval.');
    expect(taskLine(standing({ status: 'dispatched' }))).toBe('Flint is watching for the run.');
    expect(taskLine(standing({ status: 'running', assetKind: 'local_worker' }))).toBe('The local model is working on it.');
    expect(taskLine(standing({ status: 'running', assetKind: 'nexus_participant' }))).toBe('It’s running.');
    expect(taskLine(standing({ status: 'checking' }))).toBe('Flint is checking the result.');
    expect(taskLine(standing({ status: 'checking', waitingForWill: true }))).toBe('It passed its checks and is waiting for you.');
    expect(taskLine(standing({ status: 'accepted', checks: { total: 3, met: 3 } }))).toBe('It passed 3 of 3 checks.');
    expect(taskLine(standing({ status: 'accepted', checks: { total: 1, met: 1 } }))).toBe('It passed 1 of 1 check.');
    expect(taskLine(standing({ status: 'rejected', checks: { total: 3, met: 2 } }))).toBe('It failed 1 of 3 checks.');
    expect(taskLine(standing({ status: 'accepted', checks: { total: 3, met: 2 }, overridden: true }))).toBe('You accepted it.');
    expect(taskLine(standing({ status: 'rejected', checks: { total: 3, met: 3 }, overridden: true }))).toBe('You rejected it.');
    expect(taskLine(standing({ status: 'failed', failure: 'expired' }))).toBe('It wasn’t finished by its due date.');
    // It passed, and he turned its accept card down or let it lapse: said as that, not as a missed date.
    expect(taskLine(standing({ status: 'failed', failure: 'expired', declined: true }))).toBe('You didn’t accept its result.');
    expect(taskLine(standing({ status: 'cancelled' }))).toBe('It was cancelled.');
  });

  it('every sentence is fit to show: a complete sentence with no id, name, path or parentheses; every label is in Title Case', () => {
    const lines = [
      ...Object.values(TASK_SAYS), ...Object.values(TASK_STATUS_SAYS), ...Object.values(TASK_FAILURE_SAYS), ...Object.values(TASK_REASONS),
      ...TASK_STATUSES.flatMap((status) => ASSET_KINDS.flatMap((assetKind) => [null, ...TASK_FAILURES].flatMap((failure) => [null, { total: 3, met: 2 }].flatMap((checks) =>
        [true, false].flatMap((overridden) => [true, false].flatMap((waitingForWill) => [true, false].map((declined) => taskLine({ status, assetKind, failure, checks, overridden, waitingForWill, declined })))))))),
    ];
    for (const line of new Set(lines)) expect(noteProblems('A Title', line), line).toEqual([]);
    for (const name of Object.values(CHECK_NAMES)) {
      expect(noteProblems(name, ''), name).toEqual([]);
      expect(titleCase(name), name).toBe(name);
    }
    expect(Object.keys(TASK_STATUS_SAYS).sort()).toEqual([...TASK_STATUSES].sort());
    expect(Object.keys(TASK_FAILURE_SAYS).sort()).toEqual([...TASK_FAILURES].sort());
  });

  it('a refusal travels as a code from a closed set, and back', () => {
    for (const [code, sentence] of Object.entries(TASK_SAYS)) {
      expect(taskCodeOf(sentence), code).toBe(code);
      expect(taskSayOf(code)).toBe(sentence);
    }
    expect(new Set(Object.values(TASK_SAYS)).size).toBe(Object.keys(TASK_SAYS).length);
    expect(taskSayOf('status.proposed')).toBe(TASK_STATUS_SAYS.proposed);
    expect(taskCodeOf(TASK_STATUS_SAYS.cancelled)).toBe('status.cancelled');
    expect(taskSayOf('status.nowhere') ?? taskSayOf('constructor') ?? taskSayOf(7)).toBeUndefined();
    expect(taskCodeOf('A sentence of someone else’s.')).toBeUndefined();
  });
});
