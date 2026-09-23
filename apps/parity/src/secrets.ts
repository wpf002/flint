import { existsSync, readFileSync } from 'node:fs';

/**
 * Parse a KEY=value file exactly the way the server's loadSecrets does
 * (apps/server/src/index.ts): `#` comments, blank lines skipped, one layer of
 * matching quotes stripped. Returns the pairs; never logs values.
 */
export function parseSecrets(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (k) out[k] = v;
  }
  return out;
}

/** Fill `env` from the secrets file without overriding anything already set. */
export function loadSecretsInto(path: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!existsSync(path)) return;
  for (const [k, v] of Object.entries(parseSecrets(readFileSync(path, 'utf8')))) {
    if (env[k] === undefined) env[k] = v;
  }
}
