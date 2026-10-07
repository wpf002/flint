import { describe, it, expect } from 'vitest';
import { ACTION_DONE, ACTION_WORDS, actionWords } from '../src/action-words';

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
