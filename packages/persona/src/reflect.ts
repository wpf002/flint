import type { Flint, CallOptions } from '@flint/core';
import { parseLessonDrafts, type DraftLesson, type Lesson, type LessonStore } from './lessons.js';

/**
 * The nightly reflection protocol — how Flint grows on his own. It reads a
 * batch of past interactions, asks the model to distill durable lessons, and
 * writes them to the LessonStore. Those lessons then flow into future context
 * via the Persona, so behavior compounds.
 *
 * Runs on whatever provider Flint is configured with — i.e. locally, no cloud.
 * Schedule it nightly with cron/launchd (the OS's job); this is the unit of work
 * it runs.
 */

const REFLECTION_SYSTEM = `You are a reflection process for a personal AI named Flint. You are given a transcript of past interactions with the user. Extract DURABLE lessons that should change how Flint behaves in the future.

Only keep lessons that are:
- corrections the user made,
- stable preferences the user revealed,
- durable facts about the user or their world,
- mistakes Flint made and should avoid,
- genuinely reusable insights.

Ignore one-off task details, transient context, and anything not reusable.

Output ONLY a JSON array, no prose, in this exact shape:
[{"category": "correction|preference|fact|mistake|insight", "text": "<concise imperative lesson>"}]

If there is nothing durable to learn, output [].`;

export interface ReflectInput {
  flint: Flint;
  /** The interactions to reflect on (e.g. a day's messages from MemoryStore). */
  messages: Array<{ role: string; content: string }>;
  lessonStore: LessonStore;
  /** Timestamp to stamp new lessons with (injected; keeps reflect testable). */
  now: number;
  /** Tag new lessons with their source conversation, if known. */
  conversationId?: string;
  /** Override model/options for the reflection call. */
  options?: CallOptions;
}

export interface ReflectResult {
  learned: Lesson[];
  /** Drafts the model proposed before dedupe (for inspection). */
  proposed: DraftLesson[];
}

/** Distill durable lessons from a transcript and persist the new ones. */
export async function reflect(input: ReflectInput): Promise<ReflectResult> {
  const transcript = input.messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
    .join('\n\n');

  if (transcript.trim().length === 0) {
    return { learned: [], proposed: [] };
  }

  const { text } = await input.flint.generate(
    { system: REFLECTION_SYSTEM, prompt: transcript },
    input.options,
  );

  const proposed = parseLessonDrafts(text, input.conversationId);
  const learned = await input.lessonStore.add(proposed, input.now);
  return { learned, proposed };
}
