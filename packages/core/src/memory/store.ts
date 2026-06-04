import { z } from 'zod';
import { MessageSchema, type Message } from '../types/message.js';
import { TokenUsageSchema, type TokenUsage } from '../types/stream.js';
import { AiErrorSchema, type AiError } from '../types/error.js';

/** Current persisted schema version. Stamped on every store (invariant #4). */
export const SCHEMA_VERSION = 1;

export const TurnStatus = z.enum(['pending', 'complete', 'failed']);
export type TurnStatus = z.infer<typeof TurnStatus>;

/**
 * A Turn is the transactional unit: the user message and its assistant
 * response (plus any intermediate tool messages) committed together or not at
 * all (invariant #4). Only `complete` turns contribute to conversation history.
 */
export const TurnSchema = z.object({
  id: z.string().min(1),
  conversationId: z.string().min(1),
  status: TurnStatus,
  /** Ordered messages for this turn. While `pending`, holds just the user message. */
  messages: z.array(MessageSchema),
  usage: TokenUsageSchema.optional(),
  error: AiErrorSchema.optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  /** Opaque app context captured at turn start; never interpreted by Flint. */
  context: z.unknown().optional(),
});

export type Turn = z.infer<typeof TurnSchema>;

export interface BeginTurnInput {
  conversationId: string;
  turnId: string;
  userMessage: Message;
  createdAt: number;
  context?: unknown;
}

export interface CommitTurnInput {
  conversationId: string;
  turnId: string;
  /** Assistant + tool messages produced during the turn. */
  responseMessages: Message[];
  usage: TokenUsage;
  updatedAt: number;
}

export interface FailTurnInput {
  conversationId: string;
  turnId: string;
  error: AiError;
  updatedAt: number;
}

/**
 * Persistence seam. `@flint/core` ships the interface plus one in-memory
 * reference impl; durable persistence (DB, Redis, etc.) is the app's job
 * (spec §12). All implementations MUST:
 *  - validate persisted objects with zod at the boundary (invariant #7),
 *  - expose only `complete` turns through `getMessages`,
 *  - implement begin → (commit | fail) as an atomic transition.
 */
export interface MemoryStore {
  readonly schemaVersion: number;

  /** Open a transaction: record a `pending` turn holding the user message. */
  beginTurn(input: BeginTurnInput): Promise<Turn>;

  /** Commit: attach response messages and flip `pending` → `complete`. */
  commitTurn(input: CommitTurnInput): Promise<Turn>;

  /** Abort: flip `pending` → `failed`. The user message must NOT survive in history. */
  failTurn(input: FailTurnInput): Promise<Turn>;

  /** Ordered messages from `complete` turns only — the context for the next turn. */
  getMessages(conversationId: string): Promise<Message[]>;

  /** All turns (any status) for inspection / debugging. */
  getTurns(conversationId: string): Promise<Turn[]>;
}
