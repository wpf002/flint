/**
 * Which stored turns carry untrusted text (Machine plan 3.0.3, across turns).
 *
 * A turn's taint lives in its request (./turn-taint), but what the turn read is
 * stored with it: the conversation store keeps tool results, and the next
 * turns carry them back to the model. So every turn that ran tainted is
 * remembered here with the time of the untrusted read behind it (its origin):
 *  - a turn that read text a stranger wrote: its own time;
 *  - a turn tainted only by its history: the newest origin in that history
 *    (what the model wrote can repeat what it read).
 * A later turn starts tainted ("history") when the turns handed to the model
 * include one whose origin is younger than the history window's age limit, so
 * the taint ends one window after the last untrusted read (48 hours by
 * default), however long the conversation goes on. With no age limit it never
 * ends (fail closed). The memory extractor skips every turn recorded here.
 *
 * Stored at ~/.flint/memory/taint.json (0600), rewritten atomically on change.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const MAX_PER_CONVERSATION = 500;

export class ConversationTaint {
  /** conversation -> turn id -> origin (ms). */
  private readonly turns = new Map<string, Map<string, number>>();
  /** The file exists but cannot be read: fail closed. */
  private unreadable = false;

  constructor(
    private readonly file: string,
    private readonly log: (m: string) => void = () => {},
  ) {
    this.load();
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as unknown;
      if (!raw || typeof raw !== 'object') throw new Error('not an object');
      for (const [cid, ids] of Object.entries(raw as Record<string, unknown>)) {
        const m = new Map<string, number>();
        // The first format listed ids only: with no origin known, the read counts as recent.
        if (Array.isArray(ids)) for (const id of ids) typeof id === 'string' && m.set(id, Number.MAX_SAFE_INTEGER);
        else if (ids && typeof ids === 'object') for (const [id, at] of Object.entries(ids)) typeof at === 'number' && m.set(id, at);
        this.turns.set(cid, m);
      }
    } catch (err) {
      // An unreadable record must not quietly clear every conversation's taint.
      this.log(`[taint] ${this.file} is unreadable (${err instanceof Error ? err.message : String(err)}); every conversation with history counts as tainted until it is fixed or removed`);
      this.unreadable = true;
    }
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries([...this.turns].map(([cid, m]) => [cid, Object.fromEntries(m)]))), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
  }

  /** Remember that these turns carry untrusted text read at `origin`. */
  mark(conversationId: string, turnIds: readonly string[], origin: number): void {
    if (turnIds.length === 0) return;
    const m = this.turns.get(conversationId) ?? new Map<string, number>();
    for (const id of turnIds) m.set(id, Math.max(m.get(id) ?? 0, origin));
    while (m.size > MAX_PER_CONVERSATION) m.delete(m.keys().next().value as string);
    this.turns.set(conversationId, m);
    // An unreadable file is left as it is, so every restart stays fail-closed until Will looks at it.
    if (this.unreadable) return;
    try {
      this.save();
    } catch (err) {
      this.log(`[taint] could not save ${this.file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Does this turn carry untrusted text (for the memory extractor: any age)? */
  isTainted(conversationId: string, turnId: string): boolean {
    return this.unreadable || (this.turns.get(conversationId)?.has(turnId) ?? false);
  }

  /**
   * The newest origin among these turns (a history window) that is younger
   * than `maxAgeMs` at `now`, or undefined when none of them taints.
   */
  origin(conversationId: string, turnIds: readonly string[], now: number, maxAgeMs = Infinity): number | undefined {
    if (this.unreadable) return turnIds.length > 0 ? now : undefined;
    const m = this.turns.get(conversationId);
    if (!m) return undefined;
    let newest: number | undefined;
    for (const id of turnIds) {
      const at = m.get(id);
      if (at === undefined) continue;
      const t = Math.min(at, now);
      if (now - t > maxAgeMs) continue;
      newest = Math.max(newest ?? 0, t);
    }
    return newest;
  }
}
