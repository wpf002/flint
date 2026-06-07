import { randomUUID } from 'node:crypto';
import type { Flint, CallOptions } from '@flint/core';
import { parseLessonDrafts, type Lesson, type LessonStore } from './lessons.js';

/**
 * Lesson curation. Reflection only dedupes by exact text, so reworded variants
 * of the same lesson pile up over nights. consolidate() asks the model to merge
 * near-duplicates and drop redundant/contradicted lessons into a clean canonical
 * set, then replaces the store. Run it after reflect() in the nightly job.
 *
 * Runs on the configured (local) provider. Conservative: on any parse failure or
 * an empty result it leaves the store untouched rather than wiping it.
 */

const CONSOLIDATE_SYSTEM = `You are curating the memory of a personal AI named Flint. You are given his current list of learned lessons. Produce a CLEAN, consolidated set.

Rules:
- If two or more lessons express the SAME underlying preference, fact, or rule about the SAME topic, they are duplicates — MERGE them into a single canonical lesson, even if the wording is completely different.
  Example: "Always use TS strict mode", "Enable TypeScript strict mode globally", and "User prefers strict mode on" are ONE lesson.
- Drop lessons fully contained in another.
- If two contradict, keep the more specific one.
- Be aggressive about merging; the output should have NO two lessons about the same topic. But do not invent lessons that weren't in the input.

Output ONLY a JSON array, no prose, in this exact shape:
[{"category": "correction|preference|fact|mistake|insight", "text": "<canonical lesson>"}]`;

export interface ConsolidateInput {
  flint: Flint;
  lessonStore: LessonStore;
  /** Timestamp for any newly-canonicalized lessons. */
  now: number;
  /** Don't bother consolidating below this many lessons. Default 3. */
  minToRun?: number;
  options?: CallOptions;
}

export interface ConsolidateResult {
  before: number;
  after: number;
  lessons: Lesson[];
  /** True if the store was actually rewritten. */
  changed: boolean;
}

export async function consolidate(input: ConsolidateInput): Promise<ConsolidateResult> {
  const existing = await input.lessonStore.all();
  const minToRun = input.minToRun ?? 3;

  if (existing.length < minToRun) {
    return { before: existing.length, after: existing.length, lessons: existing, changed: false };
  }

  const listing = existing.map((l) => `- (${l.category}) ${l.text}`).join('\n');
  const { text } = await input.flint.generate(
    { system: CONSOLIDATE_SYSTEM, prompt: listing },
    input.options,
  );

  const drafts = parseLessonDrafts(text);
  // Safety: never let a bad parse wipe the store.
  if (drafts.length === 0) {
    return { before: existing.length, after: existing.length, lessons: existing, changed: false };
  }

  // Preserve ids/createdAt for lessons whose text is unchanged; mint new ones otherwise.
  const byText = new Map(existing.map((l) => [l.text.trim().toLowerCase(), l]));
  const seen = new Set<string>();
  const curated: Lesson[] = [];
  for (const d of drafts) {
    const key = d.text.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const prior = byText.get(key);
    curated.push(
      prior ?? {
        id: randomUUID(),
        category: d.category,
        text: d.text.trim(),
        createdAt: input.now,
      },
    );
  }

  await input.lessonStore.replace(curated);
  return {
    before: existing.length,
    after: curated.length,
    lessons: curated,
    changed: curated.length !== existing.length,
  };
}
