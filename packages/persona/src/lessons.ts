import { randomUUID } from 'node:crypto';

/**
 * The self-evolution memory. Lessons are durable behavioral takeaways distilled
 * from past interactions — corrections, preferences, facts about the user,
 * mistakes to avoid. They are injected into the persona's system prompt so
 * Flint's behavior compounds over time instead of resetting every session.
 *
 * This is what makes Flint "grow": raw conversations (MemoryStore) → nightly
 * reflection (reflect()) → distilled lessons (here) → future context.
 */

export type LessonCategory =
  | 'correction' // the user corrected something; don't repeat the error
  | 'preference' // how the user likes things done
  | 'fact' // a durable fact about the user or their world
  | 'mistake' // an error Flint made, to avoid
  | 'insight'; // a useful generalization worth keeping

export interface Lesson {
  id: string;
  category: LessonCategory;
  /** A concise, imperative, durable takeaway. */
  text: string;
  /** Where it came from, if known. */
  sourceConversationId?: string;
  createdAt: number;
}

/** A new lesson before it's persisted (no id yet). */
export interface DraftLesson {
  category: LessonCategory;
  text: string;
  sourceConversationId?: string;
}

/**
 * Persistence seam for lessons. Ships an in-memory reference impl; a real
 * deployment backs this with a durable store (the same way MemoryStore works in
 * @flint/core). Implement this interface to persist across nights.
 */
export interface LessonStore {
  /** Add drafts; returns the persisted lessons (deduped by text). */
  add(drafts: DraftLesson[], now: number): Promise<Lesson[]>;
  /** All lessons, oldest first. */
  all(): Promise<Lesson[]>;
  /** The most recent `n` lessons, newest first. */
  recent(n: number): Promise<Lesson[]>;
  /** Replace the entire set (used by consolidate to curate duplicates). */
  replace(lessons: Lesson[]): Promise<void>;
}

const VALID_CATEGORIES: ReadonlySet<LessonCategory> = new Set([
  'correction',
  'preference',
  'fact',
  'mistake',
  'insight',
]);

/**
 * Tolerantly parse a model's JSON output into lesson drafts. Shared by reflect()
 * and consolidate(); handles code fences, surrounding prose, trailing commas,
 * and single quotes. Returns [] on anything unparseable.
 */
export function parseLessonDrafts(text: string, sourceConversationId?: string): DraftLesson[] {
  const raw = findJsonArray(stripFences(text));
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    try {
      parsed = JSON.parse(raw.replace(/,\s*([}\]])/g, '$1').replace(/'/g, '"'));
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];

  const drafts: DraftLesson[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const lessonText = rec.text;
    if (typeof lessonText !== 'string' || lessonText.trim().length === 0) continue;
    const cat: LessonCategory =
      typeof rec.category === 'string' && VALID_CATEGORIES.has(rec.category as LessonCategory)
        ? (rec.category as LessonCategory)
        : 'insight';
    drafts.push({
      category: cat,
      text: lessonText.trim(),
      ...(sourceConversationId ? { sourceConversationId } : {}),
    });
  }
  return drafts;
}

function stripFences(text: string): string {
  return text.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
}

function findJsonArray(text: string): string | null {
  const start = text.indexOf('[');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export class InMemoryLessonStore implements LessonStore {
  private readonly lessons: Lesson[] = [];

  constructor(initial: Lesson[] = []) {
    this.lessons.push(...initial);
  }

  async add(drafts: DraftLesson[], now: number): Promise<Lesson[]> {
    const added: Lesson[] = [];
    for (const d of drafts) {
      const text = d.text.trim();
      if (text.length === 0) continue;
      // Dedupe: skip if we already hold an equivalent lesson.
      if (this.lessons.some((l) => l.text.trim().toLowerCase() === text.toLowerCase())) {
        continue;
      }
      const lesson: Lesson = {
        id: randomUUID(),
        category: d.category,
        text,
        createdAt: now,
        ...(d.sourceConversationId ? { sourceConversationId: d.sourceConversationId } : {}),
      };
      this.lessons.push(lesson);
      added.push(lesson);
    }
    return added.map(clone);
  }

  async all(): Promise<Lesson[]> {
    return this.lessons.map(clone);
  }

  async recent(n: number): Promise<Lesson[]> {
    return [...this.lessons]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, n)
      .map(clone);
  }

  async replace(lessons: Lesson[]): Promise<void> {
    this.lessons.length = 0;
    this.lessons.push(...lessons.map(clone));
  }

  get size(): number {
    return this.lessons.length;
  }
}

function clone<T>(v: T): T {
  return structuredClone(v);
}
