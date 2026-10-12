/**
 * The 07:30 digest's words (no database): each line is a complete sentence in
 * the console's words, singular and plural and none, and Health's names stand
 * for the components.
 */
import { describe, it, expect } from 'vitest';
import { digestBody, digestTitle, goalsSentence } from '../src/digest';
import { noteProblems } from '@flint/policy';

const zero = { relevant: 0, quiet: 0, escalated: 0, did: 0, queued: 0, open: 0, due: 0 };

describe('the digest body', () => {
  it('says each count in a sentence', () => {
    expect(digestBody({ relevant: 3, quiet: 12, escalated: 1, did: 2, queued: 1, open: 3, due: 3 }, ['bus', 'restore_drill', 'source:github']).split('\n')).toEqual([
      'Yesterday, 3 items were important and 12 went to Other. Flint escalated 1.',
      'Flint did 2 things on its own. You have 1 approval and 3 open escalations waiting.',
      'These need a look: Job Queue, Restore Test and GitHub.',
      'Today, 3 predictions resolve.',
    ]);
  });

  it('has a sentence for one, and for none', () => {
    expect(digestBody({ ...zero, relevant: 1, quiet: 1, did: 1, open: 1, due: 1 }, ['backup']).split('\n')).toEqual([
      'Yesterday, 1 item was important and 1 went to Other.',
      'Flint did 1 thing on its own. You have 1 open escalation waiting.',
      'This needs a look: Backups.',
      'Today, 1 prediction resolves.',
    ]);
    expect(digestBody(zero, []).split('\n')).toEqual([
      'Yesterday, no items were important and none went to Other.',
      'Flint did nothing on its own. Nothing is waiting on you.',
      'Everything checked is healthy.',
      'No predictions resolve today.',
    ]);
  });

  it('names the offsite copy as Settings > Health does', () => {
    expect(digestBody(zero, ['offsite_backup']).split('\n')[2]).toBe('This needs a look: Offsite Backup.');
    expect(digestBody(zero, ['backup', 'offsite_backup']).split('\n')[2]).toBe('These need a look: Backups and Offsite Backup.');
  });

  it('on a day Flint reviewed goals, says how many and how many were late: counts only, a sentence', () => {
    expect(goalsSentence(0, 0)).toBe('');
    expect(goalsSentence(1, 0)).toBe('Flint reviewed 1 goal yesterday, on time.');
    expect(goalsSentence(1, 1)).toBe('Flint reviewed 1 goal yesterday, and it was late.');
    expect(goalsSentence(3, 0)).toBe('Flint reviewed 3 goals yesterday, and none was late.');
    expect(goalsSentence(3, 1)).toBe('Flint reviewed 3 goals yesterday, and 1 was late.');
    expect(goalsSentence(3, 2)).toBe('Flint reviewed 3 goals yesterday, and 2 were late.');
    const lines = digestBody({ relevant: 3, quiet: 12, escalated: 1, did: 2, queued: 1, open: 3, due: 3, goalsReviewed: 3, goalsLate: 0 }, ['goals']).split('\n');
    expect(lines).toEqual([
      'Yesterday, 3 items were important and 12 went to Other. Flint escalated 1.',
      'Flint did 2 things on its own. You have 1 approval and 3 open escalations waiting.',
      'Flint reviewed 3 goals yesterday, and none was late.',
      'This needs a look: Goal Reviews.',
      'Today, 3 predictions resolve.',
    ]);
    for (const l of lines) expect(l).toMatch(/^[A-Z].*\.$/);
    // It is a note's line like the others: plain words, by the same rules (@flint/policy's noteProblems).
    for (const [reviewed, late] of [[1, 0], [1, 1], [3, 0], [3, 1], [12, 5]] as const) expect(noteProblems(digestTitle('2026-10-11'), goalsSentence(reviewed, late)), `${reviewed}/${late}`).toEqual([]);
    expect(noteProblems(digestTitle('2026-10-11'), lines.join('\n'))).toEqual([]);
    // No goals reviewed: the digest is the four lines it always was.
    expect(digestBody({ ...zero, goalsReviewed: 0, goalsLate: 0 }, [])).toBe(digestBody(zero, []));
    // With every count large and every line at its longest, it still fits the note's 500 characters.
    const big = { relevant: 99_999, quiet: 99_999, escalated: 99_999, did: 99_999, queued: 9_999, open: 9_999, due: 9_999, goalsReviewed: 200, goalsLate: 199 };
    const many = ['audit_intents', 'backup', 'bus', 'migrate_failed', 'ollama', 'restore_drill', 'retention', 'server', 'goals', 'source:google_calendar'];
    expect(digestBody(big, many).length).toBeLessThanOrEqual(500);
  });

  it('names six components and counts the rest', () => {
    const many = ['audit_intents', 'backup', 'bus', 'migrate_failed', 'ollama', 'restore_drill', 'retention', 'server'];
    expect(digestBody(zero, many).split('\n')[2]).toBe('These need a look: Action Log, Backups, Job Queue, Updates, Local Model, Restore Test and 2 more.');
  });

  it('the title says the day in words, never as a date code', () => {
    expect(digestTitle('2026-10-11')).toBe('Daily Summary for Sun Oct 11');
    expect(digestTitle('2026-01-01')).toBe('Daily Summary for Thu Jan 1');
    expect(digestTitle('2026-10-11')).not.toMatch(/\d{4}-\d{2}/);
  });
});
