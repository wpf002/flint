/**
 * The 07:30 digest's words (no database): each line is a complete sentence in
 * the console's words, singular and plural and none, and Health's names stand
 * for the components.
 */
import { describe, it, expect } from 'vitest';
import { digestBody } from '../src/digest';

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

  it('names six components and counts the rest', () => {
    const many = ['audit_intents', 'backup', 'bus', 'migrate_failed', 'ollama', 'restore_drill', 'retention', 'server'];
    expect(digestBody(zero, many).split('\n')[2]).toBe('These need a look: Action Log, Backups, Job Queue, Updates, Local Model, Restore Test and 2 more.');
  });
});
