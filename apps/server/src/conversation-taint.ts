/**
 * Which stored turns read untrusted text (Machine plan 3.0.3, across turns).
 *
 * A turn's taint lives in its request (./turn-taint), but what the turn read is
 * stored with it: the conversation store keeps tool results, and the next
 * turns carry them back to the model. So a turn that read text a stranger wrote
 * is remembered here, and a later turn whose history window still holds it
 * starts tainted ("history"): egress and writes need approval again.
 *
 * Only a turn's own reads mark it. A turn tainted only by its history is not
 * marked, so the taint ends when the tainted turn leaves the window (12 turns
 * or 48 hours by default). What the model wrote in between can still echo the
 * untrusted text; that residue is accepted rather than tainting a long
 * conversation forever.
 *
 * Stored at ~/.flint/memory/taint.json (0600), rewritten atomically on change.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const MAX_PER_CONVERSATION = 500;

export class ConversationTaint {
  private readonly turns = new Map<string, string[]>();
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
      if (!raw || typeof raw !== 'object') return;
      for (const [cid, ids] of Object.entries(raw as Record<string, unknown>)) {
        if (Array.isArray(ids)) this.turns.set(cid, ids.filter((i): i is string => typeof i === 'string').slice(-MAX_PER_CONVERSATION));
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
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.turns)), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
  }

  /** Remember that these turns read untrusted text. */
  mark(conversationId: string, turnIds: readonly string[]): void {
    if (turnIds.length === 0) return;
    const ids = this.turns.get(conversationId) ?? [];
    for (const id of turnIds) if (!ids.includes(id)) ids.push(id);
    this.turns.set(conversationId, ids.slice(-MAX_PER_CONVERSATION));
    // An unreadable file is left as it is, so every restart stays fail-closed until Will looks at it.
    if (this.unreadable) return;
    try {
      this.save();
    } catch (err) {
      this.log(`[taint] could not save ${this.file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Did this turn read untrusted text? */
  isTainted(conversationId: string, turnId: string): boolean {
    return this.unreadable || (this.turns.get(conversationId)?.includes(turnId) ?? false);
  }

  /** Does any of these turns (a history window) carry untrusted text? */
  anyTainted(conversationId: string, turnIds: readonly string[]): boolean {
    if (this.unreadable) return turnIds.length > 0;
    const ids = this.turns.get(conversationId);
    return !!ids && turnIds.some((t) => ids.includes(t));
  }
}
