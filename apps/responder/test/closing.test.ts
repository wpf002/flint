import { describe, it, expect } from 'vitest';
import { MAX_REVIEW_ROUNDS, namesReview, needsPassingRun, refuseClose, refuseUnreviewed, refuseUnstyled, VISUAL_REVIEW } from '../src/closing.js';

/* The fourth build put "visual review" in its commands, and the refusal read as a failed review. */
describe('namesReview', () => {
  it('recognises the review asked for as a command, however it is split', () => {
    expect(namesReview(['visual', 'review'])).toBe(true);
    expect(namesReview(['visual review'])).toBe(true);
    expect(namesReview(['Visual', 'Review', 'desktop'])).toBe(true);
  });

  it('leaves real commands alone', () => {
    expect(namesReview(['screenshot', 'server.js', '/'])).toBe(false);
    expect(namesReview(['npm', 'test'])).toBe(false);
    expect(namesReview(['node', 'visual-review.js'])).toBe(false);
  });
});

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

  it('refuses when the last test run failed', () => {
    expect(refuseClose(BUILD_GOAL, [[ok('npm install'), failed('npm test')]])).toMatch(/failed at `npm test`/);
  });

  it('refuses runs that never included the tests', () => {
    expect(refuseClose(BUILD_GOAL, [[ok('npm install')]])).toMatch(/included the tests/);
  });

  it('allows a close once the tests pass', () => {
    expect(refuseClose(BUILD_GOAL, [[ok('npm install'), ok('npm test')]])).toBeNull();
  });

  /* The third build's check that an unknown city exits 1 blocked the close for three turns. */
  it('ignores a smoke check that fails on purpose', () => {
    expect(refuseClose(BUILD_GOAL, [[ok('npm test'), failed('node bin/forecast.js Nonexistentcity')]])).toBeNull();
  });

  it('judges the newest run that included tests, even if later turns ran other things', () => {
    expect(refuseClose(BUILD_GOAL, [[ok('node bin/forecast.js Chicago')], [ok('npm test')]])).toBeNull();
    expect(refuseClose(BUILD_GOAL, [[ok('node bin/forecast.js Chicago')], [failed('npm test')]])).toMatch(/failed/);
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

/*
 * The third build's stylesheet was clean and its button ran off a phone screen. Every
 * participant read the CSS; nobody saw the page.
 */
describe('refuseUnreviewed', () => {
  const GOAL = 'Build forecast. GET / serves one HTML page. `npm test` passes.';
  const PAGE = [{ name: 'server.js', content: '<!doctype html><html><body></body></html>' }];
  const review = (ok: boolean, output = ok ? 'Ship it.' : 'Phone: the button overflows.') => ({ command: VISUAL_REVIEW, ok, output });
  const tests = { command: 'npm test', ok: true, output: '' };

  it('refuses a page nobody has looked at', () => {
    expect(refuseUnreviewed(GOAL, PAGE, [[tests]], false)).toMatch(/Nobody has looked/);
  });

  it('passes on the review\'s fixes', () => {
    expect(refuseUnreviewed(GOAL, PAGE, [[tests, review(false)]], false)).toMatch(/button overflows/);
  });

  it('accepts a page whose latest review passed', () => {
    expect(refuseUnreviewed(GOAL, PAGE, [[tests], [review(true)]], false)).toBeNull();
  });

  it('judges the newest review, not the first good one', () => {
    expect(refuseUnreviewed(GOAL, PAGE, [[review(false)], [review(true)]], false)).toMatch(/asked for fixes/);
  });

  /* A review of the page as it was is not a review of the page as it is. */
  it('refuses a turn that changed the page without looking at the change', () => {
    expect(refuseUnreviewed(GOAL, PAGE, [[], [review(true)]], true)).toMatch(/changed the page/);
  });

  it('says nothing about a build with no page', () => {
    expect(refuseUnreviewed('Build csv2md, a CLI. `npm test` passes.', [{ name: 'src/cli.js', content: 'x' }], [[tests]], false)).toBeNull();
  });

  /* The third aqi run spent sixteen review rounds, and its whole turn cap, on one phone chart. */
  it('stops holding the build once enough reviews have asked for fixes', () => {
    const rounds = Array.from({ length: MAX_REVIEW_ROUNDS }, () => [review(false)]);
    expect(refuseUnreviewed(GOAL, PAGE, rounds.slice(1), false)).toMatch(/asked for fixes/);
    expect(refuseUnreviewed(GOAL, PAGE, rounds, false)).toBeNull();
  });

  it('still wants a changed page looked at after that', () => {
    const rounds = Array.from({ length: MAX_REVIEW_ROUNDS }, () => [review(false)]);
    expect(refuseUnreviewed(GOAL, PAGE, [[], ...rounds], true)).toMatch(/changed the page/);
  });
});
