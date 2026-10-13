import { describe, expect, it } from 'vitest';
import { LONG_CONVERSATION } from '@flint/core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROUTE_FIELDS, attribution, chatOutcome, movedBy, routeLine, servedBy, type RouteRecord } from '../src/route-log';

describe('movedBy', () => {
  // 2026-09-30: greetings sent to test the routine tier were answered by Opus 5.5,
  // and nothing in the log said whether the tool router had moved them.
  it('names a confident tool match as what moved a routine one-liner to standard', () => {
    expect(movedBy('hi Flint', 'standard', { toolsLikely: true })).toBe('tools');
  });

  it('names a deep thread, and both when both apply', () => {
    expect(movedBy('thanks', 'standard', { toolsLikely: false, turns: LONG_CONVERSATION })).toBe('deep thread');
    expect(movedBy('thanks', 'standard', { toolsLikely: true, turns: LONG_CONVERSATION })).toBe('tools+deep thread');
  });

  it('is undefined when the words alone give the same tier', () => {
    expect(movedBy('hi Flint', 'routine', { toolsLikely: false })).toBeUndefined();
    expect(movedBy('Explain the birthday paradox.', 'standard', { toolsLikely: true })).toBeUndefined();
  });
});

describe('routeLine', () => {
  const rec: RouteRecord = {
    path: 'chat',
    tier: 'standard',
    movedBy: 'tools',
    appended: [{ name: 'gcal_upcoming', score: 0.5612345 }],
    turns: 2,
    brain: 'frontier',
    answeredBy: 'anthropic:claude-opus-5-5',
    outcome: 'answered',
    ms: 1840,
  };

  it('is one tagged line of JSON with a timestamp and rounded scores', () => {
    const line = routeLine(rec, Date.UTC(2026, 8, 30, 14, 0, 0));
    expect(line.startsWith('[route] ')).toBe(true);
    expect(line).not.toContain('\n');
    const parsed = JSON.parse(line.slice('[route] '.length));
    expect(parsed.ts).toBe('2026-09-30T14:00:00.000Z');
    expect(parsed.appended).toEqual([{ name: 'gcal_upcoming', score: 0.561 }]);
    expect(parsed).toMatchObject({ path: 'chat', tier: 'standard', movedBy: 'tools', answeredBy: 'anthropic:claude-opus-5-5', outcome: 'answered' });
  });

  // It is written for every message, so it must never carry what the user wrote.
  it('carries only routing facts, never message text or a conversation id', () => {
    const parsed = JSON.parse(routeLine(rec).slice('[route] '.length));
    expect(Object.keys(parsed).sort()).toEqual(
      ['answeredBy', 'appended', 'brain', 'movedBy', 'ms', 'outcome', 'path', 'tier', 'ts', 'turns'].sort(),
    );
  });

  // While the breaker has an outside provider paused, the line says who really answered: the
  // local model, by name, with the reason as a code (./frontier-breaker).
  it('a turn the breaker moved to the local model names it as the answerer, with the reason code', () => {
    const paused: RouteRecord = { path: 'generate', tier: 'hard', appended: [], brain: 'local', paused: 'anthropic:credit', ...attribution('answered', 'muse-glimmer:30b'), outcome: 'answered', ms: 900 };
    const parsed = JSON.parse(routeLine(paused).slice('[route] '.length));
    expect(parsed).toMatchObject({ tier: 'hard', brain: 'local', paused: 'anthropic:credit', answeredBy: 'muse-glimmer:30b', outcome: 'answered' });
    expect(parsed).not.toHaveProperty('tried');
    // A code, never the provider's words.
    expect(routeLine(paused)).not.toMatch(/balance|credit balance|too low/i);
  });

  // Which exact prompt answered (./style-variant promptRevision): a hash, so runs before and after a
  // prompt change can be told apart in the log.
  it('carries the prompt revision of the persona that was asked', () => {
    const parsed = JSON.parse(routeLine({ ...rec, promptRev: '3fa9c1d2' }).slice('[route] '.length));
    expect(parsed.promptRev).toBe('3fa9c1d2');
  });

  // Plan 3.0.8: what each context block adds to a frontier prompt is measured, as a count.
  it('carries the context blocks\' token estimates when there are any', () => {
    const parsed = JSON.parse(routeLine({ ...rec, ctxTokens: { world: 118 } }).slice('[route] '.length));
    expect(parsed.ctxTokens).toEqual({ world: 118 });
  });
});

describe('chatOutcome', () => {
  const base = { aborted: false, failed: false, streamErrored: false, gaveUp: false, answer: '' };

  // A provider failure (Ollama down, every tier 5xx) reaches /chat as a streamed
  // error event, not a throw; it used to be logged as an empty reply.
  it('calls a streamed error an error, even after some text went out', () => {
    expect(chatOutcome({ ...base, streamErrored: true })).toBe('error');
    expect(chatOutcome({ ...base, streamErrored: true, answer: 'Partial' })).toBe('error');
    expect(chatOutcome({ ...base, failed: true })).toBe('error');
  });

  it('calls a closed tab aborted, whatever else happened', () => {
    expect(chatOutcome({ ...base, aborted: true, streamErrored: true })).toBe('aborted');
  });

  it('tells the honest message, an answer and an empty reply apart', () => {
    expect(chatOutcome({ ...base, gaveUp: true, answer: 'No model I tried answered that.' })).toBe('unanswered');
    expect(chatOutcome({ ...base, answer: 'Morning.' })).toBe('answered');
    expect(chatOutcome({ ...base, answer: '  ' })).toBe('empty');
  });
});

describe('attribution', () => {
  it('names the last brain tried as the answerer only when it answered', () => {
    expect(attribution('answered', 'anthropic:claude-sonnet-5-5')).toEqual({ answeredBy: 'anthropic:claude-sonnet-5-5' });
    for (const o of ['error', 'empty', 'unanswered', 'aborted'] as const) {
      expect(attribution(o, 'anthropic:claude-opus-5-5')).toEqual({ tried: 'anthropic:claude-opus-5-5' });
    }
  });

  // A frontier turn that failed before any brain ran used to be credited to the local model.
  it('names nobody when no brain was asked', () => {
    expect(attribution('error', undefined)).toEqual({});
  });
});


describe('which provider served a turn, and why', () => {
  const base: RouteRecord = { path: 'chat', tier: 'standard', appended: [], brain: 'local', outcome: 'answered', ms: 900 };

  it('the line carries the mode, the rule that decided, and the adapter that served', () => {
    const line = routeLine({ ...base, mode: 'hybrid', reason: 'default', answeredBy: 'muse-glimmer:30b', provider: 'ollama' }, Date.parse('2026-10-12T15:04:05.000Z'));
    expect(JSON.parse(line.slice('[route] '.length))).toEqual({
      ts: '2026-10-12T15:04:05.000Z',
      path: 'chat',
      mode: 'hybrid',
      reason: 'default',
      tier: 'standard',
      appended: [],
      brain: 'local',
      answeredBy: 'muse-glimmer:30b',
      provider: 'ollama',
      outcome: 'answered',
      ms: 900,
    });
  });

  it('a line written before the modes existed is still a valid line: the new fields are optional', () => {
    const rec = JSON.parse(routeLine(base).slice('[route] '.length)) as Record<string, unknown>;
    expect('mode' in rec || 'reason' in rec || 'provider' in rec).toBe(false);
  });

  it('servedBy: the local brain\'s own adapter for a local answer, the label\'s provider for a frontier one', () => {
    expect(servedBy('answered', 'local', 'muse-glimmer:30b', 'ollama')).toEqual({ provider: 'ollama' });
    expect(servedBy('answered', 'local', 'muse-glimmer:30b', 'local')).toEqual({ provider: 'local' });
    expect(servedBy('answered', 'frontier', 'anthropic:claude-opus-5-5', 'ollama')).toEqual({ provider: 'anthropic' });
    expect(servedBy('answered', 'frontier', 'ollama:qwen2.5:72b', 'ollama')).toEqual({ provider: 'ollama' });
    expect(servedBy('answered', 'frontier', 'local:big-model', 'ollama')).toEqual({ provider: 'local' });
  });

  it('servedBy names nobody when nobody answered', () => {
    for (const o of ['error', 'empty', 'unanswered', 'aborted'] as const) expect(servedBy(o, 'local', 'muse-glimmer:30b', 'ollama')).toEqual({});
    expect(servedBy('answered', 'local', undefined, 'ollama')).toEqual({});
    expect(servedBy('answered', 'frontier', 'no-such-provider:x', 'ollama')).toEqual({});
  });

  it('a route record has no field that could hold what Will wrote', () => {
    // routeLine is given enums, numbers, tool names and model labels: nothing in a full record is free text.
    const full: RouteRecord = {
      path: 'generate', mode: 'local', reason: 'mode_local', tier: 'hard', movedBy: 'tools', appended: [{ name: 'web.web_search', score: 0.7 }], turns: 3, planTier: 'routine',
      brain: 'local', paused: 'anthropic:credit', tried: 'muse-glimmer:30b', outcome: 'error', declined: 1, ms: 5, eval: true, recall: 'semantic', ctxTokens: { world: 12 },
      local: { which: 'fallback', state: 'loading', firstTokenMs: 180 }, fellTo: 'fallback', private: true, fit: { window: 8192, dropped: 6, kept: 5, toolsShed: 2 },
    };
    const keys = Object.keys(JSON.parse(routeLine(full).slice('[route] '.length)) as object).sort();
    expect(keys).toEqual(['appended', 'brain', 'ctxTokens', 'declined', 'eval', 'fellTo', 'fit', 'local', 'mode', 'movedBy', 'ms', 'outcome', 'path', 'paused', 'planTier', 'private', 'reason', 'recall', 'tier', 'tried', 'ts', 'turns']);
    // What a local prompt left out is numbers, never a tool's name or a message.
    expect(JSON.parse(routeLine(full).slice('[route] '.length)).fit).toEqual({ window: 8192, dropped: 6, kept: 5, toolsShed: 2 });
    for (const k of keys) expect(k).not.toMatch(/message|prompt|text|content|answer$/);
  });

  it('a standby answer: which local model, the main model\'s state, time to first token, and what the turn fell to', () => {
    const line = routeLine({ ...base, mode: 'hybrid', reason: 'default', answeredBy: 'qwen2.5:7b', provider: 'ollama', local: { which: 'fallback', state: 'loading', firstTokenMs: 180 }, fellTo: 'fallback' });
    const rec = JSON.parse(line.slice('[route] '.length)) as Record<string, unknown>;
    expect(rec.local).toEqual({ which: 'fallback', state: 'loading', firstTokenMs: 180 });
    expect(rec.fellTo).toBe('fallback');
    // Enums and a number: nothing a model or Will wrote.
    expect(Object.keys(rec.local as object).sort()).toEqual(['firstTokenMs', 'state', 'which']);
  });
});

// The review's survivor 6. The line is written for every message, and nothing stopped a caller from spreading the
// message into the record: `...({ message: prompt } as object)` at either call site compiled, passed every test, and
// put Will's words in the log. The line is now BUILT from a list of fields, so what is not on the list cannot be in it.
describe('a [route] line is built from an allow-list of fields', () => {
  const SECRET = 'ZEBRA-7781 what Will actually typed';
  const base: RouteRecord = { path: 'chat', tier: 'standard', appended: [], brain: 'local', outcome: 'answered', ms: 12 };
  const parsed = (r: unknown): Record<string, unknown> => JSON.parse(routeLine(r as RouteRecord, 0).slice('[route] '.length)) as Record<string, unknown>;

  it('a field that is not on the list is never written, whatever it is called and however it got into the record', () => {
    const smuggled = { ...base, message: SECRET, prompt: SECRET, input: SECRET, text: SECRET, answer: SECRET, output: SECRET, content: SECRET, conversationId: 'c-1', context: { private: true, note: SECRET }, anything: [SECRET] };
    const line = routeLine(smuggled as unknown as RouteRecord);
    expect(line).not.toContain('ZEBRA');
    expect(line).not.toContain('c-1');
    expect(Object.keys(parsed(smuggled)).sort()).toEqual(['appended', 'brain', 'ms', 'outcome', 'path', 'tier', 'ts']);
    // The exact edit the review made at the two call sites.
    expect(routeLine({ ...base, ...({ message: SECRET } as object) })).not.toContain('ZEBRA');
  });

  it('the list is the record\'s own fields: every one can be written, and no other', () => {
    expect([...ROUTE_FIELDS].sort()).toEqual(
      ['answeredBy', 'appended', 'brain', 'ctxTokens', 'declined', 'eval', 'fellTo', 'fit', 'local', 'mode', 'movedBy', 'ms', 'outcome', 'path', 'paused', 'planTier', 'private', 'promptRev', 'provider', 'reason', 'recall', 'tier', 'tried', 'turns'].sort(),
    );
    // (`promptRev` is a hash of the style guide in use, eight hex characters: not a prompt.)
    for (const f of ROUTE_FIELDS.filter((x) => x !== 'promptRev')) expect(f).not.toMatch(/message|prompt|text|content|input|output|answer$/i);
    // The source holds the list to the type, so a field added to the record is logged only once it is named there.
    expect(readFileSync(join(__dirname, '..', 'src', 'route-log.ts'), 'utf8')).toContain('] as const satisfies ReadonlyArray<keyof RouteRecord>;');
  });

  it('a field on the list carries a short one-line label, a number or a flag: text in its place is left out', () => {
    const long = 'x'.repeat(161);
    for (const field of ['reason', 'movedBy', 'answeredBy', 'tried', 'provider', 'paused', 'planTier', 'recall', 'promptRev', 'brain', 'fellTo'] as const) {
      expect(parsed({ ...base, [field]: `two\nlines ${SECRET}` })[field], field).toBeUndefined();
      expect(parsed({ ...base, [field]: long })[field], field).toBeUndefined();
      expect(parsed({ ...base, [field]: { nested: SECRET } })[field], field).toBeUndefined();
      expect(parsed({ ...base, [field]: 'a-label:1' })[field], field).toBe('a-label:1');
    }
    expect(parsed({ ...base, ms: SECRET, turns: SECRET, declined: [SECRET] })).not.toHaveProperty('turns');
    expect(routeLine({ ...base, ms: SECRET as unknown as number, private: SECRET as unknown as true, eval: SECRET as unknown as boolean })).not.toContain('ZEBRA');
  });

  it('the fields that are objects are rebuilt from the parts they are known to have', () => {
    const r = parsed({
      ...base,
      appended: [{ name: 'web.web_search', score: 0.71234, query: SECRET }, { name: SECRET.repeat(10), score: 1 }, { name: 'no-score' }, SECRET],
      local: { which: 'primary', state: 'loaded', firstTokenMs: 180, prompt: SECRET },
      fit: { window: 8192, dropped: 6, kept: 5, toolsShed: 2, full: true, shed: ['a', SECRET] },
      ctxTokens: { world: 120, goals: 80, [SECRET]: 5, note: SECRET },
    });
    expect(r.appended).toEqual([{ name: 'web.web_search', score: 0.712 }]);
    expect(r.local).toEqual({ which: 'primary', state: 'loaded', firstTokenMs: 180 });
    expect(r.fit).toEqual({ window: 8192, dropped: 6, kept: 5, toolsShed: 2, full: true });
    expect(r.ctxTokens).toEqual({ world: 120, goals: 80 });
    expect(JSON.stringify(r)).not.toContain('ZEBRA');
  });

  it('the server writes a [route] line in one way only: through routeLine, at its two call sites', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'index.ts'), 'utf8');
    expect(src.match(/routeLine\(\{/g)).toHaveLength(2);
    // No line is assembled by hand anywhere in the server.
    for (const file of ['index.ts', 'local-serve.ts', 'inference.ts', 'grounding.ts']) {
      expect(readFileSync(join(__dirname, '..', 'src', file), 'utf8'), file).not.toMatch(/[`'"]\[route\] /);
    }
  });

  it('a whole real record still comes out whole', () => {
    const full: RouteRecord = {
      path: 'generate', mode: 'local', reason: 'mode_local', private: true, tier: 'hard', movedBy: 'tools', appended: [{ name: 'web.web_search', score: 0.7 }], turns: 3, planTier: 'routine',
      brain: 'local', paused: 'anthropic:credit', answeredBy: 'muse-glimmer:30b', provider: 'ollama', local: { which: 'fallback', state: 'loading', firstTokenMs: 180 }, fellTo: 'fallback',
      fit: { window: 8192, dropped: 6, kept: 5, toolsShed: 2 }, promptRev: '4a0011b5', outcome: 'answered', declined: 1, ms: 5, eval: true, recall: 'semantic', ctxTokens: { world: 12 },
    };
    expect(parsed(full)).toEqual({ ts: '1970-01-01T00:00:00.000Z', ...full });
    expect(Object.keys(parsed(full))).toEqual(['ts', ...ROUTE_FIELDS.filter((f) => f !== 'tried')]);
  });
});

