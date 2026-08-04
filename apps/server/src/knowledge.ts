import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Tool } from '@flint/core';
import { OllamaEmbedder, cosineSimilarity } from '@flint/persona';

interface Fact {
  id: string;
  text: string;
  source: string; // 'user' | 'reflection' | tool name, etc.
  ts: number;
  vector: number[];
}

/**
 * Flint's compounding long-term memory: durable FACTS about Will (preferences,
 * ongoing work, people, decisions) that ChatGPT/Claude structurally can't have.
 * Each fact is embedded once; recall pulls the few most relevant into the prompt
 * so Flint "remembers" without bloating context. Persisted to ~/.flint so it
 * survives restarts and grows over time. This is the moat — every conversation
 * can make Flint know Will a little better.
 */
export class KnowledgeStore {
  private facts: Fact[] = [];
  private seq = 0;

  constructor(
    private readonly path: string,
    private readonly embedder: OllamaEmbedder,
    private readonly floor = Number(process.env.FLINT_MEMORY_FLOOR ?? 0.45),
  ) {
    this.load();
  }

  get size(): number {
    return this.facts.length;
  }

  /** Record a durable fact. De-dupes on exact text. Returns false if a no-op. */
  /** Ephemeral / non-durable "facts" that should never be remembered — the model
   *  used to save the current time as a permanent fact, cluttering memory. */
  private static readonly EPHEMERAL = /^(it is currently|the current (date|time|day)|right now it is|today is|the time is)\b|\b\d{1,2}:\d{2}\s?(am|pm)\b/i;

  async add(text: string, source = 'user'): Promise<boolean> {
    const clean = text.trim();
    if (!clean) return false;
    if (KnowledgeStore.EPHEMERAL.test(clean)) return false; // don't remember timestamps/ephemera
    if (this.facts.some((f) => f.text.toLowerCase() === clean.toLowerCase())) return false;
    let vector: number[] = [];
    try {
      vector = (await this.embedder.embed([clean]))[0] ?? [];
    } catch (err) {
      console.error('[memory] embed failed for new fact (storing without vector):', err);
    }
    this.facts.push({ id: `k${++this.seq}`, text: clean, source, ts: Date.now(), vector });
    this.save();
    return true;
  }

  /** The facts most relevant to `query`, most-relevant first (≥ floor). */
  async recall(query: string, k = Number(process.env.FLINT_MEMORY_K ?? 5)): Promise<string[]> {
    const withVecs = this.facts.filter((f) => f.vector.length > 0);
    if (withVecs.length === 0) return [];
    let qv: number[];
    try {
      qv = (await this.embedder.embed([query.slice(0, 2000)]))[0] ?? [];
    } catch {
      return [];
    }
    if (qv.length === 0) return [];
    return withVecs
      .map((f) => ({ f, score: cosineSimilarity(qv, f.vector) }))
      .filter((x) => x.score >= this.floor)
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map((x) => x.f.text);
  }

  all(): Array<{ id: string; text: string; source: string; ts: number }> {
    return this.facts.map(({ id, text, source, ts }) => ({ id, text, source, ts }));
  }

  forget(id: string): boolean {
    const before = this.facts.length;
    this.facts = this.facts.filter((f) => f.id !== id);
    if (this.facts.length !== before) {
      this.save();
      return true;
    }
    return false;
  }

  private load(): void {
    try {
      if (!existsSync(this.path)) return;
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as { facts?: Fact[]; seq?: number };
      this.facts = Array.isArray(raw.facts) ? raw.facts.filter((f) => f && typeof f.text === 'string') : [];
      this.seq = raw.seq ?? this.facts.length;
      console.error(`[memory] loaded ${this.facts.length} long-term facts`);
    } catch (err) {
      console.error('[memory] failed to load knowledge store (starting fresh):', err);
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify({ savedAt: Date.now(), seq: this.seq, facts: this.facts }), 'utf8');
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
      const added = await store.add(fact, 'user');
      return { ok: true, remembered: added, note: added ? 'saved' : 'already known' };
    },
  };
}
