import { describe, expect, it } from 'vitest';
import type { TaskPrompt } from '../src/tasks.js';
import { scoreToolSelection, summarizeSelection, toolsOf } from '../src/tool-selection.js';

const task = (over: Partial<TaskPrompt>): TaskPrompt => ({
  id: 'x~00000000',
  prompt: 'q',
  category: 'task:x',
  templateId: 'x-lookup-01',
  system: 'x',
  privacy: 'systems',
  slots: {},
  great: 'g',
  tools: { need: [], ok: [] },
  memory: 'incidental',
  ...over,
});

describe('tool selection', () => {
  const brief = task({
    id: 'cross-brief-81~1',
    templateId: 'cross-brief-81',
    system: 'cross',
    tools: { need: [['meridian.bias_summary', 'meridian.get_signals'], ['trident.gcal_upcoming'], ['trident.gmail_search']], ok: ['vantage.*'] },
  });

  it('meets a group with any of its tools, and needs every group', () => {
    const s = scoreToolSelection(brief, ['meridian.get_signals', 'trident.gcal_upcoming', 'trident.gmail_search'], []);
    expect(s).toMatchObject({ correct: true, groupsMet: 3, needGroups: 3, recall: 1, missing: [], extra: [] });
    const partial = scoreToolSelection(brief, ['meridian.bias_summary', 'vantage.top_scores'], []);
    expect(partial).toMatchObject({ correct: false, groupsMet: 1, missing: [['trident.gcal_upcoming'], ['trident.gmail_search']], extra: [] });
    expect(partial.recall).toBeCloseTo(1 / 3);
  });

  it('reports calls outside need and ok as extra, without failing them', () => {
    const s = scoreToolSelection(brief, ['meridian.bias_summary', 'trident.gcal_upcoming', 'trident.gmail_search', 'web.web_search'], []);
    expect(s).toMatchObject({ correct: true, extra: ['web.web_search'] });
  });

  it('fails an unrequested write, even under an `ok` glob, and accepts a write the task names', () => {
    const s = scoreToolSelection(brief, ['meridian.bias_summary', 'trident.gcal_upcoming', 'trident.gmail_search', 'vantage.add_to_watchlist'], ['vantage.add_to_watchlist']);
    // `vantage.*` makes the call not "extra", but a glob never asks for a write.
    expect(s).toMatchObject({ correct: false, extra: [], unrequestedWrites: ['vantage.add_to_watchlist'] });
    const strictTask = task({ tools: { need: [['vantage.top_scores']], ok: [] } });
    expect(scoreToolSelection(strictTask, ['vantage.top_scores', 'vantage.add_to_watchlist'], ['vantage.add_to_watchlist'])).toMatchObject({
      correct: false,
      unrequestedWrites: ['vantage.add_to_watchlist'],
    });
    const addTask = task({ tools: { need: [['vantage.list_watchlists', 'vantage.add_to_watchlist']], ok: ['vantage.add_to_watchlist', 'vantage.list_watchlists'] } });
    expect(scoreToolSelection(addTask, ['vantage.add_to_watchlist'], ['vantage.add_to_watchlist']).correct).toBe(true);
  });

  it('scores a no-tool task correct unless it wrote something', () => {
    const chat = task({ tools: { need: [], ok: [] } });
    expect(scoreToolSelection(chat, ['web.web_search'], [])).toMatchObject({ correct: true, recall: undefined, extra: ['web.web_search'] });
    expect(scoreToolSelection(chat, [], ['trident.gmail_send']).correct).toBe(false);
  });

  it('checks the local route separately', () => {
    const local = task({ route: 'local', tools: { need: [['trident.gcal_upcoming']], ok: [] } });
    expect(scoreToolSelection(local, ['trident.gcal_upcoming'], [], 'local').localRouteHonored).toBe(true);
    expect(scoreToolSelection(local, ['trident.gcal_upcoming'], [], 'frontier').localRouteHonored).toBe(false);
    expect(scoreToolSelection(task({}), [], [], 'frontier').localRouteHonored).toBeUndefined();
  });

  it("reads the called tools from the turn's grounding and the writes from its proposals", () => {
    const row = {
      grounding: {
        memory: [],
        tools: [
          { name: 'vantage.get_score', isError: false, excerpt: '' },
          { name: 'vantage.get_score', isError: false, excerpt: '' },
          { name: 'vantage.add_to_watchlist', isError: false, excerpt: 'requires approval' },
        ],
      },
      meta: { proposed: ['vantage.add_to_watchlist', 7] },
    };
    expect(toolsOf(row)).toEqual({ called: ['vantage.get_score', 'vantage.add_to_watchlist'], proposed: ['vantage.add_to_watchlist'] });
    expect(toolsOf({})).toEqual({ called: [], proposed: [] });
  });

  it('summarizes overall and per system', () => {
    const list = [
      scoreToolSelection(task({ system: 'gmail', tools: { need: [['trident.gmail_search']], ok: [] } }), ['trident.gmail_search'], []),
      scoreToolSelection(task({ system: 'gmail', tools: { need: [['trident.gmail_search']], ok: [] } }), [], []),
      scoreToolSelection(task({ system: 'persona' }), ['web.web_search'], []),
    ];
    const s = summarizeSelection(list);
    expect(s).toMatchObject({ n: 3, correct: 2, withNeeds: 2, allNeedsMet: 1, meanRecall: 0.5, withExtra: 1, unrequestedWrites: 0 });
    expect(s.bySystem.gmail).toMatchObject({ n: 2, correct: 1, allNeedsMet: 1 });
    expect(s.bySystem.persona).toMatchObject({ n: 1, correct: 1, withNeeds: 0, meanRecall: undefined });
  });
});
