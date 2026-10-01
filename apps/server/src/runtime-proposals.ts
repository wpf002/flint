/**
 * Proposals in the runtime (Machine plan P1 server change 1, rollout day 4+).
 *
 * With FLINT_RUNTIME_URL set, a call that needs Will's approval becomes a
 * Proposal in the runtime (durable, audited, re-verified before it runs)
 * instead of an entry in the server's in-memory queue. If the runtime is down,
 * the proposal is spooled locally as "pending, unsynced" (chat keeps working)
 * and sent when it is back. Approving needs Will's signature; the console's
 * one-tap approve is refused in this mode.
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Runtime } from './audit-sink';

export interface ProposalIn {
  kind: 'tool_call';
  origin: string;
  action: string;
  args: Record<string, unknown>;
  argsProvenance: Record<string, { source: 'will' | 'model' | 'template' | 'event'; ref?: string; tainted: boolean }>;
  tainted: boolean;
  sensitivity?: 'ops' | 'personal' | 'financial';
  destructive?: boolean;
  readOnlyHint?: boolean;
  reason?: string;
}

export interface RuntimeProposal {
  id: string;
  action: string;
  args: Record<string, unknown> | null;
  argsDigest: string;
  argsProvenance: ProposalIn['argsProvenance'];
  tainted: boolean;
  status: string;
  reason: string | null;
  createdAt: string;
  expiresAt: string;
}

export type Proposed = { id: string } | { spooled: true } | { refused: string };

export class RuntimeError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface RuntimeProposalsOptions {
  runtime: () => Runtime | undefined;
  spoolDir: string;
  fetchImpl?: typeof fetch;
  log?: (m: string) => void;
}

export class RuntimeProposals {
  private readonly spool: string;

  constructor(private readonly o: RuntimeProposalsOptions) {
    mkdirSync(o.spoolDir, { recursive: true, mode: 0o700 });
    chmodSync(o.spoolDir, 0o700);
    this.spool = join(o.spoolDir, 'proposals.jsonl');
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const rt = this.o.runtime();
    if (!rt) throw new RuntimeError(503, 'the runtime is not installed');
    const r = await (this.o.fetchImpl ?? fetch)(`${rt.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${rt.token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await r.text();
    let data: unknown = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = {};
    }
    if (!r.ok) throw new RuntimeError(r.status, (data as { error?: string }).error ?? `runtime HTTP ${r.status}`);
    return data as T;
  }

  /** File a proposal; spool it when the runtime cannot be reached. A FORBIDDEN action is refused. */
  async propose(p: ProposalIn): Promise<Proposed> {
    try {
      const r = await this.call<{ id: string }>('POST', '/v1/proposals', p);
      return { id: r.id };
    } catch (err) {
      if (err instanceof RuntimeError && err.status >= 400 && err.status < 500) return { refused: err.message };
      appendFileSync(this.spool, `${JSON.stringify({ ...p, spooledAt: new Date().toISOString() })}\n`, { mode: 0o600 });
      this.o.log?.(`[proposals] runtime unreachable; spooled ${p.action} (pending, unsynced)`);
      return { spooled: true };
    }
  }

  /** Send spooled proposals. Ones the runtime refuses (4xx) are dropped with a log line. */
  async replay(): Promise<number> {
    if (!existsSync(this.spool)) return 0;
    const sending = `${this.spool}.sending`;
    if (!existsSync(sending)) renameSync(this.spool, sending);
    const lines = readFileSync(sending, 'utf8').split('\n').filter(Boolean);
    let sent = 0;
    const keep: string[] = [];
    for (const line of lines) {
      let p: ProposalIn & { spooledAt?: string };
      try {
        p = JSON.parse(line);
      } catch {
        continue;
      }
      const { spooledAt: _s, ...body } = p;
      try {
        await this.call('POST', '/v1/proposals', body);
        sent++;
      } catch (err) {
        if (err instanceof RuntimeError && err.status >= 400 && err.status < 500) {
          this.o.log?.(`[proposals] the runtime refused a spooled ${p.action}: ${err.message}`);
        } else keep.push(line);
      }
    }
    if (keep.length) appendFileSync(this.spool, `${keep.join('\n')}\n`, { mode: 0o600 });
    rmSync(sending, { force: true });
    return sent;
  }

  /** How many proposals wait to be sent (the console shows "pending, unsynced"). */
  unsynced(): number {
    const count = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).length : 0);
    return count(this.spool) + count(`${this.spool}.sending`);
  }

  list(status = 'pending') {
    return this.call<{ proposals: RuntimeProposal[] }>('GET', `/v1/proposals?status=${encodeURIComponent(status)}`).then((r) => r.proposals);
  }

  async get(id: string): Promise<RuntimeProposal | undefined> {
    return (await this.list('pending')).find((p) => p.id === id) ?? (await this.list('approved')).find((p) => p.id === id);
  }

  approve(id: string, approvalId: string) {
    return this.call('POST', `/v1/proposals/${encodeURIComponent(id)}/approve`, { approvalId });
  }

  reject(id: string, approvalId?: string) {
    return this.call('POST', `/v1/proposals/${encodeURIComponent(id)}/reject`, approvalId ? { approvalId } : {});
  }

  claim(id: string) {
    return this.call<{ id: string; action: string; args: Record<string, unknown>; argsDigest: string }>('POST', `/v1/proposals/${encodeURIComponent(id)}/claim`, {});
  }

  complete(id: string, outcome: { ok: boolean; result?: Record<string, unknown>; error?: string }) {
    return this.call('POST', `/v1/proposals/${encodeURIComponent(id)}/complete`, outcome);
  }

  /** Approved actions the runtime carries out itself (turning a source on, a policy change). */
  run(id: string) {
    return this.call('POST', `/v1/proposals/${encodeURIComponent(id)}/run`, {});
  }
}
