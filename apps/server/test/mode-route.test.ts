import { describe, it, expect } from 'vitest';
import { EVAL_REFUSED_IN_LOCAL, finishRoute, isLocalTurn, isPrivate, mayUseCloud, preRoute, turnFacts, type OpenRoute, type PreRouteInput } from '../src/mode-route';
import { runLocalPlan, type LocalPlan } from '../src/local-serve';
import { isLocalTurn as fromTurnTaint } from '../src/turn-taint';
import { routeTurn } from '../src/policy';
import { HYBRID_RULES, decideHybrid } from '../src/hybrid-rules';

/**
 * Which brain answers, by the mode: cloud is routeTurn exactly, local never
 * leaves this Mac, hybrid makes its refusals up front and walks the rule table
 * once the tier is known.
 */

const base: Omit<PreRouteInput, 'mode'> = {
  evalMode: false,
  message: 'what should I cook tonight?',
  localOnly: false,
  deep: false,
  hasFrontier: true,
  needs: {},
  frontierCan: { image: true, pdf: true },
  localCan: {},
};
const input = (mode: PreRouteInput['mode'], over: Partial<PreRouteInput> = {}): PreRouteInput => ({ ...base, mode, ...over });
const local = { available: true, tools: true, contextTokens: 16384 };
const plain = { tier: 'standard' as const, toolsLikely: false, promptTokens: 100, local };

describe('cloud mode is routeTurn, unchanged', () => {
  const messages = ['hello', 'keep this private please', 'think hard about this', 'write a function that sorts'];
  const cases = messages.flatMap((message) =>
    [true, false].flatMap((hasFrontier) =>
      [true, false].flatMap((localOnly) =>
        [{}, { image: true }, { pdf: true }, { image: true, pdf: true }].flatMap((needs) => [{}, { image: true }, { image: true, pdf: true }].map((frontierCan) => ({ message, hasFrontier, localOnly, needs, frontierCan }))),
      ),
    ),
  );

  it(`gives routeTurn's answer for every one of ${cases.length} inputs`, () => {
    for (const c of cases) {
      const was = routeTurn(c);
      const now = preRoute(input('cloud', c));
      if ('error' in was) {
        expect(now, JSON.stringify(c)).toEqual({ error: was.error, status: 422 });
      } else {
        expect(now, JSON.stringify(c)).toMatchObject({ brain: was.brain, localFallback: was.localFallback, cloudFallback: false, reason: 'mode_cloud', mode: 'cloud' });
        expect('open' in now).toBe(false);
      }
    }
  });

  it('never consults the hybrid rules: a "deep" message with tools still routes as it always did', () => {
    const r = preRoute(input('cloud', { deep: true, message: 'go deep on this' }));
    expect(r).toMatchObject({ brain: 'frontier', reason: 'mode_cloud' });
    // And finishing a decided route changes nothing, whatever the tier.
    if ('error' in r) throw new Error('unexpected');
    expect(finishRoute(r, { ...plain, tier: 'routine' })).toBe(r);
  });

  it('what the local model can read does not matter in the cloud mode', () => {
    expect(preRoute(input('cloud', { needs: { image: true }, localCan: { image: true } }))).toMatchObject({ brain: 'frontier', localFallback: false });
  });
});

// FLINT_LOCAL_VISION / FLINT_LOCAL_PDF (both ship off). `keptCan` is what the local model can read on a turn the
// cloud mode keeps here, and ./inference gives it only when Will turned one of them on.
describe('cloud mode, with local pictures or PDFs turned on (`keptCan`)', () => {
  const can = { image: true, pdf: true };

  it('a turn it keeps here, with a file the local model can read, is answered by the local model', () => {
    for (const needs of [{ image: true }, { pdf: true }, { image: true, pdf: true }]) {
      expect(preRoute(input('cloud', { localOnly: true, needs, localCan: can, keptCan: can })), JSON.stringify(needs)).toEqual({ brain: 'local', localFallback: true, cloudFallback: false, reason: 'mode_cloud', mode: 'cloud', private: true });
      expect(preRoute(input('cloud', { message: 'keep this private: what is it?', needs, localCan: can, keptCan: can }))).toMatchObject({ brain: 'local', private: true });
      expect(preRoute(input('cloud', { hasFrontier: false, needs, localCan: can, keptCan: can }))).toEqual({ brain: 'local', localFallback: true, cloudFallback: false, reason: 'mode_cloud', mode: 'cloud', private: false });
    }
  });

  it('without it, the same turn is refused as it always was, even when the local model can see', () => {
    const was = routeTurn({ message: base.message, hasFrontier: true, localOnly: true, needs: { image: true }, frontierCan: base.frontierCan });
    if (!('error' in was)) throw new Error('expected a refusal');
    expect(preRoute(input('cloud', { localOnly: true, needs: { image: true }, localCan: can }))).toEqual({ error: was.error, status: 422 });
    expect(preRoute(input('cloud', { localOnly: true, needs: { image: true }, localCan: can, keptCan: undefined }))).toEqual({ error: was.error, status: 422 });
    expect(preRoute(input('cloud', { hasFrontier: false, needs: { pdf: true }, localCan: can }))).toMatchObject({ error: expect.stringContaining('no frontier brain is configured'), status: 422 });
  });

  it('a turn a cloud model answers goes to it exactly as before', () => {
    for (const needs of [{}, { image: true }, { pdf: true }]) {
      const was = preRoute(input('cloud', { needs }));
      expect(preRoute(input('cloud', { needs, localCan: can, keptCan: can }))).toEqual(was);
    }
    expect(preRoute(input('cloud', { needs: { image: true }, localCan: can, keptCan: can }))).toMatchObject({ brain: 'frontier', localFallback: false });
  });

  it('a kept turn with a file the local model cannot read is still refused, and a PDF that was tried says so', () => {
    expect(preRoute(input('cloud', { localOnly: true, needs: { image: true, pdf: true }, localCan: { image: true }, keptCan: { image: true } }))).toEqual({
      error: "Local-only is on, and the on-device brain can't read PDFs. Turn Local-only off to send the file to the frontier brain, or remove the attachment.",
      status: 422,
    });
    expect(preRoute(input('cloud', { localOnly: true, needs: { pdf: true }, localCan: { pdf: false }, keptCan: { pdf: false }, pdfUnread: 'no_text' }))).toEqual({
      error: 'Local-only is on, and this PDF has no text in it that Flint can read on this Mac. Turn Local-only off to send the file to the frontier brain, or remove the attachment.',
      status: 422,
    });
  });

  it('an eval replay for a local model, with a picture it can see, runs on it: in Cloud, Hybrid and Local mode', () => {
    for (const mode of ['cloud', 'hybrid', 'local'] as const) {
      expect(preRoute(input(mode, { evalMode: true, localOnly: true, needs: { image: true }, localCan: can, keptCan: can })), mode).toMatchObject({ brain: 'local', reason: 'eval', mode });
      // ...and without the setting it is refused, as before.
      expect('error' in preRoute(input(mode, { evalMode: true, localOnly: true, needs: { image: true }, localCan: can })), mode).toBe(true);
    }
  });
});

describe('local mode never leaves this Mac', () => {
  it('is local for every message, with or without a frontier configured, private or not, deep or not', () => {
    for (const over of [{}, { hasFrontier: false }, { localOnly: true }, { deep: true }, { message: 'think hard and write a function' }] as Array<Partial<PreRouteInput>>) {
      const r = preRoute(input('local', over));
      expect(r, JSON.stringify(over)).toMatchObject({ brain: 'local', cloudFallback: false, reason: 'mode_local', mode: 'local' });
    }
  });

  it('never returns a frontier route, whatever the turn carries', () => {
    for (const needs of [{}, { image: true }, { pdf: true }]) {
      for (const localCan of [{}, { image: true }]) {
        const r = preRoute(input('local', { needs, localCan }));
        if (!('error' in r) && !('open' in r)) expect(r.brain).toBe('local');
        expect('open' in r).toBe(false);
      }
    }
  });

  it('a file the local model cannot read is refused with a sentence, never sent to the cloud', () => {
    expect(preRoute(input('local', { needs: { image: true } }))).toEqual({ error: "The local model can't read images, and Local mode never uses the cloud. Send it as text instead.", status: 422 });
    expect(preRoute(input('local', { needs: { pdf: true }, localCan: { image: true } }))).toEqual({ error: "The local model can't read PDFs, and Local mode never uses the cloud. Send it as text instead.", status: 422 });
    expect(preRoute(input('local', { needs: { image: true, pdf: true } }))).toMatchObject({ error: expect.stringContaining('images or PDFs') });
  });

  it('a local model that can read images answers an image turn', () => {
    expect(preRoute(input('local', { needs: { image: true }, localCan: { image: true } }))).toMatchObject({ brain: 'local', reason: 'mode_local' });
  });

  it('a PDF the local model is handed as text is answered here, and one that could not be read is refused in words that say which', () => {
    expect(preRoute(input('local', { needs: { pdf: true }, localCan: { pdf: true } }))).toMatchObject({ brain: 'local', reason: 'mode_local' });
    expect(preRoute(input('local', { needs: { image: true, pdf: true }, localCan: { image: true, pdf: true } }))).toMatchObject({ brain: 'local' });
    expect(preRoute(input('local', { needs: { pdf: true }, localCan: {}, pdfUnread: 'no_text' }))).toEqual({ error: 'This PDF has no text in it that Flint can read on this Mac, and Local mode never uses the cloud. Send it as text instead.', status: 422 });
    expect(preRoute(input('local', { needs: { pdf: true }, localCan: { image: true }, pdfUnread: 'failed' }))).toEqual({ error: "Flint couldn't read this PDF on this Mac just now, and Local mode never uses the cloud. Try again in a moment.", status: 422 });
    // A reader that is busy says so, and never "send it as text": the PDF is fine.
    expect(preRoute(input('local', { needs: { pdf: true }, localCan: {}, pdfUnread: 'busy' }))).toEqual({ error: "Flint's PDF reader on this Mac is busy right now, and Local mode never uses the cloud. Try again in a moment.", status: 422 });
    expect(preRoute(input('local', { needs: { pdf: true }, localCan: {}, pdfUnread: 'too_big' }))).toEqual({ error: 'This PDF is larger than the 10 MB Flint reads on this Mac, and Local mode never uses the cloud. Send a smaller part of it, or its text.', status: 422 });
    expect(preRoute(input('local', { needs: { pdf: true }, localCan: {}, pdfUnread: 'too_long' }))).toEqual({ error: 'This PDF looks like it has more than the 1,000 pages Flint reads on this Mac, and Local mode never uses the cloud. Send a smaller part of it, or its text.', status: 422 });
    // With a picture it cannot see as well, the plain words name both.
    expect(preRoute(input('local', { needs: { image: true, pdf: true }, localCan: {}, pdfUnread: 'no_text' }))).toEqual({ error: "The local model can't read images or PDFs, and Local mode never uses the cloud. Send it as text instead.", status: 422 });
    // And the words about a PDF are never said of a turn that carries none.
    expect(preRoute(input('local', { needs: { image: true }, localCan: {}, pdfUnread: 'no_text' }))).toEqual({ error: "The local model can't read images, and Local mode never uses the cloud. Send it as text instead.", status: 422 });
  });
});

describe('hybrid mode: refusals first, then the rule table', () => {
  it('leaves the route open until the tier and tools are known', () => {
    const pre = preRoute(input('hybrid'));
    expect(pre).toEqual({ open: true, mode: 'hybrid', private: false, deep: false, mediaLocalCannotRead: false, hasFrontier: true });
  });

  it('a private turn with a file the local model cannot read is refused in the same words as ever, in every mode but local', () => {
    const was = routeTurn({ message: 'x', hasFrontier: true, localOnly: true, needs: { image: true }, frontierCan: { image: true } });
    if (!('error' in was)) throw new Error('expected a refusal');
    for (const mode of ['cloud', 'hybrid'] as const) {
      expect(preRoute(input(mode, { message: 'x', localOnly: true, needs: { image: true } }))).toEqual({ error: was.error, status: 422 });
    }
    // Local mode refuses it too, in its own words.
    expect('error' in preRoute(input('local', { message: 'x', localOnly: true, needs: { image: true } }))).toBe(true);
  });

  it('a file nobody here can read is refused: no cloud model, or one that cannot read it', () => {
    expect(preRoute(input('hybrid', { hasFrontier: false, needs: { pdf: true } }))).toMatchObject({ error: expect.stringContaining('no frontier brain is configured'), status: 422 });
    expect(preRoute(input('hybrid', { needs: { pdf: true }, frontierCan: { image: true } }))).toMatchObject({ error: expect.stringContaining("can't read PDFs"), status: 422 });
  });

  it('a file the cloud can read goes to it, and is never answered blind by the local model', () => {
    const pre = preRoute(input('hybrid', { needs: { image: true } })) as OpenRoute;
    expect(pre.mediaLocalCannotRead).toBe(true);
    expect(finishRoute(pre, plain)).toEqual({ brain: 'frontier', localFallback: false, cloudFallback: false, reason: 'media', mode: 'hybrid', private: false });
  });

  it('a file the local model CAN read is not the cloud’s for that: the table decides as for any message, and a private one stays here', () => {
    const pre = preRoute(input('hybrid', { needs: { image: true, pdf: true }, localCan: { image: true, pdf: true } })) as OpenRoute;
    expect(pre).toMatchObject({ open: true, mediaLocalCannotRead: false });
    expect(finishRoute(pre, plain)).toMatchObject({ brain: 'local', cloudFallback: true });
    const priv = preRoute(input('hybrid', { localOnly: true, needs: { pdf: true }, localCan: { pdf: true } })) as OpenRoute;
    expect(finishRoute(priv, plain)).toEqual({ brain: 'local', localFallback: true, cloudFallback: false, reason: 'private', mode: 'hybrid', private: true });
    // A turn the table sends to the cloud may come back here if the cloud fails: the local model can read it.
    expect(finishRoute(pre, { ...plain, toolsLikely: true })).toMatchObject({ brain: 'frontier', localFallback: true });
  });

  it('a PDF that was tried here and could not be read: a private turn says so, and any other goes to a cloud model that reads PDFs', () => {
    expect(preRoute(input('hybrid', { localOnly: true, needs: { pdf: true }, localCan: { image: true }, pdfUnread: 'no_text' }))).toEqual({
      error: 'Local-only is on, and this PDF has no text in it that Flint can read on this Mac. Turn Local-only off to send the file to the frontier brain, or remove the attachment.',
      status: 422,
    });
    const pre = preRoute(input('hybrid', { needs: { pdf: true }, localCan: { image: true }, pdfUnread: 'no_text' })) as OpenRoute;
    expect(pre.mediaLocalCannotRead).toBe(true);
    expect(finishRoute(pre, plain)).toEqual({ brain: 'frontier', localFallback: false, cloudFallback: false, reason: 'media', mode: 'hybrid', private: false });
    // A private turn's words name only the kind the local model cannot read.
    expect(preRoute(input('hybrid', { localOnly: true, needs: { image: true, pdf: true }, localCan: { image: true } }))).toMatchObject({ error: expect.stringContaining("the on-device brain can't read PDFs.") });
  });

  it('a plain message is answered here, and may fall through to the cloud', () => {
    const pre = preRoute(input('hybrid')) as OpenRoute;
    expect(finishRoute(pre, plain)).toEqual({ brain: 'local', localFallback: true, cloudFallback: true, reason: 'default', mode: 'hybrid', private: false });
  });

  it('a private message is answered here and never falls through, whatever else is true of it', () => {
    for (const over of [{ localOnly: true }, { message: 'keep this private: think hard about my taxes' }] as Array<Partial<PreRouteInput>>) {
      const pre = preRoute(input('hybrid', { deep: true, ...over })) as OpenRoute;
      expect(pre.private).toBe(true);
      expect(finishRoute(pre, { ...plain, tier: 'hard', toolsLikely: true, promptTokens: 90_000 })).toEqual({ brain: 'local', localFallback: true, cloudFallback: false, reason: 'private', mode: 'hybrid', private: true });
    }
  });

  it('"deep" is the request flag or the words', () => {
    expect((preRoute(input('hybrid', { deep: true })) as OpenRoute).deep).toBe(true);
    expect((preRoute(input('hybrid', { message: 'give me a deep dive on heat pumps' })) as OpenRoute).deep).toBe(true);
    const pre = preRoute(input('hybrid', { deep: true })) as OpenRoute;
    expect(finishRoute(pre, plain)).toMatchObject({ brain: 'frontier', localFallback: true, reason: 'deep' });
  });

  it('tool turns, long conversations and hard messages go to the cloud, and may fall back here', () => {
    const pre = preRoute(input('hybrid')) as OpenRoute;
    expect(finishRoute(pre, { ...plain, toolsLikely: true })).toMatchObject({ brain: 'frontier', localFallback: true, cloudFallback: false, reason: 'tools' });
    expect(finishRoute(pre, { ...plain, toolsLikely: true, local: { ...local, tools: false } })).toMatchObject({ brain: 'frontier', reason: 'tools_unsupported' });
    expect(finishRoute(pre, { ...plain, promptTokens: 12_000 })).toMatchObject({ brain: 'frontier', reason: 'long_context' });
    expect(finishRoute(pre, { ...plain, tier: 'code' })).toMatchObject({ brain: 'frontier', reason: 'difficulty' });
  });

  it('with no local model the cloud answers; with no cloud model this Mac answers everything and nothing falls through', () => {
    const pre = preRoute(input('hybrid')) as OpenRoute;
    expect(finishRoute(pre, { ...plain, local: { ...local, available: false } })).toEqual({ brain: 'frontier', localFallback: false, cloudFallback: false, reason: 'local_unavailable', mode: 'hybrid', private: false });
    const noCloud = preRoute(input('hybrid', { hasFrontier: false, deep: true })) as OpenRoute;
    expect(finishRoute(noCloud, { ...plain, tier: 'hard', toolsLikely: true })).toEqual({ brain: 'local', localFallback: true, cloudFallback: false, reason: 'cloud_unavailable', mode: 'hybrid', private: false });
  });

  it('neither side there: routed local, with nowhere to fall (the caller refuses with a sentence)', () => {
    const pre = preRoute(input('hybrid', { hasFrontier: false })) as OpenRoute;
    expect(finishRoute(pre, { ...plain, local: { ...local, available: false } })).toMatchObject({ brain: 'local', cloudFallback: false, reason: 'local_unavailable' });
  });

  it('a custom table changes the answer: the rules are data', () => {
    const pre = preRoute(input('hybrid')) as OpenRoute;
    const noTools = HYBRID_RULES.filter((r) => r.id !== 'tools' && r.id !== 'tools_unsupported');
    expect(finishRoute(pre, { ...plain, toolsLikely: true }, noTools)).toMatchObject({ brain: 'local', reason: 'default' });
  });

  it('turnFacts hands the table exactly what was known', () => {
    const pre = preRoute(input('hybrid', { deep: true, needs: { image: true } })) as OpenRoute;
    expect(turnFacts(pre, plain)).toEqual({ private: false, deep: true, tier: 'standard', toolsLikely: false, promptTokens: 100, mediaLocalCannotRead: true, local, cloud: { available: true } });
  });
});

describe('an eval replay is routed by routeTurn, never by the rule table', () => {
  it('in the hybrid and cloud modes it measures the model it named, and the reason says eval', () => {
    for (const mode of ['hybrid', 'cloud'] as const) {
      expect(preRoute(input(mode, { evalMode: true }))).toMatchObject({ brain: 'frontier', reason: 'eval', mode, cloudFallback: false });
      expect(preRoute(input(mode, { evalMode: true, localOnly: true }))).toMatchObject({ brain: 'local', reason: 'eval', private: true });
    }
  });

  // The routing review's A6: in Local mode `/generate` with `eval: true` was answered by the cloud stub.
  it('in Local mode a replay an outside model would answer is refused with a sentence; one a local model answers runs', () => {
    expect(preRoute(input('local', { evalMode: true }))).toEqual({ error: EVAL_REFUSED_IN_LOCAL, status: 409 });
    expect(preRoute(input('local', { evalMode: true, deep: true }))).toEqual({ error: EVAL_REFUSED_IN_LOCAL, status: 409 });
    expect(EVAL_REFUSED_IN_LOCAL).toBe('Flint is in Local mode, which never uses the cloud, so this eval replay was not run. Switch the mode, or replay it on a local model.');
    // The local side of a bake-off still runs in Local mode: Local Only, or the words.
    expect(preRoute(input('local', { evalMode: true, localOnly: true }))).toMatchObject({ brain: 'local', reason: 'eval', mode: 'local', private: true, cloudFallback: false });
    expect(preRoute(input('local', { evalMode: true, message: 'keep it local: what is 2 + 2' }))).toMatchObject({ brain: 'local', reason: 'eval', mode: 'local' });
    // With no cloud model configured there is nothing outside to refuse: routeTurn already answers locally.
    expect(preRoute(input('local', { evalMode: true, hasFrontier: false }))).toMatchObject({ brain: 'local', reason: 'eval' });
    // An ordinary turn in Local mode is untouched by this.
    expect(preRoute(input('local'))).toMatchObject({ brain: 'local', reason: 'mode_local' });
  });
});

// The routing review, E3: privacy in hybrid rested on row 1 of a table that is meant to be edited.
describe('a private turn in hybrid never leaves this Mac, whatever is done to the rule table', () => {
  const more = { tier: 'hard' as const, toolsLikely: true, promptTokens: 100, local: { available: true, tools: true, contextTokens: 16384 } };
  const open = () => preRoute(input('hybrid', { message: 'keep this private: think hard about my diagnosis' })) as OpenRoute;
  const here = { brain: 'local', reason: 'private', private: true, cloudFallback: false, mode: 'hybrid' };

  it('with the shipped table', () => {
    expect(open()).toMatchObject({ open: true, private: true, deep: true });
    expect(finishRoute(open(), more)).toMatchObject(here);
  });

  it('with the private row deleted', () => {
    const noPrivateRow = HYBRID_RULES.filter((r) => r.id !== 'private');
    expect(noPrivateRow).toHaveLength(HYBRID_RULES.length - 1);
    // The table alone would now send this deep, hard, tool-needing turn to the cloud...
    expect(decideHybrid(turnFacts(open(), more), noPrivateRow)).toMatchObject({ route: 'cloud' });
    // ...and the route does not.
    expect(finishRoute(open(), more, noPrivateRow)).toMatchObject(here);
  });

  it('with every other row moved above it, one at a time', () => {
    for (const first of HYBRID_RULES.filter((r) => r.id !== 'private')) {
      const reordered = [first, ...HYBRID_RULES.filter((r) => r.id !== first.id)];
      expect(finishRoute(open(), more, reordered), first.id).toMatchObject(here);
      expect(finishRoute(open(), { ...more, local: { available: false, tools: false, contextTokens: 4096 } }, reordered), first.id).toMatchObject(here);
    }
  });

  it('with a table of one row that sends everything to the cloud, and with an empty table', () => {
    const allCloud = [{ ...HYBRID_RULES.find((r) => r.id === 'deep')!, when: [] }];
    expect(finishRoute(open(), more, allCloud)).toMatchObject(here);
    expect(finishRoute(open(), more, [])).toMatchObject(here);
    // Local Only on the request is private too, with no words in the message.
    expect(finishRoute(preRoute(input('hybrid', { localOnly: true, deep: true })) as OpenRoute, more, allCloud)).toMatchObject(here);
    // A turn that is not private still follows the table it is given.
    expect(finishRoute(preRoute(input('hybrid', { deep: true })) as OpenRoute, more, allCloud)).toMatchObject({ brain: 'frontier' });
  });
});

describe('helpers', () => {
  it('isPrivate: the switch, or the words', () => {
    expect(isPrivate('hello', true)).toBe(true);
    expect(isPrivate('keep it local', false)).toBe(true);
    expect(isPrivate('hello', false)).toBe(false);
  });

  it('mayUseCloud: an open hybrid turn or a frontier one', () => {
    expect(mayUseCloud(preRoute(input('hybrid')) as OpenRoute)).toBe(true);
    const cloud = preRoute(input('cloud'));
    const localRoute = preRoute(input('local'));
    if ('error' in cloud || 'error' in localRoute) throw new Error('unexpected');
    expect(mayUseCloud(cloud)).toBe(true);
    expect(mayUseCloud(localRoute)).toBe(false);
  });
});

describe('isLocalTurn: the one place to ask "is a local model answering this turn?"', () => {
  it('is the same function the rest of the server asks', () => {
    expect(isLocalTurn).toBe(fromTurnTaint);
    expect(isLocalTurn()).toBe(false);
  });

  it('is true inside the main model\'s attempt and the standby\'s, and false inside the cloud step and after the turn', async () => {
    const plan: LocalPlan<string> = {
      primaryState: 'loaded',
      warmPrimary: false,
      steps: [
        { kind: 'local', which: 'primary', state: 'loaded', persona: 'main', model: 'm' },
        { kind: 'local', which: 'fallback', state: 'loaded', persona: 'small', model: 's' },
        { kind: 'cloud' },
      ],
    };
    const seen: Array<[string, boolean]> = [];
    await runLocalPlan(
      plan,
      async (step) => {
        // Checked after an await too: the mark follows the attempt's whole async work, not only its first tick.
        await new Promise((r) => setTimeout(r, 1));
        seen.push([step.kind === 'cloud' ? 'cloud' : step.which, isLocalTurn()]);
        if (step.kind === 'local') throw new Error('this model did not answer');
        return 'ok';
      },
      { progressed: () => false },
    );
    expect(seen).toEqual([['primary', true], ['fallback', true], ['cloud', false]]);
    expect(isLocalTurn()).toBe(false);
  });
});
