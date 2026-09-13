import { describe, it, expect } from 'vitest';
import { needsPassingRun, refuseClose, refuseUnstyled } from '../src/closing.js';

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

/*
 * The second product build shipped a page with no CSS: default controls, a full-grid
 * table, black text on a dark background. Every test passed, because nothing tests how a
 * page looks. This can't judge whether a design is good, only refuse one that is absent.
 */
describe('refuseUnstyled', () => {
  const UI_GOAL = 'Build forecast. GET / serves one HTML page where a person types a city. `npm test` passes.';
  const page = (head: string) => ({ name: 'public/index.html', content: `<!doctype html><html><head>${head}</head><body><h1>7-day Forecast</h1></body></html>` });
  const styled = Array.from({ length: 30 }, (_, i) => `.c${i} { margin: ${i}px; }`).join('\n');
  const withColors = `body { color: #111; background: #fff; }\n${styled}`;

  it('refuses a page with no styling at all', () => {
    expect(refuseUnstyled(UI_GOAL, [page('')])).toMatch(/essentially unstyled/);
  });

  it('refuses a styled page that leaves the colors to the browser', () => {
    expect(refuseUnstyled(UI_GOAL, [page(`<style>${styled}</style>`)])).toMatch(/unreadable in dark mode/);
  });

  it('accepts a styled page with explicit colors', () => {
    expect(refuseUnstyled(UI_GOAL, [page(`<style>${withColors}</style>`)])).toBeNull();
  });

  it('reads a separate stylesheet too', () => {
    expect(refuseUnstyled(UI_GOAL, [page('<link rel="stylesheet" href="app.css">'), { name: 'public/app.css', content: withColors }])).toBeNull();
  });

  /* A CLI has no page to style. */
  it('says nothing about a goal with no interface', () => {
    expect(refuseUnstyled('Build csv2md, a CLI. `npm test` passes.', [{ name: 'src/cli.js', content: 'x' }])).toBeNull();
  });

  it('says nothing when a UI goal has produced no page yet', () => {
    expect(refuseUnstyled(UI_GOAL, [{ name: 'src/server.js', content: 'x' }])).toBeNull();
  });
});
