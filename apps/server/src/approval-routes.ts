/**
 * The approval surface (Machine plan 3.0.2): the proposal list; approving and
 * rejecting (one tap only until Will has an approval key, his signature after);
 * running an approved runtime proposal that has not run; enrolling keys. All of
 * it is reached with the console token, and once a key is enrolled nothing here
 * approves on that token alone.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Tool } from '@flint/core';
import { ACTION_DONE, digestOf } from '@flint/policy';
import { readJsonLimited } from './attachments';
import { keyOf, outcomeOf, type ActionQueue, type PendingAction } from './actions';
import type { AuditSink } from './audit-sink';
import { ApprovalError, type Approvals } from './approvals';
import type { Notifications } from './notifications';
import { RuntimeError, type Outcome as ProposalOutcome, type RuntimeProposal, type RuntimeProposals } from './runtime-proposals';
import { withTurnTaint } from './turn-taint';

/** A runtime card that cannot be signed: what it would carry out is not what it shows. */
export const DOES_NOT_MATCH = 'It can’t be signed: what it would do doesn’t match what it shows.';

/**
 * The digest of the args the console's card showed, when it sends one, is the digest about to be signed. (The
 * console checks the challenge too; this is the server's half. An older console that sends none is not refused.)
 */
function shownMatches(body: Record<string, unknown>, digest: string): boolean {
  return body.argsDigest === undefined || body.argsDigest === digest;
}

/** Do a runtime card's args hash to the digest it asks Will to sign? (Its args are what the card shows him.) */
function argsMatch(p: Pick<RuntimeProposal, 'args' | 'argsDigest'>): boolean {
  if (p.args === null) return false;
  try {
    return digestOf(p.args) === p.argsDigest;
  } catch {
    return false;
  }
}

export interface ApprovalDeps {
  actions: ActionQueue;
  tools: Tool[];
  audit: Pick<AuditSink, 'record'>;
  notes: Pick<Notifications, 'push'>;
  approvals: Approvals | undefined;
  proposals: RuntimeProposals | undefined;
  /** Log an error with a short reference, and return the reference for the client. */
  errorRef: (tag: string, err: unknown) => string;
}

type Ctx = ApprovalDeps;

/** Small JSON bodies (approvals). */
const SMALL_JSON_BYTES = 64 * 1024;

/** A device without a key, told where to add one (the console's footer says the same). */
const NEEDS_KEY = 'This device needs an approval key. Add one in Settings.';
const GONE = 'It no longer exists.';
const NOT_WAITING = 'It’s no longer waiting.';

/**
 * The "Action done" note's body: what Flint did, in a sentence of its own (a
 * card's title is a command, "Check What’s Happening Now", and reads wrong as a
 * sentence's subject), or no name at all (never its internal one).
 */
export const doneNote = (fullName: string): string => ACTION_DONE[fullName] ?? 'An approved action is done.';

/**
 * When the restore test runs next, in this Mac's local time (the LaunchAgent's):
 * Sundays at 2:15 AM. Its card is filed by that very run, so on a Sunday past
 * 2:15 the run that claims it is a week away, and "Sunday" would read as today.
 */
export function drillRunsAt(now: Date): string {
  if (now.getDay() !== 0) return 'Sunday at 2:15 AM';
  return now.getHours() * 60 + now.getMinutes() < 2 * 60 + 15 ? 'today at 2:15 AM' : 'next Sunday at 2:15 AM';
}

/**
 * When a nightly job runs the card Will approved, by the job that filed it: the
 * LaunchAgent runs backups at 02:15 (the drill on Sundays), and retention runs at 03:10.
 */
export function nightlyRun(origin: string, now = new Date()): string | undefined {
  const when: Record<string, string> = {
    'runtime:backup': 'tonight at 2:15 AM',
    'runtime:offsite': 'tonight at 2:15 AM',
    'runtime:drill': drillRunsAt(now),
    'runtime:retention': 'tonight at 3:10 AM',
  };
  return when[origin] ? `Approved. It runs ${when[origin]}.` : undefined;
}

function reply(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
  return true;
}

/** Handle one approval route; false when `url` is not one of them. */
export async function approvalRoutes(req: IncomingMessage, res: ServerResponse, url: string, ctx: ApprovalDeps): Promise<boolean> {
  // Proposed actions awaiting Will's approval (writes Flint wanted to make).
  if (req.method === 'GET' && url.startsWith('/proposals')) {
    if (ctx.proposals) {
      try {
        // Pending ones to decide; approved ones not run yet (a cap was reached, the
        // runtime did not answer) to run again.
        const [pending, approved] = await Promise.all([ctx.proposals.list('pending'), ctx.proposals.list('approved')]);
        const card = (p: RuntimeProposal) => ({
          id: p.id, fullName: p.action.replace(/^mcp:/, ''), args: p.args, tainted: p.tainted, provenance: p.argsProvenance, status: p.status, origin: p.origin, ts: Date.parse(p.createdAt),
          // What makes a card ask on its own (the console's Approve All leaves it out): money, a destructive tool.
          sensitivity: p.sensitivity, destructive: p.destructive === true,
          // What the card says about itself (the promotion table's week, a source's name), and when it lapses.
          ...(p.reason ? { reason: p.reason } : {}), expiresAt: p.expiresAt,
        });
        return reply(res, 200, { proposals: [...pending.map(card), ...approved.map(card)], unsynced: ctx.proposals.unsynced(), signed: true });
      } catch {
        return reply(res, 200, { proposals: [], unsynced: ctx.proposals.unsynced(), runtime: 'down', signed: true });
      }
    }
    return reply(res, 200, { proposals: ctx.actions.list(), signed: !!ctx.approvals && (await ctx.approvals.hasCredentials().catch(() => true)) });
  }
  if (req.method === 'POST' && url === '/proposals/approve' && ctx.proposals) {
    return reply(res, 403, { error: NEEDS_KEY });
  }
  // An approved runtime proposal that has not run yet (its cap was reached, or the runtime did not answer): run it now.
  if (req.method === 'POST' && url === '/proposals/run' && ctx.proposals) {
    const read = await readJsonLimited(req, SMALL_JSON_BYTES);
    if (read.tooLarge) return reply(res, 413, { error: 'request too large' });
    const id = String(read.body.id ?? '');
    try {
      const p = await ctx.proposals.get(id);
      if (!p || p.status !== 'approved') return reply(res, 409, { error: 'It already ran or is no longer approved.' });
      return reply(res, 200, { action: await executeApproved(ctx, id) });
    } catch (err) {
      return reply(res, err instanceof RuntimeError ? (err.status >= 500 ? 502 : err.status) : 502, { error: err instanceof Error ? err.message : 'It didn’t run.' });
    }
  }
  if (req.method === 'POST' && url === '/proposals/reject' && ctx.proposals) {
    const read = await readJsonLimited(req, SMALL_JSON_BYTES);
    if (read.tooLarge) return reply(res, 413, { error: 'request too large' });
    try {
      await ctx.proposals.reject(String(read.body.id ?? ''));
      return reply(res, 200, { ok: true });
    } catch (err) {
      return reply(res, err instanceof RuntimeError ? err.status : 502, { error: err instanceof Error ? err.message : 'reject failed' });
    }
  }
  if (req.method === 'POST' && url === '/proposals/approve') {
    // Once Will has an approval key, the console token alone approves nothing (plan
    // 3.0.2: a stolen token must not be enough); if the keys cannot be checked, neither.
    if (ctx.approvals) {
      const keyed = await ctx.approvals.hasCredentials().catch(() => true);
      if (keyed) return reply(res, 403, { error: NEEDS_KEY });
    }
    const read = await readJsonLimited(req, SMALL_JSON_BYTES);
    if (read.tooLarge) return reply(res, 413, { error: 'request too large' });
    const id = String(read.body.id ?? '');
    const pending = ctx.actions.list().find((a) => a.id === id && a.status === 'pending');
    if (!pending) {
      const known = ctx.actions.list().find((a) => a.id === id);
      return known ? reply(res, 200, { action: known }) : reply(res, 404, { error: GONE });
    }
    const out = await runRamApproval(ctx, pending, 'will:console', {});
    return 'error' in out ? reply(res, out.status, { error: out.error }) : reply(res, 200, { action: out.action });
  }
  // ---- Will's approval factor (./approvals) ------------------------------------
  if (url.startsWith('/approvals/')) {
    if (!ctx.approvals) return reply(res, 501, { error: 'Approvals aren’t set up on this server. Set FLINT_DB_APPROVER_URL, then restart it.' });
    const ap = ctx.approvals;
    try {
      if (req.method === 'GET' && url === '/approvals/credentials') return reply(res, 200, { credentials: await ap.credentials() });
      // New keys waiting for an existing key's approval, and whether one has been approved.
      if (req.method === 'GET' && url === '/approvals/enroll/pending') return reply(res, 200, { pending: ap.pendingEnrolApprovals() });
      if (req.method === 'GET' && url.startsWith('/approvals/enroll/approved?')) {
        return reply(res, 200, { approved: ap.enrolApproved(new URL(url, 'http://x').searchParams.get('challengeId')) });
      }
      if (req.method !== 'POST') return reply(res, 405, { error: 'method not allowed' });
      const read = await readJsonLimited(req, SMALL_JSON_BYTES);
      if (read.tooLarge) return reply(res, 413, { error: 'request too large' });
      const body = read.body as Record<string, unknown>;
      if (url === '/approvals/enroll/begin') return reply(res, 200, await ap.beginEnroll(body));
      // A further credential: an existing one signs for exactly the new key.
      if (url === '/approvals/enroll/approve-begin') return reply(res, 200, await ap.beginEnrollApproval(body));
      if (url === '/approvals/enroll/approve-finish') return reply(res, 200, await ap.finishEnrolApproval(body));
      if (url === '/approvals/enroll/finish') return reply(res, 200, await ap.finishEnroll(body));
      if (url === '/approvals/begin' && ctx.proposals) {
        // A runtime proposal: Will signs its action and the args digest the runtime computed.
        const id = String(body.proposalId ?? '');
        const decision = body.decision === 'reject' ? 'reject' : 'approve';
        const p = await ctx.proposals.get(id);
        if (!p || p.status !== 'pending') return reply(res, 404, { error: NOT_WAITING });
        // What Will signs must be the args he is shown: the digest is recomputed here, never taken on the
        // runtime's word (a runtime that stored one thing and reported another would get him to sign the other).
        // (Rejecting it is always allowed: that carries nothing out.) The console also sends the digest of the args
        // its card showed: the one signed must be that one too.
        if (decision === 'approve' && (!argsMatch(p) || !shownMatches(body, p.argsDigest))) return reply(res, 409, { error: DOES_NOT_MATCH });
        return reply(res, 200, ap.begin({ subjectType: 'proposal', subjectId: id, decision, action: p.action, argsDigest: p.argsDigest, fields: { tainted: p.tainted } }));
      }
      if (url === '/approvals/finish' && ctx.proposals) {
        const { approvalId, payload } = await ap.finish(body);
        if (payload.subjectType !== 'proposal') return reply(res, 409, { error: 'that approval is not for a proposal', approvalId });
        const id = payload.subjectId;
        if (payload.decision === 'approve') {
          // Still the args Will was shown, with the digest he signed.
          const now = await ctx.proposals.get(id);
          if (!now || !argsMatch(now) || now.argsDigest !== payload.argsDigest) return reply(res, 409, { error: DOES_NOT_MATCH, approvalId });
        }
        if (payload.decision === 'reject') {
          await ctx.proposals.reject(id, approvalId);
          return reply(res, 200, { ok: true, approvalId });
        }
        await ctx.proposals.approve(id, approvalId);
        return reply(res, 200, { action: await executeApproved(ctx, id), approvalId });
      }
      if (url === '/approvals/begin') {
        // A proposal in the RAM queue: what Will signs is its exact action and args.
        const id = String(body.proposalId ?? '');
        const decision = body.decision === 'reject' ? 'reject' : 'approve';
        const p = ctx.actions.list().find((a) => a.id === id && a.status === 'pending');
        if (!p) return reply(res, 404, { error: NOT_WAITING });
        let argsDigest: string;
        try {
          argsDigest = digestOf(p.args ?? null);
        } catch {
          return reply(res, 409, { error: 'It can’t be signed.' });
        }
        if (decision === 'approve' && !shownMatches(body, argsDigest)) return reply(res, 409, { error: DOES_NOT_MATCH });
        return reply(res, 200, ap.begin({ subjectType: 'proposal', subjectId: id, decision, action: p.fullName, argsDigest }));
      }
      if (url === '/approvals/finish') {
        const { approvalId, payload } = await ap.finish(body);
        const id = payload.subjectId;
        const p = ctx.actions.list().find((a) => a.id === id && a.status === 'pending');
        if (!p) return reply(res, 409, { error: NOT_WAITING, approvalId });
        // The args must still be exactly what was signed.
        let digest = '';
        try {
          digest = digestOf(p.args ?? null);
        } catch {
          digest = '';
        }
        if (payload.subjectType !== 'proposal' || payload.action !== p.fullName || payload.argsDigest !== digest) {
          return reply(res, 409, { error: 'It changed after you approved it.', approvalId });
        }
        if (payload.decision === 'reject') {
          ctx.actions.reject(id);
          ctx.audit.record({ actor: 'will:passkey', context: 'console', kind: 'rejection', action: p.fullName, decision: 'deny', outcome: 'denied', inputs: { proposal: id, approvalId }, correlationId: `act:${id}` });
          return reply(res, 200, { ok: true, approvalId });
        }
        const out = await runRamApproval(ctx, p, 'will:passkey', { approvalId });
        return 'error' in out ? reply(res, out.status, { error: out.error, approvalId }) : reply(res, 200, { action: out.action, approvalId });
      }
      return reply(res, 404, { error: 'not found' });
    } catch (err) {
      if (err instanceof ApprovalError) {
        // Will reads the sentence; why it was refused (the verifier's words, never a secret) is logged under the ref.
        return reply(res, err.status, { error: err.message, ...(err.why ? { ref: ctx.errorRef('approvals', `refused: ${err.why}`) } : {}) });
      }
      if (err instanceof RuntimeError) return reply(res, err.status >= 500 ? 502 : err.status, { error: err.message });
      return reply(res, 500, { error: 'The approval failed. Try again.', ref: ctx.errorRef('approvals', err) });
    }
  }
  if (req.method === 'POST' && url === '/proposals/reject') {
    const read = await readJsonLimited(req, SMALL_JSON_BYTES);
    if (read.tooLarge) return reply(res, 413, { error: 'request too large' });
    const body = read.body;
    const rid = String(body.id ?? '');
    const rejected = ctx.actions.list().find((a) => a.id === rid);
    const ok = ctx.actions.reject(rid);
    if (ok && rejected) ctx.audit.record({ actor: 'will:console', context: 'console', kind: 'rejection', action: rejected.fullName, decision: 'deny', outcome: 'denied', inputs: { proposal: rid }, correlationId: `act:${rid}` });
    return reply(res, 200, { ok });
  }
  return false;
}

/**
 * Run a RAM-queue proposal Will approved (one tap before he has a key, or his
 * signature): the intent is on disk before anything runs (plan 3.0.7), and if it
 * cannot be written nothing runs. The audit keeps an error's class, never its
 * words (they stay on the console card).
 */
export async function runRamApproval(
  ctx: Ctx,
  pending: PendingAction,
  actor: string,
  extra: Record<string, string>,
): Promise<{ action: PendingAction } | { status: number; error: string }> {
  let argsDigest: string | null = null;
  try {
    argsDigest = digestOf(pending.args ?? null);
  } catch {
    argsDigest = null;
  }
  const inputs = { proposal: pending.id, argsDigest, ...extra };
  try {
    ctx.audit.record({ actor, context: 'console', kind: 'intent', action: pending.fullName, decision: 'act', outcome: 'pending', inputs, correlationId: `act:${pending.id}` }, true);
  } catch {
    return { status: 503, error: 'the intent could not be recorded, so nothing was run' };
  }
  const result = await ctx.actions.approve(pending.id, ctx.tools);
  if (!result) return { status: 404, error: GONE };
  const ok = result.status === 'done';
  ctx.audit.record({
    actor, context: 'console', kind: 'action', action: result.fullName, decision: 'act', outcome: ok ? 'ok' : 'failed', inputs,
    ...(ok ? {} : { reasoning: 'the action did not complete (the console card has the details)' }), correlationId: `act:${pending.id}`,
  });
  // In the app only: Will just approved it, so a banner or a ping would tell him nothing new.
  if (ok) ctx.notes.push('Action done', doneNote(result.fullName), 'action', `act:${result.id}`, { channels: ['inapp'] });
  return { action: result };
}

export type Executed = { id: string; fullName: string; status: 'done' | 'error' | 'approved'; result?: unknown; error?: string; note?: string };

/**
 * Carry out a proposal Will has approved in the runtime:
 *  - a tool call this server has wired (an MCP tool or a built-in): claimed
 *    (the runtime re-verifies the signature, takes the cap and writes the
 *    intent), run here on a one-time allowance for exactly those args, in a
 *    scope as tainted as the proposal, and how it ended reported (spooled if the
 *    runtime cannot take it);
 *  - an action the runtime carries out itself (turning a source on, a signed
 *    policy change): run there;
 *  - anything else (a runtime job's own proposal, a nightly backup or drill; a
 *    tool not wired right now) stays approved, for its job or a later Run.
 */
export async function executeApproved(ctx: Ctx, id: string): Promise<Executed> {
  const p = ctx.proposals!;
  const proposal = await p.get(id);
  if (!proposal) return { id, fullName: id, status: 'error', error: GONE };
  const m = /^mcp:([A-Za-z0-9_-]+)\.(.+)$/.exec(proposal.action);
  const server = m ? m[1]! : 'flint';
  const toolName = m ? m[2]! : proposal.action;
  const fullName = m ? `${server}.${toolName}` : proposal.action;
  const tool = ctx.tools.find((t) => t.definition.name === fullName);
  if (!tool) {
    try {
      return { id, fullName, status: 'done', result: await p.run(id) };
    } catch (err) {
      if (err instanceof RuntimeError && err.status === 409 && /not carried out by the runtime/.test(err.message)) {
        // A tool that is not connected right now (Run Now in Approvals, once it is), or a nightly job's own card.
        const note = m || !proposal.origin.startsWith('runtime:')
          ? 'Approved. Its tool isn’t connected, so run it later in Approvals.'
          : (nightlyRun(proposal.origin) ?? 'Approved. Its nightly job runs it.');
        return { id, fullName, status: 'approved', note };
      }
      throw err;
    }
  }
  let claimed: Awaited<ReturnType<RuntimeProposals['claim']>>;
  try {
    claimed = await p.claim(id);
  } catch (err) {
    // A cap reached leaves it approved, to run again later.
    // The runtime's message is a sentence ("Today’s limit of 10 is reached.").
    if (err instanceof RuntimeError && err.status === 429) return { id, fullName, status: 'approved', note: `Approved. ${err.message} Run it later.` };
    throw err;
  }
  let result: unknown;
  let outcome: ProposalOutcome;
  // The tool's own words, for the console card only: the runtime gets the class.
  let detail: string | undefined;
  try {
    result = await withTurnTaint(() => tool.handler({ id: `call_${id}`, toolName: fullName, args: claimed.args }), {
      allow: [keyOf(server, toolName, claimed.args)],
      sources: proposal.tainted ? ['proposal'] : [],
    });
    const o = outcomeOf(result);
    if (o.ok) outcome = { ok: true, result: { value: storable(result) } };
    else {
      detail = o.detail;
      outcome = { ok: false, error: o.error };
    }
  } catch (err) {
    detail = err instanceof Error ? err.message : String(err);
    outcome = { ok: false, error: `the tool threw (${err instanceof Error ? err.name : 'error'})` };
  }
  const where = await p.completeDurably(id, outcome);
  // In the app only: Will just approved it, so a banner or a ping would tell him nothing new.
  if (outcome.ok) ctx.notes.push('Action done', doneNote(fullName), 'action', `act:${id}`, { channels: ['inapp'] });
  const note =
    where === 'spooled' ? 'Flint will record the result once the runtime answers.'
    : where === 'refused' ? 'The runtime didn’t record the result, so it will show as unknown.'
    : undefined;
  return {
    id, fullName, status: outcome.ok ? 'done' : 'error',
    ...(result !== undefined ? { result } : {}), ...(outcome.ok ? {} : { error: (detail ?? outcome.error ?? 'failed').slice(0, 2000) }),
    ...(note ? { note } : {}),
  };
}

/** Lone surrogates and NULs become storable text (Postgres refuses both). */
const clean = (v: string) => v.replace(/\u0000/g, '').replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');

/** A tool's result as the runtime can store it: every string clean, and past 15 KB only its size. */
export function storable(result: unknown): unknown {
  let json: string;
  try {
    json = JSON.stringify(result ?? null, (_k, v: unknown) => (typeof v === 'string' ? clean(v) : typeof v === 'bigint' ? v.toString() : v));
  } catch {
    return '[the result could not be serialised]';
  }
  return json.length <= 15_000 ? JSON.parse(json) : { truncated: true, chars: json.length };
}
