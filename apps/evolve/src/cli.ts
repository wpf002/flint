#!/usr/bin/env tsx
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { analyse, parseTier, type Finding, type TierConfig, type VendorCatalog } from './discover.js';
import { allCatalogs } from './vendors.js';
import { measure } from './run-measure.js';

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
const BASELINE = join(STATE_DIR, 'baseline.json');
const DAILY_CSV = join(STATE_DIR, 'daily.csv');

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

/** Flint's bearer token: env, then ~/.flint/token, then the launchd plist. Never printed. */
function flintToken(env: NodeJS.ProcessEnv): string {
  const fromEnv = env.FLINT_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const file = join(FLINT_HOME, 'token');
  if (existsSync(file)) {
    const t = readFileSync(file, 'utf8').trim();
    if (t) return t;
  }
  const plist = join(homedir(), 'Library', 'LaunchAgents', 'com.flint.server.plist');
  if (existsSync(plist)) {
    try {
      const t = execFileSync('/usr/bin/plutil', ['-extract', 'EnvironmentVariables.FLINT_TOKEN', 'raw', plist], {
        encoding: 'utf8',
      }).trim();
      if (t) return t;
    } catch {
      /* fall through to the error below */
    }
  }
  throw new Error('no Flint token: set FLINT_TOKEN, or ~/.flint/token');
}

async function runMeasure(): Promise<number> {
  const env = { ...process.env };
  loadSecrets(join(FLINT_HOME, 'secrets.env'), env);
  mkdirSync(STATE_DIR, { recursive: true });

  const key = env.ANTHROPIC_API_KEY?.trim();
  if (!key) throw new Error('measure needs ANTHROPIC_API_KEY (the judge)');
  const tiers = tiersFrom(env);
  const config = tiers.map((t) => `${t.tier}=${t.provider}:${t.model}`).join(',') || 'legacy-frontier';
  const budget = Number(env.EVOLVE_BUDGET_USD ?? '0.60');
  const n = Number(env.EVOLVE_PROMPTS ?? '20');

  const res = await measure({
    flintUrl: env.FLINT_URL?.trim() || 'http://127.0.0.1:8080',
    flintToken: flintToken(env),
    anthropicKey: key,
    judgeModel: env.EVOLVE_JUDGE_MODEL?.trim() || 'claude-opus-5-5',
    promptsPath: env.EVOLVE_PROMPTS_PATH?.trim() || join(FLINT_HOME, 'eval', 'parity_prompts.jsonl'),
    baselinePath: BASELINE,
    csvPath: DAILY_CSV,
    n,
    budgetUsd: budget,
    config,
    now: new Date().toISOString().replace('T', ' ').slice(0, 16),
  });

  if (res.kind === 'baseline-created') {
    console.log(`baseline created from ${res.n} answer(s), $${res.costUsd.toFixed(4)}. Tomorrow's run scores against it.`);
    return 0;
  }
  const r = res.row!;
  console.log(`${r.ts}  n=${r.n}  ${r.wins}-${r.losses}-${r.ties}  rate=${r.winRate.toFixed(3)}  ${r.signal}  $${r.costUsd.toFixed(4)}`);
  if (res.stoppedEarly) console.log(`  stopped early: ${res.stoppedEarly}`);
  console.log(`  -> ${DAILY_CSV}`);
  return r.signal === 'WORSE' ? 2 : 0;
}

const cmd = process.argv[2];
if (cmd === 'measure') {
  runMeasure()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      console.error('measure failed:', err instanceof Error ? err.message : err);
      process.exit(1);
    });
} else if (cmd === 'discover') {
  discover()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      console.error('discover failed:', err instanceof Error ? err.message : err);
      process.exit(1);
    });
} else {
  console.error('usage: evolve <discover|measure>');
  process.exit(1);
}
