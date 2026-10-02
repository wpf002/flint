/**
 * What a source adapter returns (plan P1 "Event sources"): observations for the
 * world model and numbers for MetricPoint. Sources are read-only and
 * deterministic, and make no model calls.
 */
import type { Observation } from '../world/mapper.js';

export type SourceName = 'launchd' | 'health' | 'git' | 'spend' | 'github' | 'railway' | 'nexus' | 'deploy' | 'knowledge' | 'nexus_inbox';

export interface SeriesDef {
  key: string;
  unit: string;
  freq: 'raw' | 'D' | 'W' | 'M';
  sensitivity: 'ops' | 'personal' | 'financial';
  description: string;
  entityKey?: { kind: string; key: string };
}

export interface MetricObservation {
  series: SeriesDef;
  at: Date;
  value: number;
}

export type SourceObservation = Omit<Observation, 'source' | 'actor' | 'observedAt' | 'sourceEventId'> & {
  type: string;
  sensitivity: 'ops' | 'personal' | 'financial';
  /** When the source says this changed (an issue's updated_at); absent, the sync's own time. */
  changedAt?: string | Date;
};

/**
 * An event an event-only source raises (P2: deploy, knowledge, nexus_inbox):
 * a SourceEvent and nothing in the world model. Its sourceRef names the
 * occurrence, so the same one read again is a duplicate.
 */
export interface RaisedEvent {
  sourceRef: string;
  type: string;
  occurredAt: Date;
  sensitivity: 'ops' | 'personal' | 'financial';
  tainted: boolean;
  /** Ids, enums and numbers: no text. */
  payload: Record<string, string | number | boolean | string[]>;
  /** A condition that holds now (a handoff still pending): seen again, its undecided event is refreshed. */
  current?: boolean;
}

export interface SyncResult {
  observations: SourceObservation[];
  metrics: MetricObservation[];
  events?: RaisedEvent[];
  cursor?: string;
  etag?: string;
  /**
   * Parts that failed while the rest succeeded (one repo of four, say). The run
   * still applies what it got; these are recorded as the source's last error
   * and count as a failure, so a part that keeps failing reaches the watchdog.
   */
  errors?: string[];
}

/** One of this source's live entities, as the world model has it now. */
export interface Known {
  key: string;
  name: string;
  state: Record<string, unknown>;
  taintedPaths: string[];
}

export interface SourceRun {
  now: Date;
  signal: AbortSignal;
  cursor?: { cursor: string; etag: string | null };
  /** fetch limited to this source's endpoint list (policy/egress.ts). */
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  /** This source's live entities of a kind (to notice what disappeared from a listing, and close it as it was). */
  known?: (kind: string) => Promise<Known[]>;
}

export interface Source {
  name: SourceName;
  /** How often it runs. */
  cadenceMs: number;
  run(r: SourceRun): Promise<SyncResult>;
}
