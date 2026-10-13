/**
 * git: the head of each of Will's clones every 5 minutes, through `rev-parse`
 * only. The deploy checkout (~/flint) is also the Studio's deployment: the sha
 * it runs, and whether the last deploy finished on it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Run } from './exec.js';
import type { Source, SourceObservation } from './types.js';

export interface GitOptions {
  run: Run;
  repos: ReadonlyArray<{ name: string; path: string }>;
  /** The deploy-only checkout and its deploy log. */
  deploy?: { path: string; log: string };
}

/**
 * What auto_deploy.sh's log says about `head`, from its own lines:
 *   "<ts> deployed <sha>"                 the server deployed it      -> success
 *   "<ts> up to date (<sha>)"             a quiet tick on it          -> success
 *   "<ts> server deploy FAILED at <sha>"  the gate or reload failed   -> failed
 *   "<ts> new code <a> -> <sha> ..."      started, no outcome yet     -> deploying
 * ("runtime deployed <sha>" is the runtime's, not the server's.)
 */
export function deployStatus(log: string, head: string): 'success' | 'failed' | 'deploying' | 'unknown' {
  const lines = log.trimEnd().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.includes(head)) continue;
    if (new RegExp(`^\\S+ \\S+ deployed ${head}\\s*$`).test(line) || line.includes(`up to date (${head})`)) return 'success';
    if (line.includes(`server deploy FAILED at ${head}`)) return 'failed';
    if (new RegExp(`new code \\S+ -> ${head}\\b`).test(line)) return 'deploying';
  }
  return 'unknown';
}

/** The sha of the last "deployed <sha>" line (kept for callers that want it). */
export function lastDeployed(log: string): string | undefined {
  const lines = log.trimEnd().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^\S+ \S+ deployed ([0-9a-f]{40})\s*$/.exec(lines[i]!);
    if (m) return m[1];
  }
  return undefined;
}

/** Where a clone's main branch may be, in the order tried: what origin calls its default, origin's main, the clone's own main, or master. */
export const MAIN_REFS = ['refs/remotes/origin/HEAD', 'refs/remotes/origin/main', 'refs/heads/main', 'refs/heads/master'] as const;

/**
 * The main branch of a clone, as the clone has it now (it is never fetched
 * from here): one fixed command that lists which of MAIN_REFS exist. Undefined
 * when the folder is not a clone of its own (no .git in it: a plain folder
 * inside another repo would be counted as that repo), or has none of them.
 */
export async function mainRef(run: Run, path: string): Promise<string | undefined> {
  if (!existsSync(join(path, '.git'))) return undefined;
  const have = new Set((await run('/usr/bin/git', ['-C', path, 'for-each-ref', '--format=%(refname)', ...MAIN_REFS])).split('\n').map((l) => l.trim()));
  return MAIN_REFS.find((r) => have.has(r));
}

/**
 * How many commits landed on a clone's main branch from `since` up to (not
 * including) `before` (P4: the weekly commit counts Flint forecasts). One
 * fixed command, numbers only: `rev-list --count --first-parent <main>`, by
 * commit date. Main only, and only its own line of commits: a branch's commits
 * count when they land (as one merge or squash commit, dated then), never by
 * their own dates. So a week counted the night it ends and the same week
 * counted in a backfill months later are the same number, which `--all` could
 * not give: it counted every branch the clone happened to hold that day.
 * It never fetches, reads no commit's words, and its answer is a whole number
 * or nothing: anything else git prints is refused.
 */
export async function commitsBetween(run: Run, path: string, ref: string, since: Date, before: Date): Promise<number> {
  // git's two ends both count their own second: the last second of the span is the one before `before`.
  const last = new Date(before.getTime() - 1000);
  const out = (await run('/usr/bin/git', ['-C', path, 'rev-list', '--count', '--first-parent', `--since=${since.toISOString()}`, `--before=${last.toISOString()}`, ref])).trim();
  if (!/^\d{1,9}$/.test(out)) throw new Error('git rev-list --count did not print a number');
  return Number(out);
}

export function gitSource(o: GitOptions): Source {
  return {
    name: 'git',
    cadenceMs: 5 * 60_000,
    async run() {
      const observations: SourceObservation[] = [];
      for (const repo of o.repos) {
        if (!existsSync(repo.path)) continue;
        const head = (await o.run('/usr/bin/git', ['-C', repo.path, 'rev-parse', 'HEAD'])).trim();
        const branch = (await o.run('/usr/bin/git', ['-C', repo.path, 'rev-parse', '--abbrev-ref', 'HEAD'])).trim();
        if (!/^[0-9a-f]{40}$/.test(head)) continue;
        observations.push({
          type: 'repo.head', kind: 'repo', key: `repo:local:${repo.name}`, name: repo.name, sensitivity: 'ops', externalId: `local:${repo.path}`,
          state: { host: 'local', headSha: head, ...(branch && branch !== 'HEAD' ? { branch: branch.slice(0, 120) } : {}) },
        });
      }
      if (o.deploy && existsSync(o.deploy.path)) {
        const head = (await o.run('/usr/bin/git', ['-C', o.deploy.path, 'rev-parse', 'HEAD'])).trim();
        let log = '';
        try {
          log = readFileSync(o.deploy.log, 'utf8').slice(-512 * 1024);
        } catch {
          log = '';
        }
        observations.push({
          type: 'deployment.status', kind: 'deployment', key: 'deployment:studio:flint', name: 'flint on the Studio', sensitivity: 'ops', externalId: 'studio:flint',
          state: { target: 'studio', status: deployStatus(log, head), sha: head },
        });
      }
      return { observations, metrics: [] };
    },
  };
}
