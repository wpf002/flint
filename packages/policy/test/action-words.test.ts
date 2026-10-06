import { describe, it, expect } from 'vitest';
import { ACTION_WORDS, actionWords } from '../src/action-words';

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
