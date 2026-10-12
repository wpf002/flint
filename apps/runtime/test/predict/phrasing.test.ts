/**
 * The phrase table (P4 part 3): every phrase carries its number, is fit for a
 * note, and is one the notes' lint lets through only because it came from here.
 */
import { describe, it, expect } from 'vitest';
import { noteProblems } from '@flint/policy';
import { chancePhrase, forecastPhrase, noTrendPhrase, rangePhrase, unitSpan, unitValue } from '../../src/predict/phrasing';
import { hasLoosePrediction, phrase, phraseBefore } from '../../src/templates/escalations';
import type { ForecastUnit } from '../../src/predict/forecast';

const UNITS: ForecastUnit[] = ['count', 'usd', 'minutes', 'hours'];
const BY = new Date('2026-10-12T22:30:00Z');
const TZ = 'America/Chicago';

describe('the phrase table', () => {
  it('a chance says its word and its number; the notes\' phrase() is the same words', () => {
    expect(chancePhrase(0.7, BY, TZ)).toBe('likely, around 70% by Oct 12, 5:30 PM');
    expect(chancePhrase(0.4, undefined, TZ)).toBe('somewhat unlikely, around 40%');
    for (let i = 5; i <= 95; i += 1) {
      const p = i / 100;
      const said = chancePhrase(p, BY, TZ);
      expect(said, said).toContain(`around ${i}%`);
      expect(said, said).toMatch(/^(very unlikely|unlikely|somewhat unlikely|about even|somewhat likely|likely|very likely), around \d+% by Oct 12, 5:30 PM$/);
      // What an escalation's note has said since P2, to the letter.
      expect(phrase(p, BY, TZ)).toBe(said);
      expect(phraseBefore(p, BY, TZ)).toBe(said.replace(/, around (\d+%)/, ' (~$1)'));
    }
    expect([0.05, 0.2, 0.4, 0.5, 0.6, 0.8, 0.95].map((p) => chancePhrase(p, undefined, TZ).split(',')[0])).toEqual(['very unlikely', 'unlikely', 'somewhat unlikely', 'about even', 'somewhat likely', 'likely', 'very likely']);
    // Where one word ends and the next begins, to the percent (phrase() is this same function now, so the loop above
    // cannot see a boundary move: these can).
    const word = (pct: number) => chancePhrase(pct / 100, undefined, TZ).split(',')[0];
    expect([9, 10].map(word)).toEqual(['very unlikely', 'unlikely']);
    expect([34, 35].map(word)).toEqual(['unlikely', 'somewhat unlikely']);
    expect([44, 45].map(word)).toEqual(['somewhat unlikely', 'about even']);
    expect([55, 56].map(word)).toEqual(['about even', 'somewhat likely']);
    expect([64, 65].map(word)).toEqual(['somewhat likely', 'likely']);
    expect([89, 90].map(word)).toEqual(['likely', 'very likely']);
  });

  it('a value is said in its unit\'s words, never as a raw float', () => {
    expect([unitValue(4, 'count'), unitValue(1234, 'count'), unitValue(1.2, 'usd'), unitValue(0, 'usd'), unitValue(1234.5, 'usd')]).toEqual(['4', '1,234', '$1.20', '$0.00', '$1,234.50']);
    expect([unitValue(12, 'minutes'), unitValue(1, 'minutes'), unitValue(0, 'minutes'), unitValue(3.5, 'hours'), unitValue(1, 'hours'), unitValue(0.25, 'hours')]).toEqual(['12 minutes', '1 minute', '0 minutes', '3.5 hours', '1 hour', '0.25 hours']);
    expect([unitSpan(2, 6, 'count'), unitSpan(0.8, 1.75, 'usd'), unitSpan(5, 40, 'minutes'), unitSpan(1.5, 3.5, 'hours'), unitSpan(0, 1, 'hours')]).toEqual(['2 to 6', '$0.80 to $1.75', '5 to 40 minutes', '1.5 to 3.5 hours', '0 to 1 hours']);
    expect(unitValue(0.1 + 0.2, 'hours')).toBe('0.3 hours');
  });

  it('a range that beat a plain guess says its middle, its ends and its level; one that did not says there is no reliable trend, and no middle', () => {
    expect(rangePhrase({ point: 4, lower: 2, upper: 6, level: 0.8, unit: 'count' })).toBe('about 4, with an 80% range of 2 to 6');
    expect(rangePhrase({ point: 1.2, lower: 0.8, upper: 1.75, level: 0.8, unit: 'usd' })).toBe('about $1.20, with an 80% range of $0.80 to $1.75');
    expect(rangePhrase({ point: 12, lower: 0, upper: 45, level: 0.5, unit: 'minutes' })).toBe('about 12 minutes, with a 50% range of 0 to 45 minutes');
    // It says what the range is: a plain guess's, from how far such guesses have been off. Never "recent days ran from":
    // the last value plus or minus its past changes is not where recent days ran (review finding 14).
    expect(noTrendPhrase({ lower: 0, upper: 3, level: 0.8, unit: 'count' })).toBe('no reliable trend, and a plain guess gives an 80% range of 0 to 3');
    expect(noTrendPhrase({ lower: 498, upper: 502, level: 0.8, unit: 'usd' })).toBe('no reliable trend, and a plain guess gives an 80% range of $498.00 to $502.00');
    expect(noTrendPhrase({ lower: 0, upper: 45, level: 0.5, unit: 'minutes' })).toBe('no reliable trend, and a plain guess gives a 50% range of 0 to 45 minutes');
    expect(noTrendPhrase({ lower: 2, upper: 9, level: 0.8, unit: 'count' })).not.toMatch(/recent|ran from/);
    // By what the run earned: only a run that beat naive is said as a forecast. False and "too short to tell" are not.
    const r = { point: 4, lower: 2, upper: 6, level: 0.8, unit: 'count' as const };
    expect(forecastPhrase({ ...r, beatsNaive: true })).toBe(rangePhrase(r));
    expect(forecastPhrase({ ...r, beatsNaive: false })).toBe(noTrendPhrase(r));
    expect(forecastPhrase({ ...r, beatsNaive: null })).toBe(noTrendPhrase(r));
    expect(forecastPhrase({ ...r, beatsNaive: false })).not.toContain('about 4');
  });

  it('every output contains its number: a grid of ranges, levels and units', () => {
    for (const unit of UNITS) {
      for (const level of [0.5, 0.8, 0.9]) {
        for (const [lower, point, upper] of [[0, 0, 0], [0, 1, 3], [2, 4, 6], [10, 12.5, 40], [1200, 1500.25, 9000]] as const) {
          const r = { point, lower, upper, level, unit };
          const beat = rangePhrase(r);
          const none = noTrendPhrase(r);
          for (const said of [beat, none]) {
            expect(said, said).toContain(`${Math.round(level * 100)}% range`);
            expect(said, said).toContain(unitSpan(lower, upper, unit));
            // No key, no raw float, nothing a note may not carry.
            expect(said, said).not.toMatch(/\d\.\d{3,}|[()_]|daily\.|undefined|NaN/);
            expect(noteProblems('A Title', `Deploys: ${said}.`), said).toEqual([]);
          }
          expect(beat, beat).toContain(`about ${unitValue(point, unit)}`);
          expect(none, none).toContain('no reliable trend');
        }
      }
    }
  });

  it('the notes\' lint passes a phrase only when it came from the table: said anywhere else, the note falls back', () => {
    const phrases = [
      chancePhrase(0.7, BY, TZ), chancePhrase(0.05, undefined, TZ), chancePhrase(0.5, BY, TZ),
      rangePhrase({ point: 4, lower: 2, upper: 6, level: 0.8, unit: 'count' }), rangePhrase({ point: 1.2, lower: 0.8, upper: 1.75, level: 0.8, unit: 'usd' }),
      noTrendPhrase({ lower: 0, upper: 3, level: 0.8, unit: 'count' }), noTrendPhrase({ lower: 0, upper: 45, level: 0.5, unit: 'minutes' }),
    ];
    for (const said of phrases) {
      const note = `Deploys today: ${said}.`;
      // Declared as the ledger's: fine. Not declared: a loose claim.
      expect(hasLoosePrediction(note, [said]), said).toBe(false);
      expect(hasLoosePrediction(note), said).toBe(true);
      // Another row's phrase does not cover it.
      expect(hasLoosePrediction(note, [chancePhrase(0.33, BY, TZ)]), said).toBe(true);
    }
    // Words of chance written by hand are caught, whatever numbers sit beside them.
    expect(hasLoosePrediction('Deploys will probably be about 4.')).toBe(true);
    expect(hasLoosePrediction('Deploys today: about 4.')).toBe(false);
  });
});
