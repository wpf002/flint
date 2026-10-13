/**
 * Word error rate (../src/wer): known pairs. The benchmark's transcription
 * accuracy is this number, so each kind of mistake is counted here by hand.
 */
import { describe, expect, it } from 'vitest';
import { werWords, wordErrorRate, wordErrors } from '../src/wer';

describe('werWords: two texts are made alike before they are compared', () => {
  it('case, punctuation and spacing do not count; an apostrophe inside a word is part of it', () => {
    expect(werWords('  Please, remind me — to call   the DENTIST tomorrow!  ')).toEqual(['please', 'remind', 'me', 'to', 'call', 'the', 'dentist', 'tomorrow']);
    expect(werWords("I don’t know. It's 'fine'.")).toEqual(['i', "don't", 'know', "it's", 'fine']);
    expect(werWords('follow-up, e-mail; read/write')).toEqual(['follow', 'up', 'e', 'mail', 'read', 'write']);
    expect(werWords('')).toEqual([]);
    expect(werWords('... !!! ---')).toEqual([]);
  });

  it('a number and a word for it are different words, and so are two spellings: the benchmark’s sentences avoid both', () => {
    expect(werWords('nine')).not.toEqual(werWords('9'));
    expect(werWords('colour')).not.toEqual(werWords('color'));
  });

  it('words in any script are words', () => {
    expect(werWords('Café déjà vu, 東京 2026')).toEqual(['café', 'déjà', 'vu', '東京', '2026']);
  });
});

describe('wordErrors: the fewest edits, by kind', () => {
  const REF = 'please remind me to call the dentist tomorrow morning'; // 9 words
  it('word for word is no error, whatever the case and punctuation', () => {
    expect(wordErrors(REF, 'Please remind me to call the dentist tomorrow morning.')).toEqual({ words: 9, substitutions: 0, deletions: 0, insertions: 0, errors: 0 });
  });

  it('a wrong word is a substitution, a missing word a deletion, an extra word an insertion', () => {
    expect(wordErrors(REF, 'please remind me to call the dentist tomorrow evening')).toMatchObject({ substitutions: 1, deletions: 0, insertions: 0, errors: 1 });
    expect(wordErrors(REF, 'please remind me to call dentist tomorrow morning')).toMatchObject({ substitutions: 0, deletions: 1, insertions: 0, errors: 1 });
    expect(wordErrors(REF, 'please remind me to call the the dentist tomorrow morning')).toMatchObject({ substitutions: 0, deletions: 0, insertions: 1, errors: 1 });
    expect(wordErrors(REF, 'please remind me call the dentists tomorrow morning now')).toMatchObject({ words: 9, substitutions: 1, deletions: 1, insertions: 1, errors: 3 });
  });

  it('nothing heard is every word deleted; words heard where none were said are all insertions', () => {
    expect(wordErrors(REF, '')).toEqual({ words: 9, substitutions: 0, deletions: 9, insertions: 0, errors: 9 });
    expect(wordErrors('', 'thank you for watching')).toEqual({ words: 0, substitutions: 0, deletions: 0, insertions: 4, errors: 4 });
    expect(wordErrors('', '')).toEqual({ words: 0, substitutions: 0, deletions: 0, insertions: 0, errors: 0 });
  });

  it('it is the shortest path that is counted, not a word-by-word comparison in place', () => {
    // One word dropped at the start: every later word is "in the wrong place", and it is still one error.
    expect(wordErrors('the quick brown fox jumps over the lazy dog', 'quick brown fox jumps over the lazy dog').errors).toBe(1);
    // Two words swapped: two substitutions.
    expect(wordErrors('turn off the kitchen lights', 'turn off the lights kitchen')).toMatchObject({ errors: 2 });
    // Entirely different words: as many errors as the longer text has words.
    expect(wordErrors('lock the front door', 'play some quiet music now').errors).toBe(5);
  });

  it('the counts are the same every time for the same pair (a substitution before a deletion before an insertion)', () => {
    const a = wordErrors('a b c d', 'a x d');
    expect(a).toEqual(wordErrors('a b c d', 'a x d'));
    expect(a).toMatchObject({ errors: 2, words: 4 });
    expect(a.substitutions + a.deletions + a.insertions).toBe(2);
  });
});

describe('wordErrorRate: all the errors over all the reference words', () => {
  it('a set of clips is scored together, so a short clip’s mistake counts for no more than a long one’s', () => {
    const pairs = [wordErrors('lock the door', 'lock the floor'), wordErrors('please remind me to call the dentist tomorrow morning', 'please remind me to call the dentist tomorrow morning')];
    expect(wordErrorRate(pairs)).toBeCloseTo(1 / 12, 10);
    expect(wordErrorRate([wordErrors('lock the door', 'lock the door')])).toBe(0);
  });

  it('it can pass 1, and with no reference words there is no rate', () => {
    expect(wordErrorRate([wordErrors('yes', 'thank you for watching')])).toBe(4);
    expect(wordErrorRate([])).toBeUndefined();
    expect(wordErrorRate([wordErrors('', 'anything')])).toBeUndefined();
  });
});
