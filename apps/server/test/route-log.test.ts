import { describe, expect, it } from 'vitest';
import { LONG_CONVERSATION } from '@flint/core';
import { attribution, chatOutcome, movedBy, routeLine, type RouteRecord } from '../src/route-log';

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

