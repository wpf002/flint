/**
 * launchd: which of Will's LaunchAgents are loaded, running, and how each last
 * exited (`launchctl list`, every 2 minutes). Periodic jobs (StartInterval,
 * StartCalendarInterval) run for seconds at a time, so whether one happens to be
 * running is noise, not state: it is left out for them.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Run } from './exec.js';
import type { Source, SourceObservation } from './types.js';

export interface LaunchdOptions {
  run: Run;
  agentsDir: string;
  /** Label prefixes that are Will's services. */
  prefixes: readonly string[];
}

interface Listed {
  pid: number | null;
  status: number | null;
}

export function parseLaunchctlList(out: string): Map<string, Listed> {
  const m = new Map<string, Listed>();
  for (const line of out.split('\n').slice(1)) {
    const [pid, status, label] = line.split('\t');
    if (!label) continue;
    m.set(label.trim(), {
      pid: pid && pid !== '-' ? Number(pid) : null,
      status: status && status !== '-' && Number.isFinite(Number(status)) ? Math.max(-255, Math.min(255, Number(status))) : null,
    });
  }
  return m;
}

/** Labels `launchctl print-disabled` lists as disabled: put away on purpose (`launchctl disable`). */
export function parsePrintDisabled(out: string): Set<string> {
  const off = new Set<string>();
  for (const m of out.matchAll(/^\s*"([^"]{1,200})"\s*=>\s*(disabled|true)\s*$/gm)) off.add(m[1]!);
  return off;
}

export function launchdSource(o: LaunchdOptions): Source {
  const ours = (label: string) => o.prefixes.some((p) => label.startsWith(p));
  return {
    name: 'launchd',
    cadenceMs: 2 * 60_000,
    async run() {
      const listed = parseLaunchctlList(await o.run('/bin/launchctl', ['list']));
      // Disabled with `launchctl disable` (the plist may say nothing): put away, not failed.
      const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
      const off = uid === undefined ? new Set<string>() : await o.run('/bin/launchctl', ['print-disabled', `gui/${uid}`]).then(parsePrintDisabled, () => new Set<string>());
      const plists = new Map<string, { periodic: boolean; disabled: boolean }>();
      for (const f of readdirSync(o.agentsDir).filter((f) => f.endsWith('.plist'))) {
        const label = f.slice(0, -'.plist'.length);
        if (!ours(label)) continue;
        try {
          const j = JSON.parse(await o.run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(o.agentsDir, f)])) as Record<string, unknown>;
          plists.set(label, { periodic: 'StartInterval' in j || 'StartCalendarInterval' in j, disabled: j.Disabled === true || off.has(label) });
        } catch {
          plists.set(label, { periodic: false, disabled: off.has(label) });
        }
      }
      const labels = new Set([...[...listed.keys()].filter(ours), ...plists.keys()]);
      const observations: SourceObservation[] = [...labels].sort().map((label) => {
        const l = listed.get(label);
        const p = plists.get(label);
        return {
          type: 'service.status',
          kind: 'service',
          key: `service:launchd:${label}`,
          name: label,
          sensitivity: 'ops',
          externalId: label,
          state: {
            managedBy: 'launchd',
            loaded: !!l,
            ...(p?.periodic ? {} : { running: !!l?.pid }),
            lastExit: l?.status ?? null,
            ...(p?.disabled ? { disabled: true } : {}),
          },
        };
      });
      return { observations, metrics: [] };
    },
  };
}
