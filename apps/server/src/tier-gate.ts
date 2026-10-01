/**
 * Every tool call Flint makes in chat goes through the tier engine
 * (@flint/policy resolveTier, Machine plan 3.0.3):
 *   FORBIDDEN  -> refused, and the model is told why;
 *   APPROVAL   -> runs only if Will approved this exact call; otherwise it is
 *                 queued as a proposal (the console's one-tap card) and the model
 *                 is told it was not executed;
 *   ALONE      -> runs.
 * MCP tools reach this through the MCP client's gate (every call, read-only
 * ones included); Flint's built-in tools through gateBuiltins(). A result from
 * anywhere but Flint's own runtime taints the turn (turn-taint.ts).
 *
 * FLINT_TAINT_FLOOR=0 turns the tainted-turn floor off (kill switch only: with
 * it off, an injected web page can steer a fetch or a write again).
 */
import { isWrite, resolveTier, type PolicyRow, type TierDecision } from '@flint/policy';
import type { Gate, GateRequest } from '@flint/mcp';
import type { Tool } from '@flint/core';
import type { ActionQueue } from './actions';
import { markTainted, taintSources, turnTainted, withTurnTaint } from './turn-taint';

export interface TierEvent {
  name: string;
  decision: TierDecision;
  /** Changes something (anything but a read). */
  write: boolean;
  tainted: boolean;
  taintedBy: string[];
}

export interface TierGateOptions {
  queue: ActionQueue;
  /** The live ActionPolicy rows (none until the runtime is set up and Will signs a promotion table). */
  policies?: () => readonly PolicyRow[];
  /** Called for every decision (the audit sink). */
  onDecision?: (e: TierEvent) => void;
  taintFloor?: boolean;
}

/** Built-in tools whose results are untrusted text (deep_research reads the web). */
const TAINTING_BUILTINS = new Set(['deep_research']);

function decide(name: string, opts: TierGateOptions, mcp?: { server: string; tool: string; readOnlyHint?: boolean; destructiveHint?: boolean }) {
  const tainted = (opts.taintFloor ?? true) && turnTainted();
  const decision = resolveTier(name, { context: 'chat', tainted, ...(mcp ? { mcp } : {}), policies: opts.policies?.() ?? [] });
  opts.onDecision?.({ name, decision, write: isWrite(name, mcp), tainted, taintedBy: taintSources() });
  return decision;
}

const refusal = (name: string, d: TierDecision) => `Flint may not run '${name}': ${d.reason}. It was not executed.`;
const queued = (name: string, d: TierDecision) =>
  `'${name}' needs Will's approval (${d.rule === 'tainted' ? 'this turn read untrusted text' : d.reason}); it is queued for him and was not executed.`;

/** The MCP client's gate. */
export function tierGate(opts: TierGateOptions): Gate {
  return {
    check(req: GateRequest) {
      const mcp = {
        server: req.server,
        tool: req.tool,
        ...(req.annotations.readOnlyHint ? { readOnlyHint: true } : {}),
        ...(req.annotations.destructiveHint ? { destructiveHint: true } : {}),
      };
      const d = decide(req.fullName, opts, mcp);
      if (d.tier === 'forbidden') return { allow: false, message: refusal(req.fullName, d) };
      if (d.tier === 'approval') {
        const ok = opts.queue.requestApproval({ server: req.server, tool: req.tool, fullName: req.fullName, args: req.args, destructive: !!req.annotations.destructiveHint });
        return ok ? { allow: true } : { allow: false, message: queued(req.fullName, d) };
      }
      return { allow: true };
    },
    onResult(req: GateRequest, result: unknown) {
      // Only the runtime is Flint's own code, and it says when what it returns
      // came from someone else (a world entity's tainted fields). Every other
      // server returns text others wrote: web pages, Nexus threads (several
      // writers), mail, Drive, GitHub.
      if (req.server !== 'runtime' || /"tainted"\s*:\s*true/.test(JSON.stringify(result ?? null))) markTainted(`mcp:${req.server}`);
    },
  };
}

/** Wrap Flint's built-in tools so they go through the same engine. */
export function gateBuiltins(tools: Tool[], opts: TierGateOptions): Tool[] {
  return tools.map((t) => {
    const name = t.definition.name;
    return {
      definition: t.definition,
      handler: async (call) => {
        const d = decide(name, opts);
        if (d.tier === 'forbidden') return { approved: false, message: refusal(name, d) };
        if (d.tier === 'approval' && !opts.queue.requestApproval({ server: 'flint', tool: name, fullName: name, args: call.args, destructive: false })) {
          return { approved: false, message: queued(name, d) };
        }
        // deep_research searches and then reads what it found: inside it, its own
        // results must not gate its next fetch, so it runs in a scope of its own.
        // What it returns still taints this turn.
        const result = TAINTING_BUILTINS.has(name) ? await withTurnTaint(() => t.handler(call)) : await t.handler(call);
        if (TAINTING_BUILTINS.has(name)) markTainted(name);
        return result;
      },
    };
  });
}
