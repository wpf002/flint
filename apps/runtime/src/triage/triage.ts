/**
 * Triage (Machine plan P2 pipeline, steps 2-3): what to do with one applied
 * event.
 *
 *  1. Critical rules in code, always (even when triage.rule is tightened).
 *  2. The other code rules and Will's signed rules. The final action is the
 *     most severe of everything that matched (escalate > act > log > ignore);
 *     a critical verdict wins its ties and keeps its template, so no rule can
 *     lower or rename a critical escalation.
 *  3. Nothing matched: backfill is logged quietly; an event on the closed
 *     judgement list goes to the local model, which can say how relevant it
 *     is but never "act"; anything else is logged quietly by default.
 */
import { entityRef } from '@flint/policy';
import { criticalVerdict, codeVerdict, type CodeRuleContext } from './critical.js';
import { needsJudgement, type Judged } from './judge.js';
import { ruleMatches, ruleVerdict, type DbRule } from './rules.js';
import { quietLog, RANK, type EventFacts, type Verdict } from './verdict.js';

/** Relevance at which the model's verdict escalates, and at which it reaches the relevant lane. Tuned in the shadow week. */
export const ESCALATE_AT = 0.7;
export const RELEVANT_AT = 0.4;

export interface TriageDeps {
  rules: readonly DbRule[];
  code: CodeRuleContext;
  /** triage.rule may run (promoted, or in shadow); false once a signed policy forbids it. */
  rulesAllowed: boolean;
  /** The model, when triage.local_model may run and one is configured. */
  judge?: (f: EventFacts) => Promise<Judged>;
  /** Why there is no judge: the tier forbids it (skipped) or no model is set (unavailable). */
  noJudge?: 'skipped' | 'unavailable';
  model?: string;
}

export type Decision = Verdict | { defer: true };

export function combine(hits: readonly Verdict[]): Verdict {
  return hits.reduce((best, h) => (RANK[h.action] > RANK[best.action] || (RANK[h.action] === RANK[best.action] && h.critical && !best.critical) ? h : best));
}

export async function decide(f: EventFacts, d: TriageDeps): Promise<Decision> {
  let crit = criticalVerdict(f);
  // One condition told twice (the server's threshold and the watchdog's reading of one cap; a failed
  // migration's deploy event and its marker): the second is logged, not escalated again.
  const once = crit?.template ? ONCE[crit.template.id] : undefined;
  const key = once ? crit!.template!.fields[once.field] : undefined;
  if (crit && once && typeof key === 'string' && (await d.code.escalatedRecently?.(crit.template!.id, once.field, key, once.withinMs, f.occurredAt))) {
    crit = logged(crit);
  }
  const decided = await decideRules(f, d, crit);
  // Old news (backfill, or triaged a day after it arrived) is recorded and seen, never escalated.
  if ('defer' in decided || decided.action !== 'escalate' || !(f.backfill || f.late)) return decided;
  return logged(decided);
}

/** An escalation made a relevant-lane log: no template, no ping, no cap bypass. */
function logged(v: Verdict): Verdict {
  const { template: _t, perDay: _p, ...rest } = v;
  return { ...rest, action: 'log', lane: 'relevant', critical: false };
}

/** Critical templates told once per this field over this window. */
const ONCE: Record<string, { field: string; withinMs: number }> = {
  vendor_cap: { field: 'vendor', withinMs: 24 * 3_600_000 },
  migrate_failed: { field: 'sha', withinMs: 30 * 24 * 3_600_000 },
};

async function decideRules(f: EventFacts, d: TriageDeps, crit: Verdict | undefined): Promise<Decision> {
  if (!d.rulesAllowed) return crit ?? quietLog('fallback:skipped');
  const hits: Verdict[] = crit ? [crit] : [];
  const code = await codeVerdict(f, d.code);
  if (code) hits.push(code);
  for (const r of [...d.rules].sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name))) {
    if (!ruleMatches(r, f)) continue;
    const v = ruleVerdict(r, f);
    if (v) hits.push(v);
  }
  if (hits.length) return combine(hits);
  if (f.backfill || f.late) return quietLog('fallback:backfill');
  if (!needsJudgement(f)) return quietLog('default');
  if (!d.judge) return quietLog(`fallback:${d.noJudge ?? 'unavailable'}`);
  const j = await d.judge(f);
  if (!j.ok) return j.why === 'deferred' ? { defer: true } : quietLog(`fallback:${j.why}`, { modelMs: j.modelMs });
  const { relevance, reasonCode, reasoning } = j.judgement;
  const e = f.entity!;
  const base = { decidedBy: `model:ollama:${d.model ?? 'local'}`, relevance, reasonCode, reasoning, modelMs: j.modelMs, critical: false };
  if (relevance >= ESCALATE_AT) {
    return { ...base, action: 'escalate', lane: 'relevant', template: { id: 'new_item', fields: { kind: e.kind, item: entityRef(e.kind, e.id), reasonCode } } };
  }
  return { ...base, action: 'log', lane: relevance >= RELEVANT_AT ? 'relevant' : 'quiet' };
}
