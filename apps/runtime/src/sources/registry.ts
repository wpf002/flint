/**
 * The sources and the only endpoints each may reach (plan P1, P6: a
 * self-modification PR may not touch this file). Local sources read files and
 * run fixed commands; `health` makes unauthenticated GETs to the listed URLs.
 */
import { join } from 'node:path';
import type { Config } from '../config.js';
import type { Endpoint } from '../policy/egress.js';
import type { Db } from '../db.js';
import { makeRun } from './exec.js';
import { launchdSource } from './launchd.js';
import { healthSource, type HealthTarget } from './health.js';
import { gitSource } from './git.js';
import { spendSource } from './spend.js';
import type { Source } from './types.js';

/** The loopback health endpoints. Flint listens on ::1 (apps/server/src/access.ts). */
export const LOCAL_HEALTH: readonly HealthTarget[] = [
  { name: 'flint-server', url: 'http://[::1]:8080/health' },
  { name: 'searxng', url: 'http://127.0.0.1:8888/healthz' },
  { name: 'ollama', url: 'http://127.0.0.1:11434/api/version' },
];

export interface Registered {
  source: Source;
  endpoints: Endpoint[];
}

export function registry(config: Config, db: Db): Registered[] {
  const run = makeRun(config.home);
  const health: HealthTarget[] = [...LOCAL_HEALTH, ...config.healthExtra];
  const endpointOf = (t: HealthTarget): Endpoint => {
    const u = new URL(t.url);
    return { origin: u.origin, pathPrefix: u.pathname, methods: ['GET'] };
  };
  const gh = join(config.home, 'Documents', 'GitHub');
  return [
    {
      source: launchdSource({ run, agentsDir: join(config.home, 'Library', 'LaunchAgents'), prefixes: ['com.flint.', 'com.nexus.', 'sh.brew.', 'homebrew.mxcl.'] }),
      endpoints: [],
    },
    {
      source: healthSource({ targets: health, dbPing: async () => void (await db.$queryRaw`SELECT 1`) }),
      endpoints: health.map(endpointOf),
    },
    {
      source: gitSource({
        run,
        repos: ['flint', 'nexus', 'trident', 'helm'].map((name) => ({ name, path: join(gh, name) })),
        deploy: { path: join(config.home, 'flint'), log: join(config.home, '.flint', 'deploy.out.log') },
      }),
      endpoints: [],
    },
    {
      source: spendSource({ dir: join(config.home, '.flint', 'spend'), evalCsv: join(config.home, '.flint', 'evolve', 'daily.csv'), caps: config.caps, tz: config.tz }),
      endpoints: [],
    },
  ];
}
