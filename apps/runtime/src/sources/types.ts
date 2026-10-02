/**
 * What a source adapter returns (plan P1 "Event sources"): observations for the
 * world model and numbers for MetricPoint. Sources are read-only and
 * deterministic, and make no model calls.
 */
import type { Observation } from '../world/mapper.js';

export type SourceName = 'launchd' | 'health' | 'git' | 'spend' | 'github' | 'railway' | 'nexus';

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

export type SourceObservation = Omit<Observation, 'source' | 'actor' | 'observedAt' | 'sourceEventId'> & { type: string; sensitivity: 'ops' | 'personal' | 'financial' };

export interface SyncResult {
  observations: SourceObservation[];
  metrics: MetricObservation[];
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
