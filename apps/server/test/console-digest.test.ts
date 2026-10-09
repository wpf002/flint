/**
 * What Will signs is what his card showed him (apps/console/index.html, the main
 * script): the console hashes the args a card displayed exactly as
 * @flint/policy's digestOf does, sends that digest with the request to sign, and
 * signs nothing unless the challenge carries the same digest back. Run in a vm
 * with Node's WebCrypto, against generated values and a server that names a
 * different digest.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { webcrypto } from 'node:crypto';
import { createContext, runInContext } from 'node:vm';
import { canonicalJson, digestOf } from '@flint/policy';

const html = readFileSync(join(__dirname, '..', '..', 'console', 'index.html'), 'utf8');
const mainJs = /<script>\n\/\* ---------- config ---------- \*\/([\s\S]*?)<\/script>/.exec(html)![1]!;

/** One top-level function of the main script, up to the next top-level statement. */
function fn(name: string): string {
  const start = mainJs.indexOf(`\nfunction ${name}(`);
  if (start < 0) throw new Error(`no function ${name}`);
  const rest = mainJs.slice(start + 1);
  const end = rest.slice(1).search(/\n(function |\/\*|\$\(|var )/);
  return end < 0 ? rest : rest.slice(0, end + 1);
}
const unsignable = /\nvar UNSIGNABLE=[^\n]*\n/.exec(mainJs)![0];

function sandbox(extra: Record<string, unknown> = {}) {
  const c: Record<string, unknown> = { crypto: webcrypto, TextEncoder, ...extra };
  createContext(c);
  runInContext([unsignable, fn('canonJson'), fn('shownDigest'), fn('beginSigned'), fn('enclaveDecide'), fn('passkeyDecide')].join('\n'), c);
  return c;
}

/** Values as the console holds them: parsed from JSON inside its own realm. */
const inside = (c: Record<string, unknown>, code: string, v: unknown) => runInContext(`(${code})(JSON.parse(${JSON.stringify(JSON.stringify(v))}))`, c) as unknown;

describe('the console hashes what it shows exactly as digestOf does', () => {
  it('on hundreds of generated values: unicode, control characters, quotes, nesting, empty containers, the largest safe integers, any key order', async () => {
    let seed = 41;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
    const chars = ['a', 'Z', ' ', '"', '\\', '/', '\n', '\t', '\r', '\b', '\f', '\u0000', '\u0001', '\u001f', '\u007f', 'é', 'ß', '中', '😀', ' ', ' ', '́', '\ud800', '\udfff', "'", '<', '{'];
    const str = () => Array.from({ length: Math.floor(rnd() * 10) }, () => pick(chars)).join('');
    const value = (depth: number): unknown => {
      const r = rnd();
      if (depth > 3 || r < 0.35) {
        return pick<() => unknown>([
          () => str(), () => Math.floor(rnd() * 2000) - 1000, () => pick([0, -0, 1, -1, 2 ** 53 - 1, -(2 ** 53 - 1), 0.5, -1.25, 1e21, 1e-7]), () => rnd() < 0.5, () => null,
        ])();
      }
      if (r < 0.65) return Array.from({ length: Math.floor(rnd() * 5) }, () => value(depth + 1));
      // Keys in any order, unicode ones included: the digest sorts them as JavaScript does.
      return Object.fromEntries(Array.from({ length: Math.floor(rnd() * 6) }, () => [str() || pick(['b', 'a', 'B', 'é', '😀']), value(depth + 1)]));
    };
    const samples: unknown[] = [{}, [], { a: [] }, { a: {} }, [[], {}], '', null, true, { b: 1, a: 2, A: 3, _: 4 }, { goalId: 'gotest0001', goalTitle: 'Synthetic "goal" \n' }];
    for (let i = 0; i < 400; i++) samples.push(value(0));
    const c = sandbox();
    for (const v of samples) {
      const json = JSON.parse(JSON.stringify(v)) as unknown;
      expect(inside(c, 'canonJson', v)).toBe(canonicalJson(json));
      expect(await (inside(c, 'shownDigest', v) as Promise<string>)).toBe(digestOf(json));
    }
  });

  it('what has no single JSON form is never signed', async () => {
    const c = sandbox();
    for (const bad of ['NaN', 'Infinity', '[1, undefined]', 'new Date(0)', 'function () {}']) {
      await expect(runInContext(`shownDigest(${bad})`, c) as Promise<string>).rejects.toThrow('It can’t be signed: what it would do doesn’t match what it shows.');
    }
  });
});

describe('approving signs only the digest of what the card showed', () => {
  const shownArgs = { goalId: 'gotest0001', goalTitle: 'Synthetic' };
  const run = async (decide: 'enclaveDecide' | 'passkeyDecide', named: string) => {
    const posted: Array<[string, Record<string, unknown>]> = [];
    const signed: unknown[] = [];
    const failures: string[] = [];
    const decided: unknown[] = [];
    const c = sandbox({
      postJson: async (path: string, body: Record<string, unknown>) => {
        posted.push([path, body]);
        if (path === '/approvals/begin') return { challengeId: 'ch1', challenge: 'AAAA', payload: { action: 'goal.abandon', argsDigest: named } };
        return { action: { status: 'done' } };
      },
      se: async (_op: string, o: unknown) => (signed.push(o), { signature: 'sig' }),
      signWithMyKey: async (b: unknown) => (signed.push(b), { credentialId: 'c', signature: 'sig' }),
      SE_ID: 'se_1',
      showDecision: (d: unknown) => void decided.push(d),
      failed: (e: Error) => void failures.push(e.message),
    });
    const el = { style: {} as Record<string, unknown> };
    const card = { querySelector: () => el };
    // The args go in from the card as the console got them (JSON, in its own realm).
    c.cardArgs = runInContext(`JSON.parse(${JSON.stringify(JSON.stringify(shownArgs))})`, c);
    const out = (runInContext(`${decide}('pr1', 'approve', card, { reason: 'approve: Abandon a Goal', fresh: true, args: cardArgs })`, Object.assign(c, { card })) as Promise<unknown>).then(() => 'ok', (e: Error) => e.message);
    return { result: await out, posted, signed, failures, decided };
  };

  for (const decide of ['enclaveDecide', 'passkeyDecide'] as const) {
    it(`${decide}: a challenge naming another digest is refused before anything is signed; the shown one is signed`, async () => {
      const other = await run(decide, digestOf({ ...shownArgs, goalId: 'gotest0002' }));
      expect(other.result).toBe('It can’t be signed: what it would do doesn’t match what it shows.');
      expect(other.signed).toEqual([]);
      expect(other.posted.map((p) => p[0])).toEqual(['/approvals/begin']);
      // The request itself carried the shown digest, for the server's own check.
      expect(other.posted[0]![1]).toEqual({ proposalId: 'pr1', decision: 'approve', argsDigest: digestOf(shownArgs) });
      expect(other.failures).toEqual(['It can’t be signed: what it would do doesn’t match what it shows.']);
      const same = await run(decide, digestOf(shownArgs));
      expect(same.result).toBe('ok');
      expect(same.signed).toHaveLength(1);
      expect(same.posted.map((p) => p[0])).toEqual(['/approvals/begin', '/approvals/finish']);
    });
  }
});
