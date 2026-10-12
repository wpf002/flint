import { describe, it, expect } from 'vitest';
import { SeriesKey } from '@flint/policy';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { DOMAINS } from '../../src/ledger/emit';
import { FORECAST_SERIES, FORECAST_SERIES_KEYS, forecastSeries, freqOf } from '../../src/predict/series';

describe('the forecast series registry', () => {
  it('is the closed list: twelve numbers, each with its step, unit, sensitivity, ledger domain and name', () => {
    expect(FORECAST_SERIES.map((s) => `${s.key} ${s.step} ${s.unit} ${s.sensitivity} ${s.domain} | ${s.name}`)).toEqual([
      'daily.spend.anthropic.usd day usd financial spend | Anthropic Spend',
      'daily.spend.openai.usd day usd financial spend | OpenAI Spend',
      'daily.spend.perplexity.usd day usd financial spend | Perplexity Spend',
      'daily.spend.tavily.usd day usd financial spend | Tavily Spend',
      'daily.deploys.count day count ops deploys | Deploys',
      'weekly.commits.flint.count week count ops repos | Flint Commits',
      'weekly.commits.nexus.count week count ops repos | Nexus Commits',
      'weekly.commits.trident.count week count ops repos | Trident Commits',
      'weekly.commits.helm.count week count ops repos | Helm Commits',
      'daily.services.incident_minutes day minutes ops services | Service Downtime',
      'daily.threads.open day count ops projects | Open Threads',
      'daily.calendar.hours day hours personal calendar | Calendar Hours',
    ]);
    expect(new Set(FORECAST_SERIES_KEYS).size).toBe(12);
    expect(new Set(FORECAST_SERIES.map((s) => s.name)).size).toBe(12);
  });

  it('every key fits the database\'s and the card\'s rule, every domain is a ledger domain, and every unit fits a prediction\'s', () => {
    for (const s of FORECAST_SERIES) {
      expect(SeriesKey.safeParse(s.key).success, s.key).toBe(true);
      expect(s.key, s.key).toMatch(/^[a-z0-9_]+(\.[a-z0-9_-]+)+$/);
      expect(DOMAINS as readonly string[], s.key).toContain(s.domain);
      expect(s.unit, s.key).toMatch(/^[a-z_]{1,20}$/);
      expect(s.key.startsWith(s.step === 'day' ? 'daily.' : 'weekly.'), s.key).toBe(true);
      expect(freqOf(s), s.key).toBe(s.step === 'day' ? 'D' : 'W');
    }
  });

  it('money is financial and the calendar is personal: neither is ever an ops series (the database refuses a dollar series that is not financial)', () => {
    for (const s of FORECAST_SERIES) {
      if (s.unit === 'usd' || s.key.includes('.spend.')) expect(s.sensitivity, s.key).toBe('financial');
      if (s.key.includes('.calendar.')) expect(s.sensitivity, s.key).toBe('personal');
    }
    expect(FORECAST_SERIES.filter((s) => s.sensitivity !== 'ops').map((s) => s.key).sort()).toEqual([
      'daily.calendar.hours', 'daily.spend.anthropic.usd', 'daily.spend.openai.usd', 'daily.spend.perplexity.usd', 'daily.spend.tavily.usd',
    ]);
  });

  it('each number\'s domain is one the database accepts for it: spend exactly for the financial ones, calendar exactly for the calendar one', () => {
    // prediction_forecast_check holds a forecast's prediction to this (and to the series' unit), so the registry must agree.
    for (const s of FORECAST_SERIES) {
      expect(s.domain === 'spend', s.key).toBe(s.sensitivity === 'financial');
      expect(s.domain === 'calendar', s.key).toBe(/(^|\.)calendar(\.|$)/.test(s.key));
    }
  });

  it('names are Title Case and descriptions are fixed sentences with no number in them', () => {
    for (const s of FORECAST_SERIES) {
      for (const word of s.name.split(' ')) expect(word[0], s.name).toBe(word[0]!.toUpperCase());
      expect(s.description, s.key).toMatch(/^[A-Z].*\.$/);
      expect(s.description, s.key).not.toMatch(/\d/);
      expect(s.description.length, s.key).toBeLessThanOrEqual(120);
    }
  });

  it('the console names the same numbers: its table is the registry, in order, with spending and the calendar marked', () => {
    // The Turn On Predictions card says which numbers it turns on, by these names (apps/console/index.html, APPR_SERIES).
    const html = readFileSync(join(__dirname, '..', '..', '..', 'console', 'index.html'), 'utf8');
    const table = /\nvar APPR_SERIES=(\[\[[^;]*\]\]);/.exec(html)?.[1];
    expect(table, 'APPR_SERIES in the console').toBeTruthy();
    const rows = runInNewContext(`(${table})`) as Array<[string, string, string]>;
    const kind = (s: (typeof FORECAST_SERIES)[number]) => (s.sensitivity === 'financial' ? 'money' : /(^|\.)calendar(\.|$)/.test(s.key) ? 'calendar' : '');
    expect(rows.map((r) => [...r])).toEqual(FORECAST_SERIES.map((s) => [s.key, s.name, kind(s)]));
    // Every sensitive number has a kind the card can say: a new one that is neither spending nor the calendar needs its own words there.
    for (const s of FORECAST_SERIES) expect(kind(s) !== '', s.key).toBe(s.sensitivity !== 'ops');
  });

  it('a key outside the list is not a series; lookups do not reach object internals', () => {
    expect(forecastSeries('daily.deploys.count')?.name).toBe('Deploys');
    for (const k of ['daily.spend.acme.usd', 'spend.anthropic.day.usd', '', 'constructor', '__proto__', 'toString']) expect(forecastSeries(k), k).toBeUndefined();
  });

});
