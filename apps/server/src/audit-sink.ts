/**
 * The server's side of the audit trail (Machine plan 3.0.7). The runtime is the
 * one writer; the server hands it entries through a local spool, so nothing is
 * lost while the runtime is down or not installed yet.
 *
 *  - Every entry is redacted (credentials, and this process's own tokens) and
 *    appended as one JSON line to ~/.flint/spool/audit.jsonl (0600, capped at
 *    20 MB). An intent is fsynced before the action it announces runs.
 *  - Read-only chat tool calls are only counted (AuditRollup), never rows.
 *  - A shipper renames the spool aside (so appends go to a fresh file), posts it
 *    to the runtime in batches of 100, and deletes it once every batch is in.
 *    The runtime ignores an entry it already has (same id and time), so a
 *    retried batch is harmless.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { redact } from '@flint/policy';

export interface AuditRecord {
  id: string;
  at: string;
  actor: string;
  context: 'chat' | 'autonomous' | 'console' | 'deploy';
  kind: 'intent' | 'decision' | 'action' | 'approval' | 'rejection' | 'spend' | 'policy' | 'sync' | 'escalation' | 'health' | 'forget' | 'error';
  action: string;
  tier?: 'alone' | 'approval' | 'forbidden';
  inputs: Record<string, string | number | boolean | null>;
  reasoning?: string;
  decision?: 'act' | 'log' | 'escalate' | 'queue' | 'deny';
  outcome: 'pending' | 'ok' | 'denied' | 'failed' | 'skipped';
  correlationId?: string;
  tainted?: boolean;
}

export interface Runtime {
  url: string;
  token: string;
}

export interface AuditSinkOptions {
  spoolDir: string;
  maxBytes?: number;
  /** Where to ship, when the runtime is installed. */
  runtime?: () => Runtime | undefined;
  /** Tokens this process holds: replaced wherever they appear. */
  secrets?: () => readonly string[];
  fetchImpl?: typeof fetch;
  log?: (msg: string) => void;
}

const today = (tz: string, at = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);

export class AuditSink {
  private readonly file: string;
  private readonly shipping: string;
  private readonly max: number;
  private rollups = new Map<string, number>();
  private flushing: Promise<void> | undefined;
  private dropped = 0;

  constructor(private readonly opts: AuditSinkOptions & { tz?: string }) {
    mkdirSync(opts.spoolDir, { recursive: true, mode: 0o700 });
    chmodSync(opts.spoolDir, 0o700);
    this.file = join(opts.spoolDir, 'audit.jsonl');
    this.shipping = join(opts.spoolDir, 'audit.shipping.jsonl');
    this.max = opts.maxBytes ?? 20 * 1024 * 1024;
  }

  static newId(): string {
    return `au${Date.now().toString(36)}${randomBytes(6).toString('hex')}`;
  }

  /** Append one entry. `durable` fsyncs it before returning (for intents). */
  record(e: Omit<AuditRecord, 'id' | 'at'> & { id?: string; at?: string }, durable = false): AuditRecord {
    const full: AuditRecord = redact({ ...e, id: e.id ?? AuditSink.newId(), at: e.at ?? new Date().toISOString() }, { secrets: this.opts.secrets?.() ?? [] });
    const line = `${JSON.stringify(full)}\n`;
    try {
      const size = existsSync(this.file) ? statSync(this.file).size : 0;
      if (size + Buffer.byteLength(line) > this.max) {
        this.dropped++;
        if (this.dropped === 1 || this.dropped % 100 === 0) this.opts.log?.(`[audit] spool is full (${this.max} bytes); ${this.dropped} entries not recorded`);
        return full;
      }
      const fd = openSync(this.file, 'a', 0o600);
      try {
        writeSync(fd, line);
        if (durable) fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch (err) {
      this.opts.log?.(`[audit] could not write the spool: ${err instanceof Error ? err.message : String(err)}`);
    }
    return full;
  }

  /** Count a call that is not recorded as a row (read-only chat tools). */
  count(action: string, context: AuditRecord['context']): void {
    const key = `${today(this.opts.tz ?? 'America/New_York')}\u0000${action}\u0000${context}`;
    this.rollups.set(key, (this.rollups.get(key) ?? 0) + 1);
  }

  /** Ship what is spooled. Safe to call often: one flush at a time. */
  flush(): Promise<void> {
    this.flushing ??= this.doFlush().finally(() => {
      this.flushing = undefined;
    });
    return this.flushing;
  }

  private async doFlush(): Promise<void> {
    const rt = this.opts.runtime?.();
    if (!rt) return;
    const post = async (path: string, body: unknown): Promise<boolean> => {
      try {
        const r = await (this.opts.fetchImpl ?? fetch)(`${rt.url}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${rt.token}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        });
        await r.body?.cancel().catch(() => {});
        if (r.status === 400) {
          // A batch the runtime will never take: keep going rather than block the spool forever.
          this.opts.log?.(`[audit] the runtime refused a batch to ${path} (400); dropped`);
          return true;
        }
        return r.ok;
      } catch {
        return false;
      }
    };
    if (!existsSync(this.shipping) && existsSync(this.file)) renameSync(this.file, this.shipping);
    if (existsSync(this.shipping)) {
      const lines = readFileSync(this.shipping, 'utf8').split('\n').filter(Boolean);
      const entries = lines.flatMap((l) => {
        try {
          return [JSON.parse(l) as AuditRecord];
        } catch {
          return [];
        }
      });
      for (let i = 0; i < entries.length; i += 100) {
        if (!(await post('/v1/audit', entries.slice(i, i + 100)))) return; // retried next time, from the start (replays are ignored)
      }
      rmSync(this.shipping, { force: true });
    }
    if (this.rollups.size) {
      const batch = [...this.rollups].map(([k, n]) => {
        const [day, action, context] = k.split('\u0000') as [string, string, string];
        return { day, action, context, n };
      });
      this.rollups = new Map();
      if (!(await post('/v1/audit/rollup', batch))) {
        for (const r of batch) this.rollups.set(`${r.day}\u0000${r.action}\u0000${r.context}`, (this.rollups.get(`${r.day}\u0000${r.action}\u0000${r.context}`) ?? 0) + r.n);
      }
    }
  }

  /** Ship every `ms` until stopped. */
  start(ms = 15_000): () => void {
    const t = setInterval(() => void this.flush(), ms);
    t.unref();
    return () => clearInterval(t);
  }
}

/** The runtime's address and the server's token for it, once install-runtime.sh has run. */
export function runtimeFromDisk(home: string, url: string = 'http://[::1]:8090'): () => Runtime | undefined {
  const file = join(home, '.flint', 'tokens', 'runtime.token');
  return () => {
    try {
      const token = readFileSync(file, 'utf8').trim();
      return /^[0-9a-f]{64}$/.test(token) ? { url, token } : undefined;
    } catch {
      return undefined;
    }
  };
}

