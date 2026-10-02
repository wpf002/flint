/**
 * The "chat unaffected" baseline (P2 exit criterion 6), taken before triage
 * runs: from the server's [route] lines (~/.flint/server.err.log and its
 * rotations), real chat turns only (no eval replay, no /generate), the 95th
 * percentile of turn time and the share of turns whose memory recall fell
 * back (lexical, timeout, error) among those that recalled at all. Written to
 * ~/.flint/p2-baseline.json (0600) and then frozen: it is never overwritten
 * without --replace. It needs 7 days of lines unless --force.
 *
 *   pnpm --filter server route-baseline [--replace] [--force] [log files...]
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const FALLBACKS: ReadonlySet<string> = new Set(['lexical', 'timeout', 'error']);
export const MIN_DAYS = 7;

export interface Baseline {
  from: string;
  to: string;
  n: number;
  p95Ms: number;
  recallFallbackRate: number;
}

/** The baseline in some log text, or undefined when it holds no chat turn. */
export function baselineOf(text: string): Baseline | undefined {
  const turns: Array<{ ts: string; ms: number; recall?: string }> = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('[route] ')) continue;
    let r: { ts?: unknown; path?: unknown; eval?: unknown; ms?: unknown; recall?: unknown };
    try {
      r = JSON.parse(line.slice('[route] '.length));
    } catch {
      continue;
    }
    if (r.path !== 'chat' || r.eval === true || typeof r.ms !== 'number' || typeof r.ts !== 'string' || !Number.isFinite(Date.parse(r.ts))) continue;
    turns.push({ ts: r.ts, ms: r.ms, ...(typeof r.recall === 'string' ? { recall: r.recall } : {}) });
  }
  if (!turns.length) return undefined;
  const ms = turns.map((t) => t.ms).sort((a, b) => a - b);
  const recalled = turns.filter((t) => t.recall && t.recall !== 'none' && t.recall !== 'skipped');
  const ts = turns.map((t) => t.ts).sort();
  return {
    from: ts[0]!,
    to: ts[ts.length - 1]!,
    n: turns.length,
    p95Ms: ms[Math.min(ms.length - 1, Math.ceil(0.95 * ms.length) - 1)]!,
    recallFallbackRate: recalled.length ? recalled.filter((t) => FALLBACKS.has(t.recall!)).length / recalled.length : 0,
  };
}

function main(): void {
  const args = process.argv.slice(2);
  const dir = join(homedir(), '.flint');
  const files = args.filter((a) => !a.startsWith('--'));
  const logs = files.length ? files : readdirSync(dir).filter((f) => /^server\.err\.log(\.\d+)?$/.test(f)).map((f) => join(dir, f));
  const b = baselineOf(logs.map((f) => readFileSync(f, 'utf8')).join('\n'));
  if (!b) throw new Error('no chat turns in the [route] lines yet');
  const days = (Date.parse(b.to) - Date.parse(b.from)) / 86_400_000;
  if (days < MIN_DAYS && !args.includes('--force')) throw new Error(`only ${days.toFixed(1)} days of chat turns (${b.n}); the baseline needs ${MIN_DAYS} (or --force)`);
  const out = join(dir, 'p2-baseline.json');
  if (existsSync(out) && !args.includes('--replace')) throw new Error(`${out} exists and is frozen (--replace to take a new one)`);
  writeFileSync(out, `${JSON.stringify(b, null, 2)}\n`, { mode: 0o600 });
  console.log(`baseline: ${b.n} chat turns, ${b.from} .. ${b.to}: p95 ${b.p95Ms} ms, recall fallback ${(b.recallFallbackRate * 100).toFixed(1)}% -> ${out}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main();
  } catch (err) {
    console.error(`route-baseline: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
