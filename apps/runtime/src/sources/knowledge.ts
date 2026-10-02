/**
 * knowledge: what Flint's memory learned (~/.flint/memory/knowledge.json, the
 * server's store), every 10 minutes, from the last fact read on (`seq`).
 * Event-only, and it never stores a fact's words: a fact that names things
 * Flint already tracks becomes an event carrying their ids.
 *
 *  - Matching is exact and structural: a repo's or a service's own
 *    identifier (`wpf002/flint`, `com.flint.server`) as a whole word in the
 *    fact. People are never matched, and a fact filed under `person` is
 *    skipped whole.
 *  - Exactly two things and one of a closed set of relations between them, in
 *    that order ("A depends on B"), make the event carry the relation; triage
 *    then proposes linking them (a template proposal Will approves). Anything
 *    else is logged.
 *  - Memory's text can come from anywhere: every event is tainted.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import type { RaisedEvent, Source, SourceRun, SyncResult } from './types.js';

export const KNOWLEDGE_MAX_BYTES = 50 * 1024 * 1024;
export const RELATIONS = { 'depends on': 'depends_on', deploys: 'deploys', runs: 'runs', owns: 'owns', blocks: 'blocks' } as const;
const RELATION = new RegExp(`\\b(${Object.keys(RELATIONS).join('|')})\\b`, 'gi');

export interface Nameable {
  id: string;
  kind: string;
  name: string;
}

/**
 * A name fit to match on: an identifier with a separator in it (`wpf002/flint`,
 * `com.flint.server`, `flint-server`). A bare word ("flint") is how people talk,
 * not a name for one thing.
 */
const STRUCTURAL = /^(?=[^./-]*[./-])[A-Za-z0-9][A-Za-z0-9._/-]{2,119}$/;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** The tracked things a fact names, in the order it names them, and the one relation between two of them. */
export function matchFact(text: string, things: readonly Nameable[]): { entityIds: string[]; relation?: { type: (typeof RELATIONS)[keyof typeof RELATIONS]; fromId: string; toId: string } } {
  const hits: Array<{ id: string; at: number }> = [];
  for (const t of things) {
    if (!STRUCTURAL.test(t.name)) continue;
    const m = new RegExp(`(?<![A-Za-z0-9._/-])${escape(t.name)}(?![A-Za-z0-9_/-]|\\.[A-Za-z0-9])`, 'i').exec(text);
    if (m) hits.push({ id: t.id, at: m.index });
  }
  const ids = [...new Map(hits.sort((a, b) => a.at - b.at).map((h) => [h.id, h])).values()];
  const entityIds = ids.map((h) => h.id).slice(0, 5);
  const words = [...text.matchAll(RELATION)];
  if (ids.length !== 2 || words.length !== 1) return { entityIds };
  const w = words[0]!;
  // "A <relation> B": the relation sits between the two names.
  if (!(ids[0]!.at < w.index! && w.index! < ids[1]!.at)) return { entityIds };
  return { entityIds, relation: { type: RELATIONS[w[1]!.toLowerCase() as keyof typeof RELATIONS], fromId: ids[0]!.id, toId: ids[1]!.id } };
}

export function knowledgeSource(o: { file: string; things: () => Promise<Nameable[]> }): Source {
  return {
    name: 'knowledge',
    cadenceMs: 10 * 60_000,
    async run(r: SourceRun): Promise<SyncResult> {
      const after = /^\d{1,12}$/.test(r.cursor?.cursor ?? '') ? Number(r.cursor!.cursor) : 0;
      if (!existsSync(o.file)) return { observations: [], metrics: [], events: [] };
      if (statSync(o.file).size > KNOWLEDGE_MAX_BYTES) throw new Error('knowledge.json is larger than the runtime reads');
      const raw = JSON.parse(readFileSync(o.file, 'utf8')) as { facts?: unknown };
      const facts = (Array.isArray(raw.facts) ? raw.facts : []).flatMap((f) => {
        const x = f as { id?: unknown; text?: unknown; ts?: unknown; category?: unknown; supersededBy?: unknown };
        const n = typeof x.id === 'string' ? x.id.match(/^k(\d{1,12})$/) : null;
        return n && typeof x.text === 'string' && typeof x.ts === 'number' ? [{ id: x.id as string, n: Number(n[1]), text: x.text, ts: x.ts, person: x.category === 'person', superseded: typeof x.supersededBy === 'string' }] : [];
      });
      const fresh = facts.filter((f) => f.n > after).sort((a, b) => a.n - b.n).slice(0, 500);
      const things = fresh.length ? await o.things() : [];
      const events: RaisedEvent[] = [];
      for (const f of fresh) {
        if (f.person || f.superseded) continue;
        const m = matchFact(f.text, things);
        if (!m.entityIds.length) continue;
        events.push({
          sourceRef: `fact:${f.id}`, type: 'knowledge.fact', occurredAt: new Date(f.ts), sensitivity: 'ops', tainted: true,
          payload: { knowledgeId: f.id, entityIds: m.entityIds, ...(m.relation ? { relation: m.relation.type, fromId: m.relation.fromId, toId: m.relation.toId } : {}) },
        });
      }
      const last = fresh.length ? fresh[fresh.length - 1]!.n : after;
      return { observations: [], metrics: [], events, cursor: String(last) };
    },
  };
}
