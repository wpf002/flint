/**
 * github: open PRs, open issues, milestones and the latest CI run of each of
 * Will's repos, every 10 minutes (Machine plan P1 sources).
 *
 *  - Auth: the GitHub App `flint-observer`, read-only: Metadata, Issues, Pull
 *    requests, Actions. Its private key stays in a file; the source signs a
 *    short JWT and trades it for a 1-hour installation token asking for those
 *    read permissions only. Will creates the App; until then this source
 *    cannot be enabled.
 *  - Conditional requests: a listing that fits on one page keeps its ETag in
 *    the cursor, and a 304 costs nothing and changes nothing. A listing longer
 *    than a page is always read whole (up to 10 pages), so a change on page 2
 *    is never hidden behind page 1's 304; past 10 pages the run says so.
 *  - Each repo is all-or-nothing: if any request for it fails, none of that
 *    repo's observations or ETags from this run are kept, the other repos carry
 *    on, and the failure is reported as the source's error.
 *  - Taint: anyone can open an issue on a public repo, so every issue, PR and
 *    milestone title is tainted (`name`, `state.title`). Bodies, authors and
 *    assignees are never read into state.
 *  - CI is the latest push run on the default branch: a fork's pull_request
 *    run carries a workflow name an outsider wrote.
 *  - What leaves a listing is followed up: a PR or issue no longer open is
 *    fetched once more so its closing (or merge) is recorded; one that is gone
 *    (404, 410, or moved elsewhere: 301) is closed as it was last known; a
 *    milestone that closed or lost its due date is archived.
 */
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { clip } from './text.js';
import type { Known, Source, SourceObservation, SourceRun, SyncResult } from './types.js';

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
/** What the installation token may do: read, and only these. */
export const GITHUB_PERMISSIONS = { metadata: 'read', issues: 'read', pull_requests: 'read', actions: 'read' } as const;
const MAX_PAGES = 10;

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

// ---- what GitHub sends (only the fields read; anything else is dropped) -----------------

const Token = z.object({ token: z.string().min(1).max(1000), expires_at: z.string().refine((s) => Number.isFinite(Date.parse(s))) });
const Item = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  state: z.string(),
  draft: z.boolean().optional(),
  merged_at: z.string().nullable().optional(),
  pull_request: z.unknown().optional(),
  labels: z.array(z.union([z.object({ name: z.string() }), z.string()])).optional(),
});
type Item = z.infer<typeof Item>;
const Milestone = z.object({ number: z.number().int().positive(), title: z.string(), due_on: z.string().nullable() });
const Repo = z.object({ default_branch: z.string().min(1).max(255) });
const Runs = z.object({
  workflow_runs: z.array(z.object({ name: z.string().nullable().optional(), status: z.string().nullable(), conclusion: z.string().nullable(), head_sha: z.string() })),
});

// ---- the cursor -------------------------------------------------------------------------

interface Cursor {
  /** listing URL -> ETag, for single-page listings only. */
  etags: Record<string, string>;
  /** owner/repo -> default branch (for the CI query when the repo itself is a 304). */
  branches: Record<string, string>;
}

const strings = (v: unknown): Record<string, string> =>
  v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === 'string')) : {};

export function parseCursor(raw: string | undefined): Cursor {
  try {
    const c = JSON.parse(raw || '{}') as { etags?: unknown; branches?: unknown };
    return { etags: strings(c.etags), branches: strings(c.branches) };
  } catch {
    return { etags: {}, branches: {} };
  }
}

const nextLink = (link: string | null): boolean => !!link && /rel="next"/.test(link);

export function githubSource(o: GithubOptions): Source & { endpoints: string[] } {
  let token: { value: string; expires: number } | undefined;
  return {
    name: 'github',
    cadenceMs: 10 * 60_000,
    endpoints: [GITHUB_API],
    async run(r: SourceRun): Promise<SyncResult> {
      const now = o.now?.() ?? r.now;
      const old = parseCursor(r.cursor?.cursor);
      const next: Cursor = { etags: {}, branches: {} };
      if (!token || token.expires - 60_000 < now.getTime()) {
        token = undefined;
        const jwt = appJwt(o.appId, readFileSync(o.privateKeyPath, 'utf8'), now);
        const res = await r.fetch(`${GITHUB_API}/app/installations/${encodeURIComponent(o.installationId)}/access_tokens`, {
          method: 'POST',
          headers: { authorization: `Bearer ${jwt}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'content-type': 'application/json' },
          body: JSON.stringify({ permissions: GITHUB_PERMISSIONS }),
        });
        if (!res.ok) throw new Error(`GitHub App token: HTTP ${res.status}`);
        const t = Token.safeParse(await res.json().catch(() => undefined));
        if (!t.success) throw new Error('GitHub App token: unexpected response');
        token = { value: t.data.token, expires: Date.parse(t.data.expires_at) };
      }
      const request = async (url: string, etag?: string) => {
        const res = await r.fetch(url, {
          headers: {
            authorization: `Bearer ${token!.value}`,
            accept: 'application/vnd.github+json',
            'x-github-api-version': '2022-11-28',
            ...(etag ? { 'if-none-match': etag } : {}),
          },
        });
        // A revoked or expired token: get a new one next run.
        if (res.status === 401) token = undefined;
        return res;
      };
      const fail = (path: string, status: number) => new Error(`GitHub ${path.split('?')[0]}: HTTP ${status}`);

      const observations: SourceObservation[] = [];
      const errors: string[] = [];
      for (const repo of o.repos) {
        const full = `${o.owner}/${repo}`;
        const base = `/repos/${encodeURIComponent(o.owner)}/${encodeURIComponent(repo)}`;
        const ofRepo = (url: string) => url === `${GITHUB_API}${base}` || url.startsWith(`${GITHUB_API}${base}/`);
        const found: SourceObservation[] = [];
        const etags: Record<string, string> = {};

        /** One listing (its path has a query): 'unchanged' (a 304), or every item and whether that is all of them. */
        const list = async (path: string): Promise<'unchanged' | { items: unknown[]; complete: boolean }> => {
          const first = `${GITHUB_API}${path}`;
          const etag = old.etags[first];
          const res = await request(first, etag);
          if (res.status === 304 && etag) {
            etags[first] = etag;
            return 'unchanged';
          }
          if (!res.ok) throw fail(path, res.status);
          const page = await res.json();
          if (!Array.isArray(page)) throw new Error(`GitHub ${path.split('?')[0]}: not a list`);
          const items: unknown[] = [...page];
          let more = nextLink(res.headers.get('link'));
          if (!more) {
            const e = res.headers.get('etag');
            if (e) etags[first] = e.slice(0, 200);
            return { items, complete: true };
          }
          // GitHub's next links often name /repositories/<id>/...; the pages are asked for by number here instead.
          for (let page = 2; more && page <= MAX_PAGES; page++) {
            const p = await request(`${first}&page=${page}`);
            if (!p.ok) throw fail(path, p.status);
            const body = await p.json();
            if (!Array.isArray(body)) throw new Error(`GitHub ${path.split('?')[0]}: not a list`);
            items.push(...body);
            more = nextLink(p.headers.get('link'));
          }
          if (more) errors.push(`${full}: ${path.split('?')[0]} has more than ${MAX_PAGES * 100} items; the rest are not read`);
          return { items, complete: !more };
        };

        const issueLike = (kind: 'pull_request' | 'issue', it: Item): SourceObservation => {
          const title = clip(it.title, 120);
          const state = kind === 'pull_request'
            ? { number: it.number, state: it.merged_at ? 'merged' : it.state === 'open' ? 'open' : 'closed', ...(it.draft !== undefined ? { draft: it.draft } : {}), title }
            : { number: it.number, state: it.state === 'open' ? 'open' : 'closed', labels: (it.labels ?? []).map((l) => clip(typeof l === 'string' ? l : l.name, 120)).slice(0, 20), title };
          return {
            type: `${kind}.state`, kind, key: `${kind}:github:${full}#${it.number}`, name: clip(it.title, 300) || `${kind}#${it.number}`, sensitivity: 'ops',
            externalId: `${kind}:${full}#${it.number}`, taintedPaths: ['name', 'state.title'],
            state, ...(state.state === 'open' ? {} : { status: 'archived' as const }),
          };
        };
        /** Something gone from GitHub: closed, as it was last known. */
        const goneAs = (k: Known, type: string, kind: string, externalId: string, state: Record<string, unknown>): SourceObservation => ({
          type, kind, key: k.key, name: k.name, sensitivity: 'ops', externalId, taintedPaths: k.taintedPaths, state, status: 'archived',
        });

        try {
          const metaUrl = `${GITHUB_API}${base}`;
          let branch = old.branches[full];
          {
            // Without a remembered default branch the repo is read whole, so the CI query has one.
            const etag = branch ? old.etags[metaUrl] : undefined;
            const res = await request(metaUrl, etag);
            if (res.status === 304 && etag) etags[metaUrl] = etag;
            else {
              if (!res.ok) throw fail(base, res.status);
              const m = Repo.safeParse(await res.json());
              if (!m.success) throw new Error(`GitHub ${base}: unexpected repo`);
              branch = m.data.default_branch;
              const e = res.headers.get('etag');
              if (e) etags[metaUrl] = e.slice(0, 200);
              found.push({ type: 'repo.meta', kind: 'repo', key: `repo:github:${full}`, name: full, sensitivity: 'ops', externalId: `repo:${full}`, state: { host: 'github', defaultBranch: clip(branch, 120) } });
            }
          }

          for (const kind of ['pull_request', 'issue'] as const) {
            const listed = await list(`${base}/${kind === 'pull_request' ? 'pulls' : 'issues'}?state=open&per_page=100`);
            if (listed === 'unchanged') continue;
            const open = new Set<string>();
            for (const raw of listed.items) {
              const it = Item.safeParse(raw);
              if (!it.success) continue;
              // The issues listing includes PRs; they are read from the pulls listing.
              if (kind === 'issue' && it.data.pull_request !== undefined) continue;
              const ob = issueLike(kind, it.data);
              found.push(ob);
              open.add(ob.key);
            }
            // A partial listing cannot say what closed.
            if (!listed.complete || !r.known) continue;
            for (const k of await r.known(kind)) {
              if (!k.key.startsWith(`${kind}:github:${full}#`) || open.has(k.key)) continue;
              const n = Number(k.key.slice(k.key.lastIndexOf('#') + 1));
              if (!Number.isInteger(n) || n <= 0) continue;
              const path = `${base}/${kind === 'pull_request' ? 'pulls' : 'issues'}/${n}`;
              const res = await request(`${GITHUB_API}${path}`);
              if (res.ok) {
                const it = Item.safeParse(await res.json());
                if (!it.success) throw new Error(`GitHub ${path}: unexpected item`);
                found.push(issueLike(kind, it.data));
              } else if (res.status === 404 || res.status === 410 || res.status === 301) {
                found.push(goneAs(k, `${kind}.state`, kind, `${kind}:${full}#${n}`, { ...k.state, state: 'closed' }));
              } else {
                throw fail(path, res.status);
              }
            }
          }

          if (branch) {
            const runsUrl = `${GITHUB_API}${base}/actions/runs?branch=${encodeURIComponent(branch)}&event=push&per_page=1`;
            const etag = old.etags[runsUrl];
            const runs = await request(runsUrl, etag);
            if (runs.status === 304 && etag) etags[runsUrl] = etag;
            else if (!runs.ok) throw fail(`${base}/actions/runs`, runs.status);
            const parsed = runs.status === 304 ? undefined : Runs.safeParse(await runs.json());
            if (parsed && !parsed.success) throw new Error(`GitHub ${base}/actions/runs: unexpected response`);
            const e = runs.headers.get('etag');
            if (parsed && e) etags[runsUrl] = e.slice(0, 200);
            const run = parsed?.data?.workflow_runs[0];
            if (run) {
              found.push({
                type: 'ci_run.state', kind: 'ci_run', key: `ci_run:github:${full}:latest`, name: `${full} CI`, sensitivity: 'ops', externalId: `ci_run:${full}:latest`,
                state: {
                  workflow: clip(run.name ?? 'ci', 120) || 'ci',
                  status: run.status === 'in_progress' || run.status === 'completed' ? run.status : 'queued',
                  conclusion: run.conclusion === null ? null : CONCLUSIONS.has(run.conclusion) ? run.conclusion : 'neutral',
                  ...(/^[0-9a-f]{40}$/.test(run.head_sha) ? { sha: run.head_sha } : {}),
                },
              });
            }
          }

          const milestones = await list(`${base}/milestones?state=open&per_page=100`);
          if (milestones !== 'unchanged') {
            const due = new Set<string>();
            for (const raw of milestones.items) {
              const m = Milestone.safeParse(raw);
              if (!m.success || !m.data.due_on || !/^\d{4}-\d{2}-\d{2}/.test(m.data.due_on)) continue;
              const key = `deadline:github:${full}:milestone:${m.data.number}`;
              due.add(key);
              found.push({
                type: 'deadline.due', kind: 'deadline', key, name: clip(m.data.title, 300) || `milestone ${m.data.number}`, sensitivity: 'ops',
                externalId: `milestone:${full}#${m.data.number}`, taintedPaths: ['name'], state: { dueOn: m.data.due_on.slice(0, 10), source: 'github' },
              });
            }
            if (milestones.complete && r.known) {
              for (const k of await r.known('deadline')) {
                if (!k.key.startsWith(`deadline:github:${full}:milestone:`) || due.has(k.key)) continue;
                found.push(goneAs(k, 'deadline.due', 'deadline', `milestone:${full}#${k.key.slice(k.key.lastIndexOf(':') + 1)}`, k.state));
              }
            }
          }

          observations.push(...found);
          Object.assign(next.etags, etags);
          if (branch) next.branches[full] = branch;
        } catch (err) {
          errors.push(`${full}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300));
          // Nothing of this repo from this run: its old ETags stand, so next run reads what this one could not.
          for (const [url, e] of Object.entries(old.etags)) if (ofRepo(url)) next.etags[url] = e;
          if (old.branches[full]) next.branches[full] = old.branches[full]!;
        }
      }
      if (errors.length === o.repos.length && o.repos.length > 0) throw new Error(errors.join('; ').slice(0, 500));
      return { observations, metrics: [], cursor: JSON.stringify(next), ...(errors.length ? { errors } : {}) };
    },
  };
}
