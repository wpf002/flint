/**
 * The console's voice and a reply that stays on this Mac (apps/console/index.html,
 * P3 part 4). The server's `meta` event says whether the reply being streamed
 * stays here and which stored turn it is; the console then speaks it with the
 * browser's own voice and never asks `/speak` (an outside speech service) for
 * it. Every other reply's request names its conversation and turn, so the
 * server can refuse on its side too.
 *
 * The three functions are run as the page has them, with a fake `fetch`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';

const html = readFileSync(join(__dirname, '..', '..', 'console', 'index.html'), 'utf8');
const line = (re: RegExp): string => {
  const m = re.exec(html);
  if (!m) throw new Error(`not in the console: ${re}`);
  return m[0];
};
const SOURCE = [
  'var _ttsSkipUntil=0;',
  line(/^function _neuralFetch\(clean,vctx\)\{.*$/m),
  line(/^function voiceMeta\(vctx,ev\)\{.*$/m),
  line(/^function _speechBlob\(clean,vctx\)\{.*$/m),
].join('\n');

interface Sent {
  url: string;
  body: Record<string, unknown>;
}
function page(status = 200) {
  const sent: Sent[] = [];
  const ctx = createContext({
    BASE: 'http://flint.test',
    auth: () => ({ authorization: 'Bearer test' }),
    Date,
    Promise,
    Object,
    JSON,
    Error,
    fetch: (url: string, init: { body: string }) => {
      sent.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
      return Promise.resolve({ status, ok: status >= 200 && status < 300, blob: () => Promise.resolve('mp3') });
    },
  });
  runInContext(SOURCE, ctx);
  const call = <T>(expr: string, args: Record<string, unknown>): T => {
    Object.assign(ctx, args);
    return runInContext(expr, ctx) as T;
  };
  return { sent, call, skipUntil: () => runInContext('_ttsSkipUntil', ctx) as number };
}
/** A reply's voice state once the server has said it may go out (the page starts every reply as one that stays here). */
const fresh = () => ({ displayed: '', gen: 0, conv: 'c1', here: false, turn: null as string | null });

describe('the console’s voice: a reply that stays on this Mac', () => {
  it('a reply starts as one that stays here: until the server says it may go out, nothing of it is sent to /speak', async () => {
    const p = page();
    // As the page makes it for each reply.
    const vctx = { displayed: '', gen: 0, conv: 'c1', here: true, turn: null as string | null };
    expect(await p.call<Promise<unknown>>('_speechBlob(clean,vctx)', { clean: 'A first sentence.', vctx })).toBeNull();
    // The brain's own meta event (which model answers) says nothing of it, and neither does an older server.
    p.call('voiceMeta(vctx,ev)', { vctx, ev: { type: 'meta', brain: 'frontier' } });
    expect(await p.call<Promise<unknown>>('_speechBlob(clean,vctx)', { clean: 'A second sentence.', vctx })).toBeNull();
    expect(p.sent).toEqual([]);
    // Only the server saying so clears it.
    p.call('voiceMeta(vctx,ev)', { vctx, ev: { type: 'meta', staysHere: false, turn: 'turn_abc' } });
    expect(await p.call<Promise<unknown>>('_speechBlob(clean,vctx)', { clean: 'A third sentence.', vctx })).toBe('mp3');
    expect(p.sent).toEqual([{ url: 'http://flint.test/speak', body: { text: 'A third sentence.', conversationId: 'c1', turnId: 'turn_abc' } }]);
  });

  it('the meta event sets it for the reply being streamed, with the turn it is stored as', () => {
    const p = page();
    const vctx = fresh();
    p.call('voiceMeta(vctx,ev)', { vctx, ev: { type: 'meta', brain: 'local' } });
    expect(vctx).toMatchObject({ here: false, turn: null }); // the brain's own meta event says nothing of it
    p.call('voiceMeta(vctx,ev)', { vctx, ev: { type: 'meta', staysHere: true, turn: 'turn_abc' } });
    expect(vctx).toMatchObject({ here: true, turn: 'turn_abc' });
    // A later ask of the same turn (the tier failed, another brain answers) says it for itself.
    p.call('voiceMeta(vctx,ev)', { vctx, ev: { type: 'meta', staysHere: false, turn: 'turn_def' } });
    expect(vctx).toMatchObject({ here: false, turn: 'turn_def' });
    p.call('voiceMeta(vctx,ev)', { vctx, ev: { type: 'meta', staysHere: true } });
    expect(vctx).toMatchObject({ here: true, turn: null });
    // Only a real yes or no counts.
    p.call('voiceMeta(vctx,ev)', { vctx, ev: { type: 'meta', staysHere: 'false', turn: 'x' } });
    expect(vctx).toMatchObject({ here: true, turn: null });
  });

  it('is never sent to /speak: the browser speaks it', async () => {
    const p = page();
    const vctx = { ...fresh(), here: true, turn: 'turn_abc' };
    expect(await p.call<Promise<unknown>>('_speechBlob(clean,vctx)', { clean: 'Your goal is on track.', vctx })).toBeNull();
    expect(p.sent).toEqual([]);
  });

  it('every other reply is, and its request names the conversation and the turn', async () => {
    const p = page();
    const vctx = { ...fresh(), turn: 'turn_abc' };
    expect(await p.call<Promise<unknown>>('_speechBlob(clean,vctx)', { clean: 'It is sunny.', vctx })).toBe('mp3');
    expect(p.sent).toEqual([{ url: 'http://flint.test/speak', body: { text: 'It is sunny.', conversationId: 'c1', turnId: 'turn_abc' } }]);
    // Before any meta event (or from an older server) it names the conversation alone.
    await p.call<Promise<unknown>>('_speechBlob(clean,vctx)', { clean: 'Hello.', vctx: fresh() });
    expect(p.sent[1]!.body).toEqual({ text: 'Hello.', conversationId: 'c1' });
    // Nothing to say, nothing asked.
    expect(await p.call<Promise<unknown>>('_speechBlob(clean,vctx)', { clean: '', vctx: fresh() })).toBeNull();
    expect(p.sent).toHaveLength(2);
  });

  it('the server’s own refusal (409) is the browser voice for this reply only; a 503 still rests the neural voice for ten minutes', async () => {
    const refused = page(409);
    expect(await refused.call<Promise<unknown>>('_speechBlob(clean,vctx)', { clean: 'Your goal is on track.', vctx: fresh() })).toBeNull();
    expect(refused.skipUntil()).toBe(0);
    await refused.call<Promise<unknown>>('_speechBlob(clean,vctx)', { clean: 'And another.', vctx: fresh() });
    expect(refused.sent).toHaveLength(2); // the next sentence asks again

    const out = page(503);
    expect(await out.call<Promise<unknown>>('_speechBlob(clean,vctx)', { clean: 'It is sunny.', vctx: fresh() })).toBeNull();
    expect(out.skipUntil()).toBeGreaterThan(Date.now() + 9 * 60_000);
    await out.call<Promise<unknown>>('_speechBlob(clean,vctx)', { clean: 'And another.', vctx: fresh() });
    expect(out.sent).toHaveLength(1);
  });

  it('the page wires them in: each reply has its own voice state, the meta event feeds it, and speech goes through it', () => {
    expect(html).toContain("var vctx={displayed:'',gen:_ttsGen,conv:convId,here:true,turn:null};");
    expect(html).toContain("if(ev.type==='meta'){if(ev.brain)setBrainChip(body,ev.brain);voiceMeta(vctx,ev);}");
    expect(html).toContain('var blobP=_speechBlob(clean,vctx);');
    // /speak is asked from one place.
    expect(html.match(/\/speak'/g)).toHaveLength(1);
    expect(html.match(/_neuralFetch\(/g)).toHaveLength(2); // its definition, and _speechBlob's call
  });
});
