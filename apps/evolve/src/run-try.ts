import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DailyRow } from './measure.js';
import { type Candidate, tierEnvVar } from './promote.js';

/**
 * The I/O half of stage 3: put a candidate into the live config, let it be
 * measured, then keep or undo it.
 *
 * SAFETY. Flint is the thing being changed, so the order matters. The previous
 * value is written to a rollback file BEFORE the config is touched, and that
 * file is only removed once the config is settled. If this process dies
 * mid-test — crash, power cut, SIGKILL — the next run finds the rollback file
 * and restores the old config before doing anything else. Flint is never left
 * on an unproven config because a script stopped halfway.
 */

export interface Rollback {
  envVar: string;
  /** The value before the swap. Absent means the var was not set at all. */
  previous?: string;
  startedAt: string;
  candidate: string;
}

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

/** Restore a config left behind by a run that died mid-test. Safe to call always. */
export async function recoverIfNeeded(io: TryIo): Promise<string | undefined> {
  if (!existsSync(io.rollbackPath)) return undefined;
  const rb = JSON.parse(readFileSync(io.rollbackPath, 'utf8')) as Rollback;
  const content = existsSync(io.secretsPath) ? readFileSync(io.secretsPath, 'utf8') : '';
  writeFileSync(io.secretsPath, setEnvLine(content, rb.envVar, rb.previous), 'utf8');
  io.restart();
  await io.waitHealthy();
  unlinkSync(io.rollbackPath);
  return `restored ${rb.envVar} after an interrupted try of ${rb.candidate}`;
}

/** Swap the candidate in, recording how to undo it first. */
export async function applyCandidate(io: TryIo, c: Candidate, now: string): Promise<void> {
  const envVar = tierEnvVar(c.tier);
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
  writeFileSync(io.secretsPath, setEnvLine(content, envVar, `${c.provider}:${c.model}`), 'utf8');
  io.restart();
  await io.waitHealthy();
}

/** Undo the swap and clear the rollback marker. */
export async function revertCandidate(io: TryIo): Promise<void> {
  await recoverIfNeeded(io);
}

/** Keep the candidate: nothing to change, just drop the marker. */
export function settleCandidate(io: TryIo): void {
  if (existsSync(io.rollbackPath)) unlinkSync(io.rollbackPath);
}

export interface TryOutcome {
  action: 'keep' | 'rollback' | 'refused';
  why: string;
  candidateRow?: DailyRow;
}
