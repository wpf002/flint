/**
 * Proposals in the runtime (Machine plan P1 server change 1, rollout day 4+).
 *
 * With FLINT_RUNTIME_URL set, a call that needs Will's approval becomes a
 * Proposal in the runtime (durable, audited, re-verified before it runs)
 * instead of an entry in the server's in-memory queue. If the runtime is down,
 * the proposal is spooled locally as "pending, unsynced" (chat keeps working)
 * and sent when it is back. Approving needs Will's signature; the console's
 * one-tap approve is refused in this mode.
 *
 *  - The runtime treats the same call proposed again while the first is
 *    pending as that first proposal, so a replayed spool or a retry after a
 *    timeout never makes a second card.
 *  - How an execution ended is reported with complete(); if the runtime cannot
 *    take it, the outcome is spooled too and replayed, so an action that ran is
 *    never left looking as if it had not.
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
  origin: string;
  action: string;
  args: Record<string, unknown> | null;
  argsDigest: string;
  argsProvenance: ProposalIn['argsProvenance'];
  tainted: boolean;
  sensitivity: string;
  status: string;
  reason: string | null;
  createdAt: string;
  expiresAt: string;
}

export type Proposed = { id: string } | { spooled: true } | { refused: string };
export type Outcome = { ok: boolean; result?: Record<string, unknown>; error?: string };

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

/** A 4xx is the runtime's answer (refused, not found, wrong state); anything else may be retried. */
const isAnswer = (err: unknown) => err instanceof RuntimeError && err.status >= 400 && err.status < 500;

export class RuntimeProposals {
  private readonly spool: string;
  private readonly outcomes: string;
  private replaying: Promise<number> | undefined;

  constructor(private readonly o: RuntimeProposalsOptions) {
    mkdirSync(o.spoolDir, { recursive: true, mode: 0o700 });
    chmodSync(o.spoolDir, 0o700);
    this.spool = join(o.spoolDir, 'proposals.jsonl');
    this.outcomes = join(o.spoolDir, 'outcomes.jsonl');
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
      if (isAnswer(err)) return { refused: (err as Error).message };
      // A timeout may mean it landed; the replay files it again and the runtime
      // answers with the same proposal.
      appendFileSync(this.spool, `${JSON.stringify({ ...p, spooledAt: new Date().toISOString() })}\n`, { mode: 0o600 });
      this.o.log?.(`[proposals] runtime unreachable; spooled ${p.action} (pending, unsynced)`);
      return { spooled: true };
    }
  }

  /**
   * Send spooled proposals and outcomes. One replay at a time; a crash between
   * renaming the spool aside and finishing leaves the `.sending` file, which
   * the next replay sends first.
   */
  replay(): Promise<number> {
    this.replaying ??= this.doReplay().finally(() => {
      this.replaying = undefined;
    });
    return this.replaying;
  }

  private async drain(file: string, send: (line: string) => Promise<void>, what: string): Promise<number> {
    const sending = `${file}.sending`;
    if (!existsSync(sending)) {
      if (!existsSync(file)) return 0;
      renameSync(file, sending);
    }
    const lines = readFileSync(sending, 'utf8').split('\n').filter(Boolean);
    let sent = 0;
    const keep: string[] = [];
    for (const line of lines) {
      try {
        await send(line);
        sent++;
      } catch (err) {
        if (isAnswer(err) || err instanceof SyntaxError) this.o.log?.(`[proposals] the runtime refused a spooled ${what}: ${err instanceof Error ? err.message : String(err)}`);
        else keep.push(line);
      }
    }
    if (keep.length) appendFileSync(file, `${keep.join('\n')}\n`, { mode: 0o600 });
    rmSync(sending, { force: true });
    return sent;
  }

  private async doReplay(): Promise<number> {
    const proposals = await this.drain(this.spool, async (line) => {
      const { spooledAt: _s, ...body } = JSON.parse(line) as ProposalIn & { spooledAt?: string };
      await this.call('POST', '/v1/proposals', body);
    }, 'proposal');
    const outcomes = await this.drain(this.outcomes, async (line) => {
      const { id, outcome } = JSON.parse(line) as { id: string; outcome: Outcome };
      await this.call('POST', `/v1/proposals/${encodeURIComponent(id)}/complete`, outcome);
    }, 'outcome');
    return proposals + outcomes;
  }

  /** How many proposals wait to be sent (the console shows "pending, unsynced"). */
  unsynced(): number {
    const count = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).length : 0);
    return count(this.spool) + count(`${this.spool}.sending`);
  }

  /** Proposals in one state, newest first: as many as the runtime gives (200). */
  list(status = 'pending') {
    return this.call<{ proposals: RuntimeProposal[] }>('GET', `/v1/proposals?status=${encodeURIComponent(status)}&limit=200`).then((r) => r.proposals);
  }

  async get(id: string): Promise<RuntimeProposal | undefined> {
    try {
      return (await this.call<{ proposal: RuntimeProposal }>('GET', `/v1/proposals/${encodeURIComponent(id)}`)).proposal;
    } catch (err) {
      if (err instanceof RuntimeError && err.status === 404) return undefined;
      throw err;
    }
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

  complete(id: string, outcome: Outcome) {
    return this.call('POST', `/v1/proposals/${encodeURIComponent(id)}/complete`, outcome);
  }

  /**
   * Report how an execution ended, whatever it takes: retried twice, then
   * spooled for the replay. Returns whether the runtime has it now.
   */
  async completeDurably(id: string, outcome: Outcome): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.complete(id, outcome);
        return true;
      } catch (err) {
        if (isAnswer(err)) {
          this.o.log?.(`[proposals] the runtime would not record how ${id} ended: ${(err as Error).message}`);
          return false;
        }
        if (attempt < 2) await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
    }
    appendFileSync(this.outcomes, `${JSON.stringify({ id, outcome, spooledAt: new Date().toISOString() })}\n`, { mode: 0o600 });
    this.o.log?.(`[proposals] runtime unreachable; spooled how ${id} ended`);
    return false;
  }

  /** Approved actions the runtime carries out itself (turning a source on, a policy change). */
  run(id: string) {
    return this.call('POST', `/v1/proposals/${encodeURIComponent(id)}/run`, {});
  }
}
