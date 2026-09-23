import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Tool } from '@flint/core';
import { cosineSimilarity, type Embedder } from '@flint/persona';

interface Fact {
  id: string;
  text: string;
  source: string; // 'user' | 'history' | tool name, etc.
  /** When the fact was stored. */
  ts: number;
  vector: number[];
  /** Provenance: the conversation the fact was learned from, if known. */
  conversationId?: string;
  /** Provenance: when the source turn happened (may be long before `ts`). */
  sourceAt?: number;
  /** Coarse kind — project, preference, person, system, decision, goal, … */
  category?: string;
  /** Set when a newer fact replaced this one. Kept for audit, never recalled. */
  supersededBy?: string;
  supersededAt?: number;
}

export interface FactMeta {
  conversationId?: string;
  sourceAt?: number;
  category?: string;
}

/** Why `addDetailed` did or didn't store a fact — the extractor counts these. */
export type AddOutcome =
  | { status: 'added'; id: string }
  | { status: 'empty' | 'ephemeral' | 'low-value' | 'rejected' | 'duplicate' | 'near-duplicate' };

export type PublicFact = Omit<Fact, 'vector'>;

/**
 * Words that carry no retrieval signal. "will" is here on purpose: it is both
 * Will's name (in nearly every fact, so it discriminates nothing) and a modal
 * verb in nearly every question.
 */
const STOP = new Set(
  (
    'a an the and or but if then so of to in on at by for with from into onto about as is are was were be been being ' +
    'do does did done have has had having i me my mine you your yours he him his she her it its we us our they them ' +
    'their this that these those what which who whom whose when where why how will wills would should could can may ' +
    'might must shall just not no yes any some all more most very really also too than there here up down out over ' +
    'again get got make made know tell say said think want like one ok okay hey hi hello please thanks flint ' +
    'take took go going goes doing thing things way well now lately good need use used'
  ).split(' '),
);

/** Lower-case content tokens with a crude plural/-ing stem so "servers" ~ "server". */
export function contentTokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/'s\b/g, '')
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map((t) => (t.length > 4 && t.endsWith('ing') ? t.slice(0, -3) : t.length > 3 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t));
}

function jaccard(a: string[], b: string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Resolve `p`, or throw after `ms`. The embedder has no timeout of its own, and
 *  a wedged Ollama (e.g. mid training run) must not hang every chat turn. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

/**
 * Flint's compounding long-term memory: durable FACTS about Will (preferences,
 * ongoing work, people, decisions) that ChatGPT/Claude structurally can't have.
 * Each fact is embedded once; recall pulls the few most relevant into the prompt
 * so Flint "remembers" without bloating context. Persisted to ~/.flint so it
 * survives restarts and grows over time. This is the moat — every conversation
 * can make Flint know Will a little better.
 *
 * Recall degrades instead of going dark: when the Ollama embedder is down or
 * wedged (it is, for hours, during every training run) recall falls back to a
 * lexical match, and facts stored while it was down — which have no vector —
 * are matched lexically and re-embedded once it is back. Before this, both cases
 * silently injected nothing, and a vector-less fact was invisible forever.
 */
export class KnowledgeStore {
  private facts: Fact[] = [];
  private seq = 0;
  /** Normalised texts the user has rejected. Persisted; never re-stored. */
  private rejected = new Set<string>();
  private reembedding: Promise<number> | undefined;

  constructor(
    private readonly path: string,
    private readonly embedder: Embedder,
    private readonly floor = Number(process.env.FLINT_MEMORY_FLOOR ?? 0.45),
    private readonly embedTimeoutMs = Number(process.env.FLINT_MEMORY_EMBED_TIMEOUT_MS ?? 2500),
  ) {
    this.load();
  }

  /** Active (not superseded) facts. */
  get size(): number {
    return this.active().length;
  }

  /** Ephemeral / non-durable "facts" that should never be remembered — the model
   *  used to save the current time as a permanent fact, cluttering memory. */
  private static readonly EPHEMERAL = /^(it is currently|the current (date|time|day)|right now it is|today is|the time is)\b|\b\d{1,2}:\d{2}\s?(am|pm)\b/i;

  /** Stricter bar for facts nobody asked to keep (the extractor): relative time
   *  words expire, and "Will asked about X" is a log line, not knowledge. */
  private static readonly AUTO_EPHEMERAL = /\b(today|tonight|tomorrow|yesterday|this (morning|afternoon|evening|week|weekend)|right now|at the moment|currently)\b/i;
  private static readonly LOW_VALUE = /^(will|the user|he)\s+(asked|wanted to know|inquired|requested|greeted|said (hi|hello)|checked|tested|wanted to see)\b|\b(the assistant|flint) (said|answered|replied|responded)\b/i;

  /** Record a durable fact. Returns false if it was a no-op. */
  async add(text: string, source = 'user', meta: FactMeta = {}): Promise<boolean> {
    return (await this.addDetailed(text, source, meta)).status === 'added';
  }

  /** Like `add`, but says why a fact was refused. */
  async addDetailed(text: string, source = 'user', meta: FactMeta = {}): Promise<AddOutcome> {
    const clean = text.trim().replace(/\s+/g, ' ');
    if (!clean) return { status: 'empty' };
    if (KnowledgeStore.EPHEMERAL.test(clean)) return { status: 'ephemeral' }; // don't remember timestamps/ephemera
    if (source !== 'user') {
      if (KnowledgeStore.AUTO_EPHEMERAL.test(clean)) return { status: 'ephemeral' };
      if (KnowledgeStore.LOW_VALUE.test(clean)) return { status: 'low-value' };
    }
    const n = KnowledgeStore.norm(clean);
    if (this.rejected.has(n)) return { status: 'rejected' }; // user rejected this; stays rejected
    // Superseded facts count too: an old transcript must not resurrect a fact a
    // newer one already replaced.
    if (this.facts.some((f) => KnowledgeStore.norm(f.text) === n)) return { status: 'duplicate' };
    const toks = contentTokens(clean);
    if (this.facts.some((f) => jaccard(toks, contentTokens(f.text)) >= 0.85)) return { status: 'near-duplicate' };

    let vector: number[] = [];
    try {
      vector = (await withTimeout(this.embedder.embed([clean]), this.embedTimeoutMs))[0] ?? [];
    } catch (err) {
      console.error('[memory] embed failed for new fact (storing without vector; recall matches it lexically):', String(err));
    }
    const fact: Fact = { id: `k${++this.seq}`, text: clean, source, ts: Date.now(), vector };
    if (meta.conversationId) fact.conversationId = meta.conversationId;
    if (meta.sourceAt !== undefined) fact.sourceAt = meta.sourceAt;
    if (meta.category) fact.category = meta.category;
    this.facts.push(fact);
    this.save();
    return { status: 'added', id: fact.id };
  }

  /**
   * Retire `oldId` in favour of `newId` ("delivery is Sep 25" replaces "buying
   * one around August"). Not a tombstone: the old text is kept for audit and
   * still blocks re-derivation, it just stops being recalled. Returns false if
   * either id is unknown, the old one is already retired, or they're the same.
   */
  supersede(oldId: string, newId: string): boolean {
    if (oldId === newId) return false;
    const old = this.facts.find((f) => f.id === oldId);
    const next = this.facts.find((f) => f.id === newId);
    if (!old || !next || old.supersededBy || next.supersededBy) return false;
    old.supersededBy = newId;
    old.supersededAt = Date.now();
    this.save();
    return true;
  }

  /** The facts most relevant to `query`, most-relevant first. */
  async recall(query: string, k = Number(process.env.FLINT_MEMORY_K ?? 5)): Promise<string[]> {
    const facts = this.active();
    if (facts.length === 0 || !query.trim()) return [];

    let qv: number[] = [];
    try {
      qv = (await withTimeout(this.embedder.embed([query.slice(0, 2000)]), this.embedTimeoutMs))[0] ?? [];
    } catch {
      qv = [];
    }

    if (qv.length === 0) return this.lexical(query, facts, k); // embedder down → lexical, never nothing

    // Embedder is up: opportunistically heal facts stored while it was down.
    if (facts.some((f) => f.vector.length === 0)) void this.reembedMissing();

    const semantic = facts
      .filter((f) => f.vector.length > 0)
      .map((f) => ({ f, score: cosineSimilarity(qv, f.vector) }))
      .filter((x) => x.score >= this.floor)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.f);
    // Facts without a vector yet can't be scored semantically — match them lexically.
    const unvectored = facts.filter((f) => f.vector.length === 0);
    const lex = unvectored.length ? this.lexicalFacts(query, unvectored, facts, k) : [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const f of [...semantic, ...lex]) {
      if (seen.has(f.id)) continue;
      seen.add(f.id);
      out.push(f.text);
      if (out.length >= k) break;
    }
    return out;
  }

  /** Embed facts that have no vector (stored while the embedder was down). */
  reembedMissing(limit = 25): Promise<number> {
    // Share an in-flight heal rather than racing a second one over the same facts.
    this.reembedding ??= this.heal(limit).finally(() => {
      this.reembedding = undefined;
    });
    return this.reembedding;
  }

  private async heal(limit: number): Promise<number> {
    let healed = 0;
    try {
      for (const f of this.facts.filter((x) => x.vector.length === 0).slice(0, limit)) {
        const v = (await withTimeout(this.embedder.embed([f.text]), this.embedTimeoutMs))[0] ?? [];
        if (v.length === 0) break;
        f.vector = v;
        healed++;
      }
    } catch {
      /* still down — try again next recall */
    } finally {
      if (healed > 0) this.save();
    }
    return healed;
  }

  private lexical(query: string, pool: Fact[], k: number): string[] {
    return this.lexicalFacts(query, pool, pool, k).map((f) => f.text);
  }

  /**
   * IDF-weighted token overlap. `corpus` sets the IDF (all active facts) so a
   * word in every fact scores ~0; a fact needs to share at least one rarer
   * content word with the query to be returned at all.
   */
  private lexicalFacts(query: string, pool: Fact[], corpus: Fact[], k: number): Fact[] {
    const q = new Set(contentTokens(query));
    if (q.size === 0) return [];
    const N = corpus.length;
    const df = new Map<string, number>();
    const tokCache = new Map<string, Set<string>>();
    for (const f of corpus) {
      const toks = new Set(contentTokens(f.text));
      tokCache.set(f.id, toks);
      for (const t of toks) df.set(t, (df.get(t) ?? 0) + 1);
    }
    return pool
      .map((f) => {
        const toks = tokCache.get(f.id) ?? new Set(contentTokens(f.text));
        let score = 0;
        for (const t of q) if (toks.has(t)) score += Math.log(1 + N / (df.get(t) ?? 1));
        return { f, score: score / Math.sqrt(Math.max(toks.size, 1)) };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      // A weak single-word brush alongside a strong match is noise; keep only
      // matches within reach of the best one.
      .filter((x, _i, arr) => x.score >= 0.4 * arr[0]!.score)
      .slice(0, k)
      .map((x) => x.f);
  }

  /** Active facts (what recall draws from), with provenance. */
  all(): PublicFact[] {
    return this.active().map(({ vector: _v, ...rest }) => ({ ...rest }));
  }

  /** Every fact including superseded ones — for audit/debugging. */
  history(): PublicFact[] {
    return this.facts.map(({ vector: _v, ...rest }) => ({ ...rest }));
  }

  private active(): Fact[] {
    return this.facts.filter((f) => !f.supersededBy);
  }

  /**
   * Forget a fact — and TOMBSTONE it so it cannot come back.
   *
   * Without the tombstone, deleting a wrong fact only helps until something
   * re-derives it. That is not hypothetical: the automatic extractor mined
   * "Will's favorite baseball team is the Houston Astros" — a fabrication Will
   * had already rejected and which had been purged — straight back out of an old
   * transcript, because the transcript still contains it. A fact the user has
   * rejected must stay rejected no matter how many times it appears in history.
   */
  forget(id: string): boolean {
    const doomed = this.facts.find((f) => f.id === id);
    if (!doomed) return false;
    this.facts = this.facts.filter((f) => f.id !== id);
    this.rejected.add(KnowledgeStore.norm(doomed.text));
    this.save();
    return true;
  }

  /** Reject a fact by TEXT (it may not be stored yet) and bar it permanently. */
  reject(text: string): void {
    const clean = text.trim();
    if (!clean) return;
    this.rejected.add(KnowledgeStore.norm(clean));
    this.facts = this.facts.filter((f) => KnowledgeStore.norm(f.text) !== KnowledgeStore.norm(clean));
    this.save();
  }

  /** Texts the user has rejected; never re-stored. */
  rejectedTexts(): string[] {
    return [...this.rejected];
  }

  private static norm(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9 ]+/g, '').replace(/\s+/g, ' ').trim();
  }

  private load(): void {
    try {
      if (!existsSync(this.path)) return;
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as {
        facts?: Fact[];
        seq?: number;
        rejected?: string[];
      };
      this.facts = Array.isArray(raw.facts)
        ? raw.facts
            .filter((f) => f && typeof f.text === 'string')
            .map((f) => ({ ...f, vector: Array.isArray(f.vector) ? f.vector : [] }))
        : [];
      this.seq = raw.seq ?? this.facts.length;
      this.rejected = new Set(Array.isArray(raw.rejected) ? raw.rejected : []);
      const retired = this.facts.length - this.active().length;
      console.error(`[memory] loaded ${this.active().length} long-term facts${retired ? ` (+${retired} superseded)` : ''}`);
    } catch (err) {
      console.error('[memory] failed to load knowledge store (starting fresh):', err);
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(
        tmp,
        JSON.stringify({ savedAt: Date.now(), seq: this.seq, facts: this.facts, rejected: [...this.rejected] }),
        'utf8',
      );
      renameSync(tmp, this.path);
    } catch (err) {
      console.error('[memory] failed to persist knowledge store:', err);
    }
  }
}

/**
 * The `remember` tool — lets Flint save something worth keeping the moment it
 * comes up in conversation ("I'm allergic to penicillin", "my sister's name is
 * Kate", "we decided to ship Friday"). Read-only-classified by the gate regex so
 * it runs freely; it only writes to Flint's own memory, never the outside world.
 */
export function rememberTool(store: KnowledgeStore): Tool {
  return {
    definition: {
      name: 'remember',
      description:
        "Save a durable fact about Will or his world to your long-term memory — preferences, ongoing projects, people, decisions, anything you should still know next time. Use it whenever Will tells you something worth remembering. One clear fact per call.",
      inputSchema: {
        type: 'object',
        properties: {
          fact: { type: 'string', description: 'The single fact to remember, stated plainly.' },
        },
        required: ['fact'],
      },
      idempotent: true,
    },
    handler: async (call) => {
      const fact = String((call.args as { fact?: unknown })?.fact ?? '').trim();
      if (!fact) return { ok: false, error: 'no fact provided' };
      const added = await store.add(fact, 'user', { sourceAt: Date.now() });
      return { ok: true, remembered: added, note: added ? 'saved' : 'already known' };
    },
  };
}
