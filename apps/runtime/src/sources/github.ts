/**
 * github: open PRs, open issues, milestones and the latest CI run of each of
 * Will's repos, every 10 minutes (Machine plan P1 sources).
 *
 *  - Auth: the GitHub App `flint-observer` (read-only: Metadata, Contents,
 *    Issues, Pull requests, Actions, Checks). Its private key stays in a file;
 *    the source signs a 10-minute JWT and trades it for a 1-hour installation
 *    token. Will creates the App; until then this source cannot be enabled.
 *  - Conditional requests: each URL's ETag is kept in the cursor; a 304 costs
 *    nothing and changes nothing.
 *  - Taint: anyone can open an issue on a public repo, so every title is
 *    tainted (`name`, `state.title`). Bodies are never fetched into state.
 *  - A PR or issue that drops out of the open list is fetched once more so its
 *    closing (or merge) is recorded instead of it staying open forever.
 */
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Source, SourceObservation, SourceRun, SyncResult } from './types.js';

export interface GithubOptions {
  appId: string;
  installationId: string;
  privateKeyPath: string;
  owner: string;
  repos: readonly string[];
  /** For tests. */
  now?: () => Date;
}

export const GITHUB_API = 'https://api.github.com';

const b64url = (s: string | Buffer) => Buffer.from(s).toString('base64url');
/** The conclusions the world model knows; anything newer (stale, startup_failure) reads as neutral. */
const CONCLUSIONS = new Set(['success', 'failure', 'cancelled', 'skipped', 'timed_out', 'neutral', 'action_required']);

/** An App JWT: RS256, issued a minute in the past (clock skew), valid 9 minutes. */
export function appJwt(appId: string, privateKeyPem: string, now: Date): string {
  const iat = Math.floor(now.getTime() / 1000) - 60;
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iat, exp: iat + 9 * 60, iss: appId }));
  const sig = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(privateKeyPem);
  return `${header}.${payload}.${b64url(sig)}`;
}

interface Cursor {
  etags: Record<string, string>;
}

const parseCursor = (raw: string | undefined): Cursor => {
  try {
    const c = JSON.parse(raw || '{}') as Partial<Cursor>;
    return { etags: c.etags && typeof c.etags === 'object' ? c.etags : {} };
  } catch {
    return { etags: {} };
  }
};

interface Gh {
  number: number;
  title: string;
  state: string;
  draft?: boolean;
  merged_at?: string | null;
  pull_request?: unknown;
  labels?: Array<{ name: string }>;
}

export function githubSource(o: GithubOptions): Source & { endpoints: string[] } {
  let token: { value: string; expires: number } | undefined;
  return {
    name: 'github',
    cadenceMs: 10 * 60_000,
    endpoints: [GITHUB_API],
    async run(r: SourceRun): Promise<SyncResult> {
      const now = o.now?.() ?? r.now;
      const cursor = parseCursor(r.cursor?.cursor);
      if (!token || token.expires - 60_000 < now.getTime()) {
        const jwt = appJwt(o.appId, readFileSync(o.privateKeyPath, 'utf8'), now);
        const res = await r.fetch(`${GITHUB_API}/app/installations/${encodeURIComponent(o.installationId)}/access_tokens`, {
          method: 'POST',
          headers: { authorization: `Bearer ${jwt}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
        });
        if (!res.ok) throw new Error(`GitHub App token: HTTP ${res.status}`);
        const t = (await res.json()) as { token: string; expires_at: string };
        token = { value: t.token, expires: Date.parse(t.expires_at) };
      }
      const get = async (path: string): Promise<unknown | 'unchanged'> => {
        const url = `${GITHUB_API}${path}`;
        const etag = cursor.etags[url];
        const res = await r.fetch(url, {
          headers: {
            authorization: `Bearer ${token!.value}`,
            accept: 'application/vnd.github+json',
            'x-github-api-version': '2022-11-28',
            ...(etag ? { 'if-none-match': etag } : {}),
          },
        });
        if (res.status === 304) return 'unchanged';
        if (!res.ok) throw new Error(`GitHub ${path.split('?')[0]}: HTTP ${res.status}`);
        const e = res.headers.get('etag');
        if (e) cursor.etags[url] = e;
        return res.json();
      };

      const observations: SourceObservation[] = [];
      for (const repo of o.repos) {
        const full = `${o.owner}/${repo}`;
        const base = `/repos/${encodeURIComponent(o.owner)}/${encodeURIComponent(repo)}`;
        const meta = await get(base);
        if (meta !== 'unchanged') {
          const m = meta as { default_branch?: string };
          observations.push({ type: 'repo.meta', kind: 'repo', key: `repo:github:${full}`, name: full, sensitivity: 'ops', externalId: `repo:${full}`, state: { host: 'github', ...(m.default_branch ? { defaultBranch: m.default_branch.slice(0, 120) } : {}) } });
        }
        const seenOpen = new Set<string>();
        const issueLike = (kind: 'pull_request' | 'issue', it: Gh): SourceObservation => {
          const key = `${kind}:github:${full}#${it.number}`;
          const state = kind === 'pull_request'
            ? { number: it.number, state: it.merged_at ? 'merged' : it.state === 'open' ? 'open' : 'closed', ...(it.draft !== undefined ? { draft: !!it.draft } : {}), title: it.title.slice(0, 120) }
            : { number: it.number, state: it.state === 'open' ? 'open' : 'closed', labels: (it.labels ?? []).map((l) => l.name.slice(0, 120)).slice(0, 20), title: it.title.slice(0, 120) };
          return {
            type: `${kind}.state`, kind, key, name: it.title.slice(0, 300) || `${kind}#${it.number}`, sensitivity: 'ops',
            externalId: `${kind}:${full}#${it.number}`, taintedPaths: ['name', 'state.title'],
            state, ...(state.state === 'open' ? {} : { status: 'archived' as const }),
          };
        };
        const pulls = await get(`${base}/pulls?state=open&per_page=100`);
        if (pulls !== 'unchanged') for (const p of pulls as Gh[]) {
          observations.push(issueLike('pull_request', p));
          seenOpen.add(`pull_request:github:${full}#${p.number}`);
        }
        const issues = await get(`${base}/issues?state=open&per_page=100`);
        if (issues !== 'unchanged') for (const i of (issues as Gh[]).filter((x) => !x.pull_request)) {
          observations.push(issueLike('issue', i));
          seenOpen.add(`issue:github:${full}#${i.number}`);
        }
        // Anything we knew as open that is no longer listed: one more look, to record how it ended.
        if (pulls !== 'unchanged' && issues !== 'unchanged' && r.known) {
          for (const kind of ['pull_request', 'issue'] as const) {
            for (const key of await r.known(kind)) {
              if (!key.startsWith(`${kind}:github:${full}#`) || seenOpen.has(key)) continue;
              const n = Number(key.slice(key.lastIndexOf('#') + 1));
              if (!Number.isInteger(n) || n <= 0) continue;
              const one = await get(`${base}/${kind === 'pull_request' ? 'pulls' : 'issues'}/${n}`);
              if (one !== 'unchanged') observations.push(issueLike(kind, one as Gh));
            }
          }
        }
        const runs = await get(`${base}/actions/runs?per_page=1`);
        if (runs !== 'unchanged') {
          const run = (runs as { workflow_runs?: Array<{ id: number; name?: string; status: string; conclusion: string | null; head_sha: string }> }).workflow_runs?.[0];
          if (run) {
            observations.push({
              type: 'ci_run.state', kind: 'ci_run', key: `ci_run:github:${full}:latest`, name: `${full} CI`, sensitivity: 'ops', externalId: `ci_run:${full}:latest`,
              state: {
                workflow: (run.name ?? 'ci').slice(0, 120),
                status: (['queued', 'in_progress', 'completed'].includes(run.status) ? run.status : 'queued') as 'queued',
                conclusion: run.conclusion === null ? null : (CONCLUSIONS.has(run.conclusion) ? run.conclusion : 'neutral') as 'success',
                sha: run.head_sha,
              },
            });
          }
        }
        const milestones = await get(`${base}/milestones?state=open&per_page=100`);
        if (milestones !== 'unchanged') {
          for (const m of milestones as Array<{ number: number; title: string; due_on: string | null }>) {
            if (!m.due_on) continue;
            observations.push({
              type: 'deadline.due', kind: 'deadline', key: `deadline:github:${full}:milestone:${m.number}`, name: m.title.slice(0, 300), sensitivity: 'ops',
              externalId: `milestone:${full}#${m.number}`, state: { dueOn: m.due_on.slice(0, 10), source: 'github' },
            });
          }
        }
      }
      return { observations, metrics: [], cursor: JSON.stringify(cursor) };
    },
  };
}
