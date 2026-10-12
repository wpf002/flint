import { describe, it, expect } from 'vitest';
import { ACTION_DONE, ACTION_WORDS, JOB_WORDS, actionWords, jobFailedNote, type NightlyJob } from '../src/action-words';
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

  it('says what happened and what happens next, in Will’s words', () => {
    expect(jobFailedNote('backup.offsite', { alone: true, icloud: true })).toEqual({ title: 'Offsite Backup Failed', body: 'Last night’s encrypted copy to iCloud didn’t finish. Flint tries again tonight.' });
    expect(jobFailedNote('backup.local', { alone: true })).toEqual({ title: 'Backup Failed', body: 'Last night’s database backup didn’t finish. Flint tries again tonight.' });
    expect(jobFailedNote('restore.drill', { alone: true, mismatch: true })).toEqual({ title: 'Restore Test Failed', body: 'This week’s practice restore found a problem. Flint tries again next Sunday.' });
    // It stopped before it could compare anything: it did not finish, which is not "found a problem".
    expect(jobFailedNote('restore.drill', { alone: true }).body).toBe('This week’s practice restore didn’t finish. Flint tries again next Sunday.');
    // A folder Will set himself is not called iCloud.
    expect(jobFailedNote('backup.offsite', { alone: true, icloud: false }).body).toBe('Last night’s encrypted offsite copy didn’t finish. Flint tries again tonight.');
  });

  it('never promises another try for a job that waits on Will’s card: it says where the card is', () => {
    for (const job of JOBS) {
      const note = jobFailedNote(job, { alone: false, icloud: true, mismatch: true });
      expect(note.body).toMatch(/ It runs again once you approve its next card in Approvals\.$/);
      expect(note.body).not.toMatch(/tries again/);
    }
  });

  it('every variant is a note fit to show', () => {
    for (const job of JOBS) {
      for (const alone of [true, false]) {
        for (const icloud of [true, false]) {
          for (const mismatch of [true, false]) {
            const note = jobFailedNote(job, { alone, icloud, mismatch });
            expect(noteProblems(note.title, note.body), `${job} ${JSON.stringify({ alone, icloud, mismatch })}`).toEqual([]);
            expect(note.title).toBe(`${JOB_WORDS[job]} Failed`);
          }
        }
      }
    }
  });
});
