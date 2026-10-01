/**
 * railway: the latest deployment of every service in Will's Railway projects
 * (nexus, Prophet), every 10 minutes (Machine plan P1 sources).
 *
 *  - Auth: one Railway PROJECT token per project (read access to that project
 *    only), sent as Project-Access-Token. Will creates them; until then this
 *    source cannot be enabled.
 *  - Only the named queries below are ever sent, and none of them is a
 *    mutation: assertReadOnly() refuses anything else before a request is made,
 *    and a test checks every query text.
 *  - Commit messages are written by whoever pushed: tainted, and never stored
 *    in state (only the sha and status are).
 */
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

export function railwaySource(o: RailwayOptions): Source & { endpoints: string[] } {
  return {
    name: 'railway',
    cadenceMs: 10 * 60_000,
    endpoints: [RAILWAY_API],
    async run(r: SourceRun): Promise<SyncResult> {
      const gql = async <T>(token: string, query: string, variables: Record<string, string> = {}): Promise<T> => {
        assertReadOnly(query);
        const res = await r.fetch(RAILWAY_API, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'project-access-token': token },
          body: JSON.stringify({ query, variables }),
        });
        if (!res.ok) throw new Error(`Railway: HTTP ${res.status}`);
        const body = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
        if (body.errors?.length || !body.data) throw new Error(`Railway: ${body.errors?.[0]?.message.slice(0, 200) ?? 'no data'}`);
        return body.data;
      };
      const observations: SourceObservation[] = [];
      for (const [label, token] of Object.entries(o.projects)) {
        const { projectToken } = await gql<{ projectToken: { projectId: string; environmentId: string } }>(token, RAILWAY_QUERIES.project);
        const { project } = await gql<{ project: { name: string; services: { edges: Array<{ node: { id: string; name: string } }> } } }>(token, RAILWAY_QUERIES.services, { projectId: projectToken.projectId });
        for (const { node: svc } of project.services.edges) {
          const svcName = svc.name.slice(0, 80);
          observations.push({
            type: 'service.railway', kind: 'service', key: `service:railway:${label}:${svcName}`, name: `${label}/${svcName}`, sensitivity: 'ops',
            externalId: `railway:service:${svc.id}`, state: { managedBy: 'railway' },
          });
          const d = await gql<{ deployments: { edges: Array<{ node: { id: string; status: string; createdAt: string; meta: { commitHash?: string } | null } }> } }>(
            token, RAILWAY_QUERIES.latestDeployment, { serviceId: svc.id, environmentId: projectToken.environmentId },
          );
          const dep = d.deployments.edges[0]?.node;
          if (!dep) continue;
          const sha = dep.meta?.commitHash && /^[0-9a-f]{7,64}$/.test(dep.meta.commitHash) ? dep.meta.commitHash : undefined;
          observations.push({
            type: 'deployment.railway', kind: 'deployment', key: `deployment:railway:${label}:${svcName}`, name: `${label}/${svcName} deploy`, sensitivity: 'ops',
            externalId: `railway:deployment-of:${svc.id}`,
            state: { target: 'railway', status: STATUS[dep.status] ?? 'unknown', ...(sha ? { sha } : {}) },
          });
        }
      }
      return { observations, metrics: [] };
    },
  };
}
