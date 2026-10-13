import { describe, it, expect } from 'vitest';
import { ACTION_DONE, ACTION_WORDS, JOB_WORDS, actionWords, jobFailedNote, ruleWords, type NightlyJob } from '../src/action-words';
import { HEALTH_NAMES } from '../src/health-names';
import { noteProblems } from '../src/notes';

describe('actionWords', () => {
  it('names a runtime chat tool in words, never by its internal name', () => {
    expect(actionWords('runtime.world_now')).toBe('Check What’s Happening Now');
    for (const [name, words] of Object.entries(ACTION_WORDS)) {
      expect(words).not.toContain(name.split('.')[1]!);
      expect(words).not.toMatch(/[_.]/);
    }
  });

  it('leaves an action it has no words for as it is named', () => {
    expect(actionWords('trident.gmail_send')).toBe('trident.gmail_send');
  });
});

describe('ACTION_DONE', () => {
  it('says what each action did as a sentence, Flint in the past tense, never its title or internal name', () => {
    expect(Object.keys(ACTION_DONE).sort()).toEqual(Object.keys(ACTION_WORDS).sort());
    expect(ACTION_DONE['runtime.world_now']).toBe('Flint checked what’s happening now.');
    for (const [name, line] of Object.entries(ACTION_DONE)) {
      // One sentence, past tense: never the present the console's card lines use ("Flint checks …").
      expect(line).toMatch(/^Flint [a-z]+ [^A-Z.]*\.$/);
      expect(line).not.toMatch(/^Flint [a-z]+s /);
      expect(line).not.toContain(ACTION_WORDS[name]!);
      expect(line).not.toContain(name.split('.')[1]!);
    }
  });
});

describe('JOB_WORDS', () => {
  it('names a scheduled job in words, the words Settings > Health uses', () => {
    expect(JOB_WORDS['backup.offsite']).toBe('Offsite Backup');
    expect(JOB_WORDS['restore.drill']).toBe(HEALTH_NAMES.restore_drill);
    expect(JOB_WORDS['maintenance.retention']).toBe(HEALTH_NAMES.retention);
    for (const [name, words] of Object.entries(JOB_WORDS)) {
      expect(words).not.toMatch(/[_.]/);
      expect(words).not.toContain(name.split('.')[1]!);
    }
  });
});

describe('jobFailedNote', () => {
  const JOBS: NightlyJob[] = ['backup.local', 'backup.offsite', 'restore.drill'];
  const NEXT = ['retry', 'card', 'card_later', 'setup'] as const;

  it('says what happened and what happens next, in Will’s words', () => {
    expect(jobFailedNote('backup.offsite', { next: 'retry', icloud: true })).toEqual({ title: 'Offsite Backup Failed', body: 'Last night’s encrypted copy to iCloud didn’t finish. Flint tries again tonight.' });
    expect(jobFailedNote('backup.local', { next: 'retry' })).toEqual({ title: 'Backup Failed', body: 'Last night’s database backup didn’t finish. Flint tries again tonight.' });
    expect(jobFailedNote('restore.drill', { next: 'retry', mismatch: true })).toEqual({ title: 'Restore Test Failed', body: 'This week’s practice restore found a problem. Flint tries again next Sunday.' });
    // It stopped before it could compare anything: it did not finish, which is not "found a problem".
    expect(jobFailedNote('restore.drill', { next: 'retry' }).body).toBe('This week’s practice restore didn’t finish. Flint tries again next Sunday.');
    // A folder Will set himself is not called iCloud.
    expect(jobFailedNote('backup.offsite', { next: 'retry', icloud: false }).body).toBe('Last night’s encrypted offsite copy didn’t finish. Flint tries again tonight.');
  });

  it('a failure another try cannot change never says "tries again": it says its setup needs fixing', () => {
    for (const job of JOBS) {
      const note = jobFailedNote(job, { next: 'setup', icloud: true });
      expect(note.body).toMatch(/ It won’t work until its setup is fixed\.$/);
      expect(note.body).not.toMatch(/tries again|approve/);
    }
    expect(jobFailedNote('backup.offsite', { next: 'setup', icloud: true }).body).toBe('Last night’s encrypted copy to iCloud didn’t finish. It won’t work until its setup is fixed.');
  });

  it('a job that waits on Will’s card points at a card that is there, or says when it will be', () => {
    for (const job of JOBS) {
      // The next card was filed when the run failed: it is in Approvals now.
      expect(jobFailedNote(job, { next: 'card' }).body).toMatch(/ It runs again once you approve its next card in Approvals\.$/);
      expect(jobFailedNote(job, { next: 'card' }).body).not.toMatch(/tries again/);
    }
    // It could not be filed: the next run files it, and the note says when that is.
    expect(jobFailedNote('backup.local', { next: 'card_later' }).body).toBe('Last night’s database backup didn’t finish. Its next card will be in Approvals tomorrow morning.');
    expect(jobFailedNote('backup.offsite', { next: 'card_later', icloud: true }).body).toMatch(/ Its next card will be in Approvals tomorrow morning\.$/);
    expect(jobFailedNote('restore.drill', { next: 'card_later' }).body).toBe('This week’s practice restore didn’t finish. Its next card will be in Approvals next Sunday.');
  });

  it('every variant is a note fit to show', () => {
    for (const job of JOBS) {
      for (const next of NEXT) {
        for (const icloud of [true, false]) {
          for (const mismatch of [true, false]) {
            const note = jobFailedNote(job, { next, icloud, mismatch });
            expect(noteProblems(note.title, note.body), `${job} ${JSON.stringify({ next, icloud, mismatch })}`).toEqual([]);
            expect(note.title).toBe(`${JOB_WORDS[job]} Failed`);
          }
        }
      }
    }
  });
});

describe('ruleWords', () => {
  it('says a rule’s action by the name the console shows for it, never by its internal one', () => {
    expect(ruleWords('backup.local')).toBe('Backup');
    expect(ruleWords('backup.offsite')).toBe('Offsite Backup');
    expect(ruleWords('restore.drill')).toBe('Restore Test');
    expect(ruleWords('maintenance.retention')).toBe('Cleanup');
    // A chat tool's rule is written without its server's name; it reads the same either way.
    expect(ruleWords('world_now')).toBe(ACTION_WORDS['runtime.world_now']);
    expect(ruleWords('runtime.world_now')).toBe(ACTION_WORDS['runtime.world_now']);
  });

  it('an action with no words of its own is its name’s parts as words, and a rule for a whole family says so', () => {
    expect(ruleWords('world.sync.github')).toBe('World Sync Github');
    expect(ruleWords('mcp:shell.run')).toBe('MCP Shell Run');
    expect(ruleWords('mcp:*')).toBe('Everything Under MCP');
    expect(ruleWords('backup.*')).toBe('Everything Under Backup');
    expect(ruleWords('*')).toBe('An Action');
    expect(ruleWords('.*')).toBe('Everything');
  });

  it('whatever the pattern, what is said holds no internal name, path or mark', () => {
    for (const pattern of ['backup.local', 'world.sync.google_calendar', 'mcp:hive.open_position', 'selfmod.*', 'a.b.c.d', 'x_y-z', '../etc/passwd', 'FLINT_TOKEN', 'ledger_record_prediction', '`rm`']) {
      const said = ruleWords(pattern);
      expect(said, pattern).toMatch(/^[A-Z][A-Za-z0-9’ ]*$/);
      expect(noteProblems('A Title', `Flint may do this on its own: ${said}.`), pattern).toEqual([]);
    }
  });
});

