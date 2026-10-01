/**
 * git: the head of each of Will's clones every 5 minutes, through `rev-parse`
 * only. The deploy checkout (~/flint) is also the Studio's deployment: the sha
 * it runs, and whether the last deploy finished on it.
 */
import { existsSync, readFileSync } from 'node:fs';
import type { Run } from './exec.js';
import type { Source, SourceObservation } from './types.js';

export interface GitOptions {
  run: Run;
  repos: ReadonlyArray<{ name: string; path: string }>;
  /** The deploy-only checkout and its deploy log. */
  deploy?: { path: string; log: string };
}

/** The sha of the last "deployed <sha>" line of auto_deploy.sh's log. */
export function lastDeployed(log: string): string | undefined {
  const lines = log.trimEnd().split('\n');
  for (let i = lines.length - 1; i >= 0 && i >= lines.length - 400; i--) {
    const m = / deployed ([0-9a-f]{40})\s*$/.exec(lines[i]!);
    if (m) return m[1];
  }
  return undefined;
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
          log = readFileSync(o.deploy.log, 'utf8').slice(-64 * 1024);
        } catch {
          log = '';
        }
        const deployed = lastDeployed(log);
        observations.push({
          type: 'deployment.status', kind: 'deployment', key: 'deployment:studio:flint', name: 'flint on the Studio', sensitivity: 'ops', externalId: 'studio:flint',
          state: { target: 'studio', status: deployed === head ? 'success' : deployed ? 'deploying' : 'unknown', sha: head },
        });
      }
      return { observations, metrics: [] };
    },
  };
}
