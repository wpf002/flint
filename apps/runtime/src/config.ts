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
import { isAbsolute, join, normalize } from 'node:path';
import { z } from 'zod';
import { zoneFrom } from '@flint/policy';

/**
 * `calendar:push` (P2.6) opens one route, the Apple Calendar snapshot, and
 * nothing else: Flint Calendar's token can file a snapshot and read nothing.
 */
export const SCOPES = ['events', 'audit', 'proposals', 'world:read', 'ledger', 'mcp', 'counters', 'calendar:push'] as const;
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
   * Will's calendar (P2.5): `on` registers the google_calendar source, which
   * reads ~/.flint/google (the OAuth client Will downloaded, and the token
   * `google-login` wrote). Anything else, blank included, is off. Turning it on
   * still needs an approved world.source.enable.
   */
  FLINT_SOURCE_GOOGLE_CALENDAR: z.string().optional(),
  /**
   * Will's Apple Calendar (P2.6): `on` registers the apple_calendar source,
   * which takes the snapshots Flint Calendar (apps/desktop-calendar) pushes to
   * POST /v1/sources/apple_calendar/snapshot. Anything else, blank included, is
   * off, and that route answers 404. Turning it on still needs an approved
   * world.source.enable.
   */
  FLINT_SOURCE_APPLE_CALENDAR: z.string().optional(),
  /**
   * Triage (P2): `on` to run it; anything else, blank included, is off (the
   * sources keep running). Off by default: it is turned on, in
   * runtime.override.env, once the chat baseline it is measured against exists.
   */
  FLINT_RUNTIME_TRIAGE: z.string().optional(),
  /**
   * Goal reviews (P3): `on` to run the planner (the review tick, each goal's
   * review and its local-model plan stage); anything else, blank included, is
   * off, and then nothing is scheduled. Off by default: it is turned on, in
   * runtime.override.env, with Will's OK. Turning it off is its rollback.
   */
  FLINT_PLANNER: z.string().optional(),
  /**
   * Predictions (P4): `on` to run Flint's prediction jobs; anything else, blank
   * included, is off, and nothing is forecast, resolved or scored. Off by
   * default, like triage. On is not enough: nothing is forecast until Will also
   * signs the Turn On Predictions card, which the database enforces.
   */
  FLINT_PREDICT: z.string().optional(),
  /**
   * Assets and tasks (P5): a kill switch, for rolling back. `off` stops them:
   * the task jobs are not scheduled and every task or asset card is refused with
   * a sentence. Anything else, blank included, leaves them as Will set them in
   * the console: an asset does nothing until he signs the card that turns it on.
   */
  FLINT_ASSETS: z.string().optional(),
  /** The local model triage and goal reviews ask (Ollama), on loopback only. */
  OLLAMA_URL: z.string().regex(/^http:\/\/(\[::1\]|127\.0\.0\.1|localhost):\d+$/).optional(),
  FLINT_TRIAGE_MODEL: z.string().regex(/^[A-Za-z0-9._:/-]{1,80}$/).optional(),
  /**
   * The standby model chat falls back to while the main one is not answering
   * (the server's setting of the same name, which comes with local inference;
   * install-runtime.sh copies it here when the server's settings name one, and
   * until they do there is no line). With a model's name, Settings >
   * Health says whether it is installed; with "off" or "none" it says the
   * standby is off; unset, the server chooses one for this Mac and Health has
   * no line for it. The runtime never asks that model anything.
   */
  FLINT_LOCAL_FALLBACK_MODEL: z.string().regex(/^[A-Za-z0-9._:/-]{1,80}$/).optional(),
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
  /** The calendar source (P2.5): where its OAuth client and token live. */
  google?: { dir: string };
  /** The Apple Calendar source (P2.6) is registered: Flint Calendar pushes to it. */
  appleCalendar: boolean;
  caps: Record<'anthropic' | 'openai' | 'perplexity' | 'tavily', { dailyUsd?: number; monthlyUsd?: number }>;
  /** P2 triage runs (else the sources run and nothing is triaged). */
  triage: boolean;
  /** P3 goal reviews run (else goals are kept and nothing reviews them). */
  planner: boolean;
  /** P4's prediction jobs may run (FLINT_PREDICT=on). The signed card is still what turns a number on. */
  predict: boolean;
  /** P5's tasks and assets are not switched off (FLINT_ASSETS=off is the rollback). What is on is still Will's signed cards. */
  assets: boolean;
  /** The local model triage and goal reviews ask; absent, triage is rules only and a review suggests no plan changes. */
  ollama?: { url: string; model: string; numCtx?: number };
  /** Where Ollama is asked which models it has (this Mac's own address), for Settings > Health. */
  ollamaUrl?: string;
  /** The standby model as the server's settings name it (a model, or "off"/"none"); absent when they name none. */
  standbyModel?: string;
  gitSha: string;
}

/**
 * Names a health check may not have. Its latency is kept as the ops series
 * `health.<name>.latency_ms`, and the database reads a `spend` segment as
 * dollars (financial) and a `calendar` segment as the calendar (never ops): it
 * would refuse the series, and the health source's run with it.
 */
const HEALTH_EXTRA_RESERVED: ReadonlySet<string> = new Set(['spend', 'calendar']);

/** `name=https://host/path` pairs; https only, no credentials in the URL. */
export function parseHealthExtra(raw: string | undefined): Array<{ name: string; url: string }> {
  if (!raw?.trim()) return [];
  return raw.split(',').map((pair, i) => {
    const m = pair.trim().match(/^([a-z0-9][a-z0-9_-]{0,40})=(https:\/\/[^\s,]+)$/);
    if (!m) throw new Error(`HEALTH_EXTRA entry ${i + 1} must be name=https://...`);
    if (HEALTH_EXTRA_RESERVED.has(m[1]!)) throw new Error(`HEALTH_EXTRA entry ${i + 1} can't be named ${m[1]}: that name is kept for Flint's spend and calendar numbers (try ${m[1]}-api)`);
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
    // An IANA name only: a numeric offset warns and is passed over (Postgres and JavaScript read its sign the opposite way).
    tz: zoneFrom(e.FLINT_TZ, e.FLINT_USER_TZ, (m) => console.error(m)),
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
    ...(e.FLINT_SOURCE_GOOGLE_CALENDAR?.trim().toLowerCase() === 'on' ? { google: { dir: join(e.HOME, '.flint', 'google') } } : {}),
    appleCalendar: e.FLINT_SOURCE_APPLE_CALENDAR?.trim().toLowerCase() === 'on',
    healthExtra,
    caps: {
      anthropic: cap(e.FLINT_BUDGET_ANTHROPIC_DAILY_USD, e.FLINT_BUDGET_ANTHROPIC_MONTHLY_USD),
      openai: cap(e.FLINT_BUDGET_OPENAI_DAILY_USD, e.FLINT_BUDGET_OPENAI_MONTHLY_USD),
      perplexity: cap(e.FLINT_BUDGET_PERPLEXITY_DAILY_USD, e.FLINT_BUDGET_PERPLEXITY_MONTHLY_USD),
      tavily: cap(e.FLINT_BUDGET_TAVILY_DAILY_USD, e.FLINT_BUDGET_TAVILY_MONTHLY_USD),
    },
    triage: e.FLINT_RUNTIME_TRIAGE?.trim().toLowerCase() === 'on',
    planner: e.FLINT_PLANNER?.trim().toLowerCase() === 'on',
    predict: e.FLINT_PREDICT?.trim().toLowerCase() === 'on',
    assets: e.FLINT_ASSETS?.trim().toLowerCase() !== 'off',
    ...(e.FLINT_TRIAGE_MODEL
      ? { ollama: { url: e.OLLAMA_URL ?? 'http://127.0.0.1:11434', model: e.FLINT_TRIAGE_MODEL, ...(e.OLLAMA_NUM_CTX ? { numCtx: e.OLLAMA_NUM_CTX } : {}) } }
      : {}),
    ollamaUrl: e.OLLAMA_URL ?? 'http://127.0.0.1:11434',
    ...(e.FLINT_LOCAL_FALLBACK_MODEL ? { standbyModel: e.FLINT_LOCAL_FALLBACK_MODEL } : {}),
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
  /** Where the encrypted copy goes (offsiteFolder); undefined: nowhere to send it. */
  offsiteDir?: string;
  /** Why FLINT_OFFSITE_DIR cannot be used as it is set, in words for the log. */
  offsiteProblem?: string;
  /** The offsite folder is in iCloud Drive (the note says "to iCloud" only then). */
  offsiteICloud: boolean;
  /** The names of the encrypted copies offsite, oldest first (backup.ts, pruneOffsite). */
  offsiteManifest: string;
  /** The key a dump's fingerprint file is sealed with (restore.ts, writeDumpHash). */
  fingerprintKey: string;
  tools: { pgDump: string; pgRestore: string; age?: string };
}

/**
 * Where the database's encrypted offsite copy goes: FLINT_OFFSITE_DIR when Will
 * set one (an absolute path, or one under his home written ~/…); otherwise
 * iCloud Drive's FlintBackups/pg, when iCloud Drive is on this Mac (beside the
 * folder the studio's own backup, apps/studio/backup_flint.sh, keeps its
 * encrypted snapshots in). With neither there is nowhere to send it, and a
 * setting that is not a whole path is refused rather than guessed at (`problem`):
 * the offsite job fails and says its setup needs fixing. Only age-encrypted
 * copies ever go there (backup.ts, encryptTo).
 */
export function offsiteFolder(home: string, set: string | undefined): { dir?: string; icloud: boolean; problem?: string } {
  const drive = join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs');
  const asked = set?.trim();
  if (asked) {
    const chosen = asked === '~' ? home : asked.startsWith('~/') ? join(home, asked.slice(2)) : asked;
    // A relative path would land wherever the job happened to start; "~user" is not expanded here.
    if (!isAbsolute(chosen)) return { icloud: false, problem: 'FLINT_OFFSITE_DIR is not an absolute path (or one that starts with ~/), so there is nowhere to send the copy' };
    const dir = normalize(chosen);
    return { dir, icloud: dir === drive || dir.startsWith(`${drive}/`) };
  }
  try {
    return statSync(drive).isDirectory() ? { dir: join(drive, 'FlintBackups', 'pg'), icloud: true } : { icloud: false };
  } catch {
    return { icloud: false };
  }
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
  const dumpDir = join(home, 'FlintBackups', 'pg');
  const offsite = offsiteFolder(home, B.data.FLINT_OFFSITE_DIR);
  return {
    config,
    backupUrl: B.data.FLINT_DB_BACKUP_URL,
    restoreUrl: B.data.FLINT_DB_RESTORE_URL,
    ...(recipient ? { ageRecipient: recipient } : {}),
    dumpDir,
    ...(offsite.dir ? { offsiteDir: offsite.dir } : {}),
    ...(offsite.problem ? { offsiteProblem: offsite.problem } : {}),
    offsiteICloud: offsite.icloud,
    offsiteManifest: join(dumpDir, 'offsite-copies.txt'),
    fingerprintKey: fingerprintKeyFile(home),
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

/** Where the key that seals a dump's fingerprint file is kept (0600; made the first time a backup is written). */
export const fingerprintKeyFile = (home: string): string => join(home, '.flint', 'backup-fingerprint.key');

/**
 * What `restore-production` and a rebuild's `restore-empty` need (P7), and
 * nothing more: the migration owner's URL and the runtime's own, from
 * ~/.flint/secrets.env (0600; the runtime's installer reads them there too), and
 * the read-only backup role's and the restoring role's from backup.env. Only
 * those keys are taken from either file. Every URL must name this Mac, and all
 * of them the same server; the owner's, the runtime's and the backup role's must
 * name the same database, which is never one of Postgres's own.
 */
export interface RestoreConfig {
  home: string;
  tz: string;
  ownerUrl: string;
  appUrl: string;
  /** flint_restore: the role a backup is restored as. It owns nothing else. */
  restoreUrl: string;
  backupUrl?: string;
  /** The nightly dumps (~/FlintBackups/pg). */
  dumpDir: string;
  /** Where the copy taken before a production restore goes (~/FlintBackups/pre-restore). */
  copyDir: string;
  /** The key fingerprint files are sealed with. */
  fingerprintKey: string;
  /** The file that pauses updates (apps/server/auto_deploy.sh looks for it before it does anything). */
  holdFile: string;
  /** The local record of restores (0600). */
  recordFile: string;
  /** The passkey settings signatures are verified against, when the runtime has them. */
  rp?: { rpId: string; origins: string[] };
  /** Where Homebrew's Postgres keeps its data, when that folder is there (to measure free space). */
  dataDir?: string;
  tools: { pgDump: string; pgRestore: string };
  /** For the tools the restore starts (prisma, git): the caller's PATH. */
  path: string;
  /** May launchctl be run, and the Mac's running programs be looked at? Never under a test runner. */
  launchctl: boolean;
}

export function loadRestoreConfig(): RestoreConfig {
  const home = process.env.HOME ?? '';
  if (!home) throw new Error('restore config is invalid: HOME is not set');
  const pick = (file: string, keys: string[]): Record<string, string | undefined> => {
    const all = runtimeEnv(file, {});
    return Object.fromEntries(keys.map((k) => [k, all[k]]));
  };
  const secrets = pick(process.env.FLINT_SECRETS_FILE ?? join(home, '.flint', 'secrets.env'), ['FLINT_DB_OWNER_URL', 'FLINT_DB_URL', 'FLINT_TZ', 'FLINT_USER_TZ']);
  const backupEnv = pick(process.env.BACKUP_ENV_FILE ?? join(home, '.flint', 'backup.env'), ['FLINT_DB_BACKUP_URL', 'FLINT_DB_RESTORE_URL']);
  const rpKeys = ['FLINT_RP_ID', 'FLINT_RP_ORIGINS'];
  const runtime = { ...pick(process.env.RUNTIME_ENV_FILE ?? join(home, '.flint', 'runtime.env'), rpKeys), ...pick(join(home, '.flint', 'runtime.override.env'), rpKeys) };
  // A value that is not a URL at all must end as a name and a reason, never as an error with the value in it.
  const part = (u: string, what: 'hostname' | 'port' | 'pathname'): string => {
    try {
      return new URL(u)[what];
    } catch {
      return '';
    }
  };
  /** What is wrong with a database URL, in a few words that never hold the value; the first thing only. */
  const wrong = (u: unknown): string | undefined => {
    if (typeof u !== 'string' || u.trim() === '') return 'is not set';
    if (part(u, 'hostname') === '' && part(u, 'pathname') === '') return 'is not a URL';
    if (!/^postgres(ql)?:/.test(u)) return 'must be a postgres URL';
    if (!['::1', '[::1]', '127.0.0.1', 'localhost'].includes(part(u, 'hostname'))) return 'must be a database on this Mac';
    return undefined;
  };
  const local = z.unknown().superRefine((u, ctx) => {
    const why = wrong(u);
    if (why) ctx.addIssue({ code: 'custom', message: why });
  }).transform((u) => u as string);
  const optional = z.unknown().superRefine((u, ctx) => {
    const why = u === undefined ? undefined : wrong(u);
    if (why) ctx.addIssue({ code: 'custom', message: why });
  }).transform((u) => u as string | undefined);
  const R = z
    .object({ FLINT_DB_OWNER_URL: local, FLINT_DB_URL: local, FLINT_DB_RESTORE_URL: local, FLINT_DB_BACKUP_URL: optional })
    .superRefine((v, ctx) => {
      // Only once each one is a URL on this Mac: then they must agree with each other.
      if ([v.FLINT_DB_OWNER_URL, v.FLINT_DB_URL, v.FLINT_DB_RESTORE_URL, v.FLINT_DB_BACKUP_URL].some((u) => u !== undefined && wrong(u))) return;
      const where = (u: string) => `${part(u, 'hostname')}:${part(u, 'port') || '5432'}`;
      const db = (u: string) => decodeURIComponent(part(u, 'pathname').slice(1));
      const others: Array<[string, string | undefined, boolean]> = [['FLINT_DB_URL', v.FLINT_DB_URL, true], ['FLINT_DB_BACKUP_URL', v.FLINT_DB_BACKUP_URL, true], ['FLINT_DB_RESTORE_URL', v.FLINT_DB_RESTORE_URL, false]];
      for (const [name, url, sameDb] of others) {
        if (!url) continue;
        if (where(url) !== where(v.FLINT_DB_OWNER_URL)) ctx.addIssue({ code: 'custom', path: [name], message: 'must name the same database server as FLINT_DB_OWNER_URL' });
        else if (sameDb && db(url) !== db(v.FLINT_DB_OWNER_URL)) ctx.addIssue({ code: 'custom', path: [name], message: 'must name the same database as FLINT_DB_OWNER_URL' });
      }
      if (['', 'postgres', 'template0', 'template1'].includes(db(v.FLINT_DB_OWNER_URL))) ctx.addIssue({ code: 'custom', path: ['FLINT_DB_OWNER_URL'], message: "must name Flint's own database" });
    })
    .safeParse({
      FLINT_DB_OWNER_URL: process.env.FLINT_DB_OWNER_URL ?? secrets.FLINT_DB_OWNER_URL,
      FLINT_DB_URL: process.env.FLINT_DB_URL ?? secrets.FLINT_DB_URL,
      FLINT_DB_RESTORE_URL: process.env.FLINT_DB_RESTORE_URL ?? backupEnv.FLINT_DB_RESTORE_URL,
      FLINT_DB_BACKUP_URL: process.env.FLINT_DB_BACKUP_URL ?? backupEnv.FLINT_DB_BACKUP_URL,
    });
  // Names and reasons only: a value here is a URL with a password in it.
  if (!R.success) throw new Error(`restore config is invalid: ${R.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  const bin = (name: string) => ['/opt/homebrew/opt/postgresql@17/bin', '/opt/homebrew/bin', '/usr/local/bin'].map((d) => join(d, name)).find((p) => existsSync(p));
  const pgDump = bin('pg_dump');
  const pgRestore = bin('pg_restore');
  if (!pgDump || !pgRestore) throw new Error('pg_dump/pg_restore not found (brew install postgresql@17)');
  const rpId = (process.env.FLINT_RP_ID ?? runtime.FLINT_RP_ID)?.trim();
  const origins = (process.env.FLINT_RP_ORIGINS ?? runtime.FLINT_RP_ORIGINS ?? '').split(',').map((o) => o.trim()).filter((o) => /^https:\/\/[a-z0-9.-]+(:\d+)?$/.test(o));
  const dataDir = [process.env.PGDATA, '/opt/homebrew/var/postgresql@17', '/usr/local/var/postgresql@17'].find((d): d is string => !!d && existsSync(join(d, 'PG_VERSION')));
  return {
    home,
    tz: zoneFrom(process.env.FLINT_TZ ?? secrets.FLINT_TZ, process.env.FLINT_USER_TZ ?? secrets.FLINT_USER_TZ),
    ownerUrl: R.data.FLINT_DB_OWNER_URL,
    appUrl: R.data.FLINT_DB_URL,
    restoreUrl: R.data.FLINT_DB_RESTORE_URL,
    ...(R.data.FLINT_DB_BACKUP_URL ? { backupUrl: R.data.FLINT_DB_BACKUP_URL } : {}),
    dumpDir: join(home, 'FlintBackups', 'pg'),
    copyDir: join(home, 'FlintBackups', 'pre-restore'),
    fingerprintKey: fingerprintKeyFile(home),
    holdFile: join(home, '.flint', 'deploy-hold'),
    recordFile: join(home, '.flint', 'restore-log.jsonl'),
    ...(rpId && /^[a-z0-9.-]+$/.test(rpId) && origins.length ? { rp: { rpId, origins } } : {}),
    ...(dataDir ? { dataDir } : {}),
    tools: { pgDump, pgRestore },
    path: process.env.PATH ?? '/usr/bin:/bin',
    launchctl: !process.env.VITEST && process.env.NODE_ENV !== 'test',
  };
}
