/**
 * Is each competitor (and judge) the vendor's current top model?
 *
 * The Flint-tasks suite is only as good a yardstick as the models it compares
 * against: "Flint vs frontier" means each vendor's best model today, not a model
 * that was the best when the defaults were written, and not the model Flint's own
 * frontier tier runs on. So before anything is bought, every competitor and judge
 * model is checked against the vendor's own model list (a free call):
 *
 * - `current`: on the list, and nothing newer in its family is.
 * - `newer-available`: the list has a newer version of the same model
 *   (gpt-5 → gpt-5.2, gemini-2.5-pro → gemini-3-pro-preview, claude-fable-5-1 → claude-fable-5-2).
 * - `not-listed`: the vendor doesn't list the id at all.
 * - `unverified`: there is no list to check (Bedrock's names don't version within a
 *   family, Nova Premier then Nova 2 Pro, so a newer one can't be detected there).
 * - `alias`: a versionless alias the vendor keeps current (Perplexity's `sonar-pro`).
 *
 * A built-in default is used only when it is `current` (or an `alias`): otherwise
 * the run refuses and says which flag to pass. A model Will names himself is used
 * as given, with any newer one noted in the report.
 */
import Anthropic from '@anthropic-ai/sdk';
import { googleEndpoint, VENDOR_KEY_ENV } from './compat.js';

export type CurrencyVendor = 'anthropic' | 'openai' | 'google' | 'amazon' | 'perplexity';
/** Where a model id came from: a flag, a PARITY_*_MODEL env var, a resumed run's run.json, or the built-in default. */
export type ModelSource = 'flag' | 'env' | 'run' | 'default';
export type CurrencyStatus = 'current' | 'newer-available' | 'not-listed' | 'unverified' | 'alias';

export interface ModelCheck {
  /** Who uses the model: a contestant name (`openai`, `claude`, `claude-base`, ...) or `judge:<vendor>`. */
  role: string;
  vendor: CurrencyVendor;
  model: string;
  source: ModelSource;
  status: CurrencyStatus;
  /** Newer versions of the same model on the vendor's list, newest first. */
  newer: string[];
  /** Why it couldn't be checked (`unverified`). */
  why?: string;
  /** The day the check ran (YYYY-MM-DD, UTC). */
  checkedOn: string;
}

export type Listing = { ids: string[] } | { error: string };

/** An id as vendors list it: lower case, no `models/` prefix, no Bedrock cross-region prefix. */
export function normalizeModelId(id: string): string {
  return id
    .trim()
    .toLowerCase()
    .replace(/^models\//, '')
    .replace(/^(us|eu|apac|us-gov|global)\.(?=[a-z]+\.)/, '');
}

export interface ModelIdParts {
  /** `gpt`, `gemini`, `claude-fable`, `o`. */
  family: string;
  /** `[5, 1]` for gpt-5.1 and claude-fable-5-1, `[2, 5]` for gemini-2.5-pro. */
  version: number[];
  /** What kind of model within the family: `''`, `mini`, `pro`, `codex`. Dates, `preview` and `latest` are not part of it. */
  variant: string;
}

const QUALIFIER = /^(preview|exp|experimental|latest|\d+|v\d+(:\d+)?)$/;

/**
 * Split a model id into family, version and variant, or undefined when it has no
 * version (a versionless alias like `sonar-pro`, which can't be "older").
 */
export function parseModelId(id: string): ModelIdParts | undefined {
  const tokens = normalizeModelId(id).split('-').filter(Boolean);
  const family: string[] = [];
  const version: number[] = [];
  const rest: string[] = [];
  let i = 0;
  // Family: the leading alphabetic tokens. `o3` is family `o`, version 3.
  for (; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (/^[a-z][a-z.]*$/.test(t)) {
      family.push(t);
      continue;
    }
    const glued = /^([a-z]+)(\d.*)$/.exec(t);
    if (glued && family.length === 0) {
      family.push(glued[1]!);
      tokens[i] = glued[2]!;
    }
    break;
  }
  // Version: the numeric tokens right after the family (`5.1`, or `5` `1`), each part short (a date isn't a version).
  for (; i < tokens.length; i++) {
    const t = tokens[i]!;
    const m = /^(\d{1,3}(?:\.\d{1,3})*)([a-z]*)$/.exec(t);
    if (!m) break;
    version.push(...m[1]!.split('.').map(Number));
    if (m[2]) {
      rest.push(m[2]);
      i++;
      break;
    }
  }
  for (; i < tokens.length; i++) if (!QUALIFIER.test(tokens[i]!)) rest.push(tokens[i]!);
  if (family.length === 0 || version.length === 0) return undefined;
  return { family: family.join('-'), version, variant: rest.join('-') };
}

function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** The ids on `ids` that are a newer version of `model` (same family and variant), newest first. */
export function newerInFamily(model: string, ids: readonly string[]): string[] {
  const m = parseModelId(model);
  if (!m) return [];
  const found = new Map<string, number[]>();
  for (const id of ids) {
    const p = parseModelId(id);
    if (!p || p.family !== m.family || p.variant !== m.variant) continue;
    if (compareVersions(p.version, m.version) > 0) found.set(normalizeModelId(id), p.version);
  }
  return [...found.entries()].sort(([, a], [, b]) => compareVersions(b, a)).map(([id]) => id);
}

/** One model against its vendor's list. `listing` undefined: the vendor has no list. */
export function assessModel(opts: {
  role: string;
  vendor: CurrencyVendor;
  model: string;
  source: ModelSource;
  listing: Listing | undefined;
  today: Date;
}): ModelCheck {
  const base = { role: opts.role, vendor: opts.vendor, model: opts.model, source: opts.source, checkedOn: opts.today.toISOString().slice(0, 10) };
  if (opts.vendor === 'amazon') {
    return { ...base, status: 'unverified', newer: [], why: "Bedrock's model names don't version within a family (Nova Premier, then Nova 2 Pro), so a newer one can't be detected" };
  }
  if (opts.vendor === 'perplexity') return { ...base, status: 'alias', newer: [] };
  if (!opts.listing || 'error' in opts.listing) {
    return { ...base, status: 'unverified', newer: [], why: opts.listing && 'error' in opts.listing ? opts.listing.error : 'no model list' };
  }
  const ids = opts.listing.ids.map(normalizeModelId);
  const newer = newerInFamily(opts.model, ids);
  if (!ids.includes(normalizeModelId(opts.model))) return { ...base, status: 'not-listed', newer };
  return { ...base, status: newer.length ? 'newer-available' : 'current', newer };
}

/** A check that may be used: a model Will named himself, or a default that is current (or a versionless alias). */
export function usable(c: ModelCheck): boolean {
  return c.source !== 'default' || c.status === 'current' || c.status === 'alias';
}

const VENDOR_NAME: Record<CurrencyVendor, string> = { anthropic: 'Anthropic', openai: 'OpenAI', google: 'Google', amazon: 'Amazon', perplexity: 'Perplexity' };

/** The flag that picks a role's model. */
export function modelFlagFor(role: string): string {
  if (role.startsWith('judge:')) return '--judge-panel';
  return `--${role}-model`;
}

/** Why a default can't be used, and what to pass instead; undefined when it can. */
export function refusal(c: ModelCheck): string | undefined {
  if (usable(c)) return undefined;
  const vendor = VENDOR_NAME[c.vendor];
  const what =
    c.status === 'newer-available'
      ? `isn't ${vendor}'s newest: its model list has ${c.newer.slice(0, 5).join(', ')}`
      : c.status === 'not-listed'
        ? `isn't on ${vendor}'s model list${c.newer.length ? ` (which has ${c.newer.slice(0, 5).join(', ')})` : ''}`
        : `can't be verified as ${vendor}'s current top model (${c.why ?? 'no model list'})`;
  // The default panel is the competitors' models, so the competitor flag fixes the judge too.
  const competitorFlag = c.vendor === 'anthropic' ? '--claude-model' : `--${c.vendor}-model`;
  const fix = c.role.startsWith('judge:')
    ? `Pass ${competitorFlag} <id> (${vendor}'s current top model; the default judge panel uses it too), or ${modelFlagFor(c.role)}`
    : `Pass ${modelFlagFor(c.role)} <id> (${vendor}'s current top model), or leave ${c.role} out of --contestants`;
  return `${c.role}: the default ${c.model} ${what}. ${fix}.`;
}

/** One line for the report: `gpt-5.2: current on OpenAI's model list, 2026-09-25`. */
export function describeCheck(c: ModelCheck): string {
  const src = c.source === 'default' ? 'default' : c.source === 'run' ? "this run's" : `set by ${c.source}`;
  switch (c.status) {
    case 'current':
      return `verified current on ${c.checkedOn} (newest of its family on ${VENDOR_NAME[c.vendor]}'s model list; ${src})`;
    case 'newer-available':
      return `**not the newest**: ${VENDOR_NAME[c.vendor]}'s list had ${c.newer.slice(0, 5).join(', ')} on ${c.checkedOn} (${src})`;
    case 'not-listed':
      return `**not on ${VENDOR_NAME[c.vendor]}'s model list** on ${c.checkedOn} (${src})`;
    case 'alias':
      return `versionless alias ${VENDOR_NAME[c.vendor]} keeps current; no model list to check (${src})`;
    case 'unverified':
      return `**unverified** on ${c.checkedOn}: ${c.why ?? 'no model list'} (${src})`;
  }
}

/**
 * The vendor's model list (a free call), or why it couldn't be read. Amazon and
 * Perplexity have none the harness can use.
 */
export async function listVendorModels(vendor: CurrencyVendor, env: Record<string, string | undefined>, fetchFn: typeof fetch = fetch): Promise<Listing> {
  const key = env[VENDOR_KEY_ENV[vendor]]?.trim();
  if (!key) return { error: `no ${VENDOR_KEY_ENV[vendor]}` };
  try {
    switch (vendor) {
      case 'openai':
        return await openAiShapedList('https://api.openai.com/v1/models', key, fetchFn);
      case 'google':
        return await openAiShapedList(`${googleEndpoint(env).baseURL.replace(/\/$/, '')}/models`, key, fetchFn);
      case 'anthropic': {
        const client = new Anthropic({ apiKey: key, fetch: fetchFn, maxRetries: 1, timeout: 10_000 });
        const ids: string[] = [];
        for await (const m of client.models.list({ limit: 1000 })) ids.push(m.id);
        return ids.length ? { ids } : { error: 'the model list was empty' };
      }
      case 'amazon':
      case 'perplexity':
        return { error: `${VENDOR_NAME[vendor]} has no model list the harness can read` };
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

async function openAiShapedList(url: string, key: string, fetchFn: typeof fetch): Promise<Listing> {
  const r = await fetchFn(url, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });
  if (!r.ok) return { error: `model list answered HTTP ${r.status}` };
  const body = (await r.json()) as { data?: Array<{ id?: unknown }> };
  const ids = (body.data ?? []).map((m) => (typeof m.id === 'string' ? m.id : '')).filter(Boolean);
  return ids.length ? { ids } : { error: 'the model list was empty' };
}

/** Check every (role, vendor, model), reading each vendor's list once. */
export async function checkModels(
  entries: ReadonlyArray<{ role: string; vendor: CurrencyVendor; model: string; source: ModelSource }>,
  list: (vendor: CurrencyVendor) => Promise<Listing>,
  today: Date,
): Promise<ModelCheck[]> {
  const lists = new Map<CurrencyVendor, Promise<Listing>>();
  const out: ModelCheck[] = [];
  for (const e of entries) {
    const needsList = e.vendor !== 'amazon' && e.vendor !== 'perplexity';
    if (needsList && !lists.has(e.vendor)) lists.set(e.vendor, list(e.vendor));
    out.push(assessModel({ ...e, listing: needsList ? await lists.get(e.vendor) : undefined, today }));
  }
  return out;
}
