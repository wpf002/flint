import { randomBytes } from 'node:crypto';
import type { Tool, ToolCall } from '@flint/core';
import type { ApprovalRequest } from '@flint/mcp';
import { isEvalTurn, takeAllowance, turnTainted, withTurnTaint } from './turn-taint';

export interface PendingAction {
  id: string;
  server: string;
  tool: string;
  fullName: string;
  args: unknown;
  destructive: boolean;
  /** Proposed by a turn that had read untrusted text. */
  tainted: boolean;
  ts: number;
  status: 'pending' | 'running' | 'done' | 'error' | 'rejected';
  result?: unknown;
  error?: string;
}

/** Deterministic key so an approved action matches the exact call that runs. */
export function keyOf(server: string, tool: string, args: unknown): string {
  return `${server}.${tool}::${stableStringify(args)}`;
}
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
}

/**
 * Did a tool do what it was asked? A handler that resolves is not enough: an MCP
 * server reports its own failure as `{isError: true}`, and the gate refuses as
 * `{approved: false}`. `error` is a short class for the audit trail (never the
 * tool's own words, which can carry personal data); `detail` is those words, for
 * the console card only.
 */
export function outcomeOf(result: unknown): { ok: true } | { ok: false; error: string; detail: string } {
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const r = result as { approved?: unknown; isError?: unknown; message?: unknown; content?: unknown };
    if (r.approved === false) return { ok: false, error: 'not executed: refused by the gate', detail: typeof r.message === 'string' ? r.message : 'not executed' };
    if (r.isError === true) return { ok: false, error: 'the tool reported an error', detail: typeof r.content === 'string' ? r.content.slice(0, 2000) : 'the tool reported an error' };
  }
  return { ok: true };
}

/** RAM-queue ids are unique across restarts, so an audit correlation id never names two actions. */
const BOOT = randomBytes(3).toString('hex');

/**
 * Turns Flint from an oracle into an assistant — safely. Read-only tools run
 * freely; any side-effecting (write) tool the model attempts is NOT executed
 * autonomously. Instead it's captured as a PROPOSED ACTION and surfaced to Will,
 * who approves or rejects. On approval the exact captured call is executed. The
 * hard rule still holds elsewhere: no financial-write tools are wired, so Flint
 * can draft an email or add a calendar event but can never trade or move money.
 */
export class ActionQueue {
  private readonly pending = new Map<string, PendingAction>();
  private seq = 0;

  /** isSafe classifies read-only tools that may run without approval. */
  constructor(private readonly isSafe: (tool: string) => boolean) {}

  /** Did Will approve exactly this call for this turn? Spends the allowance. */
  allowed(req: { server: string; tool: string; args: unknown }): boolean {
    return takeAllowance(keyOf(req.server, req.tool, req.args));
  }

  /** Capture a call as a pending proposal (an identical pending one is reused); returns its id. */
  capture(req: { server: string; tool: string; fullName: string; args: unknown; destructive: boolean }): string {
    const key = keyOf(req.server, req.tool, req.args);
    // Dedupe identical pending proposals.
    const existing = [...this.pending.values()].find((p) => p.status === 'pending' && keyOf(p.server, p.tool, p.args) === key);
    if (existing) return existing.id;
    const id = `act-${BOOT}-${++this.seq}`;
    this.pending.set(id, { id, server: req.server, tool: req.tool, fullName: req.fullName, args: req.args, destructive: req.destructive, tainted: turnTainted(), ts: Date.now(), status: 'pending' });
    return id;
  }

  /** The MCP approver (without the tier gate). Safe → run. Write → execute IF approved for this turn, else queue. */
  approver = (req: ApprovalRequest): boolean => {
    // The WHOLE `server.tool` name: isSafeTool is written for it (a namespace can
    // carry the dangerous word, `execute.trade`), and was handed the bare tool.
    if (this.isSafe(`${req.server}.${req.tool}`)) return true;
    if (takeAllowance(keyOf(req.server, req.tool, req.args))) return true;
    if (!isEvalTurn()) this.capture({ server: req.server, tool: req.tool, fullName: `${req.server}.${req.tool}`, args: req.args, destructive: req.destructive });
    return false;
  };

  /**
   * The tier engine already decided this call needs approval (tier-gate.ts):
   * run it only if Will approved this exact call (an allowance in this turn's
   * scope), otherwise capture it as a proposal. An eval replay captures nothing.
   */
  requestApproval(req: { server: string; tool: string; fullName: string; args: unknown; destructive: boolean }): { allowed: true } | { allowed: false; id?: string } {
    if (takeAllowance(keyOf(req.server, req.tool, req.args))) return { allowed: true };
    if (isEvalTurn()) return { allowed: false };
    return { allowed: false, id: this.capture(req) };
  }

  /** Pending proposals created since a snapshot of ids (for per-turn surfacing). */
  snapshotIds(): Set<string> {
    return new Set(this.pending.keys());
  }
  newSince(before: Set<string>): PendingAction[] {
    return [...this.pending.values()].filter((p) => !before.has(p.id) && p.status === 'pending');
  }

  list(): PendingAction[] {
    return [...this.pending.values()].sort((a, b) => b.ts - a.ts);
  }

  reject(id: string): boolean {
    const a = this.pending.get(id);
    if (!a || a.status !== 'pending') return false;
    a.status = 'rejected';
    return true;
  }

  /**
   * Approve + execute the captured call via its tool handler, in a scope of its
   * own: the allowance for exactly this call lives only there, and the scope
   * starts as tainted as the turn that proposed it.
   */
  async approve(id: string, tools: Tool[]): Promise<PendingAction | undefined> {
    const a = this.pending.get(id);
    if (!a || a.status !== 'pending') return a;
    const tool = tools.find((t) => t.definition.name === a.fullName);
    if (!tool) {
      a.status = 'error';
      a.error = `tool ${a.fullName} not wired`;
      return a;
    }
    // Off the pending list before it runs, so a second approve cannot run it again.
    a.status = 'running';
    try {
      const call: ToolCall = { id: `call_${a.id}`, toolName: a.fullName, args: a.args };
      a.result = await withTurnTaint(() => tool.handler(call), { allow: [keyOf(a.server, a.tool, a.args)], sources: a.tainted ? ['proposal'] : [] });
      const o = outcomeOf(a.result);
      a.status = o.ok ? 'done' : 'error';
      if (!o.ok) a.error = o.detail;
    } catch (err) {
      a.status = 'error';
      a.error = err instanceof Error ? err.message : String(err);
    }
    return a;
  }
}
