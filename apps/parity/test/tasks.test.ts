import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PERSONAL, effectivePrivacy } from '../src/task-privacy.js';
import {
  computedReference,
  discoverSources,
  discoveryCalls,
  expandTools,
  extractValues,
  instantiate,
  rubricFor,
  unwiredPatterns,
  validateTaskFile,
  type TaskFile,
} from '../src/tasks.js';
import { TEMPLATES_PATH } from '../src/tasks-cli.js';

const FILE = validateTaskFile(JSON.parse(readFileSync(TEMPLATES_PATH, 'utf8')));

/** Discovery results as the connectors return them (apps/mcp connectors: JSON text). */
const DISCOVERED = {
  meridian_ticker: { values: ['NVDA', 'AAPL', 'MSFT', 'TSLA'] },
  vantage_ticker: { values: ['NVDA', 'AMD', 'AAPL'] },
  bellwether_industry: { values: ['Semiconductors', 'Energy'] },
  prophet_model: { values: ['daily_equities'] },
  tdl_tactic: { values: ['initial-access', 'execution'] },
  tdl_rule_id: { values: ['TDL-0001', 'TDL-0002'] },
  nexus_thread: { values: ['Release planning'] },
  nexus_canon_key: { values: ['deploy-policy'] },
};

describe('the committed task templates', () => {
  it('validate, and cover the inventory', () => {
    expect(FILE.templates).toHaveLength(97);
    const systems = new Set(FILE.templates.map((t) => t.system));
    for (const s of ['web', 'knowledge', 'coding', 'security', 'gmail', 'calendar', 'drive', 'vantage', 'bellwether', 'meridian', 'prophet', 'tdl', 'nexus', 'self', 'memory', 'cross', 'safety', 'local-route', 'persona']) {
      expect(systems.has(s), s).toBe(true);
    }
  });

  it('hold no personal data: no emails, phone numbers, home city or names from memory', () => {
    const text = readFileSync(TEMPLATES_PATH, 'utf8');
    expect(text).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
    expect(text).not.toMatch(/\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/);
    expect(text).not.toMatch(/Dallas|Texas|Foti/i);
  });

  it('never class a template below the data its needed tools return', () => {
    for (const t of FILE.templates) {
      const concrete = expandTools(t, FILE.aliases).need.flat().filter((p) => !p.endsWith('.*'));
      const eff = effectivePrivacy(t.privacy, concrete).privacy;
      // The two personal classes gate the same vendors; below personal, the class must match exactly.
      if (PERSONAL.has(eff)) expect(PERSONAL.has(t.privacy), t.id).toBe(true);
      else expect(eff, t.id).toBe(t.privacy);
    }
  });

  it('keep memory for personal templates only (recall surfaces more than the fact the task needs)', () => {
    for (const t of FILE.templates.filter((x) => x.memory === 'task')) expect(t.privacy, t.id).toBe('personal-comms');
  });

  it('ask the local brain only through the prompt text the server routes on', () => {
    for (const t of FILE.templates.filter((x) => x.route === 'local')) expect(t.template).toMatch(/^(Stay local|Keep this private):/);
  });
});

describe('instantiate', () => {
  it('fills fixed-list templates and skips discovery ones, with the reason, when nothing was discovered', () => {
    const r = instantiate(FILE, { seed: 1, perTemplate: 1 });
    const skipped = new Map(r.skipped.map((s) => [s.templateId, s.reason]));
    expect(skipped.get('vantage-lookup-42')).toMatch(/vantage_ticker: not discovered/);
    expect(skipped.get('cross-compare-82')).toMatch(/intersect/);
    expect(r.prompts.find((p) => p.templateId === 'gmail-triage-24')).toMatchObject({
      prompt: 'Any important emails today?',
      category: 'task:gmail',
      privacy: 'personal-comms',
      tools: { need: [['trident.gmail_search']], ok: [] },
      memory: 'incidental',
    });
    for (const p of r.prompts) {
      expect(p.id).toMatch(new RegExp(`^${p.templateId}~[0-9a-f]{8}$`));
      expect(p.prompt).not.toMatch(/\{[a-z_.]+\}/);
    }
  });

  it('is deterministic for a seed, and a template draws from its own RNG', () => {
    const a = instantiate(FILE, { seed: 7, perTemplate: 1, discovered: DISCOVERED });
    const b = instantiate(FILE, { seed: 7, perTemplate: 1, discovered: DISCOVERED });
    expect(a.prompts).toEqual(b.prompts);
    // Dropping a template doesn't move another's slot choice.
    const fewer = instantiate({ ...FILE, templates: FILE.templates.filter((t) => t.id !== 'web-summarize-03') }, { seed: 7, perTemplate: 1, discovered: DISCOVERED });
    const pick = (r: typeof a) => r.prompts.find((p) => p.templateId === 'web-compare-05')!.prompt;
    expect(pick(fewer)).toBe(pick(a));
  });

  it('fills discovery slots, keeps slots sharing a source distinct, and intersects sources', () => {
    const r = instantiate(FILE, { seed: 1, perTemplate: 1, discovered: DISCOVERED });
    const cmp = r.prompts.find((p) => p.templateId === 'meridian-compare-58')!;
    expect(cmp.slots.a).not.toBe(cmp.slots.b);
    const both = r.prompts.find((p) => p.templateId === 'cross-compare-82')!;
    expect(['NVDA', 'AAPL']).toContain(both.slots.ticker);
    expect(r.sourceSizes.shared_ticker).toBe(2);
    expect(r.skipped).toEqual([]);
  });

  it('skips a template whose intersection is empty rather than guessing', () => {
    const r = instantiate(FILE, { seed: 1, perTemplate: 1, discovered: { ...DISCOVERED, vantage_ticker: { values: ['XOM'] } } });
    expect(r.skipped.find((s) => s.templateId === 'cross-compare-82')?.reason).toMatch(/0 value/);
  });

  it('fills {slot.field} from tuple values and carries references to the judge rubric', () => {
    const r = instantiate(FILE, { seed: 1, perTemplate: 1 });
    const code = r.prompts.find((p) => p.templateId === 'coding-write-22')!;
    expect(code.prompt).toMatch(/^Write a (Python|TypeScript|Go|Rust) function that .+, with tests\.$/);
    expect(code.reference).toMatch(/^Hidden tests:/);
    const wp = r.prompts.find((p) => p.templateId === 'knowledge-reason-18')!;
    expect(wp.reference).toBeTruthy();
    expect(rubricFor(wp, new Date())).toContain(`Reference: ${wp.reference}`);
  });

  it('draws int slots in range, and --per-template gives distinct prompts only for slotted templates', () => {
    const r = instantiate(FILE, { seed: 3, perTemplate: 3, discovered: DISCOVERED });
    const dates = r.prompts.filter((p) => p.templateId === 'knowledge-date-95');
    for (const d of dates) expect(Number(d.slots.day_offset)).toBeGreaterThanOrEqual(3);
    for (const d of dates) expect(Number(d.slots.day_offset)).toBeLessThanOrEqual(400);
    expect(r.prompts.filter((p) => p.templateId === 'web-compare-05')).toHaveLength(3);
    expect(new Set(r.prompts.filter((p) => p.templateId === 'web-compare-05').map((p) => p.prompt)).size).toBe(3);
    expect(r.prompts.filter((p) => p.templateId === 'gmail-triage-24')).toHaveLength(1);
    // A one-value pool can't give three distinct prompts: one copy, not three.
    expect(r.prompts.filter((p) => p.templateId === 'prophet-lookup-62')).toHaveLength(1);
  });

  it('lets --slots override a source', () => {
    const r = instantiate(FILE, { seed: 1, perTemplate: 1, discovered: DISCOVERED, overrides: { company_name: ['Berkshire Hathaway'] } });
    expect(r.prompts.find((p) => p.templateId === 'vantage-lookup-48')!.prompt).toBe('Look up Berkshire Hathaway in Vantage: ticker, sector, and current score.');
  });
});

describe('validateTaskFile', () => {
  const base = (): TaskFile => ({
    version: 1,
    aliases: { '@web': ['web.web_search'] },
    sources: { x: { values: ['a', 'b'] }, t: { values: [{ fields: { lang: 'Go' } }] } },
    templates: [{ id: 'web-lookup-01', system: 'web', template: 'Q {x}', slots: { x: 'x' }, tools: { need: [['@web']] }, great: 'g', privacy: 'public' }],
  });

  it('accepts a good file', () => {
    expect(() => validateTaskFile(base())).not.toThrow();
  });

  it('lists every problem at once', () => {
    const f = base();
    f.templates.push(
      { id: 'web-lookup-01', system: 'Web', template: 'Q {y} {t.missing}', slots: { t: 't', z: 'x' }, tools: { need: [['@nope'], []] }, great: '', privacy: 'secret' as never },
    );
    const msg = (() => {
      try {
        validateTaskFile(f);
        return '';
      } catch (e) {
        return (e as Error).message;
      }
    })();
    for (const bit of ['duplicate id', 'system must be lowercase', '{y} has no slot', "{t.missing} but source t doesn't give every value that field", 'slot z is never used', 'unknown alias @nope', 'an empty tools.need group', 'empty great', 'privacy must be one of']) {
      expect(msg).toContain(bit);
    }
  });
});

describe('discovery values', () => {
  it('reads an array of strings (meridian.list_tickers)', () => {
    expect(extractValues('["NVDA","AAPL","NVDA"]', { tool: 'meridian.list_tickers' })).toEqual(['NVDA', 'AAPL']);
  });

  it('reads the first present field of each object (vantage.top_scores, bellwether.list_industries)', () => {
    const rows = JSON.stringify([{ ticker: 'NVDA', score: 81 }, { symbol: 'AMD' }, { score: 3 }]);
    expect(extractValues(rows, { tool: 'vantage.top_scores', fields: ['ticker', 'symbol'] })).toEqual(['NVDA', 'AMD']);
    expect(extractValues(JSON.stringify([{ id: 7, label: 'Energy' }]), { tool: 'bellwether.list_industries', fields: ['label', 'id'] })).toEqual(['Energy']);
  });

  it('descends to `at` first, and takes the keys of a map (tdl.coverage by_tactic)', () => {
    const rec = JSON.stringify({ total_rules: 1500, rules: [{ rule_id: 'TDL-9', severity: 'high' }] });
    expect(extractValues(rec, { tool: 'tdl.recommendations', at: 'rules', fields: ['rule_id', 'id'] })).toEqual(['TDL-9']);
    const cov = JSON.stringify({ summary: {}, by_tactic: { 'initial-access': { pct: 40 }, execution: { pct: 70 } } });
    expect(extractValues(cov, { tool: 'tdl.coverage', at: 'by_tactic', fields: ['tactic'] })).toEqual(['initial-access', 'execution']);
    // `at` missing: the whole result.
    expect(extractValues('[{"title":"T1"}]', { tool: 'nexus.thread_list', at: 'threads', fields: ['title'] })).toEqual(['T1']);
  });

  it('refuses non-JSON and drops values that are not one short line', () => {
    expect(() => extractValues('No coverage report found.', { tool: 'tdl.coverage' })).toThrow(/didn't return JSON/);
    expect(extractValues(JSON.stringify(['ok', 'x'.repeat(200), 'two\nlines', '{inject}']), { tool: 'meridian.list_tickers' })).toEqual(['ok']);
  });

  it('calls each (tool, args) once, and records errors per source', async () => {
    const calls: string[] = [];
    const out = await discoverSources(FILE, async (tool) => {
      calls.push(tool);
      if (tool === 'nexus.thread_list') throw new Error('HTTP 404: nexus.thread_list is not wired');
      if (tool === 'nexus.read_canon') return { text: 'unauthorized', isError: true };
      if (tool === 'meridian.list_tickers') return { text: '["NVDA"]', isError: false };
      return { text: '[]', isError: false };
    });
    expect(calls.length).toBe(discoveryCalls(FILE).length);
    expect(new Set(calls).size).toBe(calls.length);
    expect(out.meridian_ticker).toEqual({ values: ['NVDA'] });
    expect(out.nexus_thread?.error).toMatch(/not wired/);
    expect(out.nexus_canon_key?.error).toMatch(/returned an error/);
    expect(out.vantage_ticker?.error).toMatch(/no values/);
  });

  it('flags expected tools the server does not wire', () => {
    const wired = ['web.web_search', 'trident.gmail_search', 'vantage.top_scores', 'vantage.get_score'];
    const missing = unwiredPatterns(FILE, wired);
    expect(missing).toContain('trident.gcal_upcoming');
    expect(missing).not.toContain('vantage.*');
    expect(missing).not.toContain('trident.gmail_search');
  });
});

describe('computed references', () => {
  it("uses the day Flint answered, in Will's time zone", () => {
    const p = { computed: 'weekday-offset' as const, slots: { day_offset: '3' } };
    expect(computedReference(p, new Date('2026-09-25T15:00:00Z'))).toContain('today is Friday, September 25, 2026');
    expect(computedReference(p, new Date('2026-09-25T15:00:00Z'))).toContain('3 days from now is Monday, September 28, 2026');
    // 03:00 UTC on the 26th is still the evening of the 25th in Chicago.
    expect(computedReference(p, new Date('2026-09-26T03:00:00Z'))).toContain('today is Friday, September 25, 2026');
    expect(computedReference({ slots: {} }, new Date())).toBeUndefined();
  });
});
