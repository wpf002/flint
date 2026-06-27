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
} from '@flint/core';

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

  constructor(private readonly path: string) {
    this.load();
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

  async getMessages(conversationId: string): Promise<Message[]> {
    return (this.conversations.get(conversationId) ?? [])
      .filter((t) => t.status === 'complete')
      .flatMap((t) => t.messages)
      .map((m) => structuredClone(m));
  }

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
        conversations: Object.fromEntries(this.conversations),
      };
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(snapshot), 'utf8');
      renameSync(tmp, this.path); // atomic on the same filesystem
    } catch (err) {
      console.error('[memory] failed to persist conversation store:', err);
    }
  }
}
