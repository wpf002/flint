#!/usr/bin/env tsx
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { analyse, parseTier, type Finding, type TierConfig, type VendorCatalog } from './discover.js';
import { allCatalogs } from './vendors.js';

/**
 * `evolve discover` — stage 1 of the nightly loop.
 *
 * Asks every vendor what it serves, compares that to the tiers Flint is
 * configured with, and writes a report. Spends nothing: model-list endpoints
 * are free. Run it unattended; read the report in the morning.
 */

const FLINT_HOME = process.env.FLINT_HOME?.trim() || join(homedir(), '.flint');
const STATE_DIR = join(FLINT_HOME, 'evolve');
const SNAPSHOT = join(STATE_DIR, 'catalog.json');
const LOG = join(STATE_DIR, 'discover.log');
const REPORT = join(STATE_DIR, 'report.md');

/** Read `KEY=value` lines the way the server's loadSecrets does. */
function loadSecrets(path: string, env: NodeJS.ProcessEnv): void {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim().replace(/^['"]|['"]$/g, '');
    if (!(k in env)) env[k] = v;
  }
}

function tiersFrom(env: NodeJS.ProcessEnv): TierConfig[] {
  const out: TierConfig[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (!k.startsWith('FLINT_TIER_') || !v) continue;
    if (v.trim().toLowerCase() === 'off') continue;
    const t = parseTier(k, v.trim());
    if (t) out.push(t);
  }
  return out.sort((a, b) => a.tier.localeCompare(b.tier));
}

function render(findings: Finding[], catalogs: VendorCatalog[], tiers: TierConfig[], when: string): string {
  const L: string[] = [`# Flint discovery — ${when}`, ''];
  L.push('## Tiers in use', '');
  for (const t of tiers) L.push(`- ${t.tier}: \`${t.provider}:${t.model}\``);
  if (tiers.length === 0) L.push('- (none configured; Flint uses its single legacy frontier)');
  L.push('', '## Vendors', '');
  for (const c of catalogs) {
    L.push(c.error ? `- ${c.vendor}: unreachable — ${c.error}` : `- ${c.vendor}: ${c.models.length} models`);
  }
  L.push('', '## Findings', '');
  if (findings.length === 0) {
    L.push('Nothing to act on. Every tier points at a model its vendor still serves, and nothing newer shipped.');
  } else {
    for (const f of findings) L.push(`- **${f.severity}** (${f.kind}) — ${f.detail}`);
  }
  L.push('', '_Stage 1 spends nothing: these are free model-list calls._', '');
  return L.join('\n');
}

async function discover(): Promise<number> {
  const env = { ...process.env };
  loadSecrets(join(FLINT_HOME, 'secrets.env'), env);
  mkdirSync(STATE_DIR, { recursive: true });

  const tiers = tiersFrom(env);
  const catalogs = await allCatalogs(env);

  let previous: Record<string, string[]> | undefined;
  if (existsSync(SNAPSHOT)) {
    try {
      previous = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as Record<string, string[]>;
    } catch {
      previous = undefined; // a corrupt snapshot is not worth failing the night over
    }
  }

  const findings = analyse({ tiers, catalogs, ...(previous ? { previous } : {}) });
  const when = new Date().toISOString().replace('T', ' ').slice(0, 16);

  writeFileSync(REPORT, render(findings, catalogs, tiers, when), 'utf8');
  // Only snapshot vendors we actually reached, so an outage can't look like
  // every model being removed tomorrow.
  const snap: Record<string, string[]> = { ...(previous ?? {}) };
  for (const c of catalogs) if (!c.error) snap[c.vendor] = c.models.map((m) => m.id);
  writeFileSync(SNAPSHOT, JSON.stringify(snap), 'utf8');

  const high = findings.filter((f) => f.severity === 'high').length;
  appendFileSync(LOG, `${when} findings=${findings.length} high=${high}\n`, 'utf8');

  console.log(render(findings, catalogs, tiers, when));
  // Exit 2 when something is actively broken, so a wrapper can alert on it.
  return high > 0 ? 2 : 0;
}

const cmd = process.argv[2];
if (cmd === 'discover') {
  discover()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      console.error('discover failed:', err instanceof Error ? err.message : err);
      process.exit(1);
    });
} else {
  console.error('usage: evolve discover');
  process.exit(1);
}
