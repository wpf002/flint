import { describe, it, expect } from 'vitest';
import { asksDeep, withoutQuoted } from '../src/hybrid-rules';
import { LOCAL_URL_MAX_LEN, parseLocalUrl, readInferenceConfig } from '../src/inference-config';
import { isPrivate } from '../src/mode-route';

/**
 * The final review's M5. Three patterns were quadratic in what they were
 * handed. Two run on the event loop for every hybrid message (asksDeep), on
 * whatever Will pasted: 100,000 `“` or blank lines took about 4 seconds, and
 * 200,000 took 15 to 17, with every other request waiting. The third ran at
 * boot on the model server's address.
 *
 * Each case below is 200,000 characters of the worst input for one of them.
 * The old code needed many seconds for each; the bound here is a few hundred
 * milliseconds, far from both.
 */

const N = 200_000;
const BOUND_MS = 400;

function timed<T>(fn: () => T): { ms: number; value: T } {
  const t0 = performance.now();
  const value = fn();
  return { ms: performance.now() - t0, value };
}

describe('asksDeep is linear in the message', () => {
  const worst: Array<[string, string]> = [
    ['a run of opening curly quotes with nothing to close them', '“'.repeat(N)],
    ['a run of opening guillemets', '«'.repeat(N)],
    ['a run of blank lines', '\n'.repeat(N)],
    ['blank lines with a quoted line at the very end', `${'\n'.repeat(N)}> quoted`],
    ['a run of carriage returns', '\r'.repeat(N)],
    ['a run of spaces and tabs before nothing', ' \t'.repeat(N / 2)],
    ['opening quotes, each on its own line', '“\n'.repeat(N / 2)],
    ['one of each opener, over and over', '“«"'.repeat(Math.floor(N / 3))],
    ['openers and then one closer at the far end', `${'“'.repeat(N - 1)}”`],
    ['single backticks with nothing to close them, one a line', '`x\n'.repeat(Math.floor(N / 3))],
    ['an unclosed code fence and a wall of backtick pairs', `\`\`\`${'`` '.repeat(Math.floor(N / 3))}`],
    ['a run of "think" with no phrase completed', 'think '.repeat(Math.floor(N / 6))],
  ];
  for (const [name, text] of worst) {
    it(`${name}: 200,000 characters in well under a second`, () => {
      expect(text.length).toBeGreaterThanOrEqual(N - 3);
      const { ms } = timed(() => asksDeep(text));
      expect(ms, `${name} took ${Math.round(ms)} ms`).toBeLessThan(BOUND_MS);
    });
  }

  it('it still answers the same question: his own instruction counts, quoted or pasted words do not', () => {
    expect(asksDeep('think hard about this')).toBe(true);
    expect(asksDeep(`${'“'.repeat(N)} think hard about this`)).toBe(true);
    expect(asksDeep(`think hard about this ${'\n'.repeat(N)}`)).toBe(true);
    expect(asksDeep(`she wrote “think hard about it” ${'x '.repeat(400)} and I laughed`)).toBe(false);
    expect(asksDeep(`${'\n'.repeat(N)}> think hard about it`)).toBe(false);
    expect(asksDeep(`  \t> use the cloud model\nwhat does that line mean?`)).toBe(false);
  });

  it('the private-words check on the same message is linear too', () => {
    for (const text of ['on-'.repeat(N / 3), 'keep this '.repeat(N / 10), 'don'.repeat(N / 3), ' '.repeat(N)]) {
      const { ms } = timed(() => isPrivate(text, false));
      expect(ms).toBeLessThan(BOUND_MS);
    }
  });
});

describe('withoutQuoted: one pass, and exactly what the pattern it replaced matched', () => {
  /** The pattern as it was. Quadratic on a run of openers, so it is only ever run here on short strings. */
  const OLD = /"[^"\n]*"|“[^”\n]*”|«[^»\n]*»/g;
  const old = (s: string): string => s.replace(OLD, ' ');

  it('the cases the routing rule was written for', () => {
    for (const s of [
      'summarise this note: "we cover the topic in depth next week"',
      'she wrote “think hard about it” and I laughed',
      'il a dit «go deep» et voilà',
      'an opener “ with no closer on its line\nand a closer ” on the next',
      '“a “b” c”',
      '"a “b" c”',
      '""',
      '"',
      '“”«»""',
      'a " b “ c « d',
      '”closer first“',
      '"one" and "two" and “three” and «four»',
      'line one "open\nline two" closed?',
      '',
    ]) {
      expect(withoutQuoted(s), JSON.stringify(s)).toBe(old(s));
    }
  });

  it('agrees with the old pattern on ten thousand random strings of quotes, text and line breaks', () => {
    // A small generator with a fixed seed, so a failure names a string that fails again.
    let seed = 0x5eed1e55;
    const rnd = (n: number): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % n;
    };
    const alphabet = ['"', '"', '“', '”', '«', '»', '\n', 'a', ' ', 'think hard', '>'];
    for (let n = 0; n < 10_000; n++) {
      let s = '';
      const len = rnd(24);
      for (let k = 0; k < len; k++) s += alphabet[rnd(alphabet.length)];
      expect(withoutQuoted(s), JSON.stringify(s)).toBe(old(s));
    }
  });

  it('a long run of openers costs one look, not one per opener', () => {
    for (const text of ['“'.repeat(N), '«'.repeat(N), '"'.repeat(N), `${'“'.repeat(N - 1)}”`, '“\n'.repeat(N / 2), `${'“a'.repeat(N / 4)}\n${'”'.repeat(N / 2)}`]) {
      const { ms } = timed(() => withoutQuoted(text));
      expect(ms).toBeLessThan(BOUND_MS);
    }
  });
});

describe("the model server's address is parsed in linear time", () => {
  it('200,000 trailing slashes, with and without something after them, are refused at once', () => {
    for (const url of [`http://127.0.0.1:11434${'/'.repeat(N)}`, `http://127.0.0.1:11434${'/'.repeat(N)}x`, `http://127.0.0.1:11434/v1${'/'.repeat(N)}`, `http://127.0.0.1:11434/${'a/'.repeat(N / 2)}`]) {
      const { ms, value } = timed(() => parseLocalUrl(url, false));
      expect(ms).toBeLessThan(BOUND_MS);
      expect(value).toEqual({ ok: false, reason: 'not_a_url' });
    }
  });

  it('an address is short: nothing over 2,048 characters is looked at, and a few trailing slashes are still fine', () => {
    expect(LOCAL_URL_MAX_LEN).toBe(2048);
    expect(parseLocalUrl(`http://127.0.0.1:11434${'/'.repeat(LOCAL_URL_MAX_LEN)}`, false)).toEqual({ ok: false, reason: 'not_a_url' });
    expect(parseLocalUrl('http://127.0.0.1:11434///', false, { defaultPath: '/v1' })).toMatchObject({ ok: true, baseURL: 'http://127.0.0.1:11434/v1', path: '/v1' });
    expect(parseLocalUrl('http://127.0.0.1:8080/v1//', false)).toMatchObject({ ok: true, baseURL: 'http://127.0.0.1:8080/v1', path: '/v1' });
    expect(parseLocalUrl(`http://127.0.0.1:11434${'/'.repeat(1000)}`, false)).toMatchObject({ ok: true, path: '' });
  });

  it('the whole config read survives such a value in every address setting', () => {
    const long = `http://127.0.0.1:11434${'/'.repeat(N)}x`;
    const { ms, value } = timed(() => readInferenceConfig({ OLLAMA_HOST: long, FLINT_LOCAL_BASE_URL: long, FLINT_LOCAL_PROVIDER: 'openai' }));
    expect(ms).toBeLessThan(BOUND_MS);
    expect(value.problems.map((p) => p.key).sort()).toEqual(['FLINT_LOCAL_BASE_URL', 'OLLAMA_HOST']);
    // The refused value is never echoed into a problem.
    expect(JSON.stringify(value.problems).length).toBeLessThan(500);
  });
});
