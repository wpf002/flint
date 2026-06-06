import { describe, it, expect } from 'vitest';
import { checkVoice } from '../src/index.js';

describe('checkVoice', () => {
  it('passes clean, answer-first Flint output', () => {
    const r = checkVoice('Use SQS. Kafka only earns its complexity with replay or high fan-out.');
    expect(r.passed).toBe(true);
    expect(r.score).toBe(1);
  });

  it('flags banned phrases', () => {
    const r = checkVoice("Great question! It's important to note this is powerful.");
    expect(r.passed).toBe(false);
    const banned = r.violations.filter((v) => v.rule === 'banned-phrase').map((v) => v.detail);
    expect(banned).toContain('Great question');
    expect(banned).toContain("It's important to note");
    expect(banned).toContain('powerful');
  });

  it('flags opening with a question instead of an answer', () => {
    const r = checkVoice('Are you sure you want Kafka? It is complex.');
    expect(r.violations.some((v) => v.rule === 'answer-first')).toBe(true);
  });

  it('flags uncommitted "it depends"', () => {
    const r = checkVoice('It depends. Both are fine.');
    expect(r.violations.some((v) => v.rule === 'no-both-sidesing')).toBe(true);
  });

  it('flags the "it\'s not X, it\'s Y" construction', () => {
    const r = checkVoice("It's not a bug, it's a feature.");
    expect(r.violations.some((v) => v.rule === 'no-not-x-its-y')).toBe(true);
  });

  it('score decreases with more violations', () => {
    const clean = checkVoice('Pick A. You will outgrow B.');
    const dirty = checkVoice("Great question! Let's dive in. It's important to note this.");
    expect(dirty.score).toBeLessThan(clean.score);
  });
});
