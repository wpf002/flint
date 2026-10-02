/**
 * The runtime's own heartbeat (Machine plan P2, exit criterion 1): one
 * RuntimeInstance row per process, its lastBeatAt moved every 30 seconds
 * independently of the job bus, and stopped (with why) on the way out. Uptime
 * is read back from these rows.
 */
import { randomBytes } from 'node:crypto';
import type { Db } from '../db.js';

export interface Instance {
  id: string;
  beat(): Promise<void>;
  stop(reason: string): Promise<void>;
}

export async function startInstance(db: Db, gitSha: string, now = new Date()): Promise<Instance> {
  const row = await db.runtimeInstance.create({
    data: { id: `ri${now.getTime().toString(36)}${randomBytes(4).toString('hex')}`, gitSha: /^([0-9a-f]{7,40}|dev)$/.test(gitSha) ? gitSha : 'dev', lastBeatAt: now },
  });
  return {
    id: row.id,
    beat: async () => void (await db.runtimeInstance.update({ where: { id: row.id }, data: { lastBeatAt: new Date() } })),
    stop: async (reason) => void (await db.runtimeInstance.update({ where: { id: row.id }, data: { stoppedAt: new Date(), stopReason: reason.slice(0, 200) } })),
  };
}

/**
 * The share of [from, to) some instance was up: each covers its start to its
 * last beat plus two minutes (a beat every 30 s; a longer gap is down time).
 * `excluded` windows (deploys) count neither way.
 */
export function uptime(
  beats: ReadonlyArray<{ startedAt: Date; lastBeatAt: Date }>,
  from: Date,
  to: Date,
  excluded: ReadonlyArray<{ start: Date; end: Date }> = [],
): number {
  const merge = (spans: Array<[number, number]>) => {
    const out: Array<[number, number]> = [];
    for (const [a, b] of spans.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0])) {
      const last = out[out.length - 1];
      if (last && a <= last[1]) last[1] = Math.max(last[1], b);
      else out.push([a, b]);
    }
    return out;
  };
  const clip = ([a, b]: [number, number]): [number, number] => [Math.max(a, from.getTime()), Math.min(b, to.getTime())];
  const length = (spans: Array<[number, number]>) => spans.reduce((t, [a, b]) => t + Math.max(0, b - a), 0);
  const ex = merge(excluded.map((w) => clip([w.start.getTime(), w.end.getTime()])));
  const up = merge(beats.map((b) => clip([b.startedAt.getTime(), b.lastBeatAt.getTime() + 120_000])));
  // Up time inside an excluded window does not count either.
  const upOutside = length(up) - length(merge(up.flatMap(([a, b]) => ex.map(([c, d]) => [Math.max(a, c), Math.min(b, d)] as [number, number]))));
  const span = to.getTime() - from.getTime() - length(ex);
  return span <= 0 ? 1 : Math.min(1, upOutside / span);
}
