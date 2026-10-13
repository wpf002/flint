/**
 * The server's record of what its model servers say (../src/ollama-locality)
 * when the Mac's clock is set back.
 *
 * A word's age is counted on that clock. Set back by an hour, a listing heard
 * a moment before would read as an hour younger than it is: "this model runs
 * here" would be believed for an hour and five minutes, and a caller that asks
 * first would not ask for an hour and two seconds. A name pointed at a cloud
 * model in that time would be sent what must stay on this Mac.
 *
 * So a clock that shows an earlier time than it has shown forgets everything
 * believed: nothing is local again until its server has said so, on the clock
 * as it now reads. And a word from an ask that was under way when the clock
 * went back is dated no later than the time it landed.
 */
import { describe, it, expect } from 'vitest';
import { FRESH_MS, OllamaLocality } from '../src/ollama-locality';

const U = 'http://127.0.0.1:11434';
const FIVE_MIN = 5 * 60_000;

/** A record on a clock the test moves, whose Ollama lists `m:1` as its own until it is repointed. */
function rig() {
  const t = { now: 10_000_000, asks: 0, remote: false, during: undefined as undefined | (() => void) };
  const fetchImpl = (async () => {
    t.asks += 1;
    t.during?.();
    return new Response(JSON.stringify({ models: [t.remote ? { name: 'm:1', remote_host: 'https://ollama.com:443' } : { name: 'm:1' }] }));
  }) as unknown as typeof fetch;
  // (Watched, but never asked by the timer in a test's lifetime.)
  const loc = new OllamaLocality({ now: () => t.now, fetchImpl, everyMs: 1e9 });
  return { t, loc };
}

describe('the Mac’s clock is set back after a model was heard to run here', () => {
  it.each([['5 seconds', 5_000], ['a minute', 60_000], ['an hour', 3_600_000]])('by %s: a caller that only reads is told nothing is local, at once and for as long after', async (_name, back) => {
    const { t, loc } = rig();
    await loc.fresh(U);
    expect(loc.runsHere(U, 'm:1')).toBe(true);
    // The name is pointed at Ollama's servers, and the clock goes back.
    t.remote = true;
    t.now -= back;
    const from = t.now;
    t.asks = 0;
    let yes = 0;
    for (let s = 0; s <= back / 1000 + 400; s += 1) {
      t.now = from + s * 1000;
      if (loc.runsHere(U, 'm:1')) yes += 1;
    }
    expect(yes).toBe(0);
    // Reading asks nothing, and "it is an Ollama" went with the rest.
    expect(t.asks).toBe(0);
    expect(loc.said(U)).toBeUndefined();
    loc.clear();
  });

  it.each([['5 seconds', 5_000], ['a minute', 60_000], ['an hour', 3_600_000]])('by %s: a caller that asks first asks at once, and is told the model runs elsewhere', async (_name, back) => {
    const { t, loc } = rig();
    await loc.fresh(U);
    expect([loc.runsHere(U, 'm:1'), t.asks]).toEqual([true, 1]);
    t.remote = true;
    t.now -= back;
    const from = t.now;
    t.asks = 0;
    let yes = 0;
    let firstAsk = -1;
    for (let s = 0; s <= back / 1000 + 10; s += 1) {
      t.now = from + s * 1000;
      await loc.fresh(U);
      if (t.asks > 0 && firstAsk < 0) firstAsk = s;
      if (loc.runsHere(U, 'm:1')) yes += 1;
    }
    expect([firstAsk, yes]).toEqual([0, 0]);
    expect(loc.runsElsewhere(U, 'm:1')).toBe(true);
    loc.clear();
  });

  it('a clock that only goes forward forgets nothing: a word is believed for its five minutes, and asked again after two seconds', async () => {
    const { t, loc } = rig();
    await loc.fresh(U);
    const heard = t.now;
    t.now = heard + FRESH_MS;
    await loc.fresh(U);
    expect(t.asks).toBe(1);
    t.now = heard + FIVE_MIN;
    expect(loc.runsHere(U, 'm:1')).toBe(true);
    t.now = heard + FIVE_MIN + 1;
    expect(loc.runsHere(U, 'm:1')).toBe(false);
    // The same time twice is not a clock set back.
    await loc.fresh(U);
    expect([t.asks, loc.runsHere(U, 'm:1')]).toEqual([2, true]);
    expect(loc.runsHere(U, 'm:1')).toBe(true);
    loc.clear();
  });

  it('what is heard after the clock went back is believed on the clock as it now reads', async () => {
    const { t, loc } = rig();
    await loc.fresh(U);
    t.now -= 3_600_000;
    expect(loc.runsHere(U, 'm:1')).toBe(false);
    await loc.fresh(U);
    const heard = t.now;
    expect(loc.runsHere(U, 'm:1')).toBe(true);
    t.now = heard + FIVE_MIN;
    expect(loc.runsHere(U, 'm:1')).toBe(true);
    t.now = heard + FIVE_MIN + 1;
    expect(loc.runsHere(U, 'm:1')).toBe(false);
    loc.clear();
  });

  it('every server’s word goes, not only the one that was read: another server’s listing and a "not an Ollama" too', async () => {
    const { t, loc } = rig();
    const OTHER = 'http://127.0.0.1:8080';
    await loc.fresh(U);
    loc.learn(OTHER, [{ name: 'q:1' }]);
    loc.notOllama('http://127.0.0.1:1234');
    expect([loc.runsHere(OTHER, 'q:1'), loc.said('http://127.0.0.1:1234')]).toEqual([true, 'other']);
    t.now -= 60_000;
    expect(loc.runsHere(U, 'm:1')).toBe(false);
    expect([loc.runsHere(OTHER, 'q:1'), loc.said('http://127.0.0.1:1234'), loc.said(OTHER)]).toEqual([false, undefined, undefined]);
    loc.clear();
  });

  it('a word from an ask that was under way when the clock went back is dated when it landed, never later', async () => {
    const { t, loc } = rig();
    const began = t.now;
    // The listing is asked; while it is on its way the clock goes back a minute.
    t.during = () => {
      t.now = began - 60_000;
      t.during = undefined;
    };
    await loc.fresh(U);
    const landed = began - 60_000;
    expect(loc.runsHere(U, 'm:1')).toBe(true);
    // Believed for five minutes from when it landed. Dated when its ask began, it would be believed a minute longer.
    t.now = landed + FIVE_MIN;
    expect(loc.runsHere(U, 'm:1')).toBe(true);
    t.now = landed + FIVE_MIN + 1;
    expect(loc.runsHere(U, 'm:1')).toBe(false);
    // And a caller that asks first two seconds after it landed has it asked again.
    const again = rig();
    const start = again.t.now;
    again.t.during = () => {
      again.t.now = start - 60_000;
      again.t.during = undefined;
    };
    await again.loc.fresh(U);
    const n = again.t.asks;
    again.t.now = start - 60_000 + FRESH_MS + 1;
    await again.loc.fresh(U);
    expect(again.t.asks).toBe(n + 1);
    loc.clear();
    again.loc.clear();
  });

  it('a word learned for good (a test’s listing, dated without end) stays for as long as the clock does not go back', () => {
    const { t, loc } = rig();
    loc.learn(U, [{ name: 'm:1' }], Number.POSITIVE_INFINITY);
    t.now += 365 * 86_400_000;
    expect(loc.runsHere(U, 'm:1')).toBe(true);
    loc.clear();
  });
});
