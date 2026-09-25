/**
 * The "Flint tasks" suite: how Flint compares with the frontier models on Will's
 * real work (his email, calendar, Drive, market and security systems, Nexus, the
 * web), not on whatever happened to be in the training corpus.
 *
 * The committed file (apps/parity/tasks/flint-tasks.json) holds generic
 * TEMPLATES and nothing personal: "What's Vantage's read on {ticker}?". The
 * builder (`build-tasks`) fills the slots when Will runs it, from fixed public
 * lists or from read-only discovery calls on his own systems (so a ticker is one
 * Meridian actually tracks today), and freezes the result to
 * ~/.flint/eval/flint_tasks.jsonl. Answers are always judged against what the
 * tools returned in the same run, never a frozen expected answer: the data moves.
 *
 * This module is pure (no network, no files): validation, alias expansion,
 * value extraction from discovery results, seeded instantiation.
 */
import { seededRng, seedFrom, sha, shuffle } from './util.js';

export const TASK_PRIVACY = ['public', 'systems', 'personal-finance', 'personal-comms'] as const;
/**
 * Who may see a prompt's material (competitor context, judge input):
 * - public: web and general knowledge.
 * - systems: Will's own tools' data (scores, signals, rule libraries, Nexus).
 * - personal-finance / personal-comms: his money, his email / calendar / Drive /
 *   long-term memory. Only vendors on the allowlist (task-privacy.ts).
 */
export type TaskPrivacy = (typeof TASK_PRIVACY)[number];

/** One slot value: text for `{slot}`, fields for `{slot.field}`, and an optional verified reference answer. */
export interface SlotValue {
  value?: string;
  fields?: Record<string, string>;
  reference?: string;
}

export interface DiscoverSpec {
  /** A tool in the server's discovery allowlist (apps/server/src/eval-tools.ts). */
  tool: string;
  args?: Record<string, unknown>;
  /** Descend to the first property with this name (e.g. `rules`, `by_tactic`) before extracting. */
  at?: string;
  /** Fields to read from each object, first present wins (e.g. `["ticker", "symbol"]`). */
  fields?: string[];
}

export type SourceSpec =
  | { values: Array<string | SlotValue>; note?: string }
  | { int: [number, number]; note?: string }
  | { discover: DiscoverSpec; note?: string }
  | { intersect: [string, string]; note?: string };

export interface TaskTemplate {
  /** `<system>-<kind>-<nn>`, stable: it keys the prompt ids and the report. */
  id: string;
  /** The row this prompt reports under: category `task:<system>`. */
  system: string;
  template: string;
  /** Placeholder → source name. `{a}` uses a source's `value`, `{a.f}` its `fields.f`. */
  slots?: Record<string, string>;
  /**
   * Tool selection: `need` is a list of groups, each met by calling ANY tool that
   * matches one of its patterns (exact name, `server.*`, or an `@alias`); `ok`
   * lists tools that are fine to call but not required. `calculate` is never
   * required: doing the arithmetic right is judged, not how.
   */
  tools: { need: string[][]; ok?: string[] };
  /** What a great answer does: shown to the judges as the task's rubric, never to a contestant. */
  great: string;
  privacy: TaskPrivacy;
  /**
   * `task`: the answer needs long-term memory (a favourite team), so recalled
   * memory is part of the context competitors get. `incidental` (default):
   * memory isn't the point, so whatever recall surfaced is withheld from
   * competitors and judges (it is personal, and nobody needs it).
   */
  memory?: 'task' | 'incidental';
  /** `local`: the prompt asks to stay on-device; the report checks the local brain answered. */
  route?: 'local';
  /** A reference the judge gets computed at answer time: `weekday-offset` uses slot `day_offset`. */
  computed?: 'weekday-offset';
}

export interface TaskFile {
  version: 1;
  description?: string;
  aliases: Record<string, string[]>;
  sources: Record<string, SourceSpec>;
  templates: TaskTemplate[];
}

/** One frozen task prompt (a row of flint_tasks.jsonl). */
export interface TaskPrompt {
  /** `<templateId>~<sha8 of the text>`: readable in reports, stable across rebuilds of the same text. */
  id: string;
  prompt: string;
  /** `task:<system>`. */
  category: string;
  templateId: string;
  system: string;
  privacy: TaskPrivacy;
  /** Placeholder → the text it was filled with. */
  slots: Record<string, string>;
  great: string;
  reference?: string;
  /** Aliases expanded. */
  tools: { need: string[][]; ok: string[] };
  memory: 'task' | 'incidental';
  route?: 'local';
  computed?: 'weekday-offset';
}

const ID_RE = /^[a-z]+(?:-[a-z]+)*-\d{2}$/;
const SYSTEM_RE = /^[a-z][a-z-]*$/;
const PLACEHOLDER_RE = /\{([a-z_]+)(?:\.([a-z_]+))?\}/g;
const PATTERN_RE = /^(@[a-z_-]+|[a-z_][a-z0-9_]*(?:\.(?:\*|[a-z0-9_]+))?)$/i;

/** The placeholders a template uses: `{slot}` and `{slot.field}`. */
export function placeholders(template: string): Array<{ slot: string; field?: string }> {
  const out: Array<{ slot: string; field?: string }> = [];
  for (const m of template.matchAll(PLACEHOLDER_RE)) out.push(m[2] ? { slot: m[1]!, field: m[2] } : { slot: m[1]! });
  return out;
}

const asValue = (v: string | SlotValue): SlotValue => (typeof v === 'string' ? { value: v } : v);

/**
 * Check a task file and return it typed. Every problem is listed at once, so a
 * bad edit to the JSON fails with all of its mistakes, not the first.
 */
export function validateTaskFile(raw: unknown): TaskFile {
  const problems: string[] = [];
  const f = raw as Partial<TaskFile>;
  if (!f || typeof f !== 'object') throw new Error('task file: not an object');
  if (f.version !== 1) problems.push('version must be 1');
  const aliases = f.aliases ?? {};
  const sources = f.sources ?? {};
  const templates = Array.isArray(f.templates) ? f.templates : [];
  if (templates.length === 0) problems.push('no templates');
  for (const [name, list] of Object.entries(aliases)) {
    if (!name.startsWith('@')) problems.push(`alias ${name}: must start with @`);
    if (!Array.isArray(list) || list.length === 0) problems.push(`alias ${name}: empty`);
    else for (const p of list) if (!PATTERN_RE.test(p) || p.startsWith('@')) problems.push(`alias ${name}: bad tool pattern "${p}"`);
  }
  for (const [name, s] of Object.entries(sources)) {
    const spec = s as Partial<Record<'values' | 'int' | 'discover' | 'intersect', unknown>>;
    const kinds = (['values', 'int', 'discover', 'intersect'] as const).filter((k) => spec[k] !== undefined);
    if (kinds.length !== 1) {
      problems.push(`source ${name}: needs exactly one of values, int, discover, intersect`);
      continue;
    }
    if (spec.values !== undefined) {
      const vals = spec.values as Array<string | SlotValue>;
      if (!Array.isArray(vals) || vals.length === 0) problems.push(`source ${name}: empty values`);
      else for (const v of vals.map(asValue)) if (!v.value && !v.fields) problems.push(`source ${name}: a value has neither value nor fields`);
    }
    if (spec.int !== undefined) {
      const r = spec.int as number[];
      if (!Array.isArray(r) || r.length !== 2 || !r.every(Number.isInteger) || r[0]! > r[1]!) problems.push(`source ${name}: int must be [lo, hi]`);
    }
    if (spec.discover !== undefined) {
      const d = spec.discover as Partial<DiscoverSpec>;
      if (typeof d.tool !== 'string' || !/^[a-z]+\.[a-z_]+$/.test(d.tool)) problems.push(`source ${name}: discover.tool must be server.tool`);
    }
    if (spec.intersect !== undefined) {
      const pair = spec.intersect as string[];
      if (!Array.isArray(pair) || pair.length !== 2 || !pair.every((p) => p in sources)) problems.push(`source ${name}: intersect needs two known sources`);
    }
  }
  const ids = new Set<string>();
  for (const t of templates) {
    const where = `template ${t.id ?? '?'}`;
    if (!ID_RE.test(t.id ?? '')) problems.push(`${where}: id must look like system-kind-01`);
    if (ids.has(t.id)) problems.push(`${where}: duplicate id`);
    ids.add(t.id);
    if (!SYSTEM_RE.test(t.system ?? '')) problems.push(`${where}: system must be lowercase`);
    if (typeof t.template !== 'string' || !t.template.trim()) problems.push(`${where}: empty template`);
    if (typeof t.great !== 'string' || !t.great.trim()) problems.push(`${where}: empty great`);
    if (!(TASK_PRIVACY as readonly string[]).includes(t.privacy)) problems.push(`${where}: privacy must be one of ${TASK_PRIVACY.join(', ')}`);
    if (t.memory !== undefined && t.memory !== 'task' && t.memory !== 'incidental') problems.push(`${where}: memory must be task or incidental`);
    if (t.route !== undefined && t.route !== 'local') problems.push(`${where}: route must be local`);
    if (t.computed !== undefined && t.computed !== 'weekday-offset') problems.push(`${where}: unknown computed`);
    if (t.computed === 'weekday-offset' && !t.slots?.day_offset) problems.push(`${where}: weekday-offset needs a day_offset slot`);
    const slots = t.slots ?? {};
    const used = new Set<string>();
    for (const ph of placeholders(t.template ?? '')) {
      used.add(ph.slot);
      const src = slots[ph.slot];
      if (!src) {
        problems.push(`${where}: {${ph.slot}} has no slot`);
        continue;
      }
      if (!(src in sources)) {
        problems.push(`${where}: slot ${ph.slot} uses unknown source ${src}`);
        continue;
      }
      const spec = sources[src] as { values?: Array<string | SlotValue> };
      if (ph.field) {
        if (!spec.values || spec.values.map(asValue).some((v) => v.fields?.[ph.field!] === undefined)) {
          problems.push(`${where}: {${ph.slot}.${ph.field}} but source ${src} doesn't give every value that field`);
        }
      } else if (spec.values && spec.values.map(asValue).some((v) => v.value === undefined)) {
        problems.push(`${where}: {${ph.slot}} but source ${src} has values without a value`);
      }
    }
    for (const s of Object.keys(slots)) if (!used.has(s)) problems.push(`${where}: slot ${s} is never used in the template`);
    const need = t.tools?.need;
    if (!Array.isArray(need)) problems.push(`${where}: tools.need must be a list of groups`);
    else {
      for (const g of need) {
        if (!Array.isArray(g) || g.length === 0) problems.push(`${where}: an empty tools.need group`);
        else for (const p of g) checkPattern(p, aliases, where, problems);
      }
    }
    for (const p of t.tools?.ok ?? []) checkPattern(p, aliases, where, problems);
  }
  if (problems.length) throw new Error(`task file has ${problems.length} problem(s):\n- ${problems.join('\n- ')}`);
  return f as TaskFile;
}

function checkPattern(p: string, aliases: Record<string, string[]>, where: string, problems: string[]): void {
  if (!PATTERN_RE.test(p)) problems.push(`${where}: bad tool pattern "${p}"`);
  else if (p.startsWith('@') && !(p in aliases)) problems.push(`${where}: unknown alias ${p}`);
}

/** A pattern list with `@aliases` expanded, deduped, order kept. */
export function expandPatterns(patterns: readonly string[], aliases: Record<string, string[]>): string[] {
  const out: string[] = [];
  for (const p of patterns) for (const q of p.startsWith('@') ? (aliases[p] ?? []) : [p]) if (!out.includes(q)) out.push(q);
  return out;
}

export function expandTools(t: TaskTemplate, aliases: Record<string, string[]>): TaskPrompt['tools'] {
  return { need: t.tools.need.map((g) => expandPatterns(g, aliases)), ok: expandPatterns(t.tools.ok ?? [], aliases) };
}

// --------------------------------------------------------------------------
// discovery values

/** The first property named `key` anywhere in `json` (breadth first). */
function findKey(json: unknown, key: string): unknown {
  const queue: unknown[] = [json];
  while (queue.length) {
    const node = queue.shift();
    if (!node || typeof node !== 'object') continue;
    if (!Array.isArray(node) && key in (node as Record<string, unknown>)) return (node as Record<string, unknown>)[key];
    queue.push(...(Array.isArray(node) ? node : Object.values(node as Record<string, unknown>)));
  }
  return undefined;
}

const cleanValue = (v: unknown): string | undefined => {
  if (typeof v !== 'string' && typeof v !== 'number') return undefined;
  const s = String(v).trim();
  // A slot value goes into a prompt: one short line, never a blob.
  return s && s.length <= 80 && !/[\n\r{}<>]/.test(s) ? s : undefined;
};

/**
 * The slot values in a discovery tool's text result. JSON only: an array of
 * strings, an array of objects (the first of `fields` each has), or an object
 * whose KEYS are the values (a `by_tactic` map). `at` descends first; if it
 * isn't there, the whole result is used. Deduped, order kept.
 */
export function extractValues(text: string, spec: DiscoverSpec): string[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${spec.tool} didn't return JSON: ${text.slice(0, 80)}`);
  }
  let node: unknown = spec.at ? (findKey(json, spec.at) ?? json) : json;
  const fields = spec.fields ?? [];
  const out: string[] = [];
  const push = (v: unknown): void => {
    const s = cleanValue(v);
    if (s && !out.includes(s)) out.push(s);
  };
  const fromObject = (o: Record<string, unknown>): unknown => fields.map((f) => o[f]).find((v) => cleanValue(v) !== undefined);
  if (node && typeof node === 'object' && !Array.isArray(node)) {
    const o = node as Record<string, unknown>;
    const direct = fromObject(o);
    if (direct !== undefined) push(direct);
    else {
      // An object of objects/arrays is keyed by the values themselves (by_tactic).
      const nested = Object.values(o).some((v) => v && typeof v === 'object');
      if (nested) Object.keys(o).forEach(push);
      else node = Object.values(o);
    }
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      if (item && typeof item === 'object' && !Array.isArray(item)) push(fromObject(item as Record<string, unknown>));
      else push(item);
    }
  }
  return out;
}

// --------------------------------------------------------------------------
// instantiation

export interface DiscoveryOutcome {
  values?: string[];
  error?: string;
}

export interface InstantiateResult {
  prompts: TaskPrompt[];
  skipped: Array<{ templateId: string; reason: string }>;
  /** How many values each source had (after discovery, overrides and intersection). */
  sourceSizes: Record<string, number>;
}

/**
 * Fill every template. A source's values come from, in order: `overrides`
 * (--slots), `discovered` (discovery calls), its own `values`. `int` sources
 * draw a seeded integer. A template whose source has too few values (discovery
 * failed or found nothing) is skipped with the reason, never filled with a guess.
 *
 * Deterministic: each template draws from its own seeded RNG (seed + id), so
 * adding a template never changes another's prompts. Slots sharing a source get
 * distinct values. With `perTemplate` > 1 a slotted template gives up to that
 * many distinct prompts; a template without slots always gives one.
 */
export function instantiate(
  file: TaskFile,
  opts: {
    seed: number;
    perTemplate: number;
    discovered?: Record<string, DiscoveryOutcome>;
    overrides?: Record<string, Array<string | SlotValue>>;
  },
): InstantiateResult {
  const resolved = new Map<string, { values?: SlotValue[]; int?: [number, number]; error?: string }>();
  const resolve = (name: string, depth = 0): { values?: SlotValue[]; int?: [number, number]; error?: string } => {
    const cached = resolved.get(name);
    if (cached) return cached;
    const spec = file.sources[name];
    let out: { values?: SlotValue[]; int?: [number, number]; error?: string };
    const override = opts.overrides?.[name];
    if (!spec) out = { error: `unknown source ${name}` };
    else if (override) out = { values: override.map(asValue) };
    else if ('values' in spec) out = { values: spec.values.map(asValue) };
    else if ('int' in spec) out = { int: spec.int };
    else if ('discover' in spec) {
      const d = opts.discovered?.[name];
      out = d?.values ? { values: d.values.map((v) => ({ value: v })) } : { error: d?.error ?? 'not discovered (run build-tasks with discovery, or pass --slots)' };
    } else {
      if (depth > 3) out = { error: 'intersect nests too deep' };
      else {
        const [a, b] = spec.intersect.map((s) => resolve(s, depth + 1));
        if (!a?.values || !b?.values) out = { error: `intersect of ${spec.intersect.join(' and ')}: ${a?.error ?? b?.error ?? 'no values'}` };
        else {
          const inB = new Set(b.values.map((v) => v.value?.toUpperCase()));
          out = { values: a.values.filter((v) => v.value !== undefined && inB.has(v.value.toUpperCase())) };
        }
      }
    }
    resolved.set(name, out);
    return out;
  };

  const prompts: TaskPrompt[] = [];
  const skipped: InstantiateResult['skipped'] = [];
  const seen = new Set<string>();
  for (const t of file.templates) {
    const slots = Object.entries(t.slots ?? {}).sort(([a], [b]) => a.localeCompare(b));
    const rng = seededRng(seedFrom(`${opts.seed}:${t.id}`));
    // Per source: a seeded shuffle, and how many slots of this template draw from it.
    const pools = new Map<string, SlotValue[]>();
    const perSource = new Map<string, number>();
    let problem: string | undefined;
    for (const [, src] of slots) {
      perSource.set(src, (perSource.get(src) ?? 0) + 1);
      if (pools.has(src)) continue;
      const r = resolve(src);
      if (r.error) problem ??= `source ${src}: ${r.error}`;
      else if (r.values) pools.set(src, shuffle(r.values, rng));
    }
    for (const [src, k] of perSource) {
      const pool = pools.get(src);
      if (pool && pool.length < k) problem ??= `source ${src} has ${pool.length} value(s); the template needs ${k} distinct`;
    }
    if (problem) {
      skipped.push({ templateId: t.id, reason: problem });
      continue;
    }
    const instances = slots.length ? Math.max(1, opts.perTemplate) : 1;
    for (let i = 0; i < instances; i++) {
      const used = new Map<string, number>();
      const filled: Record<string, SlotValue> = {};
      for (const [slot, src] of slots) {
        const r = resolve(src);
        if (r.int) {
          const [lo, hi] = r.int;
          filled[slot] = { value: String(lo + Math.floor(rng() * (hi - lo + 1))) };
          continue;
        }
        const pool = pools.get(src)!;
        const k = perSource.get(src)!;
        const j = used.get(src) ?? 0;
        used.set(src, j + 1);
        filled[slot] = pool[(i * k + j) % pool.length]!;
      }
      const prompt = t.template.replace(PLACEHOLDER_RE, (_m, slot: string, field?: string) => {
        const v = filled[slot]!;
        return (field ? v.fields?.[field] : v.value) ?? '';
      });
      if (seen.has(prompt)) continue; // a small pool cycled round: one copy is enough
      seen.add(prompt);
      const references = Object.values(filled)
        .map((v) => v.reference)
        .filter((r): r is string => !!r);
      prompts.push({
        id: `${t.id}~${sha(prompt, 8)}`,
        prompt,
        category: `task:${t.system}`,
        templateId: t.id,
        system: t.system,
        privacy: t.privacy,
        slots: Object.fromEntries(Object.entries(filled).map(([k, v]) => [k, v.value ?? Object.values(v.fields ?? {}).join(' / ')])),
        great: t.great,
        ...(references.length ? { reference: references.join(' ') } : {}),
        tools: expandTools(t, file.aliases),
        memory: t.memory ?? 'incidental',
        ...(t.route ? { route: t.route } : {}),
        ...(t.computed ? { computed: t.computed } : {}),
      });
    }
  }
  const sourceSizes: Record<string, number> = {};
  for (const [name, r] of resolved) sourceSizes[name] = r.values?.length ?? (r.int ? r.int[1] - r.int[0] + 1 : 0);
  return { prompts, skipped, sourceSizes };
}

/** The discover sources, grouped by identical call so each tool is asked once. */
export function discoveryCalls(file: TaskFile): Array<{ tool: string; args: Record<string, unknown>; sources: Array<[string, DiscoverSpec]> }> {
  const calls = new Map<string, { tool: string; args: Record<string, unknown>; sources: Array<[string, DiscoverSpec]> }>();
  for (const [name, spec] of Object.entries(file.sources)) {
    if (!('discover' in spec)) continue;
    const args = spec.discover.args ?? {};
    const key = `${spec.discover.tool}|${JSON.stringify(args)}`;
    const c = calls.get(key) ?? { tool: spec.discover.tool, args, sources: [] };
    c.sources.push([name, spec.discover]);
    calls.set(key, c);
  }
  return [...calls.values()];
}

/**
 * Run every discovery call through `call` (the Flint server's POST /eval/tool)
 * and extract each source's values. A failed call, an error result, or a result
 * with no values is recorded as that source's error, and its templates are
 * skipped at instantiation.
 */
export async function discoverSources(
  file: TaskFile,
  call: (tool: string, args: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>,
): Promise<Record<string, DiscoveryOutcome>> {
  const out: Record<string, DiscoveryOutcome> = {};
  for (const c of discoveryCalls(file)) {
    let res: { text: string; isError: boolean } | undefined;
    let error: string | undefined;
    try {
      res = await call(c.tool, c.args);
      if (res.isError) error = `${c.tool} returned an error: ${res.text.slice(0, 160)}`;
    } catch (err) {
      error = `${c.tool}: ${err instanceof Error ? err.message : String(err)}`;
    }
    for (const [name, spec] of c.sources) {
      if (error || !res) {
        out[name] = { error: error ?? 'no result' };
        continue;
      }
      try {
        const values = extractValues(res.text, spec);
        out[name] = values.length ? { values } : { error: `${c.tool} returned no values for ${name}` };
      } catch (err) {
        out[name] = { error: err instanceof Error ? err.message : String(err) };
      }
    }
  }
  return out;
}

/** Every concrete tool name (not a glob) a template expects, for checking against the server's wired tools. */
export function expectedToolNames(file: TaskFile): string[] {
  const names = new Set<string>();
  for (const t of file.templates) {
    const tools = expandTools(t, file.aliases);
    for (const p of [...tools.need.flat(), ...tools.ok]) names.add(p);
  }
  return [...names].sort();
}

/** Patterns that match none of the server's wired tools (a renamed tool would silently score as a miss). */
export function unwiredPatterns(file: TaskFile, wired: readonly string[]): string[] {
  return expectedToolNames(file).filter((p) => !wired.some((w) => matchesToolPattern(w, p)));
}

/** `vantage.top_scores` matches `vantage.top_scores` and `vantage.*`. */
export function matchesToolPattern(name: string, pattern: string): boolean {
  if (pattern.endsWith('.*')) return name.startsWith(pattern.slice(0, -1));
  return name === pattern;
}

/** Will's time zone (the server's default FLINT_USER_TZ). */
export const USER_TZ = 'America/Chicago';

/**
 * The reference for a `computed` template, from the time Flint answered: for
 * `weekday-offset`, today's date in Will's time zone and the weekday
 * `day_offset` days later.
 */
export function computedReference(p: Pick<TaskPrompt, 'computed' | 'slots'>, answeredAt: Date): string | undefined {
  if (p.computed !== 'weekday-offset') return undefined;
  const n = Number(p.slots.day_offset);
  if (!Number.isInteger(n)) return undefined;
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: USER_TZ, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(answeredAt);
  const get = (type: string): number => Number(parts.find((x) => x.type === type)?.value);
  const today = new Date(Date.UTC(get('year'), get('month') - 1, get('day')));
  const later = new Date(today.getTime() + n * 86_400_000);
  const fmt = (d: Date): string => d.toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  return `Reference (computed when the question was answered): today is ${fmt(today)} in Will's time zone (${USER_TZ}); ${n} days from now is ${fmt(later)}.`;
}

/** The judges' rubric for a task: its "great answer", plus any reference (verified or computed). */
export function rubricFor(p: Pick<TaskPrompt, 'great' | 'reference' | 'computed' | 'slots'>, answeredAt: Date): string {
  const computed = computedReference(p, answeredAt);
  return [p.great, ...(p.reference ? [`Reference: ${p.reference}`] : []), ...(computed ? [computed] : [])].join('\n');
}
