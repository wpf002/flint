import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Turn } from '@flint/core';
import type { KnowledgeStore } from './knowledge';

/**
 * Automatic long-term memory.
 *
 * THE PROBLEM THIS SOLVES: `remember` was the only writer to the KnowledgeStore,
 * and it only fires when the model spontaneously elects to call an optional tool
 * while competing with ~38 other schemas. So this re-reads the conversation
 * turns written since the last pass, asks the frontier brain to pull out the
 * DURABLE facts about Will, and writes them through `KnowledgeStore.addDetailed`
 * — which dedupes, honours tombstones and rejects ephemeral junk.
 *
 * WHY v1 YIELDED ALMOST NOTHING (measured on the live store, 2026-09-23): of
 * 1,478 stored turns only 638 were complete, and 417 of those were synthetic
 * training-corpus prompts (bulk-/grow-/seed- conversations: "how does a
 * catalytic converter work?") — pure spend, zero facts about Will. Of the ~221
 * real turns, most were repeated probes ("weather in Dallas right now" ×40,
 * "say OK"). The few fact-bearing turns were judged one at a time with no
 * surrounding context ("September 25–October 3 is when it's scheduled to be
 * delivered" is meaningless without the previous turn), through Flint's full
 * persona system prompt, under an instruction that an empty array is "the
 * common answer", and prose or truncated output silently parsed as [] while the
 * watermark advanced anyway. Net: 2 facts from the whole backlog.
 *
 * v2: skip synthetic conversations and trivial/duplicate probes, give each turn
 * its preceding turn as context, extract with a dedicated curator system prompt
 * (not the persona), show the model the facts it already has so it can SUPERSEDE
 * stale ones instead of piling contradictions, record provenance (conversation +
 * turn time), never advance past a batch whose output could not be parsed, and
 * cap spend per day. Bumping EXTRACT_VERSION re-walks old turns under the new
 * rules — resumable via the per-conversation watermarks, rate-limited by the
 * daily call budget, and idempotent because the store dedupes.
 */

/** Anything with a Flint-style `generate` — the frontier Flint in production. */
export interface ExtractBrain {
  generate(input: { system: string; prompt: string }): Promise<{ text: string }>;
}

/** The slice of PersistentStore the extractor reads. */
export interface TurnSource {
  conversationIds(): string[];
  getTurns(conversationId: string): Promise<Turn[]>;
}

/** Bump when extraction rules change enough to be worth re-reading history. */
export const EXTRACT_VERSION = 2;

interface ExtractState {
  version: number;
  /** Highest turn `updatedAt` already processed, per conversation. */
  watermarks: Record<string, number>;
  /** Frontier calls made on `day` (UTC date) — the spend cap. */
  budget: { day: string; calls: number };
  /** Consecutive unparseable outputs for the batch starting at `key`. */
  failures?: { key: string; count: number };
  /** Lifetime counters, for anyone asking "is memory actually growing?". */
  totals: PassStats;
}

export interface PassStats {
  turnsSeen: number;
  skippedSynthetic: number;
  skippedTrivial: number;
  skippedDuplicate: number;
  turnsSent: number;
  calls: number;
  unparseable: number;
  candidates: number;
  stored: number;
  superseded: number;
  rejected: Record<string, number>;
}

function emptyStats(): PassStats {
  return {
    turnsSeen: 0,
    skippedSynthetic: 0,
    skippedTrivial: 0,
    skippedDuplicate: 0,
    turnsSent: 0,
    calls: 0,
    unparseable: 0,
    candidates: 0,
    stored: 0,
    superseded: 0,
    rejected: {},
  };
}

export const EXTRACT_SYSTEM = `You are the memory curator for Flint, Will's personal AI. You read transcripts of Will talking to Flint and write the durable facts Flint should still know about Will months from now. You never chat; you output JSON only.`;

const EXTRACT_PROMPT = `Extract DURABLE FACTS about Will from the conversation turns below.

Worth keeping — anything specific that would still be true and useful months from now:
- his projects and systems: what they are, what they do, how they're built, their status and decisions about them
- his preferences, habits, constraints, and opinions he stated
- people in his life or work (names and how they relate to him)
- hardware, accounts, tools and services he owns or uses
- goals and plans he committed to (with the target date if he gave one)

Rules:
- Only what WILL said or clearly confirmed. The assistant's answers are context, not evidence: never turn an assistant claim, guess or search result into a fact about Will.
- Never infer or embellish personal details. "My team is the Astros" is a fact; guessing his pets, family or tastes from a question he asked is not.
- A question is not a fact. "Will asked about UFC 329" is worthless; skip it.
- No expiring details: weather, prices, scores, what he's doing today, "right now", "currently".
- Nothing about Flint's own behaviour, tests, bugs or this extraction task.
- Each fact is ONE standalone sentence in the third person naming Will ("Will's friend Tanner …", not "he" or "my"). Be specific: include names, numbers, dates he gave.
- Do not repeat a KNOWN FACT. If a turn UPDATES or CONTRADICTS a known fact, write the corrected fact and list the old fact's id in "supersedes".
- Returning [] is correct when a batch has nothing durable. Do not pad.

Output ONLY a JSON array, no prose, no code fence:
[{"fact": "...", "category": "project|system|preference|person|hardware|goal|decision|other", "turn": <number of the turn it came from>, "supersedes": ["k12"]}]`;

interface Item {
  cid: string;
  at: number;
  /** Non-empty when this turn is sent to the model. */
  chunk: string;
  skip?: 'synthetic' | 'trivial' | 'duplicate';
}

export interface ExtractorOptions {
  /** Base interval between passes. */
  everyMs?: number;
  /** Interval while a backlog remains and the day's budget isn't spent. */
  backlogEveryMs?: number;
  /** Turns sent per pass. */
  maxTurnsPerPass?: number;
  /** Frontier calls per UTC day — the spend cap. */
  maxCallsPerDay?: number;
  /** Prompt characters of transcript per call. */
  batchChars?: number;
  /** Conversations never mined — synthetic training-corpus traffic. */
  skipConversations?: RegExp;
  now?: () => number;
}

export class MemoryExtractor {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private stopped = true;
  private readonly everyMs: number;
  private readonly backlogEveryMs: number;
  private readonly maxTurnsPerPass: number;
  private readonly maxCallsPerDay: number;
  private readonly batchChars: number;
  private readonly skipConversations: RegExp;
  private readonly now: () => number;
  /** Whether the last pass left work queued (drives the faster backlog cadence). */
  private backlog = false;
  lastStats: PassStats = emptyStats();

  constructor(
    private readonly memory: TurnSource,
    private readonly knowledge: KnowledgeStore,
    private readonly brain: () => ExtractBrain | undefined,
    private readonly statePath: string,
    opts: ExtractorOptions = {},
  ) {
    const env = (k: string, d: number) => {
      const v = Number(process.env[k]);
      return Number.isFinite(v) && v > 0 ? v : d;
    };
    this.everyMs = opts.everyMs ?? env('FLINT_EXTRACT_INTERVAL_MS', 6 * 60 * 60 * 1000);
    this.backlogEveryMs = opts.backlogEveryMs ?? env('FLINT_EXTRACT_BACKLOG_INTERVAL_MS', 15 * 60 * 1000);
    this.maxTurnsPerPass = opts.maxTurnsPerPass ?? env('FLINT_EXTRACT_MAX_TURNS', 60);
    this.maxCallsPerDay = opts.maxCallsPerDay ?? env('FLINT_EXTRACT_MAX_CALLS_PER_DAY', 24);
    this.batchChars = opts.batchChars ?? env('FLINT_EXTRACT_BATCH_CHARS', 24_000);
    this.skipConversations =
      opts.skipConversations ?? new RegExp(process.env.FLINT_EXTRACT_SKIP_CONVERSATIONS ?? '^(bulk|grow|seed)-');
    this.now = opts.now ?? Date.now;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    // First pass shortly after boot. Unref'd so it never holds the process open.
    this.schedule(90_000);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.runSafe().finally(() => this.schedule(this.backlog ? this.backlogEveryMs : this.everyMs));
    }, ms);
    this.timer.unref?.();
  }

  private async runSafe(): Promise<void> {
    try {
      await this.run();
    } catch (err) {
      console.error('[memory-extract] pass failed:', err);
    }
  }

  /**
   * One extraction pass. Returns how many new facts were stored.
   *
   * Takes the OLDEST unprocessed turns up to the per-pass cap (and the day's call
   * budget) and advances each conversation's watermark only over what it
   * actually handled, so the backlog is worked off a slice at a time and an
   * interrupted pass loses at most one batch.
   */
  async run(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      return await this.pass();
    } finally {
      this.running = false;
    }
  }

  private async pass(): Promise<number> {
    const stats = emptyStats();
    this.lastStats = stats;
    const brain = this.brain();
    if (!brain) return 0; // no frontier configured — skip rather than use the 7B

    const state = this.loadState();
    const today = new Date(this.now()).toISOString().slice(0, 10);
    if (state.budget.day !== today) state.budget = { day: today, calls: 0 };

    const pending = await this.collect(state, stats);
    if (pending.length === 0) {
      this.backlog = false;
      this.saveState(state);
      return 0;
    }
    if (state.budget.calls >= this.maxCallsPerDay) {
      console.error(`[memory-extract] daily budget spent (${state.budget.calls}/${this.maxCallsPerDay} calls); ${pending.length} turn(s) queued`);
      this.backlog = false; // nothing to do until tomorrow; base cadence
      this.saveState(state);
      return 0;
    }

    let sent = 0;
    let idx = 0;
    try {
      while (idx < pending.length) {
        // Assemble the next batch: skipped items ride along (they only move the
        // watermark), sent items fill up to the char budget.
        const batch: Item[] = [];
        let chars = 0;
        let j = idx;
        while (j < pending.length) {
          const it = pending[j]!;
          if (!it.skip) {
            if (sent + batch.filter((b) => !b.skip).length >= this.maxTurnsPerPass) break;
            if (chars > 0 && chars + it.chunk.length > this.batchChars) break;
            chars += it.chunk.length;
          }
          batch.push(it);
          j++;
        }
        if (batch.length === 0) break; // per-pass cap reached
        const toSend = batch.filter((b) => !b.skip);

        if (toSend.length > 0) {
          if (state.budget.calls >= this.maxCallsPerDay) break;
          const key = `${toSend[0]!.cid}@${toSend[0]!.at}`;
          state.budget.calls++;
          stats.calls++;
          const out = await brain.generate({ system: EXTRACT_SYSTEM, prompt: this.prompt(toSend) });
          const cands = parseCandidates(out.text);
          if (cands === null) {
            stats.unparseable++;
            const count = state.failures?.key === key ? state.failures.count + 1 : 1;
            if (count < 3) {
              // Don't advance: the turns are retried next pass instead of being
              // silently marked done with nothing extracted.
              state.failures = { key, count };
              console.error(`[memory-extract] unparseable output (attempt ${count}/3); will retry: ${clip(out.text, 160)}`);
              break;
            }
            console.error('[memory-extract] batch unparseable 3 times; skipping it');
            delete state.failures;
          } else {
            delete state.failures;
            await this.store(cands, toSend, stats);
          }
          sent += toSend.length;
          stats.turnsSent += toSend.length;
        }
        // Advance per batch so a mid-pass failure keeps the progress already paid for.
        for (const b of batch) state.watermarks[b.cid] = Math.max(state.watermarks[b.cid] ?? 0, b.at);
        idx = j;
        this.saveState(state);
      }
    } finally {
      this.backlog = idx < pending.length && state.budget.calls < this.maxCallsPerDay;
      addStats(state.totals, stats);
      this.saveState(state);
    }

    const rej = Object.entries(stats.rejected).map(([k, v]) => `${k}=${v}`).join(' ') || 'none';
    console.error(
      `[memory-extract] v${EXTRACT_VERSION} pass: sent ${stats.turnsSent} turn(s) in ${stats.calls} call(s) ` +
        `(skipped synthetic=${stats.skippedSynthetic} trivial=${stats.skippedTrivial} duplicate=${stats.skippedDuplicate}); ` +
        `${stats.candidates} candidate(s) → stored ${stats.stored}, superseded ${stats.superseded}, rejected ${rej}` +
        `${stats.unparseable ? `, unparseable ${stats.unparseable}` : ''}; ${pending.length - idx} turn(s) still queued; ` +
        `budget ${state.budget.calls}/${this.maxCallsPerDay} today`,
    );
    return stats.stored;
  }

  /** Every unprocessed complete turn, oldest conversation first, in order. */
  private async collect(state: ExtractState, stats: PassStats): Promise<Item[]> {
    const convs: Item[][] = [];
    const seenUser = new Set<string>();
    for (const cid of this.memory.conversationIds()) {
      const since = state.watermarks[cid] ?? 0;
      const turns = (await this.memory.getTurns(cid)).filter((t) => t.status === 'complete');
      const items: Item[] = [];
      let prev: Turn | undefined;
      for (const t of turns) {
        if (t.updatedAt > since) {
          stats.turnsSeen++;
          const user = t.messages.find((m) => m.role === 'user')?.content ?? '';
          const asst = t.messages.filter((m) => m.role === 'assistant').map((m) => m.content).join(' ');
          const norm = user.toLowerCase().replace(/[^a-z0-9 ]+/g, '').replace(/\s+/g, ' ').trim();
          let skip: Item['skip'];
          if (this.skipConversations.test(cid)) skip = 'synthetic';
          else if (norm.split(' ').filter(Boolean).length < 3) skip = 'trivial';
          else if (seenUser.has(norm)) skip = 'duplicate';
          if (skip === 'synthetic') stats.skippedSynthetic++;
          else if (skip === 'trivial') stats.skippedTrivial++;
          else if (skip === 'duplicate') stats.skippedDuplicate++;
          else seenUser.add(norm);
          // The user's words carry the facts; the answer and the previous turn
          // are context, clipped so one long reply can't crowd out the batch.
          const before = prev
            ? `(earlier in this conversation — WILL: ${clip(prev.messages.find((m) => m.role === 'user')?.content ?? '', 300)} / ASSISTANT: ${clip(prev.messages.filter((m) => m.role === 'assistant').map((m) => m.content).join(' '), 300)})\n`
            : '';
          items.push(
            skip
              ? { cid, at: t.updatedAt, chunk: '', skip }
              : { cid, at: t.updatedAt, chunk: `${before}WILL: ${clip(user, 1500)}\nASSISTANT: ${clip(asst, 600)}` },
          );
        }
        prev = t;
      }
      if (items.length) convs.push(items);
    }
    // Oldest conversation first; turns stay together and in order, so a
    // conversation's watermark is always a clean cut.
    convs.sort((a, b) => a[0]!.at - b[0]!.at);
    return convs.flat();
  }

  private prompt(items: Item[]): string {
    const known = this.knownFacts(items);
    const knownBlock = known.length
      ? known.map((f) => `${f.id}: ${f.text}`).join('\n')
      : '(none yet)';
    const turns = items
      .map((it, i) => `### Turn ${i + 1} (${new Date(it.at).toISOString().slice(0, 10)})\n${it.chunk}`)
      .join('\n\n');
    return `${EXTRACT_PROMPT}\n\nKNOWN FACTS (id: text):\n${knownBlock}\n\nTURNS:\n\n${turns}`;
  }

  /** The known facts worth showing the model: all of them while the store is
   *  small, else the ones sharing the most words with this batch. */
  private knownFacts(items: Item[]): Array<{ id: string; text: string }> {
    const all = this.knowledge.all();
    const cap = 150;
    if (all.length <= cap) return all;
    const words = new Set(items.flatMap((i) => i.chunk.toLowerCase().split(/[^a-z0-9]+/)).filter((w) => w.length > 3));
    return all
      .map((f) => ({ f, s: f.text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => words.has(w)).length }))
      .sort((a, b) => b.s - a.s)
      .slice(0, cap)
      .map((x) => x.f);
  }

  private async store(cands: Candidate[], sent: Item[], stats: PassStats): Promise<void> {
    const singleCid = sent.every((s) => s.cid === sent[0]!.cid) ? sent[0]!.cid : undefined;
    for (const c of cands) {
      stats.candidates++;
      const src = c.turn !== undefined ? sent[c.turn - 1] : undefined;
      const cid = src?.cid ?? singleCid;
      const sourceAt = src?.at ?? (singleCid ? sent[sent.length - 1]!.at : undefined);
      const res = await this.knowledge.addDetailed(c.fact, 'history', {
        ...(cid ? { conversationId: cid } : {}),
        ...(sourceAt !== undefined ? { sourceAt } : {}),
        ...(c.category ? { category: c.category } : {}),
      });
      if (res.status !== 'added') {
        stats.rejected[res.status] = (stats.rejected[res.status] ?? 0) + 1;
        continue;
      }
      stats.stored++;
      for (const oldId of c.supersedes.slice(0, 3)) {
        const old = this.knowledge.all().find((f) => f.id === oldId);
        if (!old) continue;
        // An old transcript must not overrule something learned later: only a
        // turn at least as recent as the old fact may replace it.
        const oldAt = old.sourceAt ?? old.ts;
        if (sourceAt === undefined || sourceAt < oldAt) continue;
        if (this.knowledge.supersede(oldId, res.id)) {
          stats.superseded++;
          console.error(`[memory-extract] ${res.id} supersedes ${oldId}: "${clip(old.text, 80)}"`);
        }
      }
    }
  }

  private loadState(): ExtractState {
    const fresh = (): ExtractState => ({ version: EXTRACT_VERSION, watermarks: {}, budget: { day: '', calls: 0 }, totals: emptyStats() });
    if (!existsSync(this.statePath)) return fresh();
    try {
      const raw = JSON.parse(readFileSync(this.statePath, 'utf8')) as Partial<ExtractState>;
      const s = fresh();
      if (raw.budget) s.budget = raw.budget;
      if (raw.totals) s.totals = { ...emptyStats(), ...raw.totals };
      if (raw.failures) s.failures = raw.failures;
      // Watermarks from an older extractor version are dropped on purpose: the
      // rules changed, so history is re-read (resumably, under the daily cap).
      // Re-reading is idempotent — the store dedupes and honours tombstones.
      if (raw.version === EXTRACT_VERSION && raw.watermarks) s.watermarks = raw.watermarks;
      else if (raw.watermarks) console.error(`[memory-extract] extractor v${raw.version ?? 1} → v${EXTRACT_VERSION}: re-reading history under the new rules`);
      return s;
    } catch {
      return fresh();
    }
  }

  private saveState(s: ExtractState): void {
    try {
      mkdirSync(dirname(this.statePath), { recursive: true });
      writeFileSync(this.statePath, JSON.stringify(s), 'utf8');
    } catch (err) {
      console.error('[memory-extract] could not persist watermarks:', err);
    }
  }
}

function addStats(into: PassStats, s: PassStats): void {
  for (const k of Object.keys(s) as Array<keyof PassStats>) {
    if (k === 'rejected') {
      for (const [r, n] of Object.entries(s.rejected)) into.rejected[r] = (into.rejected[r] ?? 0) + n;
    } else {
      into[k] = (into[k] ?? 0) + s[k];
    }
  }
}

function clip(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

export interface Candidate {
  fact: string;
  category?: string;
  /** 1-based index of the source turn within the batch. */
  turn?: number;
  supersedes: string[];
}

/**
 * Tolerant parse of the model's JSON array — objects (v2) or bare strings (v1).
 * Returns null when there's no parseable array at all, so the caller can retry
 * instead of treating a garbled reply as "nothing to remember".
 */
export function parseCandidates(text: string): Candidate[] | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced?.[1] ?? text;
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start === -1 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out: Candidate[] = [];
  for (const e of parsed) {
    let c: Candidate | undefined;
    if (typeof e === 'string') c = { fact: e.trim(), supersedes: [] };
    else if (e && typeof e === 'object' && typeof (e as { fact?: unknown }).fact === 'string') {
      const o = e as { fact: string; category?: unknown; turn?: unknown; supersedes?: unknown };
      c = { fact: o.fact.trim(), supersedes: Array.isArray(o.supersedes) ? o.supersedes.filter((x): x is string => typeof x === 'string') : [] };
      if (typeof o.category === 'string' && o.category.trim()) c.category = o.category.trim().toLowerCase();
      const turn = Number(o.turn);
      if (Number.isInteger(turn) && turn > 0) c.turn = turn;
    }
    if (c && c.fact.length >= 8 && c.fact.length <= 400) out.push(c);
  }
  return out;
}

/** Fact texts only; malformed output degrades to []. Kept for callers/tests. */
export function parseFacts(text: string): string[] {
  return (parseCandidates(text) ?? []).map((c) => c.fact);
}
