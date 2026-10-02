/**
 * What triage may file when it decides to act (Machine plan P2, step 4): a
 * closed registry of action templates, each naming the events it answers,
 * the action it proposes and the schema its params must meet. An `act`
 * verdict with no template here files nothing.
 *
 * In P2 there is one: a knowledge fact that links two things Flint already
 * knows becomes a world.relation.write proposal, ids only (no person is ever
 * created from it).
 */
import { z } from 'zod';
import type { EventFacts } from '../triage/verdict.js';

const Id = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);

export const ACTION_TEMPLATES = {
  'knowledge.link': {
    eventTypes: ['knowledge:knowledge.fact'],
    action: 'world.relation.write',
    params: z.object({ type: z.enum(['depends_on', 'part_of', 'relates_to', 'blocks']), fromId: Id, toId: Id, knowledgeId: z.string().regex(/^[A-Za-z0-9_:-]{1,64}$/) }).strict(),
  },
} as const;
export type ActionTemplateId = keyof typeof ACTION_TEMPLATES;

/** The template and params an event's `act` would file, or undefined. */
export function actionFor(f: EventFacts): { templateId: ActionTemplateId; action: string; params: Record<string, unknown> } | undefined {
  for (const [id, t] of Object.entries(ACTION_TEMPLATES) as Array<[ActionTemplateId, (typeof ACTION_TEMPLATES)[ActionTemplateId]]>) {
    if (!(t.eventTypes as readonly string[]).includes(`${f.source}:${f.type}`) || f.tainted) continue;
    const p = t.params.safeParse({ type: f.payload.relation, fromId: f.payload.fromId, toId: f.payload.toId, knowledgeId: f.payload.knowledgeId });
    if (p.success && p.data.fromId !== p.data.toId) return { templateId: id, action: t.action, params: p.data };
  }
  return undefined;
}
