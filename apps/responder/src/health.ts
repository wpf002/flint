import { isFlintError } from '@flint/core';
import type { Participant } from './participant.js';
import { describe } from './loop.js';

/**
 * Does each participant still work?
 *
 * Two things can rot independently, and only one of them is visible from Nexus. A
 * namespace token can be revoked, which Nexus knows about; a model key can expire,
 * which it cannot — that credential lives somewhere Nexus deliberately never sees. So
 * a participant shows as connected right up until the moment it fails to take a turn.
 *
 * The probe is a real generation capped at a single token. Listing models would be
 * free but proves less: a key can list models and still be refused for a completion
 * when a quota is spent, which is exactly the failure worth catching.
 */

export interface Check {
  slug: string;
  nexus: boolean;
  model: boolean;
  note: string | null;
}

export async function checkAll(participants: Participant[]): Promise<Check[]> {
  return Promise.all(participants.map(check));
}

async function check(p: Participant): Promise<Check> {
  let nexus = false;
  let note: string | null = null;

  try {
    await p.call('whoami');
    nexus = true;
  } catch (err) {
    return { slug: p.slug, nexus: false, model: false, note: `nexus: ${describe(err)}` };
  }

  let model = false;
  try {
    await p.provider.generate({
      model: p.cfg.model,
      messages: [{ id: 'health', role: 'user', content: 'ok', timestamp: 0 }],
      maxTokens: 256,
    });
    model = true;
  } catch (err) {
    /*
     * Only a credential or configuration fault means "this is broken". A rate limit or
     * a provider outage is transient, and reporting it as a failure would train you to
     * ignore the signal — which defeats the point of having one.
     */
    if (isFlintError(err) && err.error.kind !== 'validation') {
      model = true;
      note = `transient at check time: ${err.error.kind}`;
    } else {
      note = describe(err);
    }
  }

  return { slug: p.slug, nexus, model, note };
}

/**
 * Tells Nexus what was found, so the console stops showing a broken participant as
 * connected. Best effort: a failed report must not mask the failure it was reporting.
 */
export async function publish(p: Participant, check: Check): Promise<void> {
  await p
    .call('report_health', {
      ok: check.nexus && check.model,
      ...(check.note ? { note: check.note.slice(0, 500) } : {}),
    })
    .catch(() => {});
}
