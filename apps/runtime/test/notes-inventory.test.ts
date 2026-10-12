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
 * The server's own notes and the shell scripts' banners have theirs:
 * apps/server/test/notes-inventory.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { JOB_WORDS, jobFailedNote, noteProblems, type NightlyJob } from '@flint/policy';
import { ACTION } from '../src/backup/nightly';
import { digestBody, digestTitle } from '../src/digest';
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
    // The note is jobFailedNote's, whole: no words are put together at the call.
    expect(cli).toMatch(/const note = jobFailedNote\(action, \{[^}]*\}\);\s*await notifyWill\(b\.config, note\.title, note\.body\);/);
    expect(cli).not.toMatch(/notifyWill\([^)]*[`'"]/);
    const jobs = Object.values(ACTION) as NightlyJob[];
    expect(jobs.sort()).toEqual(['backup.local', 'backup.offsite', 'restore.drill']);
    for (const job of jobs) {
      for (const alone of [true, false]) {
        for (const icloud of [true, false]) {
          for (const mismatch of [true, false]) {
            const note = jobFailedNote(job, { alone, icloud, mismatch });
            plain(`cli.ts ${job}`, note.title, note.body);
            expect(note.title).toBe(`${JOB_WORDS[job]} Failed`);
            expect(note.title.length).toBeLessThanOrEqual(40);
          }
        }
      }
    }
  });

  it('digest.ts: the morning digest, for any counts and any component that needs a look', () => {
    const zero = { relevant: 0, quiet: 0, escalated: 0, did: 0, queued: 0, open: 0, due: 0 };
    const counts = [zero, { relevant: 1, quiet: 1, escalated: 1, did: 1, queued: 1, open: 1, due: 1 }, { relevant: 12, quiet: 340, escalated: 3, did: 25, queued: 4, open: 2, due: 7 }];
    const degraded = [[], ['backup'], ['restore_drill', 'source:github'], ['audit_intents', 'backup', 'bus', 'migrate_failed', 'ollama', 'restore_drill', 'retention', 'server'], ['source:google_calendar', 'source:nexus_inbox', 'health_overdue', 'source:imessage']];
    for (const day of ['2026-10-11', '2026-01-01', '2028-02-29']) {
      expect(digestTitle(day)).toMatch(/^Daily Summary for (Sun|Mon|Tue|Wed|Thu|Fri|Sat) [A-Z][a-z]{2} \d{1,2}$/);
      for (const c of counts) for (const d of degraded) plain('digest.ts', digestTitle(day), digestBody(c, d));
    }
    expect(digestTitle('2026-10-11')).toBe('Daily Summary for Sun Oct 11');
  });

  it('surface/deliver.ts: every escalation template, at its edges, under any name a service or an item may have', () => {
    const names = [
      {},
      { 'service#abc123': 'com.flint.server', 'issue#abc123': 'wpf002/flint #60', 'pull_request#abc123': 'wpf002/flint #61', 'thread#abc123': 'Deploy plan' },
      { 'service#abc123': 'com.nexus.responder' },
      { 'service#abc123': 'org.example.sync_agent' },
      { 'service#abc123': 'trident-api' },
      // Names no note may show as they are: the note falls back to its field-free words.
      { 'service#abc123': 'api (staging) ~/bin/api', 'issue#abc123': 'see `rm -rf` in /Users/will', 'pull_request#abc123': '{"title": "x"}', 'thread#abc123': 'runtime.world_now' },
    ];
    for (const id of TEMPLATE_IDS) {
      for (const fields of EDGES[id]) {
        for (const n of names) {
          const r = render(id, fields, n);
          plain(`deliver.ts ${id}`, r.title, r.body);
        }
      }
      plain(`deliver.ts ${id} (field-free)`, TEMPLATES[id].fieldFreeTitle, TEMPLATES[id].fieldFreeBody);
    }
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
    expect(noteOf(stored[4]!).title).toBe('Anthropic Spend Is at Its Cap');
    expect(noteOf(stored[0]!)).toEqual({ title: 'A Database Update Failed', body: TEMPLATES.migrate_failed.fieldFreeBody });
    expect(noteOf(stored[1]!).title).toBe('One of Your Rules Matched');
    expect(noteOf(stored[7]!)).toEqual({ title: 'Something Needs a Look', body: TEMPLATES.calendar_upcoming.fieldFreeBody });
  });

  it('the inventory is not empty by accident', () => {
    expect(new Set(seen.map((s) => s.from.split(' ')[0])).size).toBe(Object.keys(PRODUCERS).length);
    expect(seen.length).toBeGreaterThan(300);
  });
});
