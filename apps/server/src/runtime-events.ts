/**
 * What the server tells the runtime (Machine plan P2 "server push", POST
 * /v1/events): a chat turn ended (the brain, how it ended, the tools it called,
 * how long it took, whether it read outside text), a spend threshold was newly
 * reached, a route answered 5xx. Ids, enums and numbers only (the
 * ServerEvent contract in @flint/policy, checked here before anything is kept):
 * never a message, a prompt or a tool's words. Eval replays send nothing.
 *
 *  - Every event gets a 32-hex id the runtime dedupes on, and the server's own
 *    time, so a resent batch adds nothing and a replayed spool does not fake a
 *    burst. A threshold's id comes from its notice key: the same threshold is
 *    the same event, whatever restarts in between.
 *  - Events are appended to ~/.flint/spool/events.jsonl (0600) as they happen
 *    and shipped every 15 s, at most 50 a batch, through the runtime link
 *    main() builds; a runtime that is down loses nothing. The spool is bounded:
 *    past its cap chat turns are dropped (counted, logged), and spend and route
 *    events still have a little room of their own, because they can escalate.
 *  - A batch the runtime refuses (400) is resent one event at a time; only an
 *    event refused on its own is set aside (events.rejected.jsonl) with a log
 *    line. A runtime older than P2 answers 404: what is spooled is dropped
 *    quietly (one log line), never resent forever. Anything else (down, 5xx,
 *    a token it does not take yet) is retried on the next flush.
 *  - One flush at a time; every request has a timeout and its body is cancelled.
 *  - Nothing is kept while the runtime is not installed (no token): there is no
 *    one to tell.
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { ServerEvent } from '@flint/policy';
import type { Runtime } from './audit-sink';
import type { Outcome } from './route-log';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** An event before it has its id and time (push() adds both unless given). */
export type EventDraft = DistributiveOmit<ServerEvent, 'id' | 'at'> & { id?: string; at?: string };

export interface RuntimeEventsOptions {
  runtime: () => Runtime | undefined;
  spoolDir: string;
  fetchImpl?: typeof fetch;
  log?: (msg: string) => void;
  /** Chat turns stop being kept past this many bytes on disk (default 2 MB); the others may use 256 KB more. */
  maxBytes?: number;
  timeoutMs?: number;
  now?: () => number;
}

/** At most this many events in one POST (ServerEventBatch). */
const BATCH = 50;
const ESCALATING_ROOM = 256 * 1024;
const REJECTED_MAX = 1024 * 1024;

/** A threshold notice's event id: the same notice key is always the same event. */
export function thresholdEventId(key: string): string {
  return createHash('sha256').update(`spend.threshold\u0000${key}`).digest('hex').slice(0, 32);
}

const TOOL_NAME = /^[A-Za-z0-9_.:-]{1,100}$/;

/** A finished /chat turn as an event: route-log's outcome on the wire's terms, tool names only. */
export function chatTurnEvent(t: {
  brain: string;
  outcome: Outcome;
  tools: readonly string[];
  ms: number;
  tainted: boolean;
  /** For the "chat unaffected" measures: the turn's tier, how recall went, World now's size. */
  tier?: string;
  recall?: string;
  worldTokens?: number;
}): EventDraft {
  const outcome = t.outcome === 'error' ? 'failed' : t.outcome;
  const tier = TIERS.find((x) => x === t.tier);
  const recall = RECALL.find((x) => x === t.recall);
  return {
    type: 'chat.turn',
    brain: t.brain === 'frontier' ? 'frontier' : 'local',
    outcome,
    tools: [...new Set(t.tools.filter((n) => TOOL_NAME.test(n)))].slice(0, 30),
    ms: Math.min(3_600_000, Math.max(0, Math.round(t.ms))),
    tainted: t.tainted,
    ...(tier ? { tier } : {}),
    ...(recall ? { recall } : {}),
    ...(t.worldTokens !== undefined && Number.isFinite(t.worldTokens) ? { ctxTokens: { world: Math.min(100_000, Math.max(0, Math.round(t.worldTokens))) } } : {}),
  };
}

const TIERS = ['routine', 'standard', 'hard', 'code'] as const;
const RECALL = ['semantic', 'lexical', 'timeout', 'error', 'none', 'skipped'] as const;

/**
 * Which route a request was, as the wire names it; undefined for the lanes
 * proxy (/inbox, /escalations, /runtime/health), whose 5xx says the runtime
 * failed, not the server: the runtime does not need telling about itself.
 */
export function routeOf(url: string): 'chat' | 'generate' | 'speak' | 'transcribe' | 'approvals' | 'proposals' | 'other' | undefined {
  const path = url.split('?')[0] ?? '';
  if (path === '/inbox' || path.startsWith('/inbox/') || path.startsWith('/escalations/') || path === '/runtime/health') return undefined;
  if (path === '/chat') return 'chat';
  if (path === '/generate') return 'generate';
  if (path === '/speak') return 'speak';
  if (path === '/transcribe') return 'transcribe';
  if (path.startsWith('/approvals/')) return 'approvals';
  if (path === '/proposals' || path.startsWith('/proposals/') || path.startsWith('/proposals?')) return 'proposals';
  return 'other';
}

type Sent = 'ok' | 'refused' | 'older' | 'retry';

export class RuntimeEvents {
  private readonly file: string;
  private readonly sending: string;
  private readonly rejected: string;
  private readonly max: number;
  private flushing: Promise<void> | undefined;
  private dropped = 0;
  private readonly logged = new Set<string>();

  constructor(private readonly opts: RuntimeEventsOptions) {
    mkdirSync(opts.spoolDir, { recursive: true, mode: 0o700 });
    this.file = join(opts.spoolDir, 'events.jsonl');
    this.sending = join(opts.spoolDir, 'events.sending.jsonl');
    this.rejected = join(opts.spoolDir, 'events.rejected.jsonl');
    this.max = opts.maxBytes ?? 2 * 1024 * 1024;
  }

  private logOnce(key: string, msg: string): void {
    if (this.logged.has(key)) return;
    this.logged.add(key);
    this.opts.log?.(msg);
  }

  private size(path: string): number {
    try {
      return existsSync(path) ? statSync(path).size : 0;
    } catch {
      return 0;
    }
  }

  /** Keep one event for the runtime. Returns whether it was kept. */
  push(draft: EventDraft): boolean {
    if (!this.opts.runtime()) return false;
    const at = draft.at ?? new Date(this.opts.now?.() ?? Date.now()).toISOString();
    const parsed = ServerEvent.safeParse({ ...draft, id: draft.id ?? randomBytes(16).toString('hex'), at });
    if (!parsed.success) {
      this.logOnce(`invalid:${draft.type}`, `[events] a ${draft.type} event did not fit the contract and was dropped (${parsed.error.issues.map((i) => i.path.join('.')).join(', ')})`);
      return false;
    }
    const line = `${JSON.stringify(parsed.data)}\n`;
    const limit = parsed.data.type === 'chat.turn' ? this.max : this.max + ESCALATING_ROOM;
    if (this.size(this.file) + this.size(this.sending) + Buffer.byteLength(line) > limit) {
      this.dropped++;
      if (this.dropped === 1 || this.dropped % 100 === 0) this.opts.log?.(`[events] the spool is full; ${this.dropped} event(s) not kept`);
      return false;
    }
    try {
      appendFileSync(this.file, line, { mode: 0o600 });
      return true;
    } catch (err) {
      this.logOnce('write', `[events] could not write the spool: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /** Ship what is spooled. Safe to call often: one flush at a time. */
  flush(): Promise<void> {
    this.flushing ??= this.doFlush().finally(() => {
      this.flushing = undefined;
    });
    return this.flushing;
  }

  private async post(rt: Runtime, events: ServerEvent[]): Promise<Sent> {
    try {
      const r = await (this.opts.fetchImpl ?? fetch)(`${rt.url}/v1/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${rt.token}` },
        body: JSON.stringify({ events }),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
      });
      await r.body?.cancel().catch(() => {});
      if (r.ok) return 'ok';
      if (r.status === 404) return 'older';
      if (r.status === 400) return 'refused';
      this.logOnce(`status:${r.status}`, `[events] the runtime answered ${r.status}; events stay spooled and are retried`);
      return 'retry';
    } catch {
      return 'retry';
    }
  }

  /** What is left to send, written back atomically (or removed when nothing is). */
  private keep(rest: ServerEvent[]): void {
    if (rest.length === 0) {
      rmSync(this.sending, { force: true });
      return;
    }
    const tmp = `${this.sending}.tmp`;
    writeFileSync(tmp, rest.map((e) => `${JSON.stringify(e)}\n`).join(''), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.sending);
  }

  private setAside(e: unknown, why: string, kind = 'other'): void {
    if (this.size(this.rejected) < REJECTED_MAX) appendFileSync(this.rejected, `${JSON.stringify(e)}\n`, { mode: 0o600 });
    // Once per kind: a runtime refusing a whole type would otherwise log a line per event.
    this.setAsideCount += 1;
    this.logOnce(`aside:${kind}`, `[events] ${why}; kept in events.rejected.jsonl (later ones of this kind are counted, not logged)`);
  }

  /** Events set aside since the server started. */
  setAsideCount = 0;

  private async doFlush(): Promise<void> {
    const rt = this.opts.runtime();
    if (!rt) return;
    // A file left by a flush that did not finish (a crash, a retry) goes first; the runtime dedupes on ids.
    if (!existsSync(this.sending) && existsSync(this.file)) renameSync(this.file, this.sending);
    if (!existsSync(this.sending)) return;
    let events: ServerEvent[] = [];
    let unreadable = 0;
    for (const l of readFileSync(this.sending, 'utf8').split('\n')) {
      if (!l.trim()) continue;
      let e: ServerEvent | undefined;
      try {
        const p = ServerEvent.safeParse(JSON.parse(l));
        if (p.success) e = p.data;
      } catch {
        e = undefined;
      }
      if (e) events.push(e);
      else {
        unreadable++;
        this.setAside(l.slice(0, 2000), 'an unreadable spooled event was set aside');
      }
    }
    // What was set aside is not read again; an empty file is done with.
    if (unreadable > 0 || events.length === 0) this.keep(events);
    while (events.length > 0) {
      const batch = events.slice(0, BATCH);
      const r = await this.post(rt, batch);
      if (r === 'retry') return this.keep(events);
      if (r === 'older') {
        this.logOnce('older', '[events] the runtime has no /v1/events (older than P2); spooled events are dropped');
        return this.keep([]);
      }
      if (r === 'refused') {
        // One bad event must not lose the other 49: one at a time, and only what is refused alone is set aside.
        for (let i = 0; i < batch.length; i++) {
          const one = await this.post(rt, [batch[i]!]);
          if (one === 'retry') return this.keep(events.slice(i));
          if (one === 'older') return this.keep([]);
          if (one === 'refused') this.setAside(batch[i], `the runtime refused event ${batch[i]!.id} (${batch[i]!.type})`, `refused:${batch[i]!.type}`);
        }
      }
      events = events.slice(batch.length);
      this.keep(events);
    }
  }

  /** Ship every `ms` (default 15 s) until stopped. */
  start(ms = 15_000): () => void {
    const t = setInterval(() => void this.flush().catch((err) => this.logOnce('flush', `[events] flush failed: ${err instanceof Error ? err.message : String(err)}`)), ms);
    t.unref();
    return () => clearInterval(t);
  }
}
