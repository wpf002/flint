/**
 * Every note the server can post to Will, and every banner a script can show
 * him, checked against his rules for one (2026-10-12; @flint/policy's
 * noteProblems): a short Title Case title in plain words, complete sentences
 * under it, and never an action's internal name ("backup.offsite"), a file
 * path, a command, an id, raw JSON or an aside in parentheses.
 *
 * The inventory is built from the code: the scans below find every place that
 * pushes a note or shows a banner, so a new producer fails here until it is
 * listed and its words are rendered below.
 *
 *   producer                                 what it posts
 *   approval-routes.ts                       "Action Done", for an approved action that ran
 *   spend.ts                                 a vendor's budget at 50, 80 or 100% of a cap
 *   notifications.ts (the Watcher)           a calendar reminder, a market headline (index.ts's checks)
 *   notifications.ts (the phone)             the content-free ping
 *   index.ts (/internal/notify)              the runtime's notes, passed through as they are:
 *                                            apps/runtime/test/notes-inventory.test.ts has their words
 *   apps/desktop-mac/update_app.sh           Flint.app was updated, or its update did not build
 *   apps/desktop-calendar/update_calendar.sh Flint Calendar's update did not build
 *   apps/responder/scripts/nexus-health.sh   a Nexus participant cannot take a turn
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { PAID_VENDORS } from '@flint/core';
import { ACTION_DONE, ACTION_WORDS, noteProblems } from '@flint/policy';
import { actionDoneNote } from '../src/approval-routes';
import { PHONE_PING, signalNote, upcomingNote } from '../src/notifications';
import { effectOf, thresholdNote, type BudgetLevel } from '../src/spend';

const SRC = join(__dirname, '..', 'src');
const APPS = join(__dirname, '..', '..');
const walk = (dir: string, ext: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    if (f === 'node_modules' || f === 'dist' || f.startsWith('.')) return [];
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p, ext) : f.endsWith(ext) ? [p] : [];
  });

/** What Will's screenshot showed, said outright (noteProblems checks these and more). */
const NEVER = [
  /\b[a-z][a-z0-9_]*\.[a-z][a-z0-9_.]*\b/, // a dotted action name: backup.offsite
  /~\/|\/Users\//, // a file path
  /`/, // a command in backticks
  /^\s*[{[]|[{}]/, // raw JSON
];

function plain(from: string, title: string, body: string): void {
  expect(noteProblems(title, body), `${from}: ${title} / ${body}`).toEqual([]);
  for (const re of NEVER) expect(`${title}\n${body}`, `${from}: ${title} / ${body}`).not.toMatch(re);
}

describe('the server’s notes to Will', () => {
  it('are pushed from the places listed here, each with words a named function wrote, and from nowhere else', () => {
    const found: string[] = [];
    for (const file of walk(SRC, '.ts')) {
      // Every push onto the feed, by what it passes for a title.
      for (const m of readFileSync(file, 'utf8').matchAll(/\b(?:notes|notifier)\.push\(\s*([^,)]+)/g)) found.push(`${relative(SRC, file)}: ${m[1]!.trim()}`);
    }
    expect(found.sort()).toEqual([
      'approval-routes.ts: done.title', // actionDoneNote
      'approval-routes.ts: done.title',
      'index.ts: n.title', // the runtime's, through /internal/notify
      'notifications.ts: r.title', // the Watcher's checks: upcomingNote, signalNote
      'spend.ts: note.title', // thresholdNote
    ]);
    // No title is written where it is pushed, and the Watcher's checks write none of their own.
    const index = readFileSync(join(SRC, 'index.ts'), 'utf8');
    const checks = index.slice(index.indexOf('function buildChecks('), index.indexOf('/** Build the per-request context block'));
    expect(checks).toContain('...upcomingNote(');
    expect(checks).toContain('...signalNote(');
    expect(checks).not.toMatch(/\btitle:|\bbody:/);
    const routes = readFileSync(join(SRC, 'approval-routes.ts'), 'utf8');
    expect(routes.match(/const done = actionDoneNote\(/g)).toHaveLength(2);
    expect(readFileSync(join(SRC, 'spend.ts'), 'utf8')).toMatch(/const note = thresholdNote\(/);
  });

  it('approval-routes.ts: "Action Done" says what Flint did, for every action it has words for and for one it has none', () => {
    for (const name of [...Object.keys(ACTION_WORDS), 'trident.gmail_send', 'mcp:web.web_search']) {
      const note = actionDoneNote(name);
      plain(`approval-routes.ts ${name}`, note.title, note.body);
      expect(note.title).toBe('Action Done');
    }
    expect(actionDoneNote('runtime.world_now').body).toBe(ACTION_DONE['runtime.world_now']);
    expect(actionDoneNote('trident.gmail_send').body).toBe('An approved action is done.');
  });

  it('spend.ts: a budget note names the vendor as Will does, how far along it is, and what that changes', () => {
    const levels: BudgetLevel[] = ['ok', 'notice', 'degrade', 'exhausted'];
    for (const vendor of PAID_VENDORS) {
      for (const period of ['daily', 'monthly'] as const) {
        for (const pct of [50, 80, 100]) {
          for (const level of levels) {
            const note = thresholdNote(vendor, period, pct, 8.2, 10, effectOf(vendor, level));
            plain(`spend.ts ${vendor} ${period} ${pct} ${level}`, note.title, note.body);
            expect(note.title.length).toBeLessThanOrEqual(40);
          }
        }
      }
    }
    expect(thresholdNote('anthropic', 'daily', 80, 8.2, 10, effectOf('anthropic', 'degrade'))).toEqual({
      title: 'Claude Budget at 80% for Today',
      body: 'Flint has spent $8.20 of today’s $10.00 cap. Harder questions use a cheaper model, and background work waits.',
    });
    expect(thresholdNote('openai', 'monthly', 100, 150, 150, effectOf('openai', 'exhausted')).title).toBe('OpenAI Budget at 100% for This Month');
  });

  it('notifications.ts: the Watcher’s notes are Flint’s words around someone else’s, and the phone ping says nothing of what happened', () => {
    // Flint's part, with a plain event: the day and time are fmtWhen's, the name and place the invitation's.
    for (const [e, when] of [
      [{ summary: 'Dentist', location: '12 Main Street' }, { day: 'Tue, Oct 6', time: '3:00 PM' }],
      [{ summary: 'Dentist', location: null }, { day: 'Tue, Oct 6' }],
      [{ summary: '', location: null }, { day: 'Tue, Oct 6', time: '3:00 PM' }],
    ] as const) {
      const note = upcomingNote(e, when);
      plain('notifications.ts upcoming', note.title, note.body);
    }
    expect(upcomingNote({ summary: null }, { day: 'Tue, Oct 6' }).body).toBe('An untitled event is on Tue, Oct 6.');
    // The headline is its source's: only the title is Flint's.
    plain('notifications.ts signal', signalNote('Rates were cut.').title, 'Rates were cut.');
    expect(signalNote('x'.repeat(500)).body).toHaveLength(200);
    plain('notifications.ts ping', PHONE_PING.title, PHONE_PING.body);
  });
});

describe('the banners a script can show Will', () => {
  const scripts = walk(APPS, '.sh').filter((f) => /display notification|terminal-notifier|ntfy/.test(readFileSync(f, 'utf8')));
  const text = (name: string) => readFileSync(join(APPS, name), 'utf8');

  it('come from the scripts listed here and no others; the Mac apps show none of their own', () => {
    expect(scripts.map((f) => relative(APPS, f)).sort()).toEqual(['desktop-calendar/update_calendar.sh', 'desktop-mac/update_app.sh', 'responder/scripts/nexus-health.sh']);
    for (const swift of walk(APPS, '.swift')) expect(readFileSync(swift, 'utf8'), swift).not.toMatch(/UNUserNotification|NSUserNotification|display notification/);
  });

  it('the updaters say what happened in a sentence, never the commit that did it', () => {
    for (const name of ['desktop-mac/update_app.sh', 'desktop-calendar/update_calendar.sh']) {
      const src = text(name);
      // One way to show a banner, titled Flint, and every call to it a fixed sentence.
      expect(src).toContain('notify() { osascript -e "display notification \\"$1\\" with title \\"Flint\\"" >/dev/null 2>&1 || true; }');
      const said = [...src.matchAll(/^\s*notify "([^"]*)"\s*$/gm)].map((m) => m[1]!);
      expect(src.match(/^\s*notify /gm) ?? []).toHaveLength(said.length);
      expect(said.length).toBeGreaterThan(0);
      for (const line of said) {
        expect(line, line).not.toMatch(/\$/);
        plain(name, 'Flint', line);
      }
    }
    expect([...text('desktop-mac/update_app.sh').matchAll(/^\s*notify "([^"]*)"\s*$/gm)].map((m) => m[1])).toEqual([
      'Flint was updated. Open it to use the new version.',
      'Flint was updated. The open app restarts onto the new version when you’re not using it.',
      'Flint was updated. Quit and reopen it once to finish.',
      'A Flint update didn’t build, so the current app was kept.',
    ]);
  });

  it('the Nexus health check says how many participants are stuck, in the singular or the plural, never "participant(s)"', () => {
    const src = text('responder/scripts/nexus-health.sh');
    const said = [...src.matchAll(/SAID="([^"]*)"/g)].map((m) => m[1]!);
    expect(said).toEqual(['The Nexus health check didn’t finish.', '1 Nexus participant can’t take a turn.', '$BROKEN Nexus participants can’t take a turn.']);
    for (const line of said) plain('nexus-health.sh', 'Nexus Health', line.replace('$BROKEN', '3'));
    expect(src).toContain('display notification \\"$SAID\\" with title \\"Nexus Health\\"');
    expect(src).not.toContain('(s)');
  });
});
