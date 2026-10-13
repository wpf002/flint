/**
 * Every note the runtime can post to Will, checked against his rules for one
 * (2026-10-12; @flint/policy's noteProblems): a short Title Case title in plain
 * words, complete sentences under it, and never an action's internal name
 * ("backup.offsite"), a file path, a command, an id, raw JSON or an aside in
 * parentheses.
 *
 * The inventory is built from the code: the first test finds every call in
 * src/ that posts a note, so a new producer fails here until it is listed and
 * its words are rendered below.
 *
 *   producer             what it posts
 *   cli.ts               a nightly job failed (backup, offsite copy, restore test)
 *   digest.ts            the morning digest
 *   surface/deliver.ts   an escalation, in its template's words
 *
 * Goal reviews (P3 part 3) post no note of their own. What they add to words
 * Will reads is held to the same rules here: the digest's line about the
 * goals Flint reviewed, what Goal Reviews says in Settings > Health, and the
 * sentences a goal route or a goal card is refused with. The checks of Flint's
 * own predictions (P4 part 2) post none either: what Prediction Checks says in
 * Settings > Health is held to the same rules. So are tasks and assets (P5):
 * what Tasks says in Settings > Health, an asset's line in Settings, and the
 * sentences a card is refused with when it is filed.
 *
 * The server's own notes and the shell scripts' banners have theirs:
 * apps/server/test/notes-inventory.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { GOAL_SAYS, GOAL_STATUS_SAYS, HEALTH_NAMES, JOB_WORDS, jobFailedNote, noteProblems, shownProblems, type NightlyJob } from '@flint/policy';
import { ACTION, nextAfterFailure } from '../src/backup/nightly';
import { digestBody, digestTitle, goalsSentence, questionsSentence } from '../src/digest';
import { DEFERRAL_SAYS } from '../src/goals/batch';
import { DEFERRAL_MARK as OPINION_MARK, DEFERRAL_SAYS as OPINION_WAITED, MISSED_SAYS as OPINION_MISSED } from '../src/predict/reason';
import { REVIEWS_STOPPED } from '../src/goals/late';
import { BACKUP_HEALTH, DATABASE_HEALTH, FORECAST_HEALTH, GOAL_HEALTH, LEDGER_HEALTH, NEXUS_HEALTH, TASK_HEALTH, UPKEEP_HEALTH } from '../src/health/checks';
import { MODEL_HEALTH, REMOTE_HEALTH, diskCheck, remoteAccessCheck } from '../src/health/machine';
import { pruneLines } from '../src/backup/prune-job';
import { NEXUS_OFF } from '../src/backup/nexus';
import { ASSETS } from '../src/assets/registry';
import { WAITING } from '../src/assets/view';
import { SPEND_NEEDS_ESTIMATE, WHOLE_NUMBERS_ONLY } from '../src/governance/proposals';
import { TASK_TITLES } from '../src/tasks/service';
import { noteOf } from '../src/surface/deliver';
import { TEMPLATES, TEMPLATE_IDS, fieldFreeBody, fieldFreeTitle, phrase, render } from '../src/templates/escalations';
import { EDGES } from './surface/template-edges';

const SRC = join(__dirname, '..', 'src');
const sources = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? sources(join(dir, f)) : f.endsWith('.ts') ? [join(dir, f)] : []));

/** Who posts notes, and in how many places. */
const PRODUCERS: Record<string, number> = { 'cli.ts': 1, 'digest.ts': 1, 'surface/deliver.ts': 1 };

/** What Will's screenshot showed, said outright (noteProblems checks these and more). */
const NEVER = [
  /\b[a-z][a-z0-9_]*\.[a-z][a-z0-9_.]*\b/, // a dotted action name: backup.offsite
  /~\/|\/Users\//, // a file path
  /`/, // a command in backticks
  /^\s*[{[]|[{}]/, // raw JSON
];

const seen: Array<{ from: string; title: string; body: string }> = [];
function plain(from: string, title: string, body: string): void {
  seen.push({ from, title, body });
  expect(noteProblems(title, body), `${from}: ${title} / ${body}`).toEqual([]);
  for (const re of NEVER) expect(`${title}\n${body}`, `${from}: ${title} / ${body}`).not.toMatch(re);
}

describe('the runtime’s notes to Will', () => {
  it('are posted by the producers listed here, and by nothing else', () => {
    const found: Record<string, number> = {};
    for (const file of sources(SRC)) {
      const name = relative(SRC, file);
      if (name === 'notify.ts') continue; // the two calls themselves
      const calls = (readFileSync(file, 'utf8').match(/\bnotify(?:Will|Server)\(/g) ?? []).length;
      if (calls) found[name] = calls;
    }
    expect(found).toEqual(PRODUCERS);
  });

  it('cli.ts: a nightly job that failed says what happened and what happens next, by the job’s words', () => {
    const cli = readFileSync(join(SRC, 'cli.ts'), 'utf8');
    // The words are tellFailure's (jobFailedNote's, whole; nightly.test.ts runs it): cli.ts only hands it the way
    // to tell Will, and puts no words together itself.
    expect(cli.match(/notifyWill\(/g)).toHaveLength(1);
    expect(cli).toContain('notify: (title, body) => notifyWill(b.config, title, body),');
    expect(cli).not.toMatch(/notifyWill\([^)]*[`'"]/);
    expect(cli).not.toMatch(/jobFailedNote|needsSetup\(/);
    const jobs = Object.values(ACTION) as NightlyJob[];
    expect(jobs.sort()).toEqual(['backup.local', 'backup.nexus', 'backup.nexus.offsite', 'backup.offsite', 'restore.drill', 'restore.drill.nexus']);
    for (const job of jobs) {
      for (const next of ['retry', 'card', 'card_later', 'setup', 'stopped'] as const) {
        for (const icloud of [true, false]) {
          for (const mismatch of [true, false]) {
            const note = jobFailedNote(job, { next, icloud, mismatch });
            plain(`cli.ts ${job}`, note.title, note.body);
            expect(note.title).toBe(`${JOB_WORDS[job]} Failed`);
            expect(note.title.length).toBeLessThanOrEqual(40);
          }
        }
      }
    }
    // What the note may promise: another try only for a job that runs on its own and can succeed.
    expect(nextAfterFailure({ setup: false, onCard: false, cardFiled: false })).toBe('retry');
    expect(nextAfterFailure({ setup: false, onCard: true, cardFiled: true })).toBe('card');
    expect(nextAfterFailure({ setup: false, onCard: true, cardFiled: false })).toBe('card_later');
    for (const onCard of [true, false]) for (const cardFiled of [true, false]) expect(nextAfterFailure({ setup: true, onCard, cardFiled })).toBe('setup');
  });

  it('digest.ts: the morning digest, for any counts and any component that needs a look', () => {
    const zero = { relevant: 0, quiet: 0, escalated: 0, did: 0, queued: 0, open: 0, due: 0 };
    const counts = [zero, { relevant: 1, quiet: 1, escalated: 1, did: 1, queued: 1, open: 1, due: 1 }, { relevant: 12, quiet: 340, escalated: 3, did: 25, queued: 4, open: 2, due: 7 }];
    const degraded = [[], ['backup'], ['ledger'], ['forecasts', 'ledger'], ['restore_drill', 'source:github'], ['audit_intents', 'backup', 'bus', 'forecasts', 'ledger', 'migrate_failed', 'ollama', 'restore_drill', 'retention', 'server'], ['source:google_calendar', 'source:nexus_inbox', 'health_overdue', 'source:imessage']];
    for (const day of ['2026-10-11', '2026-01-01', '2028-02-29']) {
      expect(digestTitle(day)).toMatch(/^Daily Summary for (Sun|Mon|Tue|Wed|Thu|Fri|Sat) [A-Z][a-z]{2} \d{1,2}$/);
      for (const c of counts) for (const d of degraded) plain('digest.ts', digestTitle(day), digestBody(c, d));
      // On a day Flint reviewed goals the digest has a fifth line, and Goal Reviews may be among what needs a look.
      for (const [goalsReviewed, goalsLate] of [[1, 0], [1, 1], [3, 0], [3, 1], [3, 3], [40, 12]] as const) {
        for (const c of counts) for (const d of [[], ['goals'], ['backup', 'goals', 'source:github']]) plain('digest.ts', digestTitle(day), digestBody({ ...c, goalsReviewed, goalsLate }, d));
        expect(digestBody({ ...zero, goalsReviewed, goalsLate }, [])).toContain(goalsSentence(goalsReviewed, goalsLate));
      }
      // Once Will lets Flint ask on its own, the digest ends with how many questions wait in Predictions (P4 part 4).
      for (const questions of [1, 2, 5, 37]) {
        for (const c of counts) for (const d of [[], ['forecasts', 'ledger']]) plain('digest.ts', digestTitle(day), digestBody({ ...c, questions }, d));
        expect(digestBody({ ...zero, questions }, []).split('\n').at(-1)).toBe(questionsSentence(questions));
      }
    }
    expect(digestTitle('2026-10-11')).toBe('Daily Summary for Sun Oct 11');
  });

  it('surface/deliver.ts: every escalation template, at its edges, under any name a service or an item may have', () => {
    // Names Flint says in its own words (a service's), or that read as plain words: the whole note is held to the rule.
    const plainNames = [
      {},
      { 'service#abc123': 'com.flint.server', 'issue#abc123': 'wpf002/flint #60', 'pull_request#abc123': 'wpf002/flint #61', 'thread#abc123': 'Deploy plan' },
      { 'service#abc123': 'com.nexus.responder' },
      { 'service#abc123': 'org.example.sync_agent' },
      { 'service#abc123': 'trident-api' },
      { 'service#abc123': 'npm' },
      { 'service#abc123': 'worker-4aef4bf9c2' },
      // Names no note may show as they are: a service is still said in words, any other thing by its kind.
      { 'service#abc123': 'api (staging) ~/bin/api', 'issue#abc123': 'see `rm -rf` in /Users/will', 'pull_request#abc123': '{"title": "x"}', 'thread#abc123': 'see https://example.com/x' },
    ];
    // Someone's own name for a thing (a repo with a hyphen, a version): shown as it is, and held to what no text may carry.
    const ownNames = { 'issue#abc123': 'wpf002/nexus-responder #12', 'pull_request#abc123': 'v2.1 plan', 'thread#abc123': 'runtime.world_now rename' };
    for (const id of TEMPLATE_IDS) {
      for (const fields of EDGES[id]) {
        for (const n of plainNames) {
          const r = render(id, fields, n);
          // Never the field-free words for a name's sake: only the note's own facts.
          expect(r.linted, `${id} ${JSON.stringify(fields)} ${JSON.stringify(n)}`).toBe(false);
          plain(`deliver.ts ${id}`, r.title, r.body);
        }
        const own = render(id, fields, ownNames);
        expect(own.linted, `${id} ${JSON.stringify(fields)}`).toBe(false);
        expect(shownProblems(`${own.title}\n${own.body}`), `${own.title} / ${own.body}`).toEqual([]);
        for (const re of NEVER.slice(1)) expect(`${own.title}\n${own.body}`).not.toMatch(re);
      }
      plain(`deliver.ts ${id} (field-free)`, TEMPLATES[id].fieldFreeTitle, TEMPLATES[id].fieldFreeBody);
      // The job's own failure note is folded by its title in the console: no escalation may share one.
      for (const job of Object.values(JOB_WORDS)) expect(TEMPLATES[id].fieldFreeTitle).not.toBe(`${job} Failed`);
    }
    expect(render('new_item', { kind: 'issue', item: 'issue#abc123', reasonCode: 'fyi' }, ownNames).title).toBe('New Issue: wpf002/nexus-responder #12');
    // With the ledger's phrase, at each word it has.
    for (const p of [0.02, 0.2, 0.4, 0.5, 0.6, 0.8, 0.97]) {
      const r = render('service_down', { service: 'service#abc123', downMinutes: 45 }, { 'service#abc123': 'com.flint.server' }, phrase(p, new Date('2026-10-02T22:30:00Z'), 'America/Chicago'));
      expect(r.linted).toBe(false);
      plain('deliver.ts service_down (ledger)', r.title, r.body);
    }
    // A template this build does not know (an older row): the note still says something true.
    plain('deliver.ts (unknown template)', fieldFreeTitle('gone_template'), fieldFreeBody('gone_template'));
  });

  it('surface/deliver.ts: a row stored before these rules, or purged, still goes out in plain words', () => {
    const stored: Array<{ templateId: string; title: string | null; body: string | null }> = [
      // As the templates wrote them before 2026-10-12.
      { templateId: 'migrate_failed', title: 'A database migration failed', body: 'The runtime’s database update failed and won’t be retried until it’s fixed. A copy of the database from just before it is in ~/FlintBackups/pre-migrate.' },
      { templateId: 'rule_match', title: 'issue.state: your rule ci_red', body: 'A GitHub event matched your rule “ci_red”.' },
      { templateId: 'new_item', title: 'New issue: issue#24ehza', body: 'Flint flagged it as needing you. It’s in Activity, under Important.' },
      { templateId: 'service_down', title: 'The server is down', body: 'The server has been down for 45 minutes. Recovery is somewhat unlikely (~40%) by Oct 2, 5:30 PM.' },
      { templateId: 'vendor_cap', title: 'anthropic spend is at its cap', body: 'Flint has reached its Claude spending cap. Paid calls to it stop until the cap resets or is raised.' },
      { templateId: 'drill_failed', title: 'The restore drill failed', body: 'The last restore test didn’t match the backup, so the backups may not restore.' },
      // Purged by retention (its field-free title, no body), and by the database's forget (its own words, in sentence case).
      { templateId: 'backup_stale', title: 'Backups Have Stopped', body: null },
      { templateId: 'calendar_upcoming', title: 'Something needs a look', body: null },
      { templateId: 'gone_template', title: null, body: null },
    ];
    for (const e of stored) {
      const note = noteOf(e);
      plain(`deliver.ts ${e.templateId} (stored)`, note.title, note.body);
    }
    // One that only lacked Title Case keeps its words; one with a path or an internal name goes out field-free.
    expect(noteOf(stored[5]!)).toEqual({ title: 'The Restore Drill Failed', body: stored[5]!.body });
    // A name someone gave a thing is not Flint's words: a hyphen or a dot in it never costs the note.
    const named = { templateId: 'new_item', title: 'New Pull Request: wpf002/nexus-responder #12', body: 'Flint flagged it as worth knowing. It’s in Activity, under Important.' };
    expect(noteOf(named)).toEqual({ title: named.title, body: named.body });
    expect(noteOf({ ...named, title: 'New thread: v2.1 plan for claude.ai' }).title).toBe('New Thread: v2.1 Plan for claude.ai');
    expect(noteOf({ ...named, title: 'New issue: see /Users/will/notes' }).title).toBe('Something New Needs a Look');
    expect(noteOf(stored[4]!).title).toBe('Anthropic Spend Is at Its Cap');
    expect(noteOf(stored[0]!)).toEqual({ title: 'A Database Update Failed', body: TEMPLATES.migrate_failed.fieldFreeBody });
    expect(noteOf(stored[1]!).title).toBe('One of Your Rules Matched');
    expect(noteOf(stored[7]!)).toEqual({ title: 'Something Needs a Look', body: TEMPLATES.calendar_upcoming.fieldFreeBody });
  });

  it('goal reviews: what Goal Reviews says in Settings > Health, and what a goal route or card is refused with, are plain sentences too', () => {
    // Not notes (nothing here is posted), so they stay out of the producers' count; the words are held to the same rules.
    const said = (from: string, title: string, body: string) => {
      expect(noteProblems(title, body), `${from}: ${title} / ${body}`).toEqual([]);
      for (const re of NEVER) expect(`${title}\n${body}`, `${from}: ${body}`).not.toMatch(re);
      for (const line of body.split('\n')) expect(line, line).toMatch(/^[A-Z0-9“].*[.?]$/);
    };
    const health = [
      GOAL_HEALTH.stopped, GOAL_HEALTH.noModel, DEFERRAL_SAYS,
      ...[1, 2, 14].flatMap((n) => [GOAL_HEALTH.late(n), GOAL_HEALTH.down(n)]),
      ...[1, 2, 3].map((n) => GOAL_HEALTH.noAnswer(n)),
    ];
    expect(health).toHaveLength(12);
    for (const line of health) said('health/checks.ts goals', HEALTH_NAMES.goals!, line);
    expect(HEALTH_NAMES.goals).toBe('Goal Reviews');
    expect(GOAL_HEALTH.stopped).toBe(REVIEWS_STOPPED);
    // Every sentence checks.ts can give for the component is one of these: none is put together where it is returned.
    const checks = readFileSync(join(SRC, 'health', 'checks.ts'), 'utf8');
    const goalReviews = checks.slice(checks.indexOf('async function goalReviews('), checks.indexOf('export async function recordChecks'));
    expect(goalReviews.match(/\bdetail: (?!true\b)/g)).toHaveLength(6);
    expect(goalReviews.match(/detail: (GOAL_HEALTH\.\w+(\([\w.]+\))?|clip\(deferred\.detail\))/g)).toHaveLength(6);
    // The refusals: every fixed sentence a goal card or a goal route answers with (the reviews' own among them).
    const refusals = { ...GOAL_SAYS, ...GOAL_STATUS_SAYS };
    for (const code of ['reviewsOff', 'reviewCap', 'notReady', 'replacedReview', 'reviewsStopped', 'minorCard', 'reviewStep', 'runtimeOrigin'] as const) expect(GOAL_SAYS[code], code).toBeTruthy();
    for (const [code, sentence] of Object.entries(refusals)) said(`GOAL_SAYS.${code}`, 'Goals', sentence);
  });

  it('prediction checks (P4): what Prediction Checks says in Settings > Health is plain sentences, from counts, and nothing else', () => {
    const said = (line: string) => {
      expect(noteProblems(HEALTH_NAMES.ledger!, line), line).toEqual([]);
      for (const re of NEVER) expect(`${HEALTH_NAMES.ledger}\n${line}`, line).not.toMatch(re);
      expect(line, line).toMatch(/^[A-Z].*\.$/);
      // Counts and fixed words: never the ledger's own name for itself, a key, or an id.
      expect(line, line).not.toMatch(/ledger|sweep|snapshot|resolver|spec\b|daily\.|\bpd[a-z0-9]{8}/i);
      expect(line.length, line).toBeLessThanOrEqual(120);
    };
    const health = [
      LEDGER_HEALTH.stopped, LEDGER_HEALTH.starting, LEDGER_HEALTH.down, LEDGER_HEALTH.noScores,
      ...[0, 1, 2, 18, 240].map((n) => LEDGER_HEALTH.checked(n)),
      // Run out is said beside what was checked, never as checked.
      ...[[0, 1], [0, 7], [1, 1], [18, 2], [240, 31]].map(([n, out]) => LEDGER_HEALTH.checked(n!, out)),
      ...[3, 8, 25].map((n) => LEDGER_HEALTH.late(n)),
      ...[1, 2, 40].flatMap((n) => [LEDGER_HEALTH.refused(n), LEDGER_HEALTH.noRule(n)]),
      ...[2, 3, 30].map((n) => LEDGER_HEALTH.scoresOld(n)),
    ];
    expect(health).toHaveLength(26);
    for (const line of health) said(line);
    expect(HEALTH_NAMES.ledger).toBe('Prediction Checks');
    expect([LEDGER_HEALTH.checked(1), LEDGER_HEALTH.checked(18), LEDGER_HEALTH.late(3), LEDGER_HEALTH.refused(1), LEDGER_HEALTH.scoresOld(3)]).toEqual([
      'Flint checked 1 prediction in the last day.', 'Flint checked 18 predictions in the last day.', 'Prediction checks haven’t run in 3 hours.',
      'The database refused 1 prediction check.', 'Flint’s accuracy scores are 3 days old.',
    ]);
    expect([LEDGER_HEALTH.checked(0, 1), LEDGER_HEALTH.checked(0, 7), LEDGER_HEALTH.checked(18, 2), LEDGER_HEALTH.noScores]).toEqual([
      'In the last day, 1 prediction ran out unchecked.', 'In the last day, 7 predictions ran out unchecked.',
      'Flint checked 18 predictions in the last day, and 2 ran out unchecked.', 'Flint hasn’t scored its predictions yet.',
    ]);
    // Every sentence checks.ts can give for the component is one of these: none is put together where it is returned.
    const checks = readFileSync(join(SRC, 'health', 'checks.ts'), 'utf8');
    const fn = checks.slice(checks.indexOf('async function predictionChecks('), checks.indexOf('/** How many of the latest plan stages Health looks at. */'));
    expect(fn.length).toBeGreaterThan(500);
    expect(fn.match(/\bdetail: /g)).toHaveLength(10);
    expect(fn.match(/detail: LEDGER_HEALTH\.\w+(\([^)]*\)+)?/g)).toHaveLength(10);
    // The digest names the component as Health does when it needs a look.
    expect(digestBody({ relevant: 0, quiet: 0, escalated: 0, did: 0, queued: 0, open: 0, due: 0 }, ['ledger'])).toContain('Prediction Checks');
  });

  it('tasks and assets (P5): what Tasks says in Settings > Health, an asset’s line, and the sentences a card is refused with are plain, from counts', () => {
    const said = (line: string) => {
      expect(noteProblems(HEALTH_NAMES.tasks!, line), line).toEqual([]);
      for (const re of NEVER) expect(`${HEALTH_NAMES.tasks}\n${line}`, line).not.toMatch(re);
      expect(line, line).toMatch(/^[A-Z0-9].*\.$/);
    };
    const health = [TASK_HEALTH.none, TASK_HEALTH.stopped, ...[1, 2, 14].map((n) => TASK_HEALTH.stuck(n))];
    for (const line of [...health, WAITING, SPEND_NEEDS_ESTIMATE, WHOLE_NUMBERS_ONLY, ...ASSETS.map((a) => a.line)]) said(line);
    expect(HEALTH_NAMES.tasks).toBe('Tasks');
    expect([TASK_HEALTH.stuck(1), TASK_HEALTH.stuck(14)]).toEqual(['A task is past its time and hasn’t been ended.', '14 tasks are past their time and haven’t been ended.']);
    // An asset's name and a task's title are labels: Title Case, plain words.
    for (const label of [...ASSETS.map((a) => a.name), ...Object.values(TASK_TITLES)]) expect(noteProblems(label, ''), label).toEqual([]);
    // Every sentence checks.ts can give for the component is one of these: none is put together where it is returned.
    const checks = readFileSync(join(SRC, 'health', 'checks.ts'), 'utf8');
    const fn = checks.slice(checks.indexOf('async function tasks('), checks.indexOf('/** Last night\'s run is this old: it was missed'));
    expect(fn.length).toBeGreaterThan(300);
    expect(fn.match(/\bdetail: /g)).toHaveLength(3);
    expect(fn.match(/detail: TASK_HEALTH\.\w+(\([^)]*\))?/g)).toHaveLength(3);
    // The digest names the component as Health does when it needs a look.
    expect(digestBody({ relevant: 0, quiet: 0, escalated: 0, did: 0, queued: 0, open: 0, due: 0 }, ['tasks'])).toContain('Tasks');
  });

  it('forecasts (P4): what Forecasts says in Settings > Health is plain sentences, from counts, and nothing else', () => {
    const said = (line: string) => {
      expect(noteProblems(HEALTH_NAMES.forecasts!, line), line).toEqual([]);
      for (const re of NEVER) expect(`${HEALTH_NAMES.forecasts}\n${line}`, line).not.toMatch(re);
      expect(line, line).toMatch(/^[A-Z0-9].*\.$/);
      // Counts and fixed words: never a series' key, a method's name, or a value with its unit.
      expect(line, line).not.toMatch(/daily\.|weekly\.|fc\.v1|statistical|base rate|naive|\$|usd/i);
      expect(line.length, line).toBeLessThanOrEqual(120);
    };
    const health = [
      FORECAST_HEALTH.stopped, FORECAST_HEALTH.starting, FORECAST_HEALTH.missed, FORECAST_HEALTH.noNumbers,
      ...[1, 2, 11].map((n) => FORECAST_HEALTH.ran(n)),
      // Some have their forecast and some are waiting for yesterday's number.
      ...[[1, 1], [2, 1], [9, 3]].map(([n, late]) => FORECAST_HEALTH.ran(n!, late)),
      ...[1, 2, 12].flatMap((n) => [FORECAST_HEALTH.waiting(n), FORECAST_HEALTH.late(n), FORECAST_HEALTH.failed(n), FORECAST_HEALTH.refused(n), FORECAST_HEALTH.capped(n), FORECAST_HEALTH.numbersFailed(n)]),
      ...[2, 3, 30].map((n) => FORECAST_HEALTH.down(n)),
      // The second opinion's own mark: the local model's estimate gave up waiting for chat, or could not be saved.
      OPINION_WAITED, OPINION_MISSED,
    ];
    expect(health).toHaveLength(33);
    expect(OPINION_WAITED).toBe('Chat was busy for 10 minutes, so a forecast went without the local model’s second opinion.');
    expect(OPINION_MISSED).toBe('The local model’s second opinion couldn’t be saved, so a forecast went without it.');
    expect(OPINION_MARK).toBe('forecasts.deferral');
    for (const line of health) said(line);
    expect(HEALTH_NAMES.forecasts).toBe('Forecasts');
    expect([FORECAST_HEALTH.ran(11), FORECAST_HEALTH.ran(1), FORECAST_HEALTH.failed(1), FORECAST_HEALTH.waiting(1), FORECAST_HEALTH.down(2)]).toEqual([
      'Last night’s forecasts ran for 11 numbers.', 'Last night’s forecasts ran for 1 number.', '1 forecast failed last night.',
      'Flint needs more history before it forecasts its number.', 'Forecasts haven’t run in 2 days.',
    ]);
    expect([FORECAST_HEALTH.ran(9, 3), FORECAST_HEALTH.ran(2, 1), FORECAST_HEALTH.late(1), FORECAST_HEALTH.late(3), FORECAST_HEALTH.refused(12), FORECAST_HEALTH.capped(1), FORECAST_HEALTH.capped(12)]).toEqual([
      'Last night’s forecasts ran for 9 numbers, and 3 are waiting for yesterday’s number.', 'Last night’s forecasts ran for 2 numbers, and 1 is waiting for yesterday’s number.',
      'Yesterday’s number isn’t in, so Flint didn’t forecast it.', 'Yesterday’s numbers aren’t in for 3 numbers, so Flint didn’t forecast them.',
      'The database refused 12 forecasts last night.',
      'The daily limit on forecasts was reached, so 1 number waits until tomorrow.', 'The daily limit on forecasts was reached, so 12 numbers wait until tomorrow.',
    ]);
    // Every sentence checks.ts can give for the component is one of these.
    const checks = readFileSync(join(SRC, 'health', 'checks.ts'), 'utf8');
    const fn = checks.slice(checks.indexOf('async function forecasts('), checks.indexOf('/** The hourly check has not run in this long: degraded. */'));
    expect(fn.length).toBeGreaterThan(500);
    expect(fn.match(/\bdetail: /g)).toHaveLength(15);
    expect(fn.match(/detail: FORECAST_HEALTH\.\w+(\([^)]*\)+)?/g)).toHaveLength(13);
    // ...or the second opinion's mark, read as it was written (one of the two sentences above), for an hour.
    expect(fn.match(/select: \{ detail: true \}/g)).toHaveLength(1);
    expect(fn).toContain("where: { component: 'forecasts.deferral', at: { gt: new Date(now.getTime() - 3_600_000) } }");
    expect(fn.match(/detail: clip\(deferred\.detail\)/g)).toHaveLength(1);
    expect(digestBody({ relevant: 0, quiet: 0, escalated: 0, did: 0, queued: 0, open: 0, due: 0 }, ['forecasts'])).toContain('Forecasts');
  });

  it('the Mac itself (P7): what the new Health rows say, and what a job says when it removes old backups, are plain sentences too', () => {
    const said = (component: string, line: string) => {
      expect(HEALTH_NAMES[component], component).toBeTruthy();
      expect(noteProblems(HEALTH_NAMES[component]!, line), `${component}: ${line}`).toEqual([]);
      for (const re of NEVER) expect(`${HEALTH_NAMES[component]}\n${line}`, line).not.toMatch(re);
      expect(line, line).toMatch(/^[A-Z].*\.$/);
      // Numbers and fixed words: no percent sign, no aside, and nothing a program or a file said.
      expect(line, line).not.toMatch(/[%()]|tailscale|ollama|statfs|\.jsonl|\.sock/i);
      expect(line.length, line).toBeLessThanOrEqual(120);
    };
    const GB = 1e9;
    const now = new Date('2026-10-12T18:00:00Z');
    const lines: Array<[string, string | undefined]> = [
      ...[undefined, 0, 0.4 * GB, 4 * GB, 14 * GB, 212 * GB, 4000 * GB].map((free): [string, string | undefined] => ['disk', diskCheck(free).detail]),
      ['remote_access', REMOTE_HEALTH.ok], ['remote_access', REMOTE_HEALTH.unknown], ...Object.values(REMOTE_HEALTH.down).map((l): [string, string] => ['remote_access', l]),
      ...[0, 1, 2, 14].map((d): [string, string] => ['remote_access', REMOTE_HEALTH.expiring(d)]),
      ...Object.values(MODEL_HEALTH).flatMap((l): Array<[string, string]> => [['ollama', l], ['standby_model', l]]),
      ...[1, 2, 40].map((n): [string, string] => ['postgres', DATABASE_HEALTH.largeObjects(n)]),
      ['backup', BACKUP_HEALTH.failed], ['files_backup', BACKUP_HEALTH.filesNone], ['files_backup', BACKUP_HEALTH.filesFailed], ['offsite_backup', BACKUP_HEALTH.filesOffsiteNone], ['offsite_backup', BACKUP_HEALTH.filesOffsiteFailed],
      ...[0, 1, 30].flatMap((h): Array<[string, string]> => [['files_backup', BACKUP_HEALTH.filesAge(h)], ['offsite_backup', BACKUP_HEALTH.filesOffsiteAge(h)]]),
      ...['today', 'yesterday', '6 days ago'].flatMap((w): Array<[string, string]> => [['offsite_drill', BACKUP_HEALTH.drillPassed(w)], ['offsite_drill', BACKUP_HEALTH.drillFailed(w)]]),
      ...[9, 13, 14, 400].map((d): [string, string] => ['offsite_drill', BACKUP_HEALTH.drillLate(d)]),
      ['deploy_hold', UPKEEP_HEALTH.neverChecked],
      ...[0, 59_000, 60_000, 45 * 60_000].map((ms): [string, string] => ['deploy_hold', UPKEEP_HEALTH.checked(ms)]),
      ...[61 * 60_000, 5 * 3_600_000, 47 * 3_600_000, 9 * 86_400_000].map((ms): [string, string] => ['deploy_hold', UPKEEP_HEALTH.notChecked(ms)]),
      // Nexus's own backup (P7): its one line in Health, whichever of its three parts it speaks of.
      ['nexus_backup', NEXUS_HEALTH.none], ['nexus_backup', NEXUS_HEALTH.failed], ['nexus_backup', NEXUS_HEALTH.offsiteNone], ['nexus_backup', NEXUS_HEALTH.offsiteFailed], ['nexus_backup', NEXUS_HEALTH.drillNone],
      ['nexus_backup', NEXUS_HEALTH.address],
      ...[0, 1, 30, 400].flatMap((h): Array<[string, string]> => [['nexus_backup', NEXUS_HEALTH.age(h)], ['nexus_backup', NEXUS_HEALTH.offsiteAge(h)]]),
      ...['today', 'yesterday', '6 days ago'].map((w): [string, string] => ['nexus_backup', NEXUS_HEALTH.drillFailed(w)]),
      ...[9, 13, 400].map((d): [string, string] => ['nexus_backup', NEXUS_HEALTH.drillLate(d)]),
    ];
    expect(lines.length).toBeGreaterThan(75);
    // Every sentence Nexus Backup can say is one of those: its check puts none together where it is returned.
    const nexusCheck = readFileSync(join(SRC, 'health', 'checks.ts'), 'utf8');
    const nexusFn = nexusCheck.slice(nexusCheck.indexOf('async function nexusBackup('), nexusCheck.indexOf('async function filesOffsite('));
    expect(nexusFn.length).toBeGreaterThan(500);
    expect(nexusFn.match(/\bdetail: /g)).toHaveLength(5);
    expect(nexusFn.match(/NEXUS_HEALTH\.\w+/g)!.sort()).toEqual(['age', 'drillFailed', 'drillLate', 'drillNone', 'failed', 'none', 'offsiteAge', 'offsiteFailed', 'offsiteNone'].map((k) => `NEXUS_HEALTH.${k}`));
    // (The one sentence its check does not say itself: an address that cannot be used, said before the check is made.)
    expect(Object.keys(NEXUS_HEALTH).sort()).toEqual(['address', 'age', 'drillFailed', 'drillLate', 'drillNone', 'failed', 'none', 'offsiteAge', 'offsiteFailed', 'offsiteNone']);
    expect(nexusCheck.match(/NEXUS_HEALTH\.address/g)).toHaveLength(1);
    expect(HEALTH_NAMES.nexus_backup).toBe('Nexus Backup');
    expect(digestBody({ relevant: 0, quiet: 0, escalated: 0, did: 0, queued: 0, open: 0, due: 0 }, ['nexus_backup'])).toContain('Nexus Backup');
    // Its three jobs by name, as a failure's note says them, and the commands' own lines in Terminal.
    expect([JOB_WORDS['backup.nexus'], JOB_WORDS['backup.nexus.offsite'], JOB_WORDS['restore.drill.nexus']]).toEqual(['Nexus Backup', 'Nexus Offsite Backup', 'Nexus Restore Test']);
    for (const line of NEXUS_OFF.filter((l) => !l.startsWith('  '))) expect(line, line).toMatch(/^[A-Z].*[.:]$/);
    for (const [component, line] of lines) said(component, line!);
    // What each of the checks from a reading can say is one of the lines above: none is put together where it is returned.
    for (const r of [{ state: 'unknown' }, { state: 'ok' }, { state: 'ok', expiresAt: new Date(now.getTime() + 86_400_000) }, { state: 'down', why: 'offline' }] as const) said('remote_access', remoteAccessCheck(r, now).detail!);
    const machine = readFileSync(join(SRC, 'health', 'machine.ts'), 'utf8');
    expect(machine.match(/\bdetail: /g)).toHaveLength(16);
    // (One of them chooses between two of the fixed sentences: loaded, or installed.)
    expect(machine.match(/detail: models\.loaded\.has\(name\) \? MODEL_HEALTH\.loaded : MODEL_HEALTH\.installed/g)).toHaveLength(1);
    expect(machine.match(/detail: (REMOTE_HEALTH|MODEL_HEALTH)\.[\w.[\]]+(\([\w.]*\))?/g)).toHaveLength(11);
    // (The other four are free space's own: a whole number of gigabytes in one of three fixed sentences, or that it could not be read.)
    expect(machine.match(/detail: (`This Mac [^`]*\$\{gigabytes\(free\)\} free\.`|'Flint couldn’t read how much space is free\.')/g)).toHaveLength(4);
    // The names are the ones Settings > Health and the digest show.
    expect([HEALTH_NAMES.disk, HEALTH_NAMES.remote_access, HEALTH_NAMES.standby_model, HEALTH_NAMES.files_backup, HEALTH_NAMES.offsite_drill]).toEqual(['Disk Space', 'Remote Access', 'Standby Model', 'Files Backup', 'Offsite Restore Test']);
    expect(digestBody({ relevant: 0, quiet: 0, escalated: 0, did: 0, queued: 0, open: 0, due: 0 }, ['disk', 'offsite_drill'])).toContain('Disk Space and Offsite Restore Test');
    // Removing old backups by hand: sentences, counts and sizes.
    for (const o of [
      { did: 'nothing', would: 0, megabytes: 0, kept: 0, removed: 0, failed: 0 }, { did: 'nothing', would: 0, megabytes: 0, kept: 7, removed: 0, failed: 0 }, { did: 'held', would: 0, megabytes: 0, kept: 12, removed: 0, failed: 0 },
      { did: 'waiting', would: 3, megabytes: 9, kept: 10, removed: 0, failed: 0 }, { did: 'removed', would: 3, megabytes: 9, kept: 10, removed: 3, failed: 0 }, { did: 'failed', would: 3, megabytes: 9, kept: 11, removed: 2, failed: 1 },
    ] as const) {
      for (const line of pruneLines(o)) {
        expect(noteProblems(JOB_WORDS['backup.prune']!, line), line).toEqual([]);
        for (const re of NEVER) expect(line, line).not.toMatch(re);
      }
    }
    expect(JOB_WORDS['backup.prune']).toBe('Backup Cleanup');
  });

  it('the inventory is not empty by accident', () => {
    expect(new Set(seen.map((s) => s.from.split(' ')[0])).size).toBe(Object.keys(PRODUCERS).length);
    expect(seen.length).toBeGreaterThan(300);
  });
});
