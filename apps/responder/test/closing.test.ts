import { describe, it, expect } from 'vitest';
import { needsPassingRun, refuseClose } from '../src/closing.js';

/*
 * The first real product build ended on turn 1: asked to confirm three Node APIs,
 * Perplexity (API) answered and marked the thread done before a file existed.
 */

const BUILD_GOAL =
  "Build csv2md. It's done when all of these hold: `npm test` passes in the build sandbox; README.md explains usage.";

describe('needsPassingRun', () => {
  it.each([
    [BUILD_GOAL, true],
    ['Ship the parser once pnpm test is green', true],
    ['Make sure the tests pass before merging', true],
    ['Run node --test on the CLI', true],
    ['Pick a message queue for the digest', false],
    ['Standup for 2026-09-13: how this group is working, and what should change', false],
    ['Write a test plan for the onboarding flow', false],
  ])('%s → %s', (goal, expected) => {
    expect(needsPassingRun(goal)).toBe(expected);
  });
});

describe('refuseClose', () => {
  const ok = (command: string) => ({ command, ok: true, output: '' });
  const failed = (command: string) => ({ command, ok: false, output: 'boom' });

  it('refuses when nothing has run', () => {
    expect(refuseClose(BUILD_GOAL, [])).toMatch(/nothing has been run/);
  });

  it('refuses when the last run failed', () => {
    expect(refuseClose(BUILD_GOAL, [ok('npm install'), failed('npm test')])).toMatch(/failed at `npm test`/);
  });

  it('refuses a passing run that ran no tests', () => {
    expect(refuseClose(BUILD_GOAL, [ok('npm install')])).toMatch(/included no tests/);
  });

  it('allows a close once the tests pass', () => {
    expect(refuseClose(BUILD_GOAL, [ok('npm install'), ok('npm test')])).toBeNull();
  });

  it('never gets in the way of a goal with no check', () => {
    expect(refuseClose('Pick a message queue', [])).toBeNull();
  });
});
