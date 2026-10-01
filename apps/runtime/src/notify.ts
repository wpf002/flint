/** Tell Will something through the server's internal listener (a notification in the console). Best effort. */
import type { Config } from './config.js';

export async function notifyWill(config: Pick<Config, 'server'>, title: string, body: string): Promise<boolean> {
  if (!config.server) return false;
  try {
    const r = await fetch(`${config.server.url}/internal/notify`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.server.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ title: title.slice(0, 80), body: body.slice(0, 500) }),
      signal: AbortSignal.timeout(5000),
    });
    return r.ok;
  } catch {
    return false;
  }
}
