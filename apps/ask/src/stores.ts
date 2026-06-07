import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  SCHEMA_VERSION,
  TurnSchema,
  type MemoryStore,
  type Turn,
  type BeginTurnInput,
  type CommitTurnInput,
  type FailTurnInput,
  type Message,
} from '@flint/core';
import type { LessonStore, Lesson, DraftLesson } from '@flint/persona';

/**
 * Durable JSON-file stores — the "app's job" persistence the reference in-memory
 * impls leave open. These are what make Flint actually accumulate memory and
 * lessons across runs (without them, nightly evolution resets every night).
 * Simple sync file IO; fine for a single-user CLI.
 */

function loadJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function saveJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
}

interface MemoryFile {
  schemaVersion: number;
  conversations: Record<string, Turn[]>;
}

/** File-backed MemoryStore — same transactional rules as InMemoryStore. */
export class FileMemoryStore implements MemoryStore {
  readonly schemaVersion = SCHEMA_VERSION;
  private data: MemoryFile;

  constructor(private readonly path: string) {
    this.data = loadJson<MemoryFile>(path, {
      schemaVersion: SCHEMA_VERSION,
      conversations: {},
    });
  }

  async beginTurn(input: BeginTurnInput): Promise<Turn> {
    const turns = this.data.conversations[input.conversationId] ?? [];
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
    this.data.conversations[input.conversationId] = turns;
    this.save();
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
    this.save();
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
    this.save();
    return structuredClone(failed);
  }

  async getMessages(conversationId: string): Promise<Message[]> {
    return (this.data.conversations[conversationId] ?? [])
      .filter((t) => t.status === 'complete')
      .flatMap((t) => t.messages)
      .map((m) => structuredClone(m));
  }

  async getTurns(conversationId: string): Promise<Turn[]> {
    return (this.data.conversations[conversationId] ?? []).map((t) => structuredClone(t));
  }

  private requirePending(conversationId: string, turnId: string): Turn {
    const turn = this.data.conversations[conversationId]?.find((t) => t.id === turnId);
    if (!turn) throw new Error(`Unknown turn ${turnId}`);
    if (turn.status !== 'pending') {
      throw new Error(`Turn ${turnId} is ${turn.status}, expected pending`);
    }
    return turn;
  }

  private replace(conversationId: string, next: Turn): void {
    const turns = this.data.conversations[conversationId];
    if (!turns) return;
    const idx = turns.findIndex((t) => t.id === next.id);
    if (idx >= 0) turns[idx] = next;
  }

  private save(): void {
    saveJson(this.path, this.data);
  }
}

interface LessonFile {
  lessons: Lesson[];
}

/** File-backed LessonStore — dedupes by text, persists across runs. */
export class FileLessonStore implements LessonStore {
  private data: LessonFile;

  constructor(private readonly path: string) {
    this.data = loadJson<LessonFile>(path, { lessons: [] });
  }

  async add(drafts: DraftLesson[], now: number): Promise<Lesson[]> {
    const added: Lesson[] = [];
    for (const d of drafts) {
      const text = d.text.trim();
      if (text.length === 0) continue;
      if (this.data.lessons.some((l) => l.text.trim().toLowerCase() === text.toLowerCase())) {
        continue;
      }
      const lesson: Lesson = {
        id: randomUUID(),
        category: d.category,
        text,
        createdAt: now,
        ...(d.sourceConversationId ? { sourceConversationId: d.sourceConversationId } : {}),
      };
      this.data.lessons.push(lesson);
      added.push(lesson);
    }
    if (added.length > 0) this.save();
    return added.map((l) => structuredClone(l));
  }

  async all(): Promise<Lesson[]> {
    return this.data.lessons.map((l) => structuredClone(l));
  }

  async recent(n: number): Promise<Lesson[]> {
    return [...this.data.lessons]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, n)
      .map((l) => structuredClone(l));
  }

  async replace(lessons: Lesson[]): Promise<void> {
    this.data.lessons = lessons.map((l) => structuredClone(l));
    this.save();
  }

  private save(): void {
    saveJson(this.path, this.data);
  }
}
