import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { NOTIFY_CHANNELS, type NotifyChannel } from '@flint/policy';

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
 * What push() did: `stored` (in the console's list, and sent on the other
 * channels asked for), `duplicate` (already pushed under that dedupe key, so
 * nothing new happened) or `refused` (not something Flint shows: a raw
 * payload). `pinged` says whether the phone got its content-free ping.
 */
export interface PushResult {
  status: 'stored' | 'duplicate' | 'refused';
  pinged: boolean;
}

/**
 * The only thing the phone is ever sent (Machine plan P2: 0 ntfy payloads carry
 * content). ntfy topics are public by name, so the ping says that something is
 * waiting and nothing about what: the words stay in the console.
 */
export const PHONE_PING = { title: 'Flint', body: 'Something needs a look in the console.', tags: 'bell' } as const;

/**
 * The channels a note goes out on: all three when none are named (what every
 * note did before P2). A banner or a phone ping always comes with the in-app
 * note, so nothing points Will at a console that has nothing to show.
 */
export function noteChannels(asked?: readonly NotifyChannel[]): NotifyChannel[] {
  const want = new Set<NotifyChannel>(asked && asked.length > 0 ? asked : NOTIFY_CHANNELS);
  if (want.has('banner') || want.has('push')) want.add('inapp');
  return NOTIFY_CHANNELS.filter((c) => want.has(c));
}

export interface NotificationsDeps {
  /** The ntfy topic (default FLINT_NTFY_TOPIC); unset: no phone pings. */
  topic?: () => string | undefined;
  fetchImpl?: typeof fetch;
  /** The macOS banner (default osascript). */
  banner?: (title: string, body: string) => void;
}

function deliverOS(title: string, body: string): void {
  const esc = (s: string) => s.replace(/["\\]/g, '\\$&').slice(0, 240);
  execFile('osascript', ['-e', `display notification "${esc(body)}" with title "Flint" subtitle "${esc(title)}"`], () => {});
}

/**
 * Makes Flint proactive — it notices and tells Will instead of only answering
 * when asked. A durable notifications feed (console bell + unread badge), plus a
 * watcher that runs lightweight checks on an interval and pushes anything new.
 * Delivery is layered and all best-effort: always the in-app feed; a macOS
 * banner when asked for; and a phone ping via ntfy.sh when FLINT_NTFY_TOPIC is
 * set (install the free ntfy app, subscribe to the topic — no account, no keys).
 * The ping is the same for every caller and carries no content (PHONE_PING).
 */
/**
 * Kinds nothing sends any more, kept in the file but never shown or counted. 'nexus':
 * the Nexus run watcher was removed (5bbccd9, 19381dc), and the notes it left
 * ("Nexus run finished: Build aqi: closed") are fragments Will can't act on. They age
 * out with the 300-item cap; nothing is deleted.
 */
export const RETIRED_KINDS: ReadonlySet<string> = new Set(['nexus']);
const shown = (n: Notification) => !RETIRED_KINDS.has(n.kind);

export class Notifications {
  private items: Notification[] = [];
  private readonly seen = new Set<string>(); // dedupe signatures already pushed
  private seq = 0;

  constructor(
    private readonly path: string,
    private readonly deps: NotificationsDeps = {},
  ) {
    this.load();
  }

  list(limit = 50): Notification[] {
    return this.items.filter(shown).slice(0, limit);
  }
  unreadCount(): number {
    return this.items.filter((n) => shown(n) && !n.read).length;
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

  /**
   * Add a notification (deduped by signature) and deliver it on `channels`
   * (noteChannels: all three by default, and never a banner or ping without the
   * in-app note). The in-app note keeps the words; the banner shows them on this
   * Mac only; the phone gets PHONE_PING, whatever the title and body say.
   */
  push(title: string, body: string, kind: string, dedupe?: string, opts: { channels?: readonly NotifyChannel[] } = {}): PushResult {
    // Safety net: never surface a raw JSON blob as a notification — a check
    // should format human-readable text, not dump a tool payload.
    if (/^\s*[{[]/.test(body)) return { status: 'refused', pinged: false };
    const sig = dedupe ?? `${kind}:${title}:${body}`;
    if (this.seen.has(sig)) return { status: 'duplicate', pinged: false };
    this.seen.add(sig);
    const channels = noteChannels(opts.channels);
    const n: Notification = { id: `n${++this.seq}`, title, body, kind, ts: Date.now(), read: false };
    this.items.unshift(n);
    if (this.items.length > 300) this.items.length = 300;
    this.save();
    if (channels.includes('banner')) (this.deps.banner ?? deliverOS)(title, body);
    const pinged = channels.includes('push') && this.deliverPhone();
    return { status: 'stored', pinged };
  }

  /**
   * The phone ping, content-free by construction: it takes no text, so no caller
   * (the runtime, the Watcher, the spend guard, "Action done") can put words on
   * ntfy.sh. Returns whether a ping was sent off.
   */
  private deliverPhone(): boolean {
    const topic = (this.deps.topic ?? (() => process.env.FLINT_NTFY_TOPIC))()?.trim();
    if (!topic) return false;
    (this.deps.fetchImpl ?? fetch)(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
      method: 'POST',
      headers: { Title: PHONE_PING.title, Tags: PHONE_PING.tags },
      body: PHONE_PING.body,
      signal: AbortSignal.timeout(10_000),
    })
      .then((r) => r.body?.cancel())
      .catch(() => {});
    return true;
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
/**
 * `FLINT_WATCHER=off` (or 0, false, no) turns the Watcher off: once the
 * runtime's google_calendar source is live it owns the calendar (Machine plan
 * P2.5), with titles kept out of notes. Unset, or anything else: on.
 */
export function watcherEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return !/^(off|0|false|no)$/i.test(env.FLINT_WATCHER?.trim() ?? '');
}

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
