/**
 * The runtime's configuration: the ONLY place in apps/runtime/src that reads
 * process.env (a forbidden-APIs test enforces it). Validated once at startup,
 * and never logged: the database URL carries a password.
 *
 * runtime.env (0600) holds no vendor keys and no FLINT_TOKEN (plan 3.0.2): only
 * the database URL, the digests of the tokens allowed to call the runtime, and
 * the passkey relying-party settings it re-verifies approvals against.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { zoneFrom } from '@flint/policy';

export const SCOPES = ['events', 'audit', 'proposals', 'world:read', 'ledger', 'mcp', 'counters'] as const;
export type RuntimeScope = (typeof SCOPES)[number];

export interface TokenGrant {
  name: string;
  /** sha256 hex of the bearer token; the runtime never holds the token itself. */
  sha256: string;
  scopes: ReadonlySet<RuntimeScope>;
}

/**
 * RUNTIME_TOKENS: `name:sha256:scope|scope,name2:sha256:...`, for example
 * `server:9f86d0...:events|audit|proposals|world:read|ledger|counters`. Each
 * caller gets only the scopes it needs.
 */
export function parseTokens(raw: string | undefined): TokenGrant[] {
  if (!raw?.trim()) return [];
  const seen = new Set<string>();
  return raw.split(',').map((entry, i) => {
    // Scopes contain a colon (world:read), so the name and digest come off the front.
    const m = entry.trim().match(/^([a-z][a-z0-9_-]{0,31}):([0-9a-f]{64}):([a-z:|]+)$/);
    if (!m) throw new Error(`RUNTIME_TOKENS entry ${i + 1} is malformed`);
    const [, name, sha256, scopeList] = m as unknown as [string, string, string, string];
    if (seen.has(name)) throw new Error(`RUNTIME_TOKENS names ${name} twice`);
    seen.add(name);
    const list = scopeList.split('|');
    for (const s of list) {
      if (!(SCOPES as readonly string[]).includes(s)) throw new Error(`RUNTIME_TOKENS entry ${name}: unknown scope ${s}`);
    }
    return { name, sha256, scopes: new Set(list as RuntimeScope[]) };
  });
}

const Env = z.object({
  DATABASE_URL: z.string().url().refine((u) => /^postgres(ql)?:/.test(u), 'must be a postgres URL'),
  /** Loopback only (plan 3.0.1); ::1 for the same reason as the server (apps/server/src/access.ts). */
  RUNTIME_HOST: z.enum(['::1', '127.0.0.1', 'localhost']).default('::1'),
  RUNTIME_PORT: z.coerce.number().int().min(1024).max(65535).default(8090),
  RUNTIME_TOKENS: z.string().optional(),
  /** The passkey relying party: the tailnet host name, and the console's exact origins (comma-separated). */
  FLINT_RP_ID: z.string().regex(/^[a-z0-9.-]+$/).optional(),
  FLINT_RP_ORIGINS: z.string().optional(),
  /** Calendar days for daily caps. */
  FLINT_TZ: z.string().optional(),
  /** The server's zone variable; the runtime's days and months must match the server's. */
  FLINT_USER_TZ: z.string().optional(),
  HOME: z.string().min(1),
  /** The server's internal listener and the runtime's token for it (notify, spend-external). */
  SERVER_INTERNAL_URL: z.string().regex(/^http:\/\/(\[::1\]|127\.0\.0\.1|localhost):\d+$/).optional(),
  SERVER_INTERNAL_TOKEN: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  /** The GitHub App flint-observer (Will creates it): id, installation and the private key's path. */
  GITHUB_APP_ID: z.string().regex(/^\d{1,12}$/).optional(),
  GITHUB_APP_INSTALLATION_ID: z.string().regex(/^\d{1,15}$/).optional(),
  GITHUB_APP_KEY_PATH: z.string().optional(),
  GITHUB_OWNER: z.string().regex(/^[A-Za-z0-9-]{1,39}$/).default('wpf002'),
  /** Nexus, for the nexus source: a namespace token (Nexus has no scopes yet); the source only reads. */
  NEXUS_MCP_URL: z.string().url().refine((u) => u.startsWith('https://'), 'must be https').optional(),
  NEXUS_READ_TOKEN: z.string().min(16).optional(),
  /** Health endpoints off the box: `name=https://host/path,...` (Railway services). */
  HEALTH_EXTRA: z.string().optional(),
  /**
   * Triage (P2): `on` to run it; anything else, blank included, is off (the
   * sources keep running). Off by default: it is turned on, in
   * runtime.override.env, once the chat baseline it is measured against exists.
   */
  FLINT_RUNTIME_TRIAGE: z.string().optional(),
  /** The local model triage asks (Ollama), on loopback only. */
  OLLAMA_URL: z.string().regex(/^http:\/\/(\[::1\]|127\.0\.0\.1|localhost):\d+$/).optional(),
  FLINT_TRIAGE_MODEL: z.string().regex(/^[A-Za-z0-9._:/-]{1,80}$/).optional(),
  /** The server's num_ctx: a different one makes Ollama reload the model chat is using. */
  OLLAMA_NUM_CTX: z.coerce.number().int().min(512).max(262_144).optional(),
  /** The deployed commit (install-runtime.sh writes it). */
  RUNTIME_GIT_SHA: z.string().optional(),
  FLINT_BUDGET_ANTHROPIC_DAILY_USD: z.coerce.number().nonnegative().optional(),
  FLINT_BUDGET_ANTHROPIC_MONTHLY_USD: z.coerce.number().nonnegative().optional(),
  FLINT_BUDGET_OPENAI_DAILY_USD: z.coerce.number().nonnegative().optional(),
  FLINT_BUDGET_OPENAI_MONTHLY_USD: z.coerce.number().nonnegative().optional(),
  FLINT_BUDGET_PERPLEXITY_DAILY_USD: z.coerce.number().nonnegative().optional(),
  FLINT_BUDGET_PERPLEXITY_MONTHLY_USD: z.coerce.number().nonnegative().optional(),
  FLINT_BUDGET_TAVILY_DAILY_USD: z.coerce.number().nonnegative().optional(),
  FLINT_BUDGET_TAVILY_MONTHLY_USD: z.coerce.number().nonnegative().optional(),
});

export interface Config {
  databaseUrl: string;
  host: string;
  port: number;
  tokens: TokenGrant[];
  rp?: { rpId: string; origins: string[] };
  tz: string;
  home: string;
  healthExtra: Array<{ name: string; url: string }>;
  server?: { url: string; token: string };
  github?: { appId: string; installationId: string; keyPath: string; owner: string };
  railway: Record<string, string>;
  nexus?: { url: string; token: string };
  caps: Record<'anthropic' | 'openai' | 'perplexity' | 'tavily', { dailyUsd?: number; monthlyUsd?: number }>;
  /** P2 triage runs (else the sources run and nothing is triaged). */
  triage: boolean;
  /** The local model triage asks; absent, triage is rules only. */
  ollama?: { url: string; model: string; numCtx?: number };
  gitSha: string;
}

/** `name=https://host/path` pairs; https only, no credentials in the URL. */
export function parseHealthExtra(raw: string | undefined): Array<{ name: string; url: string }> {
  if (!raw?.trim()) return [];
  return raw.split(',').map((pair, i) => {
    const m = pair.trim().match(/^([a-z0-9][a-z0-9_-]{0,40})=(https:\/\/[^\s,]+)$/);
    if (!m) throw new Error(`HEALTH_EXTRA entry ${i + 1} must be name=https://...`);
    const u = new URL(m[2]!);
    if (u.username || u.password || u.search) throw new Error(`HEALTH_EXTRA entry ${m[1]} must not carry credentials or a query`);
    return { name: m[1]!, url: u.toString() };
  });
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const r = Env.safeParse(env);
  if (!r.success) {
    // Names and reasons only: a value here may be a secret.
    const why = r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`runtime config is invalid: ${why}`);
  }
  const e = r.data;
  let tokens: TokenGrant[];
  let healthExtra: Array<{ name: string; url: string }>;
  try {
    tokens = parseTokens(e.RUNTIME_TOKENS);
    healthExtra = parseHealthExtra(e.HEALTH_EXTRA);
  } catch (err) {
    throw new Error(`runtime config is invalid: ${(err as Error).message}`);
  }
  const cap = (d?: number, m?: number) => ({ ...(d !== undefined ? { dailyUsd: d } : {}), ...(m !== undefined ? { monthlyUsd: m } : {}) });
  const origins = (e.FLINT_RP_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean);
  if (origins.some((o) => !/^https:\/\/[a-z0-9.-]+(:\d+)?$/.test(o))) throw new Error('runtime config is invalid: FLINT_RP_ORIGINS must be https origins');
  return {
    databaseUrl: e.DATABASE_URL,
    host: e.RUNTIME_HOST,
    port: e.RUNTIME_PORT,
    tokens,
    ...(e.FLINT_RP_ID && origins.length ? { rp: { rpId: e.FLINT_RP_ID, origins } } : {}),
    tz: zoneFrom(e.FLINT_TZ, e.FLINT_USER_TZ),
    home: e.HOME,
    ...(e.SERVER_INTERNAL_URL && e.SERVER_INTERNAL_TOKEN ? { server: { url: e.SERVER_INTERNAL_URL, token: e.SERVER_INTERNAL_TOKEN } } : {}),
    ...(e.GITHUB_APP_ID && e.GITHUB_APP_INSTALLATION_ID && e.GITHUB_APP_KEY_PATH
      ? { github: { appId: e.GITHUB_APP_ID, installationId: e.GITHUB_APP_INSTALLATION_ID, keyPath: e.GITHUB_APP_KEY_PATH, owner: e.GITHUB_OWNER } }
      : {}),
    // RAILWAY_TOKEN_<PROJECT>: one project token per Railway project.
    railway: Object.fromEntries(
      Object.entries(env)
        .filter(([k, v]) => /^RAILWAY_TOKEN_[A-Z0-9_]{1,40}$/.test(k) && typeof v === 'string' && /^[A-Za-z0-9-]{16,200}$/.test(v))
        .map(([k, v]) => [k.slice('RAILWAY_TOKEN_'.length).toLowerCase(), v as string]),
    ),
    ...(e.NEXUS_MCP_URL && e.NEXUS_READ_TOKEN ? { nexus: { url: e.NEXUS_MCP_URL, token: e.NEXUS_READ_TOKEN } } : {}),
    healthExtra,
    caps: {
      anthropic: cap(e.FLINT_BUDGET_ANTHROPIC_DAILY_USD, e.FLINT_BUDGET_ANTHROPIC_MONTHLY_USD),
      openai: cap(e.FLINT_BUDGET_OPENAI_DAILY_USD, e.FLINT_BUDGET_OPENAI_MONTHLY_USD),
      perplexity: cap(e.FLINT_BUDGET_PERPLEXITY_DAILY_USD, e.FLINT_BUDGET_PERPLEXITY_MONTHLY_USD),
      tavily: cap(e.FLINT_BUDGET_TAVILY_DAILY_USD, e.FLINT_BUDGET_TAVILY_MONTHLY_USD),
    },
    triage: e.FLINT_RUNTIME_TRIAGE?.trim().toLowerCase() === 'on',
    ...(e.FLINT_TRIAGE_MODEL
      ? { ollama: { url: e.OLLAMA_URL ?? 'http://127.0.0.1:11434', model: e.FLINT_TRIAGE_MODEL, ...(e.OLLAMA_NUM_CTX ? { numCtx: e.OLLAMA_NUM_CTX } : {}) } }
      : {}),
    gitSha: e.RUNTIME_GIT_SHA && /^[0-9a-f]{40}$/.test(e.RUNTIME_GIT_SHA) ? e.RUNTIME_GIT_SHA : 'dev',
  };
}

/**
 * The environment the runtime starts with: runtime.env (0600, refused if group-
 * or world-readable), then the process environment on top. launchd cannot read
 * an env file itself, and the file keeps the database password out of the plist.
 */
export function runtimeEnv(file: string, base: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
  if (!existsSync(file)) return { ...base };
  const mode = statSync(file).mode & 0o777;
  if (mode & 0o077) throw new Error(`${file} must be readable only by its owner (chmod 600)`);
  const out: Record<string, string | undefined> = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^(?:export\s+)?([A-Z][A-Z0-9_]*)=(.*)$/);
    if (m) out[m[1]!] = m[2]!.trim().replace(/^(["'])(.*)\1$/, '$2');
  }
  return { ...out, ...base };
}

/**
 * The config the service runs with: ~/.flint/runtime.env (or RUNTIME_ENV_FILE),
 * then ~/.flint/runtime.override.env (Will's settings, e.g. FLINT_RUNTIME_TRIAGE;
 * every deploy rewrites runtime.env, never this), then the process environment.
 * Both files must be readable only by their owner.
 */
export function loadRuntimeConfig(): Config {
  const home = process.env.HOME ?? '';
  const file = process.env.RUNTIME_ENV_FILE ?? join(home, '.flint', 'runtime.env');
  const override = join(home, '.flint', 'runtime.override.env');
  return loadConfig({ ...runtimeEnv(file, {}), ...runtimeEnv(override, {}), ...process.env });
}

/**
 * What the backup CLI needs beyond the service's config, from ~/.flint/backup.env
 * (0600): the read-only dump role (flint_backup) and flint_restore, a role that
 * can only create databases, for the scratch restore. Never the owner.
 */
export interface BackupConfig {
  config: Config;
  backupUrl: string;
  restoreUrl: string;
  ageRecipient?: string;
  dumpDir: string;
  offsiteDir?: string;
  tools: { pgDump: string; pgRestore: string; age?: string };
}

export function loadBackupConfig(): BackupConfig {
  const home = process.env.HOME ?? '';
  const env = runtimeEnv(process.env.RUNTIME_ENV_FILE ?? join(home, '.flint', 'runtime.env'));
  const backupEnv = runtimeEnv(process.env.BACKUP_ENV_FILE ?? join(home, '.flint', 'backup.env'), {});
  const config = loadConfig(env);
  const B = z
    .object({
      FLINT_DB_BACKUP_URL: z.string().url(),
      FLINT_DB_RESTORE_URL: z.string().url(),
      FLINT_BACKUP_AGE_RECIPIENT: z.string().optional(),
      FLINT_OFFSITE_DIR: z.string().optional(),
    })
    .safeParse({ ...backupEnv, ...process.env });
  if (!B.success) throw new Error(`backup config is invalid: ${B.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  const bin = (name: string) => ['/opt/homebrew/opt/postgresql@17/bin', '/opt/homebrew/bin', '/usr/local/bin'].map((d) => join(d, name)).find((p) => existsSync(p));
  const pgDump = bin('pg_dump');
  const pgRestore = bin('pg_restore');
  if (!pgDump || !pgRestore) throw new Error('pg_dump/pg_restore not found (brew install postgresql@17)');
  const age = bin('age');
  let recipient = B.data.FLINT_BACKUP_AGE_RECIPIENT?.trim();
  const recipientFile = join(home, '.flint', 'backup-age-recipient');
  if (!recipient && existsSync(recipientFile)) recipient = readFileSync(recipientFile, 'utf8').trim().split('\n')[0];
  return {
    config,
    backupUrl: B.data.FLINT_DB_BACKUP_URL,
    restoreUrl: B.data.FLINT_DB_RESTORE_URL,
    ...(recipient ? { ageRecipient: recipient } : {}),
    dumpDir: join(home, 'FlintBackups', 'pg'),
    ...(B.data.FLINT_OFFSITE_DIR ? { offsiteDir: B.data.FLINT_OFFSITE_DIR } : {}),
    tools: { pgDump, pgRestore, ...(age ? { age } : {}) },
  };
}

/**
 * The crash harness's fault point (test/p2-crash.test.ts): the process kills
 * itself (SIGKILL, as `kill -9` would) on reaching the named point. Read only
 * here, and only when NODE_ENV is `test`: a deployed runtime never has one.
 */
export type FaultPoint = 'after_event' | 'after_decision' | 'after_notify';
export function faultAt(point: FaultPoint): void {
  if (process.env.NODE_ENV === 'test' && process.env.FLINT_TEST_FAULT === point) process.kill(process.pid, 'SIGKILL');
}
