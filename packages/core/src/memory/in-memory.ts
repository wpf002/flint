import { makeAiError } from '../types/error.js';
import { FlintError } from '../types/error.js';
import {
  SCHEMA_VERSION,
  TurnSchema,
  type MemoryStore,
  type Turn,
  type BeginTurnInput,
  type CommitTurnInput,
  type FailTurnInput,
} from './store.js';
import type { Message } from '../types/message.js';

/**
 * The single reference MemoryStore. In-process, non-durable. Proves the
 * transactional contract (invariant #4); real apps swap in a durable store.
 *
 * Transaction model:
 *   beginTurn  → writes a `pending` turn (user message only)
 *   commitTurn → atomically attaches the response and flips to `complete`
 *   failTurn   → flips to `failed`; the turn's messages never enter history
 *
 * `getMessages` returns messages from `complete` turns ONLY, so a failed or
 * still-pending turn can never leave an orphaned user message in the history
 * fed to the next generation.
 */
export class InMemoryStore implements MemoryStore {
  readonly schemaVersion = SCHEMA_VERSION;

  /** conversationId → ordered turns. */
  private readonly conversations = new Map<string, Turn[]>();

  async beginTurn(input: BeginTurnInput): Promise<Turn> {
    const turns = this.conversations.get(input.conversationId) ?? [];

    if (turns.some((t) => t.id === input.turnId)) {
      throw new FlintError(
        makeAiError('internal', `Turn ${input.turnId} already exists`, {
          retryable: false,
        }),
      );
    }

    const turn: Turn = TurnSchema.parse({
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
    return clone(turn);
  }

  async commitTurn(input: CommitTurnInput): Promise<Turn> {
    const turn = this.requirePending(input.conversationId, input.turnId);

    const committed: Turn = TurnSchema.parse({
      ...turn,
      status: 'complete',
      messages: [...turn.messages, ...input.responseMessages],
      usage: input.usage,
      updatedAt: input.updatedAt,
    });

    this.replace(input.conversationId, committed);
    return clone(committed);
  }

  async failTurn(input: FailTurnInput): Promise<Turn> {
    const turn = this.requirePending(input.conversationId, input.turnId);

    const failed: Turn = TurnSchema.parse({
      ...turn,
      status: 'failed',
      error: input.error,
      updatedAt: input.updatedAt,
    });

    this.replace(input.conversationId, failed);
    return clone(failed);
  }

  async getMessages(conversationId: string): Promise<Message[]> {
    const turns = this.conversations.get(conversationId) ?? [];
    return turns
      .filter((t) => t.status === 'complete')
      .flatMap((t) => t.messages)
      .map(clone);
  }

  async getTurns(conversationId: string): Promise<Turn[]> {
    return (this.conversations.get(conversationId) ?? []).map(clone);
  }

  private requirePending(conversationId: string, turnId: string): Turn {
    const turns = this.conversations.get(conversationId);
    const turn = turns?.find((t) => t.id === turnId);
    if (!turn) {
      throw new FlintError(
        makeAiError('internal', `Unknown turn ${turnId}`, { retryable: false }),
      );
    }
    if (turn.status !== 'pending') {
      throw new FlintError(
        makeAiError(
          'internal',
          `Turn ${turnId} is ${turn.status}, expected pending`,
          { retryable: false },
        ),
      );
    }
    return turn;
  }

  private replace(conversationId: string, next: Turn): void {
    const turns = this.conversations.get(conversationId);
    if (!turns) return;
    const idx = turns.findIndex((t) => t.id === next.id);
    if (idx >= 0) turns[idx] = next;
  }
}

/** Defensive deep clone so callers can't mutate stored turns. */
function clone<T>(value: T): T {
  return structuredClone(value);
}
