/**
 * The runtime's configuration: the ONLY place in apps/runtime/src that reads
 * process.env (a forbidden-APIs test enforces it). Validated once at startup,
 * and never logged: the database URL carries a password.
 */
import { z } from 'zod';

const Env = z.object({
  DATABASE_URL: z.string().url().refine((u) => /^postgres(ql)?:/.test(u), 'must be a postgres URL'),
  /** Loopback only (plan 3.0.1); ::1 for the same reason as the server (access.ts). */
  RUNTIME_HOST: z.enum(['::1', '127.0.0.1', 'localhost']).default('::1'),
  RUNTIME_PORT: z.coerce.number().int().min(1024).max(65535).default(8090),
  /** sha256 hex of the server's RUNTIME_TOKEN; the runtime never holds the token itself. */
  RUNTIME_TOKEN_SHA256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  FLINT_TZ: z.string().default('America/New_York'),
});

export type Config = z.infer<typeof Env>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const r = Env.safeParse(env);
  if (!r.success) {
    // Names and reasons only: a value here may be a secret.
    const why = r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`runtime config is invalid: ${why}`);
  }
  return r.data;
}
