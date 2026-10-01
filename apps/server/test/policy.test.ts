import { describe, it, expect } from 'vitest';
import { judgeBrain, isSafeTool, routeTurn } from '../src/policy';
import { ActionQueue } from '../src/actions';

describe('judgeBrain', () => {
  it('falls back to local when no frontier is configured', () => {
    expect(judgeBrain('anything at all', false, false)).toBe('local');
  });

  it('defaults to the frontier brain', () => {
    expect(judgeBrain('what happened in the market today?', true, false)).toBe('frontier');
  });

  // The privacy switch. It was ignored for a while; a control that lies is worse
  // than no control, so this is the regression guard.
  it('HONORS the Local-only toggle', () => {
    expect(judgeBrain('summarize this private document', true, true)).toBe('local');
  });

  it('honors plain-language local requests', () => {
    for (const msg of ['stay local please', 'keep this private', 'answer on-device']) {
      expect(judgeBrain(msg, true, false)).toBe('local');
    }
  });
});

describe('routeTurn (attachments)', () => {
  const base = { message: 'what is in this?', hasFrontier: true, localOnly: false, frontierCan: { image: true, pdf: true } };

  it('routes a plain turn exactly like judgeBrain, with local fallback allowed', () => {
    expect(routeTurn({ ...base, needs: {} })).toEqual({ brain: 'frontier', localFallback: true });
    expect(routeTurn({ ...base, localOnly: true, needs: {} })).toEqual({ brain: 'local', localFallback: true });
    expect(routeTurn({ ...base, hasFrontier: false, needs: {} })).toEqual({ brain: 'local', localFallback: true });
  });

  it('sends image and PDF turns to the frontier, with NO silent local fallback', () => {
    expect(routeTurn({ ...base, needs: { image: true } })).toEqual({ brain: 'frontier', localFallback: false });
    expect(routeTurn({ ...base, needs: { pdf: true } })).toEqual({ brain: 'frontier', localFallback: false });
  });

  it('refuses rather than answering blind when there is no frontier', () => {
    const r = routeTurn({ ...base, hasFrontier: false, needs: { image: true } });
    expect((r as { error: string }).error).toMatch(/no frontier brain/);
  });

  // Privacy wins: Local-only must never be overridden by an attachment.
  it('HONORS Local-only: an image is refused, not shipped off-device', () => {
    const r = routeTurn({ ...base, localOnly: true, needs: { image: true } });
    expect((r as { error: string }).error).toMatch(/Local-only is on/);
    const r2 = routeTurn({ ...base, message: 'keep this private: what is this?', needs: { pdf: true } });
    expect(r2).toHaveProperty('error');
  });

  it('refuses when the configured frontier cannot read the file type', () => {
    const r = routeTurn({ ...base, frontierCan: {}, needs: { image: true } });
    expect((r as { error: string }).error).toMatch(/can't read images/);
    const r2 = routeTurn({ ...base, frontierCan: { image: true }, needs: { image: true, pdf: true } });
    expect(r2).toHaveProperty('error');
  });
});

// isSafeTool's own cases live with it in packages/policy/test/tool-safety.test.ts.

// The audit found the approver handing isSafeTool the bare tool name, so a
// dangerous word in the server namespace (`execute.trade`) was never seen.
describe('ActionQueue approver — judges the full server.tool name', () => {
  const req = (server: string, tool: string) => ({ server, tool, args: {}, safety: 'guarded' as const, destructive: false });

  it('denies a read-shaped tool on a server whose name is an action', () => {
    const q = new ActionQueue(isSafeTool);
    expect(isSafeTool('list_items')).toBe(true); // the bare name alone looks safe
    expect(q.approver(req('execute', 'list_items'))).toBe(false);
    expect(q.list().map((p) => p.fullName)).toEqual(['execute.list_items']);
  });

  it('still runs a read on an ordinary server without approval', () => {
    const q = new ActionQueue(isSafeTool);
    expect(q.approver(req('trident', 'gdrive_search'))).toBe(true);
    expect(q.list()).toEqual([]);
  });

  it('passes the name it judged to isSafe', () => {
    const seen: string[] = [];
    new ActionQueue((t) => (seen.push(t), false)).approver(req('nexus', 'thread_append'));
    expect(seen).toEqual(['nexus.thread_append']);
  });
});

