import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { TIERS } from '@flint/core';
import type { DailyRow } from './measure.js';
import { type Candidate, localOnly, parseCandidate, tierEnvVar } from './promote.js';

/**
 * The I/O half of stage 3: put a candidate into the live config, let it be
 * measured, then keep or undo it.
 *
 * SAFETY. Flint is the thing being changed, so the order matters. A rollback
 * marker is written BEFORE the config is touched, and is only removed once the
 * config is settled. If this process dies mid-test — crash, power cut, SIGKILL —
 * the next run finds the marker and restores the old config before doing
 * anything else. Flint is never left on an unproven config because a script
 * stopped halfway.
 *
 * LOCAL ONLY, in both directions.
 *  - The value written into FLINT_TIER_* is always `ollama:<model>`:
 *    applyCandidate checks that itself (promote.ts localOnly) before it touches
 *    a file, whatever the caller already checked.
 *  - Undoing a try never WRITES a value either. The line that was there before
 *    is not deleted by the swap: it stays in the file, parked as a comment
 *    (`#evolve-parked FLINT_TIER_HARD=...`), and undoing un-parks it. So the
 *    only tier values this file can put into the config are a local candidate
 *    and Will's own line, byte for byte, from his own file.
 *  - The marker is checked before it is believed (readRollback): its env var
 *    must be a tier's, its candidate a local model. It used to be read as it
 *    was, so a stale or hand-made rollback.json made any `evolve try`, even a
 *    refused one, write whatever KEY=value it named and restart Flint.
 */

export interface Rollback {
  envVar: string;
  /** The value before the swap, for the record. Absent means the var was not set at all. */
  previous?: string;
  startedAt: string;
  candidate: string;
}

/** The comment a tier's previous line is parked under while a candidate is tried. */
const PARKED = '#evolve-parked ';

/** Set or remove one KEY=value line, preserving everything else in the file. */
export function setEnvLine(content: string, key: string, value: string | undefined): string {
  const lines = content.split('\n');
  const kept = lines.filter((l) => !l.trim().startsWith(`${key}=`));
  // Drop the trailing empty element so we do not accumulate blank lines.
  while (kept.length > 0 && kept[kept.length - 1]!.trim() === '') kept.pop();
  if (value !== undefined) kept.push(`${key}=${value}`);
  return `${kept.join('\n')}\n`;
}

/** The current value of `key`, or undefined when the file does not set it. */
export function readEnvLine(content: string, key: string): string | undefined {
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith(`${key}=`)) continue;
    return line.slice(key.length + 1).trim().replace(/^['"]|['"]$/g, '');
  }
  return undefined;
}

/**
 * Put `value` in as `key`, and park the line that set `key` before (if any) as
 * a comment where it stood. The server skips comment lines, so the parked line
 * sets nothing; it is only kept, exactly as Will wrote it, to be put back.
 */
export function parkEnvLine(content: string, key: string, value: string): string {
  const lines = content
    .split('\n')
    .filter((l) => !l.trim().startsWith(`${PARKED}${key}=`)) // an older try's leftover is not this one's
    .map((l) => (l.trim().startsWith(`${key}=`) ? `${PARKED}${l.trim()}` : l));
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();
  lines.push(`${key}=${value}`);
  return `${lines.join('\n')}\n`;
}

/** Undo parkEnvLine: drop the line that sets `key` now, and un-park the one that was parked for it (if any). */
export function unparkEnvLine(content: string, key: string): string {
  const lines = content
    .split('\n')
    .filter((l) => !l.trim().startsWith(`${key}=`))
    .map((l) => (l.trim().startsWith(`${PARKED}${key}=`) ? l.trim().slice(PARKED.length) : l));
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();
  return `${lines.join('\n')}\n`;
}

/** Is a line parked for `key` (a try of it is under way, or was interrupted)? */
export function hasParked(content: string, key: string): boolean {
  return content.split('\n').some((l) => l.trim().startsWith(`${PARKED}${key}=`));
}

/** The env vars a try may touch: one per tier, and nothing else in the file. */
const TIER_VARS: ReadonlySet<string> = new Set(TIERS.map((t) => tierEnvVar(t)));

/**
 * A rollback marker, checked: valid JSON, an env var that is a tier's
 * (FLINT_TIER_ROUTINE, _STANDARD, _HARD, _CODE), and a candidate that is a
 * local model. Anything else is not a marker this code wrote, and is not acted
 * on. Returns why not, for the message.
 */
export function readRollback(raw: string): { ok: true; rb: Rollback } | { ok: false; why: string } {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return { ok: false, why: 'it is not JSON' };
  }
  const o = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
  if (typeof o.envVar !== 'string' || !TIER_VARS.has(o.envVar)) return { ok: false, why: 'its env var is not a tier' };
  const cand = typeof o.candidate === 'string' ? parseCandidate(`${o.envVar.slice('FLINT_TIER_'.length)}=${o.candidate}`) : undefined;
  if (!cand || !localOnly(cand).ok) return { ok: false, why: 'its candidate is not a local model' };
  if (o.previous !== undefined && (typeof o.previous !== 'string' || !/^[A-Za-z0-9_-]{1,40}:[A-Za-z0-9._:/-]{1,160}$/.test(o.previous))) {
    return { ok: false, why: 'its previous value is not a provider:model' };
  }
  return {
    ok: true,
    rb: { envVar: o.envVar, candidate: o.candidate as string, startedAt: typeof o.startedAt === 'string' ? o.startedAt.slice(0, 40) : '', ...(typeof o.previous === 'string' ? { previous: o.previous } : {}) },
  };
}

export interface TryIo {
  secretsPath: string;
  rollbackPath: string;
  /** Restart Flint so a config change takes effect. */
  restart: () => void;
  /** Wait until Flint answers again, throwing if it never does. */
  waitHealthy: () => Promise<void>;
}

export function defaultRestart(): void {
  const uid = execFileSync('/usr/bin/id', ['-u'], { encoding: 'utf8' }).trim();
  execFileSync('/bin/launchctl', ['kickstart', '-k', `gui/${uid}/com.flint.server`], { stdio: 'ignore' });
}

export function makeWaitHealthy(url: string, tries = 20, delayMs = 2000): () => Promise<void> {
  return async () => {
    for (let i = 0; i < tries; i++) {
      try {
        const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) });
        if (res.ok) return;
      } catch {
        /* still coming up */
      }
      await new Promise((r) => setTimeout(r, delayMs));
    }
    throw new Error(`Flint did not come back up at ${url} after a config change`);
  };
}

/**
 * Restore a config left behind by a run that died mid-test. Safe to call always.
 *
 * What it will do, and no more:
 *  - a marker that does not check out (readRollback) is dropped, and nothing
 *    in the config is touched;
 *  - a config that no longer holds the marker's candidate (the swap never
 *    happened, or Will has changed the tier since) is left as it is;
 *  - otherwise the candidate's line is removed and the line parked for that
 *    tier, Will's own, is un-parked. With nothing parked the tier is left
 *    unset. A marker written before parking existed names its previous value
 *    only in the JSON: that is put back when it is a local model, and when it
 *    is an outside one the message says what it was, for Will to set by hand.
 */
export async function recoverIfNeeded(io: TryIo): Promise<string | undefined> {
  if (!existsSync(io.rollbackPath)) return undefined;
  const read = readRollback(readFileSync(io.rollbackPath, 'utf8'));
  if (!read.ok) {
    unlinkSync(io.rollbackPath);
    return `dropped a rollback marker that is not one (${read.why}); the config was not touched`;
  }
  const { rb } = read;
  const content = existsSync(io.secretsPath) ? readFileSync(io.secretsPath, 'utf8') : '';
  if (readEnvLine(content, rb.envVar) !== rb.candidate) {
    unlinkSync(io.rollbackPath);
    return `an interrupted try of ${rb.candidate} left a marker, but ${rb.envVar} no longer holds it; the config was left as it is`;
  }
  let restored = unparkEnvLine(content, rb.envVar);
  let note = `restored ${rb.envVar} after an interrupted try of ${rb.candidate}`;
  if (!hasParked(content, rb.envVar) && rb.previous !== undefined) {
    // A marker from before the previous line was parked: its value is only in the JSON.
    const before = parseCandidate(`${rb.envVar.slice('FLINT_TIER_'.length)}=${rb.previous}`);
    if (before && localOnly(before).ok) restored = setEnvLine(restored, rb.envVar, rb.previous);
    else note = `removed ${rb.candidate} from ${rb.envVar} after an interrupted try. It was ${rb.previous} before; evolve does not write an outside model, so set it back by hand if you want it`;
  }
  writeFileSync(io.secretsPath, restored, 'utf8');
  io.restart();
  await io.waitHealthy();
  unlinkSync(io.rollbackPath);
  return note;
}

/** Swap the candidate in, recording how to undo it first. Throws, having written nothing, for anything but a local model on a tier. */
export async function applyCandidate(io: TryIo, c: Candidate, now: string): Promise<void> {
  const local = localOnly(c);
  if (!local.ok) throw new Error(`refusing to write ${c.provider}:${c.model} into the config: ${local.reason}`);
  const envVar = tierEnvVar(c.tier);
  if (!TIER_VARS.has(envVar)) throw new Error(`refusing to write ${envVar}: '${c.tier}' is not a tier (${TIERS.join(', ')})`);
  const content = existsSync(io.secretsPath) ? readFileSync(io.secretsPath, 'utf8') : '';
  const previous = readEnvLine(content, envVar);
  const rb: Rollback = {
    envVar,
    ...(previous !== undefined ? { previous } : {}),
    startedAt: now,
    candidate: `${c.provider}:${c.model}`,
  };
  mkdirSync(dirname(io.rollbackPath), { recursive: true });
  // Written BEFORE the swap: if we die on the next line, recovery still works.
  writeFileSync(io.rollbackPath, JSON.stringify(rb), 'utf8');
  // The previous line stays in the file, parked: undoing un-parks it and writes no value of its own.
  writeFileSync(io.secretsPath, parkEnvLine(content, envVar, `${c.provider}:${c.model}`), 'utf8');
  io.restart();
  await io.waitHealthy();
}

/** Undo the swap and clear the rollback marker. */
export async function revertCandidate(io: TryIo): Promise<void> {
  await recoverIfNeeded(io);
}

/** Keep the candidate: drop the marker, and the line that was parked for the tier (it has been replaced for good). */
export function settleCandidate(io: TryIo): void {
  if (!existsSync(io.rollbackPath)) return;
  const read = readRollback(readFileSync(io.rollbackPath, 'utf8'));
  if (read.ok && existsSync(io.secretsPath)) {
    const content = readFileSync(io.secretsPath, 'utf8');
    const kept = content.split('\n').filter((l) => !l.trim().startsWith(`${PARKED}${read.rb.envVar}=`)).join('\n');
    if (kept !== content) writeFileSync(io.secretsPath, kept, 'utf8');
  }
  unlinkSync(io.rollbackPath);
}

export interface TryOutcome {
  action: 'keep' | 'rollback' | 'refused';
  why: string;
  candidateRow?: DailyRow;
}
