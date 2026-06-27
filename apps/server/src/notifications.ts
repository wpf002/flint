import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { execFile } from 'node:child_process';

export interface Notification {
  id: string;
  title: string;
  body: string;
  kind: string; // 'calendar' | 'signal' | 'digest' | 'system' | ...
  ts: number;
  read: boolean;
}

/** A periodic check: returns zero or more notifications to push. Must be cheap
 *  (no LLM) and resilient — a throwing check is caught and skipped. */
export type Check = () => Promise<Array<{ title: string; body: string; kind: string; dedupe: string }>>;

/**
 * Makes Flint proactive — it notices and tells Will instead of only answering
 * when asked. A durable notifications feed (console bell + unread badge), plus a
 * watcher that runs lightweight checks on an interval and pushes anything new.
 * Delivery is layered and all best-effort: always the in-app feed; a macOS
 * banner if available; and a phone push via ntfy.sh when FLINT_NTFY_TOPIC is set
 * (install the free ntfy app, subscribe to the topic — no account, no keys).
 */
export class Notifications {
  private items: Notification[] = [];
  private readonly seen = new Set<string>(); // dedupe signatures already pushed
  private seq = 0;

  constructor(private readonly path: string) {
    this.load();
  }

  list(limit = 50): Notification[] {
    return this.items.slice(0, limit);
  }
  unreadCount(): number {
    return this.items.filter((n) => !n.read).length;
  }
  markRead(id: string): boolean {
    const n = this.items.find((x) => x.id === id);
    if (n && !n.read) {
      n.read = true;
      this.save();
      return true;
    }
    return false;
  }
  markAllRead(): void {
    let changed = false;
    for (const n of this.items) if (!n.read) ((n.read = true), (changed = true));
    if (changed) this.save();
  }

  /** Add a notification (deduped by signature) and fan out to OS + phone. */
  push(title: string, body: string, kind: string, dedupe?: string): Notification | undefined {
    // Safety net: never surface a raw JSON blob as a notification — a check
    // should format human-readable text, not dump a tool payload.
    if (/^\s*[{[]/.test(body)) return undefined;
    const sig = dedupe ?? `${kind}:${title}:${body}`;
    if (this.seen.has(sig)) return undefined;
    this.seen.add(sig);
    const n: Notification = { id: `n${++this.seq}`, title, body, kind, ts: Date.now(), read: false };
    this.items.unshift(n);
    if (this.items.length > 300) this.items.length = 300;
    this.save();
    this.deliverOS(title, body);
    this.deliverPhone(title, body);
    return n;
  }

  private deliverOS(title: string, body: string): void {
    const esc = (s: string) => s.replace(/["\\]/g, '\\$&').slice(0, 240);
    execFile('osascript', ['-e', `display notification "${esc(body)}" with title "Flint" subtitle "${esc(title)}"`], () => {});
  }

  private deliverPhone(title: string, body: string): void {
    const topic = process.env.FLINT_NTFY_TOPIC?.trim();
    if (!topic) return;
    fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
      method: 'POST',
      headers: { Title: title.slice(0, 120), Tags: 'fire' },
      body: body.slice(0, 1000),
    }).catch(() => {});
  }

  private load(): void {
    try {
      if (!existsSync(this.path)) return;
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as { items?: Notification[]; seq?: number; seen?: string[] };
      this.items = Array.isArray(raw.items) ? raw.items : [];
      this.seq = raw.seq ?? this.items.length;
      for (const s of raw.seen ?? []) this.seen.add(s);
    } catch (err) {
      console.error('[notify] failed to load (starting fresh):', err);
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify({ savedAt: Date.now(), seq: this.seq, items: this.items, seen: [...this.seen].slice(-500) }), 'utf8');
      renameSync(tmp, this.path);
    } catch (err) {
      console.error('[notify] failed to persist:', err);
    }
  }
}

/**
 * Runs registered checks on an interval and pushes whatever they surface. Each
 * check is isolated (one failing check never stops the others), so a broken
 * integration (e.g. expired calendar OAuth) degrades quietly instead of taking
 * the watcher down.
 */
export class Watcher {
  private timer: ReturnType<typeof setInterval> | undefined;
  constructor(
    private readonly notes: Notifications,
    private readonly checks: Check[],
    private readonly intervalMs = Number(process.env.FLINT_WATCH_MS ?? 30 * 60 * 1000),
  ) {}

  start(): void {
    if (this.checks.length === 0) return;
    const run = () => void this.runOnce();
    // First sweep shortly after boot, then on the interval.
    setTimeout(run, 20_000);
    this.timer = setInterval(run, this.intervalMs);
    console.error(`[watch] proactive watcher started (${this.checks.length} checks, every ${Math.round(this.intervalMs / 60000)}m)`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async runOnce(): Promise<void> {
    for (const check of this.checks) {
      try {
        for (const r of await check()) this.notes.push(r.title, r.body, r.kind, r.dedupe);
      } catch (err) {
        console.error('[watch] check failed (skipping):', err);
      }
    }
  }
}
