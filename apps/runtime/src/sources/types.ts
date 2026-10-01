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
}

export interface SourceRun {
  now: Date;
  signal: AbortSignal;
  cursor?: { cursor: string; etag: string | null };
  /** fetch limited to this source's endpoint list (policy/egress.ts). */
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
}

export interface Source {
  name: SourceName;
  /** How often it runs. */
  cadenceMs: number;
  run(r: SourceRun): Promise<SyncResult>;
}
