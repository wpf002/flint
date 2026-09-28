/**
 * Stage 1 of the nightly loop: find out what models exist today.
 *
 * WHY THIS EXISTS. Flint's brain tiers are set by hand in ~/.flint/secrets.env.
 * On 2026-09-28 the code tier was pointed at `gpt-5.2-codex`, which OpenAI had
 * already deprecated; every code question paid for a failed call before falling
 * back. Nothing in Flint noticed, because nothing was looking. Meanwhile GPT-6
 * and several Gemini generations had shipped and Flint had never heard of them.
 *
 * So this asks each vendor what it actually serves, compares that to what Flint
 * is configured to use, and reports three things: tiers pointing at a model the
 * vendor no longer lists (dead config), models newer than the ones configured
 * (missed upgrades), and what changed since last night (news).
 *
 * Every call here is a free model-list endpoint. This stage never spends money,
 * which is what makes it safe to run unattended every night.
 */

export interface ModelInfo {
  id: string;
  /** Vendor-reported creation time, when it gives one. Used to rank "newer". */
  created?: number;
}

export interface VendorCatalog {
  vendor: string;
  /** Empty with a reason when the vendor could not be reached or has no key. */
  models: ModelInfo[];
  error?: string;
}

/** A tier as Flint configures it: `provider:model`, model may contain colons. */
export interface TierConfig {
  tier: string;
  provider: string;
  model: string;
}

export interface Finding {
  kind: 'dead-config' | 'missed-upgrade' | 'new-model' | 'removed-model';
  severity: 'high' | 'medium' | 'low';
  detail: string;
}

/** `FLINT_TIER_CODE=openai:gpt-5.2-codex` -> {tier:'code', provider:'openai', model:'gpt-5.2-codex'} */
export function parseTier(name: string, value: string): TierConfig | undefined {
  const tier = name.replace(/^FLINT_TIER_/, '').toLowerCase();
  const i = value.indexOf(':');
  if (i <= 0 || i === value.length - 1) return undefined;
  return { tier, provider: value.slice(0, i), model: value.slice(i + 1) };
}

/**
 * Is `model` served by this catalog? An id counts as present when the vendor
 * lists it exactly. Prefix matching would hide exactly the failure this is for:
 * `gpt-5.2-codex` starts with `gpt-5.2`, which IS served, while the codex id is
 * not.
 */
export function isServed(catalog: VendorCatalog, model: string): boolean {
  const want = model.replace(/^models\//, '');
  return catalog.models.some((m) => m.id.replace(/^models\//, '') === want);
}

/**
 * Compare two version-ish ids of the same family, newest first. Vendors don't
 * date every model, so this reads the numbers in the id: gpt-5.6 > gpt-5.5, and
 * gpt-6 > gpt-5.6. Returns 0 when they aren't comparable.
 */
export function compareVersions(a: string, b: string): number {
  const nums = (s: string): number[] => (s.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
  const [x, y] = [nums(a), nums(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (y[i] ?? -1) - (x[i] ?? -1);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** The family an id belongs to: gpt-5.6-sol -> gpt, claude-opus-5-5 -> claude-opus. */
export function familyOf(id: string): string {
  const base = id.replace(/^models\//, '');
  const cut = base.search(/[-.]?\d/);
  return (cut > 0 ? base.slice(0, cut) : base).replace(/[-.]$/, '');
}

/**
 * The findings a night produces. `previous` is last night's catalog, so the
 * report can say what changed rather than repeating the whole world each time.
 */
export function analyse(opts: {
  tiers: TierConfig[];
  catalogs: VendorCatalog[];
  previous?: Record<string, string[]>;
}): Finding[] {
  const { tiers, catalogs, previous } = opts;
  const byVendor = new Map(catalogs.map((c) => [c.vendor, c]));
  const out: Finding[] = [];

  for (const t of tiers) {
    const cat = byVendor.get(t.provider);
    // A vendor we couldn't reach proves nothing about the tier; stay quiet.
    if (!cat || cat.error || cat.models.length === 0) continue;

    if (!isServed(cat, t.model)) {
      out.push({
        kind: 'dead-config',
        severity: 'high',
        detail: `tier ${t.tier} points at ${t.provider}:${t.model}, which ${t.provider} no longer lists. Every ${t.tier} question pays for a failed call before falling back.`,
      });
      continue;
    }
    // Served, but is there something newer in the same family?
    const fam = familyOf(t.model);
    const newer = cat.models
      .map((m) => m.id.replace(/^models\//, ''))
      .filter((id) => familyOf(id) === fam && compareVersions(t.model, id) > 0)
      .sort((a, b) => compareVersions(a, b));
    if (newer.length > 0) {
      out.push({
        kind: 'missed-upgrade',
        severity: 'medium',
        detail: `tier ${t.tier} uses ${t.model}; ${t.provider} now serves ${newer.slice(0, 3).join(', ')}`,
      });
    }
  }

  if (previous) {
    for (const cat of catalogs) {
      if (cat.error) continue;
      const before = new Set(previous[cat.vendor] ?? []);
      if (before.size === 0) continue; // first sighting of this vendor is not news
      const now = new Set(cat.models.map((m) => m.id));
      for (const id of now) {
        if (!before.has(id)) out.push({ kind: 'new-model', severity: 'low', detail: `${cat.vendor} added ${id}` });
      }
      for (const id of before) {
        if (!now.has(id)) {
          out.push({ kind: 'removed-model', severity: 'medium', detail: `${cat.vendor} removed ${id}` });
        }
      }
    }
  }

  const rank = { high: 0, medium: 1, low: 2 } as const;
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}
