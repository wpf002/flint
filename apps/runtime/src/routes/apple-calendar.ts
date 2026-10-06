/**
 * Flint Calendar's push (Machine plan P2.6): POST
 * /v1/sources/apple_calendar/snapshot, the one route the `calendar:push` scope
 * opens, and the only way calendar data reaches the apple_calendar source.
 *
 *  - Its token can file a snapshot and nothing else: it reads nothing, and no
 *    other token may push (the server's and the connector's lack the scope).
 *    The token is checked before the body is read (401, 403).
 *  - Then, in order: 413 over 2 MiB; 400 for a NUL (the app's own hook) or an
 *    envelope that is not wire v1, answered with schema paths, never a value;
 *    404 while the source is off (FLINT_SOURCE_APPLE_CALENDAR); 409 while it is
 *    not turned on, and what it held is dropped, so a source that is off keeps
 *    no calendar in memory; 422 for a snapshot that is not fresh, or not newer
 *    than the last one accepted; 429 within 5 seconds of the last accepted;
 *    otherwise 202.
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
import { parseSnapshot } from '../sources/apple/wire.js';

export const SNAPSHOT_PATH = '/v1/sources/apple_calendar/snapshot';
/** A full snapshot (1000 events of 100 attendees) is well under this. */
export const SNAPSHOT_BODY_LIMIT = 2 * 1024 * 1024;
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
      d.inbox.clear();
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
    return reply.code(202).send({ accepted: true });
  });
}
