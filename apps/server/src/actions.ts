import type { Tool, ToolCall } from '@flint/core';
import type { ApprovalRequest } from '@flint/mcp';

export interface PendingAction {
  id: string;
  server: string;
  tool: string;
  fullName: string;
  args: unknown;
  destructive: boolean;
  ts: number;
  status: 'pending' | 'done' | 'error' | 'rejected';
  result?: unknown;
  error?: string;
}

/** Deterministic key so an approved action matches the exact call that runs. */
function keyOf(server: string, tool: string, args: unknown): string {
  return `${server}.${tool}::${stableStringify(args)}`;
}
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
}

/**
 * Turns Flint from an oracle into an assistant — safely. Read-only tools run
 * freely; any side-effecting (write) tool the model attempts is NOT executed
 * autonomously. Instead it's captured as a PROPOSED ACTION and surfaced to Will,
 * who approves or rejects with one tap. On approval the exact captured call is
 * executed. The hard rule still holds elsewhere: no financial-write tools are
 * wired, so Flint can draft an email or add a calendar event but can never trade
 * or move money.
 */
export class ActionQueue {
  private readonly pending = new Map<string, PendingAction>();
  private readonly preApproved = new Set<string>();
  private seq = 0;

  /** isSafe classifies read-only tools that may run without approval. */
  constructor(private readonly isSafe: (tool: string) => boolean) {}

  /** The MCP approver. Safe → run. Write → execute IF pre-approved, else queue. */
  approver = (req: ApprovalRequest): boolean => {
    if (this.isSafe(req.tool)) return true;
    const key = keyOf(req.server, req.tool, req.args);
    if (this.preApproved.has(key)) {
      this.preApproved.delete(key);
      return true;
    }
    // Capture as a proposal (dedupe identical pending proposals).
    const existing = [...this.pending.values()].find(
      (p) => p.status === 'pending' && keyOf(p.server, p.tool, p.args) === key,
    );
    if (!existing) {
      const id = `act${++this.seq}`;
      this.pending.set(id, {
        id,
        server: req.server,
        tool: req.tool,
        fullName: `${req.server}.${req.tool}`,
        args: req.args,
        destructive: req.destructive,
        ts: Date.now(),
        status: 'pending',
      });
    }
    return false;
  };

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

  /** Approve + execute the captured call via its tool handler. */
  async approve(id: string, tools: Tool[]): Promise<PendingAction | undefined> {
    const a = this.pending.get(id);
    if (!a || a.status !== 'pending') return a;
    const tool = tools.find((t) => t.definition.name === a.fullName);
    if (!tool) {
      a.status = 'error';
      a.error = `tool ${a.fullName} not wired`;
      return a;
    }
    const key = keyOf(a.server, a.tool, a.args);
    this.preApproved.add(key); // let the approver pass this one specific call
    try {
      const call: ToolCall = { id: `call_${a.id}`, toolName: a.fullName, args: a.args };
      a.result = await tool.handler(call);
      a.status = 'done';
    } catch (err) {
      a.status = 'error';
      a.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.preApproved.delete(key);
    }
    return a;
  }
}
