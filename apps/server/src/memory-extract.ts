import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import type { Persona } from '@flint/persona';
import type { KnowledgeStore } from './knowledge';
import type { PersistentStore } from './persistent-store';

/**
 * Automatic long-term memory.
 *
 * THE PROBLEM THIS SOLVES: `remember` was the only writer to the KnowledgeStore,
 * and it only fires when the model spontaneously elects to call an optional tool
 * while competing with ~38 other schemas. The result, measured: 9 facts stored
 * against 1,421 real turns — roughly two remembered things in a month of daily
 * use. The recall path was excellent and starved of input. Flint's whole
 * personal moat is this store, so a store that does not grow is the single
 * biggest thing holding the "own brain" goal back.
 *
 * WHAT THIS DOES: periodically re-reads the conversation turns written since the
 * last pass, asks the frontier brain to pull out the DURABLE facts about Will,
 * and writes them through `KnowledgeStore.add` — which already dedupes and
 * rejects timestamp/ephemeral junk, so this is safe to run unattended.
 *
 * Deliberately conservative: it only ever ADDS facts, never edits or deletes,
 * and a bad pass costs a few junk rows that `forget` can remove — not damage.
 */

interface ExtractState {
  /** Highest turn `updatedAt` already processed, per conversation. */
  watermarks: Record<string, number>;
}

const EXTRACT_PROMPT = `Below are recent turns from conversations between Will and his assistant.

Pull out DURABLE FACTS ABOUT WILL worth remembering months from now: his projects and what they do, decisions he made and why, his stated preferences and constraints, people and systems he works with, hardware he owns, goals he set.

STRICT RULES:
- Only facts that are STILL TRUE LATER. No dates, times, "currently", "today", "right now", weather, prices, scores, or anything that expires.
- Only what Will actually said or clearly established. NEVER infer or invent personal details (pets, family, teams, tastes) — a wrong fact in permanent memory is worse than a missing one.
- Nothing about the assistant itself, and nothing about this extraction task.
- Each fact stands alone, one sentence, no pronouns without antecedents ("Will bought a Mac Studio M4 Max with 64GB", not "he bought it").
- If there is nothing durable, return an empty array. That is a fine answer and the common one.

Return ONLY a JSON array of strings. No prose, no code fence.`;

export class MemoryExtractor {
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly memory: PersistentStore,
    private readonly knowledge: KnowledgeStore,
    private readonly persona: () => Persona | undefined,
    private readonly statePath: string,
    private readonly everyMs = Number(process.env.FLINT_EXTRACT_INTERVAL_MS ?? 6 * 60 * 60 * 1000),
  ) {}

  start(): void {
    if (this.timer) return;
    // First pass shortly after boot, then on the interval. Unref'd so it never
    // holds the process open.
    const kick = setTimeout(() => void this.runSafe(), 90_000);
    kick.unref?.();
    this.timer = setInterval(() => void this.runSafe(), this.everyMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async runSafe(): Promise<void> {
    try {
      await this.run();
    } catch (err) {
      console.error('[memory-extract] pass failed:', err);
    }
  }

  /** One extraction pass. Returns how many new facts were stored. */
  async run(): Promise<number> {
    const persona = this.persona();
    if (!persona) return 0; // no frontier configured — skip rather than use the 7B

    const state = this.loadState();
    const chunks: string[] = [];
    const nextMarks: Record<string, number> = { ...state.watermarks };

    for (const cid of this.memory.conversationIds()) {
      const since = state.watermarks[cid] ?? 0;
      const turns = await this.memory.getTurns(cid);
      const fresh = turns.filter((t) => t.status === 'complete' && t.updatedAt > since);
      if (fresh.length === 0) continue;
      nextMarks[cid] = Math.max(since, ...fresh.map((t) => t.updatedAt));

      for (const t of fresh) {
        const user = t.messages.find((m) => m.role === 'user')?.content ?? '';
        const asst = t.messages.filter((m) => m.role === 'assistant').map((m) => m.content).join(' ');
        if (!user.trim()) continue;
        // The user's own words carry the facts; the answer is context only, and
        // clipped hard so one long reply can't crowd out the rest of the batch.
        chunks.push(`WILL: ${clip(user, 1200)}\nASSISTANT: ${clip(asst, 400)}`);
      }
    }

    if (chunks.length === 0) return 0;

    let stored = 0;
    // Batch so a busy week doesn't become one enormous prompt.
    for (const batch of batches(chunks, 25)) {
      const out = await persona.generate({
        prompt: `${EXTRACT_PROMPT}\n\n---\n${batch.join('\n\n---\n')}`,
      });
      for (const fact of parseFacts(out.text)) {
        if (await this.knowledge.add(fact, 'history')) stored++;
      }
    }

    this.saveState({ watermarks: nextMarks });
    if (stored > 0) console.error(`[memory-extract] stored ${stored} new fact(s) from ${chunks.length} turn(s)`);
    return stored;
  }

  private loadState(): ExtractState {
    if (!existsSync(this.statePath)) return { watermarks: {} };
    try {
      const raw = JSON.parse(readFileSync(this.statePath, 'utf8')) as Partial<ExtractState>;
      return { watermarks: raw.watermarks ?? {} };
    } catch {
      return { watermarks: {} };
    }
  }

  private saveState(s: ExtractState): void {
    try {
      writeFileSync(this.statePath, JSON.stringify(s), 'utf8');
    } catch (err) {
      console.error('[memory-extract] could not persist watermarks:', err);
    }
  }
}

function clip(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

function* batches<T>(items: T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}

/**
 * Tolerant parse of the model's JSON array. Models wrap it in a fence or add a
 * sentence often enough that failing closed here would silently mean "memory
 * never grows" — the exact bug this file exists to fix.
 */
export function parseFacts(text: string): string[] {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced?.[1] ?? text;
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start === -1 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((f): f is string => typeof f === 'string')
    .map((f) => f.trim())
    .filter((f) => f.length >= 8 && f.length <= 400);
}
