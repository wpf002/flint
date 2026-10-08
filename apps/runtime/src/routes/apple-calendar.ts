/**
 * Flint Calendar's push (Machine plan P2.6): POST
 * /v1/sources/apple_calendar/snapshot, the one route the `calendar:push` scope
 * opens, and the only way calendar data reaches the apple_calendar source.
 *
 *  - Its token can file a snapshot and nothing else: it reads nothing, and no
 *    other token may push (the server's and the connector's lack the scope).
 *    The token is checked before the body is read (401, 403).
 *  - Then, in order: 413 over the wire's byte budget (MAX_BYTES, 2 MiB, which
 *    the helper cuts a snapshot to fit); 400 for a NUL (the app's own hook) or
 *    an envelope that is not wire v1, answered with schema paths, never a
 *    value (an event this side cannot read is set aside, not refused); 404
 *    while the source is off (FLINT_SOURCE_APPLE_CALENDAR); 409 while it is not
 *    turned on, and what it held is dropped, so a source that is off keeps no
 *    calendar in memory (the helper was still heard from: the first run after
 *    Will turns it on waits for its next push); 422 for a snapshot that is not
 *    fresh, or not newer than the last one accepted or applied; 429 within 5
 *    seconds of the last accepted; otherwise 202, with how many events were set
 *    aside when any were.
 *  - Accepted: held in this process's memory only (../sources/apple/inbox.ts),
 *    never written or logged, and one sync.apple_calendar job is sent with no
 *    content but why. The bus being down loses nothing: the source's own
 *    5-minute run reads the same snapshot.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { RuntimeScope } from '../config.js';
import type { Db } from '../db.js';
import type { Bus } from '../bus.js';
import type { CalendarInbox } from '../sources/apple/inbox.js';
import { MAX_BYTES, parseSnapshot } from '../sources/apple/wire.js';

export const SNAPSHOT_PATH = '/v1/sources/apple_calendar/snapshot';
/**
 * The wire's byte budget. The caps on counts and lengths alone allow far more
 * (a thousand events of a hundred attendees each is tens of megabytes), so the
 * helper cuts a snapshot to this (fitToBudget) and says `complete: false`.
 */
export const SNAPSHOT_BODY_LIMIT = MAX_BYTES;
const QUEUE = 'sync.apple_calendar';

export interface AppleCalendarDeps {
  db: Db;
  need: (scope: RuntimeScope) => (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  /** The inbox, while the source is registered (FLINT_SOURCE_APPLE_CALENDAR=on); absent, every push is 404. */
  inbox?: CalendarInbox;
  /** The bus, once it has started. */
  bus: () => Pick<Bus, 'boss'> | undefined;
  /** What failed, by its class only (never a snapshot's words). */
  log?: (msg: string) => void;
}

export function registerAppleCalendarRoutes(app: FastifyInstance, d: AppleCalendarDeps): void {
  app.post(SNAPSHOT_PATH, { onRequest: d.need('calendar:push'), bodyLimit: SNAPSHOT_BODY_LIMIT }, async (req, reply) => {
    const parsed = parseSnapshot(req.body);
    if (!parsed.ok) return reply.code(400).send({ error: 'invalid input', issues: parsed.issues.map((path) => ({ path })) });
    if (!d.inbox) return reply.code(404).send({ error: 'not_registered' });
    const cursor = await d.db.sourceCursor.findUnique({ where: { source: 'apple_calendar' }, select: { enabled: true } });
    if (!cursor?.enabled) {
      d.inbox.turnedAway();
      return reply.code(409).send({ error: 'not_enabled' });
    }
    const offer = d.inbox.offer(parsed.snapshot);
    if (offer === 'stale') return reply.code(422).send({ error: 'stale' });
    if (offer === 'too_soon') return reply.code(429).header('retry-after', '5').send({ error: 'too_soon' });
    // One job, with no content. The queue is a singleton; the run reads whatever is held when it starts.
    const bus = d.bus();
    if (bus) {
      await bus.boss.send(QUEUE, { reason: 'push' }).catch((err: unknown) => d.log?.(`sending ${QUEUE} failed: ${err instanceof Error ? err.name : 'error'}`));
    }
    const setAside = parsed.snapshot.setAside.length;
    return reply.code(202).send({ accepted: true, ...(setAside ? { setAside } : {}) });
  });
}
