/**
 * The server's side of the audit trail (Machine plan 3.0.7). The runtime is the
 * one writer; the server hands it entries through a local spool, so nothing is
 * lost while the runtime is down or not installed yet.
 *
 *  - Every entry is redacted (credentials, and this process's own tokens) and
 *    appended as one JSON line to ~/.flint/spool/audit.jsonl (0600, capped at
 *    20 MB). An intent is fsynced before the action it announces runs, and if
 *    it cannot be written, record() throws: the caller runs nothing.
 *  - Read-only chat tool calls are only counted (AuditRollup), never rows; the
 *    counts are kept in ~/.flint/spool/rollups.json until shipped, so a restart
 *    or a runtime that is down loses none.
 *  - A shipper renames the spool aside (so appends go to a fresh file), posts it
 *    to the runtime in batches of 100, and deletes it once every batch is in.
 *    The runtime ignores an entry it already has (same id and time), so a
 *    retried batch is harmless. A batch the runtime refuses (400) is sent one
 *    entry at a time; only the entries it refuses alone are set aside, in
 *    audit.rejected.jsonl, with a log line.
 */
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync, chmodSync } from 'node:fs';
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

/** An intent that could not be made durable: the action it announces must not run. */
export class AuditUnavailable extends Error {}

const today = (tz: string, at = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);

export class AuditSink {
  private readonly file: string;
  private readonly shipping: string;
  private readonly rejected: string;
  private readonly rollupFile: string;
  private readonly max: number;
  private rollups = new Map<string, number>();
  private rollupSave: ReturnType<typeof setTimeout> | undefined;
  private flushing: Promise<void> | undefined;
  private dropped = 0;

  constructor(private readonly opts: AuditSinkOptions & { tz?: string }) {
    mkdirSync(opts.spoolDir, { recursive: true, mode: 0o700 });
    chmodSync(opts.spoolDir, 0o700);
    this.file = join(opts.spoolDir, 'audit.jsonl');
    this.shipping = join(opts.spoolDir, 'audit.shipping.jsonl');
    this.rejected = join(opts.spoolDir, 'audit.rejected.jsonl');
    this.rollupFile = join(opts.spoolDir, 'rollups.json');
    this.max = opts.maxBytes ?? 20 * 1024 * 1024;
    try {
      if (existsSync(this.rollupFile)) {
        for (const [k, n] of Object.entries(JSON.parse(readFileSync(this.rollupFile, 'utf8')) as Record<string, unknown>)) {
          if (typeof n === 'number' && Number.isInteger(n) && n > 0) this.rollups.set(k, n);
        }
      }
    } catch {
      this.opts.log?.('[audit] rollups.json is unreadable; starting the counts afresh');
    }
  }

  /** Write the counts to disk (soon after a change, and before the process exits). */
  saveRollups(): void {
    if (this.rollupSave) clearTimeout(this.rollupSave);
    this.rollupSave = undefined;
    try {
      const tmp = `${this.rollupFile}.tmp`;
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.rollups)), { mode: 0o600 });
      renameSync(tmp, this.rollupFile);
    } catch (err) {
      this.opts.log?.(`[audit] could not save the rollup counts: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  static newId(): string {
    return `au${Date.now().toString(36)}${randomBytes(6).toString('hex')}`;
  }

  /**
   * Append one entry. `durable` fsyncs it before returning (for intents), and
   * throws AuditUnavailable if it could not be written: the action it announces
   * must not run unrecorded.
   */
  record(e: Omit<AuditRecord, 'id' | 'at'> & { id?: string; at?: string }, durable = false): AuditRecord {
    const full: AuditRecord = redact({ ...e, id: e.id ?? AuditSink.newId(), at: e.at ?? new Date().toISOString() }, { secrets: this.opts.secrets?.() ?? [] });
    const line = `${JSON.stringify(full)}\n`;
    try {
      const size = existsSync(this.file) ? statSync(this.file).size : 0;
      if (size + Buffer.byteLength(line) > this.max) {
        this.dropped++;
        if (this.dropped === 1 || this.dropped % 100 === 0) this.opts.log?.(`[audit] spool is full (${this.max} bytes); ${this.dropped} entries not recorded`);
        if (durable) throw new AuditUnavailable('the audit spool is full');
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
      if (err instanceof AuditUnavailable) throw err;
      this.opts.log?.(`[audit] could not write the spool: ${err instanceof Error ? err.message : String(err)}`);
      if (durable) throw new AuditUnavailable('the audit spool could not be written');
    }
    return full;
  }

  /** Count a call that is not recorded as a row (read-only chat tools). */
  count(action: string, context: AuditRecord['context']): void {
    // The runtime takes action names up to 200 characters.
    const key = `${today(this.opts.tz ?? 'America/Chicago')}\u0000${action.slice(0, 200)}\u0000${context}`;
    this.rollups.set(key, (this.rollups.get(key) ?? 0) + 1);
    this.rollupSave ??= setTimeout(() => this.saveRollups(), 5000);
    this.rollupSave.unref?.();
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
    /** 'ok', 'refused' (400: the runtime will never take it), or 'retry'. */
    const post = async (path: string, body: unknown): Promise<'ok' | 'refused' | 'retry'> => {
      try {
        const r = await (this.opts.fetchImpl ?? fetch)(`${rt.url}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${rt.token}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        });
        await r.body?.cancel().catch(() => {});
        if (r.status === 400) return 'refused';
        return r.ok ? 'ok' : 'retry';
      } catch {
        return 'retry';
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
        const batch = entries.slice(i, i + 100);
        const r = await post('/v1/audit', batch);
        if (r === 'retry') return; // retried next time, from the start (replays are ignored)
        if (r === 'refused') {
          // One bad entry must not lose the other 99: one at a time, and only what is refused alone is set aside.
          for (const e of batch) {
            const one = await post('/v1/audit', [e]);
            if (one === 'retry') return;
            if (one === 'refused') {
              appendFileSync(this.rejected, `${JSON.stringify(e)}\n`, { mode: 0o600 });
              this.opts.log?.(`[audit] the runtime refused entry ${e.id} (${e.kind} ${e.action}); kept in audit.rejected.jsonl`);
            }
          }
        }
      }
      rmSync(this.shipping, { force: true });
    }
    if (this.rollups.size) {
      // The runtime takes at most 500 rows a batch, each batch all or nothing.
      const rows = [...this.rollups].map(([k, n]) => {
        const [day, action, context] = k.split('\u0000') as [string, string, string];
        return { key: k, row: { day, action, context, n } };
      });
      for (let i = 0; i < rows.length; i += 500) {
        const chunk = rows.slice(i, i + 500);
        const r = await post('/v1/audit/rollup', chunk.map((c) => c.row));
        if (r === 'retry') break;
        if (r === 'refused') this.opts.log?.(`[audit] the runtime refused ${chunk.length} rollup counts; dropped`);
        // Shipped (or never shippable): subtract what was sent, keeping counts added meanwhile.
        for (const c of chunk) {
          const left = (this.rollups.get(c.key) ?? 0) - c.row.n;
          if (left > 0) this.rollups.set(c.key, left);
          else this.rollups.delete(c.key);
        }
      }
      this.saveRollups();
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

