/**
 * What triage reads and what it decides (Machine plan P2 pipeline steps 2-3).
 *
 * A verdict names an escalation's template and its typed fields, never text:
 * fields are enums, numbers, hex SHAs and entity refs (kind#<last 6 of id>).
 * Surfacing renders the words from the template (templates/escalations.ts).
 */
import type { REASON_CODES } from '@flint/policy';

export type Action = 'ignore' | 'log' | 'act' | 'escalate';
export type Lane = 'quiet' | 'relevant';
export type ReasonCode = (typeof REASON_CODES)[number];
export const RANK: Record<Action, number> = { ignore: 0, log: 1, act: 2, escalate: 3 };

export type FieldValue = string | number | boolean | null;

export interface FactsEntity {
  id: string;
  kind: string;
  key: string;
  name: string;
  state: Record<string, unknown>;
  taintedPaths: string[];
  status: string;
}

export interface EventFacts {
  eventId: string;
  source: string;
  type: string;
  sensitivity: 'ops' | 'personal' | 'financial';
  tainted: boolean;
  occurredAt: Date;
  receivedAt: Date;
  /** The event's payload; rules read only its clean, allowlisted paths. */
  payload: Record<string, unknown>;
  /** The entity this event changed (a sync's EntityVersion, or a raised event's payload.entityId). */
  entity?: FactsEntity;
  /** This event created its entity. */
  created: boolean;
  backfill: boolean;
  /** Triaged more than a day after it arrived (triage was off, or its job waited): old news, never an escalation. */
  late: boolean;
  /** The state this event recorded is still the entity's state: a critical condition in it still holds. */
  current: boolean;
}

export interface Template {
  id: string;
  fields: Record<string, FieldValue>;
}

export interface Verdict {
  action: Action;
  lane: Lane;
  /** `code:<rule>`, `rule:<name>`, `model:ollama:<model>`, `fallback:<why>` or `default`. */
  decidedBy: string;
  ruleName?: string;
  relevance?: number;
  reasonCode?: ReasonCode;
  /** The model's own words (it may have read a stranger's text): console only, purged at 7 days. */
  reasoning?: string;
  modelMs?: number;
  /** For an escalation: which template, with which fields. */
  template?: Template;
  /** A critical code rule decided it: no rule lowers it, and its push is past the cap but counted. */
  critical: boolean;
  /** At most `limit` a day per key (`notify.handoff:<namespace>`, `triage.sender:<rule>:<slug>`); past it, logged quietly. */
  perDay?: { key: string; limit: number };
  /** Why an escalation was logged instead: old news, or a condition already told. */
  downgraded?: 'late' | 'backfill' | 'told_once';
}

export const quietLog = (decidedBy: string, extra: Partial<Verdict> = {}): Verdict => ({ action: 'log', lane: 'quiet', decidedBy, critical: false, ...extra });
