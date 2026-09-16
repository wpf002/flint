import { describe, it, expect } from 'vitest';
import { MAX_REVIEW_ROUNDS, namesReview, needsPassingRun, refuseClose, refuseUnreviewed, refuseUnstyled, REVIEW_FIX_TURNS, skippedStep, stepFor, unappliedReview, VISUAL_REVIEW } from '../src/closing.js';

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

  /* The fourth aqi run's review passed a 17px text field and a 2:1 button three times. */
  const shot = (problems: string[]) => ({
    command: 'screenshot server.js /',
    ok: true,
    output: `Rendered /: desktop 1280x800, mobile 375x812.${problems.length ? `\nMeasured on the phone view (dark mode):\n${problems.map((p) => `- ${p}`).join('\n')}` : ''}`,
  });

  it('holds a build the review passed while the phone view measures a problem', () => {
    const refused = refuseUnreviewed(GOAL, PAGE, [[shot(['input#city is 17px tall; controls on a phone need to be at least 44px.']), review(true)]], false);
    expect(refused).toMatch(/measured and still has problems/);
    expect(refused).toContain('On /: input#city is 17px tall');
  });

  it('lets it close once the newest screenshots measure clean', () => {
    const history = [[shot([]), review(true)], [shot(['input#city is 17px tall.']), review(false)]];
    expect(refuseUnreviewed(GOAL, PAGE, history, false)).toBeNull();
  });

  it('stops holding on measurements the builders could not fix after enough rounds', () => {
    const rounds = Array.from({ length: MAX_REVIEW_ROUNDS + 1 }, () => [shot(['input#city is 17px tall.']), review(true)]);
    expect(refuseUnreviewed(GOAL, PAGE, rounds, false)).toBeNull();
  });
});

describe('skippedStep', () => {
  const goal =
    'How we work: claude, chatgpt and perplexity are chat apps. 1) claude plans, then hands to perplexity. ' +
    '2) perplexity checks the plan and hands to gpt-api. 3) gpt-api and claude-api build it, then hand to chatgpt. ' +
    '4) chatgpt reads the page files and hands to claude-api. 5) gpt-api and claude-api fix and close.';
  const participants = [
    { slug: 'claude', answers_on_its_own: false },
    { slug: 'chatgpt', answers_on_its_own: false },
    { slug: 'perplexity', answers_on_its_own: false },
    { slug: 'claude-api', answers_on_its_own: true },
    { slug: 'gpt-api', answers_on_its_own: true },
  ];

  it('names the first app whose step has not happened, in the order of the plan', () => {
    const turns = [{ by: 'claude' }, { by: 'gpt-api' }, { by: 'claude-api' }];
    expect(skippedStep(goal, participants, turns)).toBe('perplexity');
  });

  it('is satisfied once every named app has taken a turn', () => {
    const turns = [{ by: 'claude' }, { by: 'perplexity' }, { by: 'gpt-api' }, { by: 'chatgpt' }, { by: 'claude-api' }];
    expect(skippedStep(goal, participants, turns)).toBeNull();
  });

  it('counts a step the responder covered after the app missed it', () => {
    const turns = [
      { by: 'claude' },
      { by: 'perplexity' },
      { by: 'gpt-api', kind: 'note' as const, content: 'chatgpt did not take its turn within 90 minutes, so gpt-api is doing its part. The ask is unchanged.' },
      { by: 'gpt-api' },
    ];
    expect(skippedStep(goal, participants, turns)).toBeNull();
  });

  it('does not count a note by the app as its step', () => {
    const turns = [{ by: 'claude', kind: 'note' as const, content: 'step 1 as a note' }, { by: 'perplexity' }, { by: 'chatgpt' }];
    expect(skippedStep(goal, participants, turns)).toBe('claude');
  });

  it('does not read claude-api as claude', () => {
    expect(skippedStep('1) claude-api builds it.', participants, [])).toBeNull();
  });

  it('asks nothing of a thread whose roster has no chat apps', () => {
    expect(skippedStep(goal, participants.filter((p) => p.answers_on_its_own), [])).toBeNull();
  });
});

describe('stepFor', () => {
  const goal = '1) claude plans. 2) perplexity checks and hands to gpt-api. 3) gpt-api and claude-api build. 4) chatgpt reads the page files with artifact_read, gives at most 5 fixes, and hands to claude-api. 5) gpt-api closes.';

  it('returns the step that starts with the participant', () => {
    expect(stepFor(goal, 'chatgpt')).toBe('4) chatgpt reads the page files with artifact_read, gives at most 5 fixes, and hands to claude-api.');
  });

  it('does not match claude inside claude-api', () => {
    expect(stepFor('3) claude-api builds.', 'claude')).toBeNull();
  });
});

describe('unappliedReview', () => {
  const participants = [
    { slug: 'claude', answers_on_its_own: false },
    { slug: 'chatgpt', answers_on_its_own: false },
    { slug: 'claude-api', answers_on_its_own: true },
    { slug: 'gpt-api', answers_on_its_own: true },
  ];
  const review = {
    by: 'chatgpt',
    at: '2026-09-16T21:39:16.875Z',
    content: '1. `public/app.js` — use textContent. 4. `server.js` — return JSON error bodies.',
  };
  const before = '2026-09-16T21:10:00.000Z';
  const after = '2026-09-16T21:40:23.000Z';
  const file = (name: string, ...ats: string[]) => ({ name, history: ats.map((at, i) => ({ version: i + 1, at })) });

  it('names a file the review asked to change that nobody has written since (the eighth aqi run)', () => {
    const found = unappliedReview([{ by: 'claude-api', at: before, content: 'plan' }, review], participants,
      [file('public/app.js', before, after), file('server.js', before), file('README.md', before)], []);
    expect(found).toEqual({ by: 'chatgpt', files: ['server.js'] });
  });

  it('is satisfied when every named file has a version newer than the review', () => {
    expect(unappliedReview([review], participants, [file('public/app.js', after), file('server.js', before, after)], [])).toBeNull();
  });

  it('counts a file this turn is writing', () => {
    expect(unappliedReview([review], participants, [file('public/app.js', after), file('server.js', before)], ['server.js'])).toBeNull();
  });

  it('treats the stand-in that covered a missed review as the reviewer', () => {
    const turns = [
      { by: 'gpt-api', kind: 'note' as const, content: 'chatgpt did not take its turn within 90 minutes, so gpt-api is doing its part. The ask is unchanged.' },
      { by: 'gpt-api', at: review.at, content: review.content },
    ];
    expect(unappliedReview(turns, participants, [file('server.js', before)], [])).toEqual({ by: 'gpt-api', files: ['server.js'] });
  });

  it('stops holding the close after ${REVIEW_FIX_TURNS} builder turns', () => {
    const later = Array.from({ length: REVIEW_FIX_TURNS }, () => ({ by: 'gpt-api', at: after, content: 'x' }));
    expect(unappliedReview([review, ...later], participants, [file('server.js', before)], [])).toBeNull();
  });

  it('does not read src/server.js as server.js', () => {
    const r = { ...review, content: 'Change src/server.js.' };
    expect(unappliedReview([r], participants, [file('server.js', before)], [])).toBeNull();
  });
});
