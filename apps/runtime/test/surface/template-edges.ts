import { REASON_CODES } from '@flint/policy';
import type { TemplateId } from '../../src/templates/escalations';

/**
 * Every escalation template's fields at their edges: templates.test.ts renders
 * them, and so does the notes inventory (../notes-inventory.test.ts), so a new
 * template's words are checked the day it is added.
 */
export const EDGES: Record<TemplateId, unknown[]> = {
  service_down: [{ service: 'service#abc123', downMinutes: 30 }, { service: null, downMinutes: 1_000_000 }],
  backup_stale: [{ hoursSince: 36 }, { hoursSince: 1_000_000 }],
  nexus_backup_stale: [{ hoursSince: 36 }, { hoursSince: 1_000_000 }],
  drill_failed: [{ mismatches: 0 }, { mismatches: 1_000_000 }],
  vendor_cap: ['anthropic', 'openai', 'perplexity', 'tavily'].map((vendor) => ({ vendor })),
  deploy_failed: ['gate', 'restart', 'health'].flatMap((stage) => [{ component: 'server', stage, sha: 'a'.repeat(40) }, { component: 'runtime', stage, sha: null }]),
  migrate_failed: [{ component: 'runtime', sha: 'abcdef1' }, { component: 'server', sha: null }],
  ci_failing: [{ run: 'ci_run#abc123', sha: 'f'.repeat(40) }, { run: null, sha: null }],
  route_errors: [{ count: 6, minutes: 10 }, { count: 1_000_000, minutes: 60 }],
  handoff_unaccepted: [{ handoff: 'handoff#abc123', namespace: 'trident' }, { handoff: null, namespace: null }],
  calendar_upcoming: [
    { item: 'commitment#abc123', kind: 'commitment', date: '2026-10-06', time: '00:00', until: '2026-10-06T05:00:00.000Z' },
    { item: 'commitment#abc123', kind: 'commitment', date: '2026-12-31', time: null, until: '2027-01-01T06:00:00.000Z' },
    { item: 'deadline#abc123', kind: 'deadline', date: '2028-02-29', time: null, until: '2028-03-01T06:00:00.000Z' },
  ],
  new_item: (['issue', 'pull_request', 'thread'] as const).flatMap((kind) => REASON_CODES.map((reasonCode) => ({ kind, item: `${kind}#abc123`, reasonCode }))),
  disk_low: [{ gb: 0 }, { gb: 1 }, { gb: 4 }],
  offsite_stale: [3, 10_000].flatMap((days) => (['database', 'files'] as const).flatMap((what) => [true, false].flatMap((icloud) => [true, false].map((local) => ({ days, what, icloud, local }))))),
  remote_access_expiring: [{ days: 0 }, { days: 1 }, { days: 14 }],
  remote_access_down: [{}],
  updates_stalled: [{ hours: 3 }, { hours: 47 }, { hours: 48 }, { hours: 100_000 }],
  offsite_drill_stale: [{ weeks: 5 }, { weeks: 10_000 }],
  rule_match: [{ rule: 'r'.repeat(80), source: 'github', eventType: 'issue.state', entity: 'issue#abc123' }, { rule: 'a', source: 'server', eventType: 'route.error', entity: null }],
};
