/**
 * The scoped clients' tokens on disk (./access SCOPED_CLIENTS): ~/.flint/tokens,
 * dir 0700, one <name>.token per client, 0600, 32 random bytes as hex. Made when
 * missing, never rotated here (delete a file and restart to rotate that token).
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SCOPED_CLIENTS, type Scope } from './access';

export function ensureScopedTokens(dir: string): Array<{ name: string; token: string; scope: Exclude<Scope, 'full'> }> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return SCOPED_CLIENTS.map(({ name, scope }) => {
    const file = join(dir, `${name}.token`);
    // Missing, empty or cut short (a half-written file): a fresh one. A blank token
    // would leave this client's scope silently off while it fell back to FLINT_TOKEN.
    const current = existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
    if (!/^[0-9a-f]{64}$/.test(current)) writeFileSync(file, `${randomBytes(32).toString('hex')}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
    return { name, scope, token: readFileSync(file, 'utf8').trim() };
  });
}
