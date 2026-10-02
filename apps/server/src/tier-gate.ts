/**
 * Every tool call Flint makes in chat goes through the tier engine
 * (@flint/policy resolveTier, Machine plan 3.0.3):
 *   FORBIDDEN  -> refused, and the model is told why;
 *   APPROVAL   -> runs only if Will approved this exact call; otherwise it is
 *                 queued as a proposal (the console's approval card) and the
 *                 model is told it was not executed;
 *   ALONE      -> runs (a capped one only once its counter is claimed).
 * MCP tools reach this through the MCP client's gate (every call, read-only
 * ones included); Flint's built-in tools through gateBuiltins(). A result from
 * anywhere but Flint's own runtime taints the turn (turn-taint.ts).
 *
 * What is recorded (onDecision / onOutcome, the audit sink): every refusal;
 * every call queued in the RAM queue (correlated with its proposal id); every
 * ALONE write, as pending and then with its real outcome. Reads are counted.
 * A call that became a runtime proposal is recorded by the runtime itself, and
 * an approved call running on its allowance by whoever ran it.
 *
 * An eval replay (isEvalTurn) never queues or proposes anything.
 *
 * FLINT_TAINT_FLOOR=0 turns the tainted-turn floor off (kill switch only: with
 * it off, an injected web page can steer a fetch or a write again).
 */
import { randomBytes } from 'node:crypto';
import { CLAIM_TEMPLATE_HELP, ClaimTemplate, isWrite, resolveTier, type PolicyRow, type TierDecision } from '@flint/policy';
import type { Gate, GateRequest } from '@flint/mcp';
import type { Tool } from '@flint/core';
import { outcomeOf, type ActionQueue } from './actions';
import { isEvalTurn, markTainted, noteProposal, taintSources, turnId, turnTainted, withTurnTaint } from './turn-taint';
import type { RuntimeProposals } from './runtime-proposals';

export interface TierEvent {
  name: string;
  decision: TierDecision;
  /** Changes something (anything but a read). */
  write: boolean;
  tainted: boolean;
  taintedBy: string[];
  /**
   * What happened: refused, queued for Will (RAM queue), acting (an ALONE write;
   * its outcome follows with the same correlation id), or a read (counted).
   */
  status: 'denied' | 'queued' | 'acting' | 'read';
  correlationId?: string;
}

export interface TierOutcome {
  name: string;
  key: string;
  correlationId: string;
  ok: boolean;
  /** A short class (never the tool's own words). */
  error?: string;
}

/** Claim a promoted action's cap in the runtime: claimed, at the cap, or the runtime cannot say. */
export type CapClaim = (d: TierDecision) => Promise<'ok' | 'capped' | 'unavailable'>;

export interface TierGateOptions {
  queue: ActionQueue;
  /** The live ActionPolicy rows (none until the runtime is set up and Will signs a promotion table). */
  policies?: () => readonly PolicyRow[];
  /** Called for every decision (the audit sink). */
  onDecision?: (e: TierEvent) => void;
  /** Called when an ALONE write finishes. */
  onOutcome?: (o: TierOutcome) => void;
  /** Caps are claimed atomically at decision time; without this, a capped call needs approval. */
  claimCap?: CapClaim;
  taintFloor?: boolean;
  /** Runtime mode (FLINT_RUNTIME_URL): approval-tier calls become runtime proposals. */
  proposals?: RuntimeProposals;
}

type Mcp = Parameters<typeof isWrite>[1];
type Call = { server: string; tool: string; fullName: string; action: string; args: unknown; destructive: boolean; readOnlyHint?: boolean };

const refusal = (name: string, d: TierDecision) => `Flint may not run '${name}': ${d.reason}. It was not executed.`;
const queued = (name: string, d: TierDecision) =>
  `'${name}' needs Will's approval (${d.rule === 'tainted' ? 'this turn read untrusted text' : d.reason}); it is queued for him and was not executed.`;
const newCorrelation = () => `call:${randomBytes(8).toString('hex')}`;

function event(opts: TierGateOptions, name: string, d: TierDecision, mcp: Mcp, status: TierEvent['status'], correlationId?: string): void {
  opts.onDecision?.({ name, decision: d, write: isWrite(name, mcp), tainted: turnTainted(), taintedBy: taintSources(), status, ...(correlationId ? { correlationId } : {}) });
}

/**
 * An approval-tier call: run it if Will approved this exact call, otherwise
 * queue it (RAM queue, or a runtime proposal in runtime mode). Returns the
 * message the model sees when it does not run.
 */
async function needsApproval(opts: TierGateOptions, d: TierDecision, call: Call, mcp: Mcp): Promise<string | undefined> {
  // An eval replay: nothing it asks for may ever become approvable.
  if (isEvalTurn()) return `${queued(call.fullName, d)} (eval replay: not queued)`;
  if (!opts.proposals) {
    const id = opts.queue.capture(call);
    noteProposal({ id, fullName: call.fullName, args: call.args, tainted: turnTainted() });
    event(opts, call.fullName, d, mcp, 'queued', `act:${id}`);
    return queued(call.fullName, d);
  }
  const tainted = turnTainted();
  const args = (call.args && typeof call.args === 'object' ? call.args : { value: call.args }) as Record<string, unknown>;
  const p = await opts.proposals.propose({
    kind: 'tool_call',
    origin: `chat:${turnId()}`,
    action: call.action,
    args,
    argsProvenance: Object.fromEntries(Object.keys(args).slice(0, 50).map((k) => [k, { source: 'model' as const, tainted }])),
    tainted,
    destructive: call.destructive,
    ...(call.readOnlyHint ? { readOnlyHint: true } : {}),
  });
  if ('refused' in p) {
    event(opts, call.fullName, { ...d, tier: 'forbidden', reason: p.refused }, mcp, 'denied');
    return `Flint may not run '${call.fullName}': ${p.refused}. It was not executed.`;
  }
  if ('spooled' in p) {
    // The runtime records it when the spool reaches it; until then this is the record.
    event(opts, call.fullName, d, mcp, 'queued', `spool:${p.spoolId}`);
    return `${queued(call.fullName, d)} (pending, unsynced: the runtime is down)`;
  }
  // The runtime recorded the decision, correlated with this proposal.
  noteProposal({ id: p.id, fullName: call.fullName, args, tainted });
  return `${queued(call.fullName, d)} (proposal ${p.id})`;
}

/**
 * The common path for one call: decide, refuse, queue or claim. Returns the
 * message for a call that does not run, or the correlation id an ALONE write's
 * outcome is reported under.
 */
async function gateCall(opts: TierGateOptions, call: Call, mcp?: Mcp): Promise<{ run: false; message: string } | { run: true; correlationId?: string }> {
  const tainted = (opts.taintFloor ?? true) && turnTainted();
  let d = resolveTier(call.fullName, { context: 'chat', tainted, ...(mcp ? { mcp } : {}), policies: opts.policies?.() ?? [] });
  if (d.tier === 'forbidden') {
    event(opts, call.fullName, d, mcp, 'denied');
    return { run: false, message: refusal(call.fullName, d) };
  }
  // Will approved exactly this call: it runs on his approval (its cap was taken
  // when the runtime claimed it), recorded by whoever ran the approval.
  if (opts.queue.allowed(call)) return { run: true };
  // An eval replay changes nothing, promoted or not.
  if (isEvalTurn() && isWrite(call.fullName, mcp)) return { run: false, message: `'${call.fullName}' was not executed (eval replay: it would change something)` };
  if (d.tier === 'alone' && d.cap) {
    // A promoted action's cap is claimed before it runs; if the runtime cannot
    // say, the call goes to Will instead (fail closed).
    const c = opts.claimCap ? await opts.claimCap(d).catch(() => 'unavailable' as const) : 'unavailable';
    if (c === 'capped') {
      const capped: TierDecision = { ...d, tier: 'forbidden', reason: `its cap of ${d.cap.limit} a ${d.cap.period} is used up` };
      event(opts, call.fullName, capped, mcp, 'denied');
      return { run: false, message: refusal(call.fullName, capped) };
    }
    if (c === 'unavailable') d = { ...d, tier: 'approval', reason: `its cap cannot be checked right now (${d.reason})` };
  }
  if (d.tier === 'approval') {
    const message = await needsApproval(opts, d, call, mcp);
    return message ? { run: false, message } : { run: true };
  }
  if (!isWrite(call.fullName, mcp)) {
    event(opts, call.fullName, d, mcp, 'read');
    return { run: true };
  }
  const correlationId = newCorrelation();
  event(opts, call.fullName, d, mcp, 'acting', correlationId);
  return { run: true, correlationId };
}

/**
 * Does a result from Flint's runtime carry text from outside? The runtime marks
 * it (`"tainted": true`, or a non-empty `taintedPaths`) anywhere in the JSON it
 * returns. Anything that is not that JSON counts as tainted (fail closed).
 */
export function runtimeResultTainted(result: unknown): boolean {
  const marked = (v: unknown, depth = 0): boolean => {
    if (depth > 12 || v === null || typeof v !== 'object') return false;
    if (Array.isArray(v)) return v.some((x) => marked(x, depth + 1));
    const o = v as Record<string, unknown>;
    if (o.tainted === true || (Array.isArray(o.taintedPaths) && o.taintedPaths.length > 0)) return true;
    return Object.values(o).some((x) => marked(x, depth + 1));
  };
  let text: unknown;
  if (typeof result === 'string') text = result;
  else if (result && typeof result === 'object' && 'isError' in result) text = (result as { content?: unknown }).content;
  else return true;
  if (typeof text !== 'string') return true;
  try {
    return marked(JSON.parse(text));
  } catch {
    return true;
  }
}

/** What every MCP call carries in `_meta`: whether the turn is tainted (the runtime connector stores it with a prediction). */
const TAINT_META = 'flint/tainted';

/**
 * A prediction worded in a tainted turn must use a claim template (the ledger
 * refuses tainted free text): refused here, before Will is asked to approve a
 * call that cannot succeed.
 */
function predictionRefusal(req: GateRequest): string | undefined {
  if (req.server !== 'runtime' || req.tool !== 'ledger_record_prediction') return undefined;
  const args = req.args && typeof req.args === 'object' ? (req.args as Record<string, unknown>) : {};
  // A template that is given must be a real one, tainted turn or not: the ledger would refuse it after Will approved.
  if (args.template === undefined && !turnTainted()) return undefined;
  const t = ClaimTemplate.safeParse(args.template);
  if (t.success) return undefined;
  const why = args.template === undefined ? 'no template was given' : t.error.issues.map((i) => `${i.path.join('.') || 'template'}: ${i.message}`).join('; ').slice(0, 300);
  return `${turnTainted() ? 'This turn read text from outside, so a' : 'A'} prediction's template must be one of the ledger's claim templates, filled exactly (${why}). ${CLAIM_TEMPLATE_HELP} It was not recorded.`;
}

/** The MCP client's gate. */
export function tierGate(opts: TierGateOptions): Gate {
  // An ALONE write's correlation id, from its check to its result.
  const acting = new WeakMap<GateRequest, string>();
  return {
    async check(req: GateRequest) {
      const mcp = {
        server: req.server,
        tool: req.tool,
        ...(req.annotations.readOnlyHint ? { readOnlyHint: true } : {}),
        ...(req.annotations.destructiveHint ? { destructiveHint: true } : {}),
      };
      const refused = predictionRefusal(req);
      if (refused) {
        // A refusal, recorded like every other.
        const d = resolveTier(req.fullName, { context: 'chat', tainted: turnTainted(), mcp, policies: opts.policies?.() ?? [] });
        event(opts, req.fullName, { ...d, tier: 'forbidden', rule: 'forbidden', reason: 'a prediction needs a valid claim template' }, mcp, 'denied');
        return { allow: false, message: refused };
      }
      const g = await gateCall(opts, {
        server: req.server, tool: req.tool, fullName: req.fullName, action: `mcp:${req.server}.${req.tool}`, args: req.args,
        destructive: !!req.annotations.destructiveHint, ...(req.annotations.readOnlyHint ? { readOnlyHint: true } : {}),
      }, mcp);
      if (!g.run) return { allow: false, message: g.message };
      if (g.correlationId) acting.set(req, g.correlationId);
      return { allow: true, meta: { [TAINT_META]: turnTainted() } };
    },
    onResult(req: GateRequest, result: unknown) {
      // Only the runtime is Flint's own code, and it says when what it returns
      // came from someone else (a world entity's tainted fields). Every other
      // server returns text others wrote: web pages, Nexus threads (several
      // writers), mail, Drive, GitHub.
      if (req.server !== 'runtime' || runtimeResultTainted(result)) markTainted(`mcp:${req.server}`);
      const correlationId = acting.get(req);
      if (correlationId) {
        acting.delete(req);
        const o = outcomeOf(result);
        opts.onOutcome?.({ name: req.fullName, key: `mcp:${req.server}.${req.tool}`, correlationId, ok: o.ok, ...(o.ok ? {} : { error: o.error }) });
      }
    },
  };
}

/** Built-in tools whose results are untrusted text (deep_research reads the web). */
const TAINTING_BUILTINS = new Set(['deep_research']);

/** Wrap Flint's built-in tools so they go through the same engine. */
export function gateBuiltins(tools: Tool[], opts: TierGateOptions): Tool[] {
  return tools.map((t) => {
    const name = t.definition.name;
    return {
      definition: t.definition,
      handler: async (call) => {
        const g = await gateCall(opts, { server: 'flint', tool: name, fullName: name, action: name, args: call.args, destructive: false });
        if (!g.run) return { approved: false, message: g.message };
        const report = (ok: boolean, error?: string) => {
          if (g.correlationId) opts.onOutcome?.({ name, key: name, correlationId: g.correlationId, ok, ...(error ? { error } : {}) });
        };
        let result: unknown;
        try {
          // deep_research searches and then reads what it found: inside it, its own
          // results must not gate its next fetch, so it runs in a scope of its own.
          // What it returns still taints this turn.
          result = TAINTING_BUILTINS.has(name) ? await withTurnTaint(() => t.handler(call), { eval: isEvalTurn() }) : await t.handler(call);
        } catch (err) {
          report(false, err instanceof Error ? err.name : 'error');
          throw err;
        }
        if (TAINTING_BUILTINS.has(name)) markTainted(name);
        const o = outcomeOf(result);
        report(o.ok, o.ok ? undefined : o.error);
        return result;
      },
    };
  });
}
