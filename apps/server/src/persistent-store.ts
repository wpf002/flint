import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  TurnSchema,
  SCHEMA_VERSION,
  type MemoryStore,
  type Turn,
  type BeginTurnInput,
  type CommitTurnInput,
  type FailTurnInput,
  type Message,
  hasPayload,
  shedPayload,
} from '@flint/core';
import {
  DEFAULT_HISTORY_WINDOW,
  describeHistoryWindow,
  readHistoryWindow,
  windowTurns,
  type HistoryStats,
  type HistoryWindow,
} from './history-window';

/**
 * How many of a conversation's most recent turns keep their attachment bodies
 * in RAM, so "and what about the chart on page 3?" still has the PDF to look
 * at. Older turns keep only the metadata (the adapters render it as a note).
 * Bodies are NEVER written to disk: conversations.json holds chat history, not
 * a pile of base64 photos, and a restart simply sheds them.
 */
export const ATTACHMENT_RETAIN_TURNS = 3;

/** A message with any attachment bodies dropped (metadata kept). Same object if nothing to shed. */
export function shedMessage(m: Message): Message {
  if (!m.attachments || !m.attachments.some(hasPayload)) return m;
  return { ...m, attachments: m.attachments.map(shedPayload) };
}

function shedTurn(t: Turn): Turn {
  if (!t.messages.some((m) => m.attachments?.some(hasPayload))) return t;
  return { ...t, messages: t.messages.map(shedMessage) };
}

export interface PersistentStoreOptions {
  /**
   * What `getMessages` hands the next turn: only the recent complete turns
   * (./history-window). Omitted, it is DEFAULT_HISTORY_WINDOW (12 turns / 48h),
   * so a store built without options can't quietly go back to re-sending a whole
   * thread; `null` sends every complete turn (the behaviour before the window).
   * `getTurns` is never windowed, and nothing stored is dropped.
   */
  history?: HistoryWindow | null;
  /** Clock for the window's age limit. Injectable for tests. */
  now?: () => number;
}

/**
 * The server's conversation store: windowed by FLINT_HISTORY_TURNS /
 * FLINT_HISTORY_MAX_AGE_HOURS (./history-window readHistoryWindow), with the
 * window it chose in the log.
 */
export function openConversationStore(
  path: string,
  env: Record<string, string | undefined>,
  log: (msg: string) => void = () => {},
  now?: () => number,
): PersistentStore {
  const history = readHistoryWindow(env, log);
  log(`[memory] chat history window: ${describeHistoryWindow(history)}`);
  return new PersistentStore(path, { history, ...(now ? { now } : {}) });
}

/**
 * Disk-backed MemoryStore — the fix for Flint forgetting everything on restart.
 * Same transactional contract as the in-memory reference impl (begin →
 * commit|fail; only `complete` turns enter history), but every write snapshots
 * to a JSON file under ~/.flint, debounced, with an atomic rename so a crash
 * mid-write can't corrupt history. On boot it loads and zod-validates what was
 * there, so a conversation survives reboots, redeploys, and crashes.
 */
export class PersistentStore implements MemoryStore {
  readonly schemaVersion = SCHEMA_VERSION;
  private readonly conversations = new Map<string, Turn[]>();
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly history: HistoryWindow | null;
  private readonly now: () => number;

  constructor(
    private readonly path: string,
    opts: PersistentStoreOptions = {},
  ) {
    this.history = opts.history === undefined ? { ...DEFAULT_HISTORY_WINDOW } : opts.history;
    this.now = opts.now ?? Date.now;
    this.load();
  }

  /** Every conversation id currently held. Used by the memory extractor to walk
   *  recent history; MemoryStore itself has no enumeration in its contract. */
  conversationIds(): string[] {
    return [...this.conversations.keys()];
  }

  async beginTurn(input: BeginTurnInput): Promise<Turn> {
    const turns = this.conversations.get(input.conversationId) ?? [];
    if (turns.some((t) => t.id === input.turnId)) {
      throw new Error(`Turn ${input.turnId} already exists`);
    }
    const turn = TurnSchema.parse({
      id: input.turnId,
      conversationId: input.conversationId,
      status: 'pending',
      messages: [input.userMessage],
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      ...(input.context !== undefined ? { context: input.context } : {}),
    });
    turns.push(turn);
    // Past the retention window, attachment bodies go (the newest turns keep theirs).
    for (let i = 0; i < turns.length - ATTACHMENT_RETAIN_TURNS; i++) turns[i] = shedTurn(turns[i]!);
    this.conversations.set(input.conversationId, turns);
    this.scheduleSave();
    return structuredClone(turn);
  }

  async commitTurn(input: CommitTurnInput): Promise<Turn> {
    const turn = this.requirePending(input.conversationId, input.turnId);
    const committed = TurnSchema.parse({
      ...turn,
      status: 'complete',
      messages: [...turn.messages, ...input.responseMessages],
      usage: input.usage,
      updatedAt: input.updatedAt,
    });
    this.replace(input.conversationId, committed);
    this.scheduleSave();
    return structuredClone(committed);
  }

  async failTurn(input: FailTurnInput): Promise<Turn> {
    const turn = this.requirePending(input.conversationId, input.turnId);
    const failed = TurnSchema.parse({
      ...turn,
      status: 'failed',
      error: input.error,
      updatedAt: input.updatedAt,
    });
    this.replace(input.conversationId, failed);
    this.scheduleSave();
    return structuredClone(failed);
  }

  /**
   * The context for this conversation's next turn: its complete turns, only the
   * recent ones unless the window is off (`history: null`). Every chat path
   * (Flint.chat on any brain) reads history through here, so they all share it.
   */
  async getMessages(conversationId: string): Promise<Message[]> {
    return this.windowed(this.completeTurns(conversationId))
      .flatMap((t) => t.messages)
      .map((m) => structuredClone(m));
  }

  /**
   * How many complete turns the conversation's next message carries, and how many
   * the window leaves out: the /chat handler sizes the tier classifier's "deep
   * thread" rule with `sent`, and tells the model about `leftOut` (./history-window
   * withHistoryNote).
   */
  historyStats(conversationId: string): HistoryStats {
    const complete = this.completeTurns(conversationId);
    const sent = this.windowed(complete).length;
    return { sent, leftOut: complete.length - sent, window: this.history ? { ...this.history } : null };
  }

  private completeTurns(conversationId: string): Turn[] {
    return (this.conversations.get(conversationId) ?? []).filter((t) => t.status === 'complete');
  }

  private windowed(complete: Turn[]): Turn[] {
    return this.history ? windowTurns(complete, this.history, this.now()) : complete;
  }

  /** Every turn, any status, never windowed: the memory extractor reads the full history here. */
  async getTurns(conversationId: string): Promise<Turn[]> {
    return (this.conversations.get(conversationId) ?? []).map((t) => structuredClone(t));
  }

  // --- internals ------------------------------------------------------------

  private requirePending(conversationId: string, turnId: string): Turn {
    const turn = this.conversations.get(conversationId)?.find((t) => t.id === turnId);
    if (!turn) throw new Error(`Unknown turn ${turnId}`);
    if (turn.status !== 'pending') throw new Error(`Turn ${turnId} is ${turn.status}, expected pending`);
    return turn;
  }

  private replace(conversationId: string, next: Turn): void {
    const turns = this.conversations.get(conversationId);
    if (!turns) return;
    const idx = turns.findIndex((t) => t.id === next.id);
    if (idx >= 0) turns[idx] = next;
  }

  private load(): void {
    try {
      if (!existsSync(this.path)) return;
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as {
        conversations?: Record<string, unknown[]>;
      };
      let restored = 0;
      for (const [id, turns] of Object.entries(raw.conversations ?? {})) {
        const valid: Turn[] = [];
        for (const t of turns) {
          const parsed = TurnSchema.safeParse(t);
          if (parsed.success) valid.push(parsed.data);
        }
        if (valid.length > 0) {
          this.conversations.set(id, valid);
          restored += valid.length;
        }
      }
      console.error(`[memory] restored ${restored} turns across ${this.conversations.size} conversations`);
    } catch (err) {
      console.error('[memory] failed to load conversation store (starting fresh):', err);
    }
  }

  /** Debounced atomic snapshot — coalesces bursts of writes into one flush. */
  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.flush();
    }, 400);
  }

  private flush(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const snapshot = {
        schemaVersion: this.schemaVersion,
        savedAt: Date.now(),
        // Attachment bodies stay in RAM only — see ATTACHMENT_RETAIN_TURNS.
        conversations: Object.fromEntries(
          [...this.conversations].map(([id, turns]) => [id, turns.map(shedTurn)] as const),
        ),
      };
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(snapshot), 'utf8');
      renameSync(tmp, this.path); // atomic on the same filesystem
    } catch (err) {
      console.error('[memory] failed to persist conversation store:', err);
    }
  }
}
