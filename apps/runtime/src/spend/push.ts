/**
 * The unified spend view (plan 3.0.8), pushed to the server after each spend
 * sync (POST /internal/spend-external). The server holds background calls to
 * 70% of Flint's cap on this view and refuses when it is missing or over two
 * hours old, so without this push every metered background call is refused.
 *
 * What it carries is Flint's own ledger, per vendor, today and this month,
 * marked as an estimate: other accounts' spend on the same vendor is not
 * known here yet, so the view errs low only by what Flint cannot see.
 */
import type { Config } from '../config.js';
import { scopedFetch } from '../policy/egress.js';
import { ledgerTotals, VENDORS } from '../sources/spend.js';
import { join } from 'node:path';

export async function pushSpend(config: Pick<Config, 'server' | 'home' | 'tz'>, now = new Date(), base: typeof fetch = fetch): Promise<'pushed' | 'skipped' | 'failed'> {
  if (!config.server) return 'skipped';
  const t = ledgerTotals(join(config.home, '.flint', 'spend'), config.tz, now);
  const round = (n: number) => Math.round(n * 1e6) / 1e6;
  const body = { asOf: now.toISOString(), vendors: Object.fromEntries(VENDORS.map((v) => [v, { dayUsd: round(t[v].day), monthUsd: round(t[v].month), estimate: true }])) };
  const origin = new URL(config.server.url).origin;
  const post = scopedFetch([{ origin, pathPrefix: '/internal/spend-external', methods: ['POST'] }], base, 5_000);
  try {
    const res = await post(`${origin}/internal/spend-external`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.server.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    await res.body?.cancel().catch(() => {});
    return res.ok ? 'pushed' : 'failed';
  } catch {
    return 'failed';
  }
}
