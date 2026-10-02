/**
 * railway: the latest deployment of every service in Will's Railway projects
 * (nexus, Prophet), every 10 minutes (Machine plan P1 sources).
 *
 *  - Auth: one Railway PROJECT token per project, sent as Project-Access-Token.
 *    A project token is NOT read-only (Railway has no read-only token): it can
 *    deploy and read the project's variables. What keeps this source read-only
 *    is the code: only the named queries below are ever sent, none of them is a
 *    mutation, assertReadOnly() refuses anything else before a request is
 *    made, and a test checks every query text. Will creates the tokens; until
 *    then this source cannot be enabled.
 *  - Entities are keyed by Railway's service id, so renaming a service (or its
 *    RAILWAY_TOKEN_<LABEL>) renames the entity instead of orphaning it.
 *  - Each project is all-or-nothing; a project that fails is reported and the
 *    others carry on. Services that are gone are archived, but only after a run
 *    in which every project answered.
 *  - Commit messages are written by whoever pushed: never stored (only the sha
 *    and status are).
 */
import { z } from 'zod';
import { clip } from './text.js';
import type { Source, SourceObservation, SourceRun, SyncResult } from './types.js';

export const RAILWAY_API = 'https://backboard.railway.com/graphql/v2';

/** The whole vocabulary this source speaks. */
export const RAILWAY_QUERIES = {
  project: `query FlintProject {
  projectToken { projectId environmentId }
}`,
  services: `query FlintServices($projectId: String!) {
  project(id: $projectId) { name services { edges { node { id name } } } }
}`,
  latestDeployment: `query FlintLatestDeployment($serviceId: String!, $environmentId: String!) {
  deployments(first: 1, input: { serviceId: $serviceId, environmentId: $environmentId }) {
    edges { node { id status createdAt meta } }
  }
}`,
} as const;

/** A query text must be one of the named, read-only queries above. */
export function assertReadOnly(query: string): void {
  if (!(Object.values(RAILWAY_QUERIES) as string[]).includes(query) || /\bmutation\b|\bsubscription\b/i.test(query)) {
    throw new Error('railway: only the named read-only queries may be sent');
  }
}

export interface RailwayOptions {
  /** project label -> project token (from runtime.env, RAILWAY_TOKEN_<LABEL>). */
  projects: Record<string, string>;
}

const STATUS: Record<string, 'building' | 'deploying' | 'success' | 'failed' | 'crashed' | 'removed' | 'unknown'> = {
  BUILDING: 'building', INITIALIZING: 'building', QUEUED: 'building', WAITING: 'building',
  DEPLOYING: 'deploying', SUCCESS: 'success', FAILED: 'failed', CRASHED: 'crashed', REMOVED: 'removed', REMOVING: 'removed', SLEEPING: 'success', SKIPPED: 'unknown',
};

const ProjectToken = z.object({ projectToken: z.object({ projectId: z.string().min(1).max(100), environmentId: z.string().min(1).max(100) }) });
const Services = z.object({ project: z.object({ services: z.object({ edges: z.array(z.object({ node: z.object({ id: z.string().min(1).max(100), name: z.string() }) })) }) }) });
const Deployments = z.object({
  deployments: z.object({ edges: z.array(z.object({ node: z.object({ status: z.string(), meta: z.object({ commitHash: z.string().optional() }).passthrough().nullable().optional() }) })) }),
});

export function railwaySource(o: RailwayOptions): Source & { endpoints: string[] } {
  return {
    name: 'railway',
    cadenceMs: 10 * 60_000,
    endpoints: [RAILWAY_API],
    async run(r: SourceRun): Promise<SyncResult> {
      const gql = async <T>(token: string, query: string, shape: z.ZodType<T>, variables: Record<string, string> = {}): Promise<T> => {
        assertReadOnly(query);
        const res = await r.fetch(RAILWAY_API, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'project-access-token': token },
          body: JSON.stringify({ query, variables }),
        });
        if (!res.ok) throw new Error(`Railway: HTTP ${res.status}`);
        const body = (await res.json().catch(() => ({}))) as { data?: unknown; errors?: Array<{ message?: unknown }> };
        if (body.errors?.length || !body.data) throw new Error(`Railway: ${typeof body.errors?.[0]?.message === 'string' ? body.errors[0].message.slice(0, 200) : 'no data'}`);
        const parsed = shape.safeParse(body.data);
        if (!parsed.success) throw new Error('Railway: unexpected response');
        return parsed.data;
      };
      const observations: SourceObservation[] = [];
      const errors: string[] = [];
      const seen = new Set<string>();
      for (const [label, token] of Object.entries(o.projects)) {
        const found: SourceObservation[] = [];
        try {
          const { projectToken } = await gql(token, RAILWAY_QUERIES.project, ProjectToken);
          const { project } = await gql(token, RAILWAY_QUERIES.services, Services, { projectId: projectToken.projectId });
          for (const { node: svc } of project.services.edges) {
            const name = `${clip(label, 40)}/${clip(svc.name, 80)}`;
            found.push({
              type: 'service.railway', kind: 'service', key: `service:railway:${svc.id}`, name, sensitivity: 'ops',
              externalId: `railway:service:${svc.id}`, state: { managedBy: 'railway' },
            });
            const d = await gql(token, RAILWAY_QUERIES.latestDeployment, Deployments, { serviceId: svc.id, environmentId: projectToken.environmentId });
            const dep = d.deployments.edges[0]?.node;
            if (!dep) continue;
            const sha = dep.meta?.commitHash && /^[0-9a-f]{7,64}$/.test(dep.meta.commitHash) ? dep.meta.commitHash : undefined;
            found.push({
              type: 'deployment.railway', kind: 'deployment', key: `deployment:railway:${svc.id}`, name: `${name} deploy`, sensitivity: 'ops',
              externalId: `railway:deployment-of:${svc.id}`,
              state: { target: 'railway', status: STATUS[dep.status] ?? 'unknown', ...(sha ? { sha } : {}) },
            });
          }
          observations.push(...found);
          for (const f of found) seen.add(f.key);
        } catch (err) {
          errors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300));
        }
      }
      // Gone from Railway: archived as last known, once every project has answered.
      if (!errors.length && r.known) {
        for (const kind of ['service', 'deployment'] as const) {
          for (const k of await r.known(kind)) {
            if (!k.key.startsWith(`${kind}:railway:`) || seen.has(k.key)) continue;
            const id = k.key.slice(`${kind}:railway:`.length);
            observations.push({
              type: `${kind}.railway`, kind, key: k.key, name: k.name, sensitivity: 'ops', taintedPaths: k.taintedPaths,
              externalId: kind === 'service' ? `railway:service:${id}` : `railway:deployment-of:${id}`,
              state: kind === 'deployment' ? { ...k.state, status: 'removed' } : k.state, status: 'archived',
            });
          }
        }
      }
      const total = Object.keys(o.projects).length;
      if (total > 0 && errors.length === total) throw new Error(errors.join('; ').slice(0, 500));
      return { observations, metrics: [], ...(errors.length ? { errors } : {}) };
    },
  };
}
