/**
 * health: unauthenticated GETs to each service's health endpoint every 5
 * minutes. The verdict (ok, degraded, down) is state; the latency is a metric,
 * so a quiet day creates no versions.
 */
import type { Source, SourceObservation, MetricObservation } from './types.js';

export interface HealthTarget {
  name: string;
  url: string;
}

export interface HealthOptions {
  targets: readonly HealthTarget[];
  /** Postgres is checked through the runtime's own connection. */
  dbPing?: () => Promise<void>;
  slowMs?: number;
}

export function verdict(status: number | 'error', ms: number, slowMs: number): 'ok' | 'degraded' | 'down' {
  if (status === 'error' || status >= 500) return 'down';
  if (status >= 300 || ms > slowMs) return 'degraded';
  return 'ok';
}

export function healthSource(o: HealthOptions): Source {
  const slow = o.slowMs ?? 2000;
  return {
    name: 'health',
    cadenceMs: 5 * 60_000,
    async run({ fetch, now }) {
      const observations: SourceObservation[] = [];
      const metrics: MetricObservation[] = [];
      const record = (name: string, health: 'ok' | 'degraded' | 'down', ms: number | null) => {
        const key = `service:endpoint:${name}`;
        observations.push({ type: 'service.health', kind: 'service', key, name, sensitivity: 'ops', externalId: name, state: { managedBy: 'other', health } });
        if (ms !== null) {
          metrics.push({
            series: { key: `health.${name}.latency_ms`, unit: 'ms', freq: 'raw', sensitivity: 'ops', description: `${name} health check latency`, entityKey: { kind: 'service', key } },
            at: now,
            value: ms,
          });
        }
      };
      await Promise.all(
        o.targets.map(async (t) => {
          const t0 = performance.now();
          let status: number | 'error';
          try {
            const r = await fetch(t.url);
            await r.body?.cancel().catch(() => {});
            status = r.status;
          } catch {
            status = 'error';
          }
          const ms = Math.round(performance.now() - t0);
          record(t.name, verdict(status, ms, slow), status === 'error' ? null : ms);
        }),
      );
      if (o.dbPing) {
        const t0 = performance.now();
        let ok = true;
        try {
          await o.dbPing();
        } catch {
          ok = false;
        }
        const ms = Math.round(performance.now() - t0);
        record('postgres', ok ? verdict(200, ms, slow) : 'down', ok ? ms : null);
      }
      observations.sort((a, b) => a.key.localeCompare(b.key));
      return { observations, metrics };
    },
  };
}
