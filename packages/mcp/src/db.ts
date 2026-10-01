/**
 * The Postgres connection a connector queries through, from one env var, failing
 * closed.
 *
 * WHY. Each database connector (hive, bellwether, crossbar, vantage) fell back to a
 * hard-coded development URL with the password in the source (`postgres://hive:hive@
 * localhost:5436/hive`) when its env var was missing, and the repo is public. A
 * connector with no URL now connects to nothing: it still starts and lists its
 * tools, and every query fails saying which variable to set.
 */
import pg from 'pg';

export interface Db {
  /** Run a parameterized query; throws when the URL is not configured. */
  q<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Whether the env var was set. */
  configured: boolean;
}

export function dbFromEnv(envVar: string, env: Record<string, string | undefined> = process.env, opts: { max?: number } = {}): Db {
  const url = env[envVar]?.trim();
  if (!url) {
    console.error(`[db] ${envVar} is not set: this connector's tools will report it until it is`);
    return {
      configured: false,
      async q() {
        throw new Error(`${envVar} is not set, so this connector has no database`);
      },
    };
  }
  const pool = new pg.Pool({ connectionString: url, max: opts.max ?? 4 });
  return {
    configured: true,
    async q<T>(sql: string, params: unknown[] = []) {
      return (await pool.query(sql, params)).rows as T[];
    },
  };
}
