/**
 * What a note to Will may show (2026-10-12): a short Title Case title in plain
 * words and complete sentences under it, never an internal name, a file path, a
 * command, an id, raw JSON or an aside in parentheses. noteProblems is that
 * rule as a check; the producers' inventory tests run every note through it,
 * and the runtime swaps a note that fails it for its field-free wording. So the
 * probes here cut both ways: what must be caught, and good words that must
 * never be mistaken for it (a false alarm would cost Will a good note).
 */
import { describe, it, expect } from 'vitest';
import { noteProblems, shownProblems, titleCase, nameWords, plainName } from '../src/notes';
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
    for (const t of ['The Server Is Down', 'New Issue: wpf002/flint #60', 'Claude Budget at 80% for This Month', 'CI Is Failing on Flint', 'The Trident API Service Is Down']) expect(titleCase(t)).toBe(t);
  });
});

describe('noteProblems', () => {
  const body = (b: string) => noteProblems('A Title', b);
  const title = (t: string) => noteProblems(t, '');

  it('passes a note in plain words', () => {
    expect(noteProblems('Offsite Backup Failed', 'Last night’s encrypted copy to iCloud didn’t finish. Flint tries again tonight.')).toEqual([]);
    expect(noteProblems('Daily Summary for Sun Oct 11', 'Yesterday, 3 items were important and 12 went to Other.\nToday, 1 prediction resolves.')).toEqual([]);
    expect(noteProblems('Claude Budget at 80% for Today', 'Flint has spent $8.00 of today’s $10.00 cap. Harder questions use a cheaper model, and background work waits.')).toEqual([]);
    // A title can stand alone.
    expect(noteProblems('Action Done', '')).toEqual([]);
  });

  it('catches what Will’s screenshot showed: an action’s name for a title, and a file path under it', () => {
    const was = noteProblems('backup.offsite failed', 'Last night’s offsite copy failed. The details are in ~/.flint/runtime-backup.out.log.');
    expect(was).toContain('the title has an internal name');
    expect(was).toContain('the body has a file path');
    expect(was.some((p) => p.startsWith('the title is not in Title Case'))).toBe(true);
  });

  it('catches each thing a note may not show', () => {
    const caught: Array<[string, string]> = [
      // Internal names, however they are written.
      ['The restore_drill job failed.', 'an internal name'],
      ['The com.flint.server agent stopped.', 'an internal name'],
      ['Set FLINT_OFFSITE_DIR to fix it.', 'an internal name'],
      ['The offsiteDir setting is empty.', 'an internal name'],
      ['It called worldNow twice.', 'an internal name'],
      ['The flint-server endpoint is down.', 'an internal name'],
      ['The worker-2 service is down.', 'an internal name'],
      ['The log is runtime-backup.out.log.', 'an internal name'],
      ['It ran maintenance.retention.', 'an internal name'],
      // Files and commands.
      ['A copy is in /Users/will/FlintBackups.', 'a file path'],
      ['A copy is in ~/FlintBackups/pre-migrate.', 'a file path'],
      ['Run `pnpm install` to fix it.', 'a backtick'],
      ['Run pnpm install to fix it.', 'a command'],
      ['Run ./install.sh again.', 'a command'],
      ['Try running launchctl kickstart on it.', 'a command'],
      ['Run it again with --auto to retry.', 'a command'],
      ['Restart it with kickstart -k first.', 'a command'],
      ['It reads $HOME for the folder.', 'a variable'],
      ['It reads ${HOME} for the folder.', 'a variable'],
      ['See https://example.com/help for more.', 'a link'],
      ['It is stored at file://tmp.', 'a link'],
      // Raw output.
      ['{"events":[{"id":1}]}', 'raw JSON'],
      ['It returned {ok: false}.', 'raw JSON'],
      ['It stopped with Error: connect refused.', 'an error’s own words'],
      ['It stopped with TypeError: x is not a function.', 'an error’s own words'],
      ['The server is down (again).', 'parentheses'],
      // Ids.
      ['The item issue#24ehza changed.', 'an id'],
      ['The deploy of 4aef4bf9c2 failed.', 'an id'],
      ['The card cmg4x2k9d0001ab3cdefgh1234 is waiting.', 'an id'],
      ['The escalation esmv5dr1mgf124592ee4 was sent.', 'an id'],
    ];
    for (const [text, what] of caught) expect(body(text), text).toContain(`the body has ${what}`);
    expect(title('service#abc123 is down')).toContain('the title has an id');
    expect(title('backup.offsite Failed')).toContain('the title has an internal name');
  });

  it('holds a title and each line to their shape', () => {
    expect(body('the server is down.')).toEqual(['a line of the body is not a sentence: the server is down.']);
    expect(body('The server is down')).toEqual(['a line of the body is not a sentence: The server is down']);
    expect(title('The server is down')).toEqual(['the title is not in Title Case (The Server Is Down)']);
    expect(title('The Server Is Down.')).toContain('the title ends with a stop');
    expect(title('The Server Is Down!')).toContain('the title ends with a stop');
    expect(noteProblems('', 'A sentence.')).toContain('the title is empty');
    expect(title(`A ${'Long '.repeat(20)}Title`)).toContain('the title is over 80 characters');
  });

  it('never mistakes good words for any of them: a false alarm would swap a good note for its field-free one', () => {
    const fine = [
      'It runs tonight at 2:15 AM.',
      'Flint has spent $8.00 of today’s $10.00 cap.',
      'Recovery is somewhat unlikely, around 40% by Oct 2, 5:30 PM.',
      'In the last 10 minutes, 1000000 requests to Flint failed.',
      'You have an event on Tue Oct 6 at 12:05 AM. Its title is in Activity, under Important.',
      'Nexus’s Responder service has been down for 35 minutes.',
      'The Trident API service has been down for 35 minutes.',
      // A sentence that starts with a name that starts small.
      'iCloud Drive is full.',
      'iMessage is quiet today.',
      // Short forms, versions and a site's name are not internal names.
      'It runs at 2 a.m. and again at 3 p.m. each day.',
      'Some services, e.g. voice, are optional.',
      'Flint moved to v2.1 last night.',
      'Claude answers at claude.ai as well.',
      // Ordinary words with a hyphen.
      'Auto-deploy has been down for 35 minutes. It is read-only until then.',
      'The age-encrypted copy is kept for a week.',
      'Flint flagged it as money-related. It’s in Activity, under Important.',
      'It dropped to -5 overnight.',
      // Tool names as words, not commands; a dash between words.
      'The Npm service has been down for 35 minutes.',
      'The Psql service has been down for 35 minutes.',
      'The Brew service has been down for 35 minutes.',
      'Flint ran its checks - all passed.',
      'It ran the backup again.',
      'Run it again from Approvals.',
      // A line that ends inside a closing quote, and a quoted name.
      'An iMessage event matched your rule “ci red”.',
      'It said “all done.”',
      'A GitHub event matched one of your rules.',
      // Money, counts and times are not ids.
      'The last good database backup is 1000000 hours old.',
      'It won’t work until its setup is fixed, so tell Claude.',
    ];
    for (const ok of fine) expect(body(ok), ok).toEqual([]);
    for (const ok of ['Is the Server Down?', 'The iCloud Copy Failed', 'New Issue: Item', 'On Your Calendar Tue Oct 6 at 2:30 PM', 'Offsite Backup Failed']) expect(title(ok), ok).toEqual([]);
  });
});

describe('shownProblems: a name someone else gave a thing', () => {
  it('lets a repo, a thread or a version be named as it is', () => {
    for (const label of ['wpf002/nexus-responder #12', 'wpf002/flint.js #60', 'v2.1 plan', 'claude.ai outage', 'Deploy 4aef4bf9c2 plan', 'my_thread', 'worldNow rename']) expect(shownProblems(label), label).toEqual([]);
  });

  it('still refuses what no text on a note may carry', () => {
    expect(shownProblems('see /Users/will/notes')).toEqual(['a file path']);
    expect(shownProblems('fix `rm -rf` bug')).toEqual(['a backtick']);
    expect(shownProblems('{"title": "x"}')).toContain('raw JSON');
    expect(shownProblems('api (staging)')).toEqual(['parentheses']);
    expect(shownProblems('see https://example.com')).toEqual(['a link']);
    expect(shownProblems('uses $HOME')).toEqual(['a variable']);
    expect(shownProblems('TypeError: x')).toEqual(['an error’s own words']);
    expect(shownProblems('Run npm ci nightly')).toEqual(['a command']);
    expect(shownProblems('about issue#24ehza')).toEqual(['an id']);
  });
});

describe('words for internal values', () => {
  it('a name’s parts are its words', () => {
    expect(nameWords('restore_drill')).toBe('restore drill');
    expect(nameWords('backup.offsite')).toBe('backup offsite');
    expect(plainName('ci_red.main')).toBe('ci red main');
    expect(plainName('ci-red')).toBe('ci red');
    // A name of marks alone has no words.
    expect(plainName('...')).toBe('');
    expect(plainName('-_-')).toBe('');
  });

  it('a cap’s period is a real word: daily, never "dayly"', () => {
    expect(CAP_WORDS).toEqual({ hour: 'hourly', day: 'daily', week: 'weekly' });
  });
});
