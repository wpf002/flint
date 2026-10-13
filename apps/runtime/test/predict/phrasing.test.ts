/**
 * The phrase table (P4 part 3): every phrase carries its number, is fit for a
 * note, and is one the notes' lint lets through only because it came from here.
 */
import { describe, it, expect } from 'vitest';
import { noteProblems } from '@flint/policy';
import { PanelSentence, PanelWords, noteProblems as problems } from '@flint/policy';
import {
  PANEL, aboutValue, aboveLabel, answeredSays, calledSays, chanceParts, chancePhrase, chanceSays, chanceValue, dayWords, dueSays, earlySays, errorScoreSays, expectSays, forecastPhrase, gapSays, noTrendPhrase, noTrendSays,
  opinionSays, opinionTooFewSays, opinionVersusSays, rangePhrase, rangesHeldSays, recordSays, saidSays, scoredValue, shortSays, steadySays, stepLabel, stepRangeSays, templatedClaim, thresholdClaim, tooFewSays, unitSpan, unitValue, unsettledSays, waitingSays,
} from '../../src/predict/phrasing';
import { hasLoosePrediction, phrase, phraseBefore } from '../../src/templates/escalations';
import { FORECAST_SERIES } from '../../src/predict/series';
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
    // Odds said with "even" are caught as before: the phrases, never the plain word.
    for (const loose of ['Even money says yes.', 'It’s even money the deploy lands.', 'Even odds it holds.', 'It’s about even.', 'There’s an even chance it slips.']) {
      expect(hasLoosePrediction(loose), loose).toBe(true);
    }
    for (const plain of ['It held even after a restart.', 'Even the backup finished.', 'Not even one failed.', 'Spend is even with last month.']) {
      expect(hasLoosePrediction(plain), plain).toBe(false);
    }
  });
});

describe('the Predictions panel\'s words (P4 part 4)', () => {
  /** A sentence the panel shows: fit for the wire, and for Will (the notes' rules). */
  const sentence = (s: string) => {
    expect(PanelSentence.safeParse(s).success, s).toBe(true);
    expect(problems('Predictions', s), s).toEqual([]);
    expect(s, s).toMatch(/^[A-Z0-9].*[.]$/);
    expect(s, s).not.toMatch(/daily\.|weekly\.|\busd\b|_|[()]|NaN|undefined|null|Infinity/);
  };
  /** A label or a value: a few words, Title Case. */
  const words = (s: string) => {
    expect(PanelWords.safeParse(s).success, s).toBe(true);
    expect(s, s).not.toMatch(/(^| )[a-z]/);
    expect(s, s).not.toMatch(/NaN|undefined|null|Infinity|[()_]/);
  };

  it('a forecast says its range in plain words, in the number\'s own unit', () => {
    expect(expectSays({ point: 4, lower: 2, upper: 6, level: 0.8, unit: 'count' })).toBe('Flint expects about 4, with an 80% range of 2 to 6.');
    expect(expectSays({ point: 1.2, lower: 0.8, upper: 1.75, level: 0.8, unit: 'usd' })).toBe('Flint expects about $1.20, with an 80% range of $0.80 to $1.75.');
    expect(expectSays({ point: 12, lower: 5, upper: 40, level: 0.8, unit: 'minutes' })).toBe('Flint expects about 12 minutes, with an 80% range of 5 to 40 minutes.');
    expect(expectSays({ point: 3.5, lower: 1, upper: 6.25, level: 0.8, unit: 'hours' })).toBe('Flint expects about 3.5 hours, with an 80% range of 1 to 6.25 hours.');
    expect([aboutValue(4, 'count'), aboutValue(1.2, 'usd'), aboutValue(12, 'minutes'), aboutValue(1, 'minutes'), aboutValue(3.5, 'hours'), aboutValue(12_345, 'count')]).toEqual(['About 4', 'About $1.20', 'About 12 Minutes', 'About 1 Minute', 'About 3.5 Hours', 'About 12,345']);
    for (const unit of UNITS) {
      sentence(expectSays({ point: 4, lower: 2, upper: 6, level: 0.8, unit }));
      words(aboutValue(4, unit));
    }
  });

  it('no reliable trend names no middle: only a plain guess\'s range', () => {
    expect(noTrendSays({ lower: 0, upper: 3, level: 0.8, unit: 'count' })).toBe('There’s no reliable trend, and a plain guess gives an 80% range of 0 to 3.');
    for (const unit of UNITS) {
      const said = noTrendSays({ lower: 0, upper: 3, level: 0.8, unit });
      sentence(said);
      expect(said).not.toContain('about');
      expect(said).not.toContain('expects');
    }
    words(PANEL.values.noTrend);
  });

  it('too early to tell is said as that, never as "no reliable trend": only a plain guess\'s range, and no middle', () => {
    expect(earlySays({ lower: 0, upper: 3, level: 0.8, unit: 'count' })).toBe('It’s too early to tell a trend, and a plain guess gives an 80% range of 0 to 3.');
    expect(earlySays({ lower: 0.8, upper: 1.75, level: 0.8, unit: 'usd' })).toBe('It’s too early to tell a trend, and a plain guess gives an 80% range of $0.80 to $1.75.');
    for (const unit of UNITS) {
      const said = earlySays({ lower: 0, upper: 3, level: 0.8, unit });
      sentence(said);
      expect(said).not.toMatch(/about|expects|no reliable trend/);
    }
    words(PANEL.values.early);
  });

  it('money below zero carries its sign before the dollar sign, and nothing is ever minus zero', () => {
    expect(unitValue(-5, 'usd')).toBe('-$5.00');
    expect(unitValue(-1234.5, 'usd')).toBe('-$1,234.50');
    expect(unitValue(-0.001, 'usd')).toBe('$0.00');
    expect(unitValue(0, 'usd')).toBe('$0.00');
    expect(unitSpan(-5, 2.5, 'usd')).toBe('-$5.00 to $2.50');
    expect(thresholdClaim('Anthropic Spend', 'above', -5, 'usd')).toBe('Anthropic Spend ran above -$5.00.');
    for (const s of [unitValue(-5, 'usd'), unitSpan(-5, 2.5, 'usd')]) expect(s).not.toContain('$-');
  });

  it('a state with no number says so in a sentence, and carries no number of the series', () => {
    expect(waitingSays('day')).toBe('Yesterday’s number isn’t in yet, so there’s no forecast for today.');
    expect(waitingSays('week')).toBe('Last week’s number isn’t in yet, so there’s no forecast for this week.');
    expect(shortSays('day', 24, 9)).toBe('Flint needs 24 days of history. It has 9.');
    expect(shortSays('week', 19, 1)).toBe('Flint needs 19 weeks of history. It has 1.');
    // A steady number says how many of its latest steps are the same, as counted, and never more than there are: 24
    // equal days are 24 days, not the 28 a longer history is judged over.
    expect(steadySays('day', 28)).toBe('This number hasn’t changed in 28 days.');
    expect(steadySays('day', 24)).toBe('This number hasn’t changed in 24 days.');
    expect(steadySays('week', 19)).toBe('This number hasn’t changed in 19 weeks.');
    expect(steadySays('week', 28)).toBe('This number hasn’t changed in 28 weeks.');
    // More than the 28 it is judged over is still said as 28; not counted, it says so with no number at all.
    expect(steadySays('day', 400)).toBe('This number hasn’t changed in 28 days.');
    for (const none of [undefined, 0, 1, 2.5, Number.NaN]) expect(steadySays('day', none), String(none)).toBe('This number hasn’t changed lately.');
    expect([PANEL.noData, PANEL.off, PANEL.failed, PANEL.tonight]).toEqual([
      'This number has no data yet.', 'Forecasts for this number are off.', 'Flint couldn’t forecast this number last night.', 'Flint makes its next forecast tonight.',
    ]);
    for (const s of [waitingSays('day'), waitingSays('week'), steadySays('day', 24), steadySays('week', 28), steadySays('day'), PANEL.noData, PANEL.off, PANEL.failed, PANEL.tonight]) {
      sentence(s);
      // Nothing but its own count of steps: no value, no range, no percent.
      expect(s.replace(/in \d+ (days|weeks)/, ''), s).not.toMatch(/\d|%|\$/);
    }
    sentence(shortSays('day', 24, 0));
    expect(Object.values(PANEL.values)).toEqual(['No Trend', 'Too Early', 'Steady', 'Waiting', 'Not Enough History', 'No Data', 'Tonight', 'Failed', 'Off']);
    for (const v of Object.values(PANEL.values)) words(v);
  });

  it('one step of a forecast: its own range, or a plain guess\'s; later steps are named by their day or week', () => {
    expect(stepRangeSays({ lower: 2, upper: 6, level: 0.8, unit: 'count' }, true)).toBe('The 80% range is 2 to 6.');
    expect(stepRangeSays({ lower: 0, upper: 3, level: 0.8, unit: 'count' }, false)).toBe('A plain guess gives an 80% range of 0 to 3.');
    for (const unit of UNITS) for (const beats of [true, false]) sentence(stepRangeSays({ lower: 0.5, upper: 3, level: 0.8, unit }, beats));
    expect(stepLabel(new Date('2026-10-13T05:00:00Z'), TZ, 'day')).toBe('Tue, Oct 13');
    expect(stepLabel(new Date('2026-10-19T05:00:00Z'), TZ, 'week')).toBe('Week of Oct 19');
    // The day is Flint's own zone's: this instant is still Oct 12 in Chicago.
    expect(stepLabel(new Date('2026-10-13T03:00:00Z'), TZ, 'day')).toBe('Mon, Oct 12');
    expect(dayWords(new Date('2026-10-03T17:00:00Z'), TZ, new Date('2026-10-12T12:00:00Z'))).toBe('Oct 3');
    expect(dayWords(new Date('2025-12-31T17:00:00Z'), TZ, new Date('2026-10-12T12:00:00Z'))).toBe('Dec 31, 2025');
  });

  it('the forecast\'s yes/no question says its chance in the ledger\'s own words, with its number', () => {
    expect(aboveLabel(3, 'count')).toBe('Above 3');
    expect(aboveLabel(1.2, 'usd')).toBe('Above $1.20');
    expect(aboveLabel(12, 'minutes')).toBe('Above 12 Minutes');
    expect(chanceValue(0.7)).toBe('Likely · 70%');
    expect(chanceValue(0.5)).toBe('About Even · 50%');
    expect(chanceSays(0.7, 'day', 3, 'count')).toBe('It’s likely, around 70%, that today runs above 3.');
    expect(chanceSays(0.08, 'week', 12, 'count')).toBe('It’s very unlikely, around 8%, that this week runs above 12.');
    for (let i = 5; i <= 95; i += 5) {
      const p = i / 100;
      const x = chanceParts(p, undefined, TZ);
      for (const unit of UNITS) sentence(chanceSays(p, 'day', 3, unit));
      // The same word and number the notes' phrase table gives for this chance.
      expect(chanceSays(p, 'day', 3, 'count')).toContain(`${x.word}, around ${x.pct}%`);
      expect(chanceValue(p)).toContain(`${x.pct}%`);
      words(chanceValue(p));
    }
  });

  it('a number\'s record, a question for Will and his answer are each one sentence', () => {
    expect(recordSays(22, 27)).toBe('22 of its last 27 ranges held.');
    expect(recordSays(0, 0)).toBe('Flint has no results for this number yet.');
    expect([recordSays(1, 1), recordSays(0, 1)]).toEqual(['Its last range held.', 'Its last range didn’t hold.']);
    expect(saidSays(0.7, 'Oct 3')).toBe('Flint said likely, around 70%, on Oct 3.');
    // When it was due, in Flint's own zone: his answer is recorded as of that moment, so the question says it.
    const asOf = new Date('2026-10-12T12:00:00Z');
    // (The time and its AM or PM are held together by a no-break space: a narrow row never leaves "PM." alone on a line.)
    expect(dueSays(new Date('2026-10-05T20:00:00Z'), TZ, asOf)).toBe('It was due Oct 5 at 3:00\u00a0PM.');
    expect(dueSays(new Date('2026-10-06T03:30:00Z'), TZ, asOf)).toBe('It was due Oct 5 at 10:30\u00a0PM.');
    expect(dueSays(new Date('2025-12-31T18:05:00Z'), TZ, asOf)).toBe('It was due Dec 31, 2025 at 12:05\u00a0PM.');
    expect(dueSays(new Date('2026-10-05T14:00:00Z'), TZ, asOf)).toBe('It was due Oct 5 at 9:00\u00a0AM.');
    expect(`${saidSays(0.7, 'Oct 3')} ${dueSays(new Date('2026-10-05T20:00:00Z'), TZ, asOf)}`).toBe('Flint said likely, around 70%, on Oct 3. It was due Oct 5 at 3:00\u00a0PM.');
    sentence(`${saidSays(0.7, 'Oct 3')} ${dueSays(new Date('2026-10-05T20:00:00Z'), TZ, asOf)}`);
    expect(answeredSays('yes', 'Oct 12')).toBe('You said yes on Oct 12.');
    expect(answeredSays('no', 'Oct 12')).toBe('You said no on Oct 12.');
    expect(answeredSays('skip', 'Oct 12')).toBe('You skipped it on Oct 12.');
    expect(templatedClaim('healthy', 'Flint Server')).toBe('Flint Server reports healthy.');
    expect(templatedClaim('deploy', 'wpf002/flint CI')).toBe('The next deploy of wpf002/flint CI succeeds.');
    expect(templatedClaim('closed', 'wpf002/flint #57')).toBe('wpf002/flint #57 is closed.');
    // "Ran" needs no agreement with the name: every one of Flint's twelve numbers reads right.
    expect(thresholdClaim('Deploys', 'above', 4, 'count')).toBe('Deploys ran above 4.');
    expect(thresholdClaim('Anthropic Spend', 'below', 1.2, 'usd')).toBe('Anthropic Spend ran below $1.20.');
    expect(FORECAST_SERIES.map((d) => thresholdClaim(d.name, 'above', 4, d.unit))).toEqual([
      'Anthropic Spend ran above $4.00.', 'OpenAI Spend ran above $4.00.', 'Perplexity Spend ran above $4.00.', 'Tavily Spend ran above $4.00.', 'Deploys ran above 4.',
      'Flint Commits ran above 4.', 'Nexus Commits ran above 4.', 'Trident Commits ran above 4.', 'Helm Commits ran above 4.',
      'Service Downtime ran above 4 minutes.', 'Open Threads ran above 4.', 'Calendar Hours ran above 4 hours.',
    ]);
    for (const d of FORECAST_SERIES) {
      sentence(thresholdClaim(d.name, 'below', 4, d.unit));
      expect(thresholdClaim(d.name, 'above', 4, d.unit)).not.toMatch(/ is (above|below) /);
    }
    for (const s of [recordSays(22, 27), recordSays(0, 0), recordSays(1, 1), recordSays(0, 1), saidSays(0.7, 'Oct 3'), saidSays(0.05, 'Dec 31, 2025'), answeredSays('yes', 'Oct 12'), answeredSays('skip', 'Oct 12'), PANEL.outsideClaim, PANEL.noRecord]) sentence(s);
  });

  it('how Flint has done: each line a sentence made from counts and shares', () => {
    expect(calledSays(70, 64, 41)).toBe('When Flint said about 70%, it happened 64% of the time, over 41 predictions.');
    expect(rangesHeldSays(0.8, 79, 120)).toBe('Its 80% ranges held 79% of the time, over 120 forecasts.');
    expect(tooFewSays('binary', 12, 30)).toBe('Flint has 12 of the 30 results it needs for its yes or no predictions.');
    expect(tooFewSays('range', 25, 30)).toBe('Flint has 25 of the 30 results it needs for its ranges.');
    expect(errorScoreSays(0.2149)).toBe('Its error score is 0.21, and lower is better.');
    expect(errorScoreSays(0.21, 0.18, 0.24)).toBe('Its error score is 0.21, and lower is better. The likely range is 0.18 to 0.24.');
    expect(gapSays(6)).toBe('Its stated chances sat 6 points from what happened, on average.');
    expect(gapSays(1)).toBe('Its stated chances sat 1 point from what happened, on average.');
    expect([PANEL.better, PANEL.noBetter, PANEL.noResults]).toEqual(['Flint did better than always guessing the usual rate.', 'Flint did no better than guessing the usual rate.', 'There are no results yet.']);
    expect(scoredValue(41)).toBe('41 Scored');
    words(scoredValue(0));
    expect([unsettledSays('expired', 3), unsettledSays('late', 2), unsettledSays('declined', 4), unsettledSays('void', 1)]).toEqual([
      '3 predictions ran out before they could be checked.', '2 were revised close to their date.', '4 depended on advice you declined.', '1 was set aside with your approval.',
    ]);
    expect([unsettledSays('expired', 1), unsettledSays('late', 1), unsettledSays('declined', 1), unsettledSays('void', 2)]).toEqual([
      '1 prediction ran out before it could be checked.', '1 was revised close to its date.', '1 depended on advice you declined.', '2 were set aside with your approval.',
    ]);
    for (const s of [
      calledSays(70, 64, 41), calledSays(100, 0, 1), rangesHeldSays(0.8, 79, 120), rangesHeldSays(0.8, 100, 1), tooFewSays('binary', 12, 30), tooFewSays('range', 25, 30), errorScoreSays(0.21), errorScoreSays(0.21, 0.18, 0.24), gapSays(6), gapSays(0),
      PANEL.better, PANEL.noBetter, PANEL.noResults,
      ...(['expired', 'late', 'declined', 'void'] as const).flatMap((kind) => [1, 2, 40].map((n) => unsettledSays(kind, n))),
    ]) sentence(s);
  });

  it('the local model\'s second opinion is one plain sentence: the percentage it said, and nothing else of its reply (P4 part 5)', () => {
    expect(opinionSays(0.6)).toBe('The local model said about 60%.');
    expect([opinionSays(0.05), opinionSays(0.95), opinionSays(0.624), opinionSays(0.625), opinionSays(0.5)]).toEqual([
      'The local model said about 5%.', 'The local model said about 95%.', 'The local model said about 62%.', 'The local model said about 63%.', 'The local model said about 50%.',
    ]);
    // No word for the chance, no reason, no model's name, no decimal: a percentage inside one fixed sentence.
    for (let p = 0.05; p <= 0.951; p += 0.01) {
      const says = opinionSays(p);
      sentence(says);
      expect(says, says).toMatch(/^The local model said about \d{1,2}%\.$/);
    }
    expect([PANEL.noOpinion, PANEL.opinionOff, PANEL.noLocalModel]).toEqual([
      'The local model has no estimate for this forecast.', 'The local model doesn’t estimate this number.', 'No local model is set on this Mac.',
    ]);
    for (const s of [PANEL.noOpinion, PANEL.opinionOff, PANEL.noLocalModel]) sentence(s);
  });

  it('Accuracy compares the local model with the other two answers to the same questions, a sentence each', () => {
    expect([opinionVersusSays('forecast', 45, 'closer'), opinionVersusSays('forecast', 45, 'further'), opinionVersusSays('forecast', 45, 'same')]).toEqual([
      'Over 45 questions, the local model was closer than the forecast.',
      'Over 45 questions, the forecast was closer than the local model.',
      'Over 45 questions, the local model and the forecast did about as well.',
    ]);
    expect([opinionVersusSays('usual', 33, 'closer'), opinionVersusSays('usual', 33, 'further'), opinionVersusSays('usual', 33, 'same'), opinionVersusSays('usual', 1, 'closer')]).toEqual([
      'Over 33 questions, the local model was closer than the usual rate.',
      'Over 33 questions, the usual rate was closer than the local model.',
      'Over 33 questions, the local model and the usual rate did about as well.',
      'Over 1 question, the local model was closer than the usual rate.',
    ]);
    expect(opinionTooFewSays(12, 30)).toBe('The local model has 12 of the 30 results it needs to be compared.');
    for (const other of ['forecast', 'usual'] as const) for (const verdict of ['closer', 'further', 'same'] as const) for (const n of [1, 30, 4000]) {
      const says = opinionVersusSays(other, n, verdict);
      sentence(says);
      // Counts and fixed words: never a method's name, a score or a model's.
      expect(says, says).not.toMatch(/statistical|base.rate|model_reasoning|brier|0\.\d|ollama/i);
    }
    sentence(opinionTooFewSays(1, 30));
  });
});
