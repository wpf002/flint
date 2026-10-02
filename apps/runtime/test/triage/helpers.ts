import type { EventFacts, FactsEntity } from '../../src/triage/verdict';

export const NOW = new Date('2026-10-02T15:00:00Z');

export function facts(over: Partial<EventFacts> = {}, entity?: Partial<FactsEntity>): EventFacts {
  return {
    eventId: 'se1', source: 'github', type: 'issue.state', sensitivity: 'ops', tainted: false, occurredAt: NOW, receivedAt: NOW, payload: {}, created: false, backfill: false,
    ...(entity ? { entity: { id: 'cent0000abc123', kind: 'issue', key: 'issue:github:wpf002/flint#7', name: 'a title', state: {}, taintedPaths: [], status: 'active', ...entity } } : {}),
    ...over,
  };
}

export const noCode = { routeErrorsIn10m: async () => 0, burstEscalatedThisOutage: async () => false };
