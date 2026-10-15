import { describe, it, expect } from 'vitest';
import { judgeBrain, isSafeTool, pdfUnreadAdvice, pdfUnreadClause, pdfUnreadSentence, routeTurn, unreadable, type PdfUnread } from '../src/policy';
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

// Local vision and PDF reading (FLINT_LOCAL_VISION, FLINT_LOCAL_PDF; both ship off). `localCan` is what the local
// model can read of the turn, and it is only ever given when Will turned one of them on (./inference localReads).
describe('routeTurn: a turn the local brain keeps, with a file it can read', () => {
  const base = { message: 'what is in this?', hasFrontier: true, localOnly: false, frontierCan: { image: true, pdf: true } };
  const KINDS = [{ image: true }, { pdf: true }, { image: true, pdf: true }];

  it('Local-only with a picture the local model can see: answered here, with nothing to fall back from', () => {
    expect(routeTurn({ ...base, localOnly: true, needs: { image: true }, localCan: { image: true } })).toEqual({ brain: 'local', localFallback: true });
    expect(routeTurn({ ...base, message: 'keep this private: what is this?', needs: { pdf: true }, localCan: { pdf: true } })).toEqual({ brain: 'local', localFallback: true });
    expect(routeTurn({ ...base, localOnly: true, needs: { image: true, pdf: true }, localCan: { image: true, pdf: true } })).toEqual({ brain: 'local', localFallback: true });
  });

  it('no frontier brain at all: the local brain answers what it can read', () => {
    for (const needs of KINDS) expect(routeTurn({ ...base, hasFrontier: false, needs, localCan: { image: true, pdf: true } })).toEqual({ brain: 'local', localFallback: true });
  });

  it('a turn a frontier brain answers is routed exactly as before, whatever the local model can read', () => {
    for (const needs of KINDS) {
      for (const frontierCan of [{}, { image: true }, { image: true, pdf: true }]) {
        const was = routeTurn({ ...base, needs, frontierCan });
        expect(routeTurn({ ...base, needs, frontierCan, localCan: { image: true, pdf: true } })).toEqual(was);
        expect(routeTurn({ ...base, needs, frontierCan, localCan: {} })).toEqual(was);
      }
    }
  });

  it('with nothing said of the local brain, and with a local brain that can read nothing, every answer is the one it always was', () => {
    for (const hasFrontier of [true, false]) {
      for (const localOnly of [true, false]) {
        for (const needs of [{}, ...KINDS]) {
          const was = routeTurn({ ...base, hasFrontier, localOnly, needs });
          expect(routeTurn({ ...base, hasFrontier, localOnly, needs, localCan: {} })).toEqual(was);
          expect(routeTurn({ ...base, hasFrontier, localOnly, needs, localCan: { image: false, pdf: false } })).toEqual(was);
          expect(routeTurn({ ...base, hasFrontier, localOnly, needs, localCan: undefined, pdfUnread: undefined })).toEqual(was);
        }
      }
    }
  });

  it('a file it cannot read is still refused, and the words name only what it cannot read', () => {
    expect(routeTurn({ ...base, localOnly: true, needs: { image: true, pdf: true }, localCan: { image: true } })).toEqual({
      error: "Local-only is on, and the on-device brain can't read PDFs. Turn Local-only off to send the file to the frontier brain, or remove the attachment.",
    });
    expect(routeTurn({ ...base, localOnly: true, needs: { image: true, pdf: true }, localCan: { pdf: true } })).toEqual({
      error: "Local-only is on, and the on-device brain can't read images. Turn Local-only off to send the file to the frontier brain, or remove the attachment.",
    });
    expect(routeTurn({ ...base, hasFrontier: false, needs: { image: true }, localCan: { pdf: true } })).toEqual({ error: "The local brain can't read images, and no frontier brain is configured. Send it as text instead." });
    // A picture is never the local brain's because it reads PDFs, or the other way round.
    expect(routeTurn({ ...base, localOnly: true, needs: { image: true }, localCan: { pdf: true } })).toHaveProperty('error');
    expect(routeTurn({ ...base, localOnly: true, needs: { pdf: true }, localCan: { image: true } })).toHaveProperty('error');
  });

  it('a PDF that was looked at here and could not be read is refused in words that say which', () => {
    expect(routeTurn({ ...base, localOnly: true, needs: { pdf: true }, localCan: { image: true }, pdfUnread: 'no_text' })).toEqual({
      error: 'Local-only is on, and this PDF has no text in it that Flint can read on this Mac. Turn Local-only off to send the file to the frontier brain, or remove the attachment.',
    });
    expect(routeTurn({ ...base, localOnly: true, needs: { pdf: true }, localCan: {}, pdfUnread: 'failed' })).toEqual({
      error: "Local-only is on, and Flint couldn't read this PDF on this Mac just now. Try again in a moment.",
    });
    expect(routeTurn({ ...base, hasFrontier: false, needs: { pdf: true }, localCan: {}, pdfUnread: 'no_text' })).toEqual({ error: 'This PDF has no text in it that Flint can read on this Mac, and no frontier brain is configured. Send it as text instead.' });
    expect(routeTurn({ ...base, hasFrontier: false, needs: { pdf: true }, localCan: {}, pdfUnread: 'failed' })).toEqual({ error: "Flint couldn't read this PDF on this Mac just now, and no frontier brain is configured. Try again in a moment." });
    // With a picture it cannot see on the same turn, the words are the plain ones: both kinds are the trouble.
    expect(routeTurn({ ...base, localOnly: true, needs: { image: true, pdf: true }, localCan: {}, pdfUnread: 'no_text' })).toEqual({
      error: "Local-only is on, and the on-device brain can't read images or PDFs. Turn Local-only off to send the file to the frontier brain, or remove the attachment.",
    });
    // And a turn a frontier brain answers is not refused for it: that brain reads the PDF itself.
    expect(routeTurn({ ...base, needs: { pdf: true }, localCan: {}, pdfUnread: 'no_text' })).toEqual({ brain: 'frontier', localFallback: false });
  });

  // Each reason a PDF was not read has its own words, and its own advice. A reader that is only busy never tells
  // Will to send the PDF as text: the PDF is fine, and a moment is all it needs.
  it('each reason has its own sentence: too big, too long and busy as much as a scan', () => {
    const kept = (why: PdfUnread) => (routeTurn({ ...base, localOnly: true, needs: { pdf: true }, localCan: {}, pdfUnread: why }) as { error: string }).error;
    const alone = (why: PdfUnread) => (routeTurn({ ...base, hasFrontier: false, needs: { pdf: true }, localCan: {}, pdfUnread: why }) as { error: string }).error;
    expect(kept('busy')).toBe("Local-only is on, and Flint's PDF reader on this Mac is busy right now. Try again in a moment.");
    expect(alone('busy')).toBe("Flint's PDF reader on this Mac is busy right now, and no frontier brain is configured. Try again in a moment.");
    expect(kept('too_big')).toBe('Local-only is on, and this PDF is larger than the 10 MB Flint reads on this Mac. Send a smaller part of it, or its text.');
    expect(alone('too_big')).toBe('This PDF is larger than the 10 MB Flint reads on this Mac, and no frontier brain is configured. Send a smaller part of it, or its text.');
    expect(kept('too_long')).toBe('Local-only is on, and this PDF looks like it has more than the 1,000 pages Flint reads on this Mac. Send a smaller part of it, or its text.');
    expect(alone('too_long')).toBe('This PDF looks like it has more than the 1,000 pages Flint reads on this Mac, and no frontier brain is configured. Send a smaller part of it, or its text.');
    for (const why of ['busy', 'failed'] as const) {
      expect(kept(why)).not.toMatch(/as text|its text/);
      expect(alone(why)).not.toMatch(/as text|its text/);
      expect(pdfUnreadAdvice(why)).toBe('Try again in a moment.');
    }
    expect(pdfUnreadAdvice('no_text')).toBe('Send it as text instead.');
    expect(pdfUnreadSentence('busy', 'and Local mode never uses the cloud.')).toBe("Flint's PDF reader on this Mac is busy right now, and Local mode never uses the cloud. Try again in a moment.");
    // Every one is a sentence that starts with a capital and ends with a full stop, with no parentheses.
    for (const why of ['no_text', 'too_big', 'too_long', 'busy', 'failed'] as const) {
      for (const said of [kept(why), alone(why)]) {
        expect(said).toMatch(/^[A-Z].*\.$/);
        expect(said).not.toMatch(/[()]/);
      }
    }
  });

  it('the helpers: what cannot be read, in words, and the clause for a PDF that was tried', () => {
    expect(unreadable({}, {})).toBeUndefined();
    expect(unreadable({ image: true, pdf: true }, { image: true, pdf: true })).toBeUndefined();
    expect(unreadable({ image: true, pdf: true }, {})).toBe('images or PDFs');
    expect(unreadable({ image: true, pdf: true }, { image: true })).toBe('PDFs');
    expect(unreadable({ image: true }, { pdf: true })).toBe('images');
    expect(pdfUnreadClause('no_text')).toBe('this PDF has no text in it that Flint can read on this Mac');
    expect(pdfUnreadClause('failed')).toBe("Flint couldn't read this PDF on this Mac just now");
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

