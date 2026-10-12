/**
 * What a note to Will may show (2026-10-12): a short Title Case title in plain
 * words and complete sentences under it, never an internal name, a file path, a
 * command, an id, raw JSON or an aside in parentheses. noteProblems is that
 * rule as a check; the producers' inventory tests run every note through it.
 */
import { describe, it, expect } from 'vitest';
import { noteProblems, titleCase, nameWords } from '../src/notes';
import { CAP_WORDS } from '../src/tiers';

describe('titleCase', () => {
  it('is Apple’s title style: small words stay small inside, the first and last word never do', () => {
    expect(titleCase('backups waiting for you')).toBe('Backups Waiting for You');
    expect(titleCase('on your calendar tue oct 6, all day')).toBe('On Your Calendar Tue Oct 6, All Day');
    expect(titleCase('something to look at')).toBe('Something to Look At');
    expect(titleCase('école of ödeme')).toBe('École of Ödeme');
  });

  it('leaves a word with its own capitals or marks as written, and is the same said twice', () => {
    for (const kept of ['GitHub', 'iCloud', 'iMessage', 'CI', 'OpenAI', '2:15', '#60', 'wpf002/flint']) expect(titleCase(`the ${kept} thing`)).toBe(`The ${kept} Thing`);
    // A colon or a stop after a word is not such a mark.
    expect(titleCase('new issue: the login page')).toBe('New Issue: the Login Page');
    for (const t of ['The Server Is Down', 'New Issue: wpf002/flint #60', 'Claude Budget at 80% for This Month', 'CI Is Failing on Flint']) expect(titleCase(t)).toBe(t);
  });
});

describe('noteProblems', () => {
  it('passes a note in plain words', () => {
    expect(noteProblems('Offsite Backup Failed', 'Last night’s encrypted copy to iCloud didn’t finish. Flint tries again tonight.')).toEqual([]);
    expect(noteProblems('Daily Summary for Sun Oct 11', 'Yesterday, 3 items were important and 12 went to Other.\nToday, 1 prediction resolves.')).toEqual([]);
    expect(noteProblems('Claude Budget at 80% for Today', 'Flint has spent $8.00 of today’s $10.00 cap. Harder questions use a cheaper model, and background work waits.')).toEqual([]);
    expect(noteProblems('New Issue: wpf002/flint #60', 'Flint flagged it as needing you. It’s in Activity, under Important.')).toEqual([]);
    // A title can stand alone.
    expect(noteProblems('Action Done', '')).toEqual([]);
  });

  it('catches what Will’s screenshot showed: an action’s name for a title, and a file path under it', () => {
    const was = noteProblems('backup.offsite failed', 'Last night’s offsite copy failed. The details are in ~/.flint/runtime-backup.out.log.');
    expect(was).toContain('the title has an internal name');
    expect(was).toContain('the body has a file path');
    expect(was.some((p) => p.startsWith('the title is not in Title Case'))).toBe(true);
  });

  it('catches each thing a note may not show, in the title or the body', () => {
    const body = (b: string) => noteProblems('A Title', b);
    expect(body('The restore_drill job failed.')).toContain('the body has an internal name');
    expect(body('The com.flint.server agent stopped.')).toContain('the body has an internal name');
    expect(body('A copy is in /Users/will/FlintBackups.')).toContain('the body has a file path');
    expect(body('A copy is in ~/FlintBackups/pre-migrate.')).toContain('the body has a file path');
    expect(body('Run `pnpm install` to fix it.')).toContain('the body has a backtick');
    expect(body('Run it again with --auto to retry.')).toContain('the body has a command');
    expect(body('Restart it with launchctl kickstart.')).toContain('the body has a command');
    expect(body('{"events":[{"id":1}]}')).toContain('the body has raw JSON');
    expect(body('It returned {ok: false}.')).toContain('the body has raw JSON');
    expect(body('The server is down (again).')).toContain('the body has parentheses');
    expect(body('The item issue#24ehza changed.')).toContain('the body has an id');
    expect(body('The deploy of 4aef4bf9c2 failed.')).toContain('the body has an id');
    expect(body('the server is down.')).toEqual(['a line of the body is not a sentence: the server is down.']);
    expect(body('The server is down')).toEqual(['a line of the body is not a sentence: The server is down']);
    expect(noteProblems('service#abc123 is down', '')).toContain('the title has an id');
    expect(noteProblems('The server is down', '')).toEqual(['the title is not in Title Case (The Server Is Down)']);
    expect(noteProblems('The Server Is Down.', '')).toContain('the title ends with a stop');
    expect(noteProblems('', 'A sentence.')).toContain('the title is empty');
    expect(noteProblems(`A ${'Long '.repeat(20)}Title`, '')).toContain('the title is over 80 characters');
  });

  it('does not mistake ordinary words for any of them', () => {
    for (const ok of [
      'It runs tonight at 2:15 AM.', 'Flint has spent $8.00 of today’s $10.00 cap.', 'The trident-api service has been down for 35 minutes.',
      'Recovery is somewhat unlikely, around 40% by Oct 2, 5:30 PM.', 'An iMessage event matched your rule “ci-red”.', 'In the last 10 minutes, 1000000 requests to Flint failed.',
      'You have an event on Tue Oct 6 at 12:05 AM. Its title is in Activity, under Important.', 'Nexus’s responder service has been down for 35 minutes.',
    ]) {
      expect(noteProblems('A Title', ok), ok).toEqual([]);
    }
  });
});

describe('words for internal values', () => {
  it('a name’s parts are its words', () => {
    expect(nameWords('restore_drill')).toBe('restore drill');
    expect(nameWords('backup.offsite')).toBe('backup offsite');
    expect(nameWords('ci-red')).toBe('ci-red');
  });

  it('a cap’s period is a real word: daily, never "dayly"', () => {
    expect(CAP_WORDS).toEqual({ hour: 'hourly', day: 'daily', week: 'weekly' });
  });
});
