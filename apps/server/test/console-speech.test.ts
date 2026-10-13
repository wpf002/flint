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
import { forVoice, isPartOf } from '../src/spoken-text';
import { SAY_AT_ONCE, SAY_WAITING, SpeechBusy, sayLine } from '../src/voice';

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

  // The Mac's own voice is held to a line (../src/voice sayLine): past it the server answers 429. That is "this
  // one reply, speak it yourself", not "the voice is out": the very next sentence is asked for again.
  it('a busy server (429) is the browser voice for this reply only, like its refusal: the next sentence asks again', async () => {
    const busy = page(429);
    expect(await busy.call<Promise<unknown>>('_speechBlob(clean,vctx)', { clean: 'It is sunny.', vctx: fresh() })).toBeNull();
    expect(busy.skipUntil()).toBe(0);
    await busy.call<Promise<unknown>>('_speechBlob(clean,vctx)', { clean: 'And another.', vctx: fresh() });
    expect(busy.sent).toHaveLength(2);
  });

  // Local voice: when the server's own speech is made on this Mac (`say`, a speech server on this Mac), the meta
  // event says so (`speechHere`), and a reply that stays here may then be sent to it: nothing spoken there leaves.
  // The page starts from "it is not", and only the server's own yes changes that, for the reply it was said about.
  it('a reply that stays here is sent to /speak only when the server has said its speech is made on this Mac', async () => {
    const p = page();
    const vctx = { displayed: '', gen: 0, conv: 'c1', here: true, turn: null as string | null };
    // Stays here, and nothing said about where the speech is made: not sent.
    p.call('voiceMeta(vctx,ev)', { vctx, ev: { type: 'meta', staysHere: true, turn: 'turn_kept' } });
    expect(await p.call<Promise<unknown>>('_speechBlob(clean,vctx)', { clean: 'A private sentence.', vctx })).toBeNull();
    expect(p.sent).toEqual([]);
    // The server says it speaks on this Mac: sent, naming the turn as any other reply's request does.
    p.call('voiceMeta(vctx,ev)', { vctx, ev: { type: 'meta', staysHere: true, turn: 'turn_kept', speechHere: true } });
    expect(await p.call<Promise<unknown>>('_speechBlob(clean,vctx)', { clean: 'A private sentence.', vctx })).toBe('mp3');
    expect(p.sent).toEqual([{ url: 'http://flint.test/speak', body: { text: 'A private sentence.', conversationId: 'c1', turnId: 'turn_kept' } }]);
    // Only a real yes counts, and it is said again by each event: one without it takes it back.
    for (const said of ['true', 1, {}, null, false]) {
      p.call('voiceMeta(vctx,ev)', { vctx, ev: { type: 'meta', staysHere: true, turn: 'turn_kept', speechHere: said } });
      expect(await p.call<Promise<unknown>>('_speechBlob(clean,vctx)', { clean: 'Another.', vctx }), String(said)).toBeNull();
    }
    p.call('voiceMeta(vctx,ev)', { vctx, ev: { type: 'meta', staysHere: true, turn: 'turn_kept', speechHere: true } });
    p.call('voiceMeta(vctx,ev)', { vctx, ev: { type: 'meta', staysHere: true, turn: 'turn_next' } });
    expect(await p.call<Promise<unknown>>('_speechBlob(clean,vctx)', { clean: 'Another.', vctx })).toBeNull();
    expect(p.sent).toHaveLength(1);
    // An event that says nothing of the reply (the brain's own) changes nothing, whatever else it carries.
    p.call('voiceMeta(vctx,ev)', { vctx, ev: { type: 'meta', brain: 'local', speechHere: true } });
    expect(await p.call<Promise<unknown>>('_speechBlob(clean,vctx)', { clean: 'Another.', vctx })).toBeNull();
    expect(p.sent).toHaveLength(1);
  });

  it('...and when the server then refuses or fails, the device’s own voice speaks it, as for any reply', async () => {
    for (const status of [409, 429, 502, 503]) {
      const p = page(status);
      const vctx = { displayed: '', gen: 0, conv: 'c1', here: true, turn: 'turn_kept' as string | null, speechHere: true };
      expect(await p.call<Promise<unknown>>('_speechBlob(clean,vctx)', { clean: 'A private sentence.', vctx }), String(status)).toBeNull();
      expect(p.sent, String(status)).toHaveLength(1);
    }
  });

  it('the page wires them in: each reply has its own voice state, the meta event feeds it, and speech goes through it', () => {
    expect(html).toContain("var vctx={displayed:'',gen:_ttsGen,conv:convId,here:true,turn:null};");
    // (The tag under the reply also says when the standby local model answered: `ev.standby`.)
    expect(html).toContain("if(ev.type==='meta'){if(ev.brain)setBrainChip(body,ev.brain,ev.standby);modeSeen(ev.route);voiceMeta(vctx,ev);}");
    expect(html).toContain('var blobP=_speechBlob(clean,vctx);');
    // Nothing else in the page sets the voice state: not Local Only, not the route the brain's own event carries.
    expect(html).not.toContain('vctx.priv');
    expect(html.match(/vctx\.here=[^=]/g)).toHaveLength(1); // voiceMeta's own assignment
    expect(html.match(/vctx\.speechHere=[^=]/g)).toHaveLength(1); // ...and the same for where the server speaks
    expect(html.match(/speechHere/g)).toHaveLength(4); // voiceMeta reads and sets it; _speechBlob reads it, and its comment names it
    // The browser's own voice is told whether the reply stays here.
    expect(html).toContain('}else{if(clean)vctx.own=true;reveal();_localSpeak(clean,vctx.here===true).then(res);}');
    // /speak is asked from one place.
    expect(html.match(/\/speak'/g)).toHaveLength(1);
    expect(html.match(/_neuralFetch\(/g)).toHaveLength(2); // its definition, and _speechBlob's call
  });
});

// One reply, one voice. The console asks the server for a reply's speech one sentence at a time, as the reply
// streams in, and speaks a sentence with the device's own voice when the server has none for it (it refused, was
// busy, or failed). With the Mac's own voice behind a short line, a long reply came out as
// MMMMMMMMMMMMMMMMddMMdddMdMdMdM: the Mac's voice (M) and the device's (d), back and forth. Two changes: the line
// is long enough for a whole reply (../src/voice SAY_WAITING), and a reply that has gone to the device's voice for
// one sentence stays with it to its end.
describe('one reply, one voice: a reply that has been spoken by the device for one sentence stays with the device', () => {
  const SPEAK_SOURCE = [
    'var _ttsSkipUntil=0,_ttsChain=Promise.resolve(),_ttsGen=0,_ttsAudio=null,_ttsQueued=0;',
    line(/^function _neuralFetch\(clean,vctx\)\{.*$/m),
    line(/^function voiceMeta\(vctx,ev\)\{.*$/m),
    line(/^function _speechBlob\(clean,vctx\)\{.*$/m),
    // speakForVoice and speakSynced, as the page has them.
    html.slice(html.indexOf('function speakForVoice(s){'), html.indexOf('function toggleMic(){')),
  ].join('\n');
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  type Answer = { status: number; ok: boolean; blob: () => Promise<string> };

  /**
   * The page's own speech functions, with what they touch replaced: `fetch` is a stand-in for the server (it is
   * handed the sentence, and answers 200 with "audio" or a refusal), an `Audio` that "plays" for a moment, and the
   * device's own voice. `voices` is what was heard, one letter a sentence, in the order it was spoken.
   */
  function reply(server: (text: string, n: number) => Promise<Answer>) {
    const voices: string[] = [];
    const asked: string[] = [];
    const ctx = createContext({
      BASE: 'http://flint.test',
      auth: () => ({ authorization: 'Bearer test' }),
      Date,
      Promise,
      Object,
      JSON,
      Error,
      fetch: (_url: string, init: { body: string }) => {
        const text = (JSON.parse(init.body) as { text: string }).text;
        asked.push(text);
        return server(text, asked.length - 1);
      },
      URL: { createObjectURL: (b: unknown) => String(b), revokeObjectURL: () => {} },
      Audio: class {
        onplay: (() => void) | undefined;
        onended: (() => void) | undefined;
        onerror: (() => void) | undefined;
        play(): Promise<void> {
          voices.push('M');
          setTimeout(() => {
            this.onplay?.();
            this.onended?.();
          }, 1);
          return Promise.resolve();
        }
        pause(): void {}
      },
      document: { getElementById: () => null },
      md: (s: string) => s,
      // The device's own voice: it says nothing for a sentence with no words in it.
      _localSpeak: (clean: string) => {
        if (clean) voices.push('d');
        return sleep(1);
      },
    });
    runInContext(SPEAK_SOURCE, ctx);
    /** A reply's voice state, as the page makes one and the server's `meta` event fills it: an ordinary reply, so every sentence may be asked for. */
    const start = (): Record<string, unknown> => ({ displayed: '', gen: 0, conv: 'c1', here: false, turn: 't1' });
    const say = (sentence: string, vctx: Record<string, unknown>): void => {
      Object.assign(ctx, { s: sentence, body: { innerHTML: '' }, vctx });
      runInContext('speakSynced(s,body,vctx)', ctx);
    };
    const done = (): Promise<void> => runInContext('_ttsChain', ctx) as Promise<void>;
    return { voices, asked, start, say, done };
  }
  const ok = (text: string): Answer => ({ status: 200, ok: true, blob: () => Promise.resolve(`audio:${text}`) });
  const no = (status: number): Answer => ({ status, ok: false, blob: () => Promise.reject(new Error('no audio')) });
  /** The server with this Mac's own voice behind its line (../src/voice sayLine, the real one): a sentence takes `ms` to speak, and past the line the answer is 429. */
  const mac = (ms: number, atOnce?: number, waiting?: number) => {
    const inLine = sayLine(atOnce, waiting);
    return (text: string): Promise<Answer> => inLine(() => sleep(ms)).then(() => ok(text), (e: unknown) => no(e instanceof SpeechBusy ? 429 : 502));
  };
  const changes = (heard: string[]): number => heard.filter((v, i) => i > 0 && v !== heard[i - 1]).length;
  const THIRTY = Array.from({ length: 30 }, (_, i) => `Sentence number ${i + 1} of a long reply.`);

  it('thirty sentences at once, and thirty at five a second: the Mac’s voice speaks every one, with the line it has now', async () => {
    expect([SAY_AT_ONCE, SAY_WAITING]).toEqual([2, 40]);
    // (A sentence takes this Mac about 0.7 s to speak; at five a second one arrives every 0.2 s. The same ratio, a
    // fiftieth of the time. The outcome does not hang on those times: the line holds forty-two, and a reply of
    // thirty fits in it however slowly anything is spoken.)
    for (const everyMs of [0, 4]) {
      const r = reply(mac(14));
      const vctx = r.start();
      for (const s of THIRTY) {
        r.say(s, vctx);
        if (everyMs > 0) await sleep(everyMs);
      }
      await r.done();
      expect(r.voices.join(''), `one every ${everyMs} ms`).toBe('M'.repeat(30));
      expect(changes(r.voices), `one every ${everyMs} ms`).toBe(0);
      expect(r.asked).toHaveLength(30);
      expect(vctx.own, `one every ${everyMs} ms`).toBeUndefined();
    }
  });

  it('a server that runs out of room mid-reply: one change of voice at most, and never back', async () => {
    // A reply that arrives whole, at a server whose line is the one it had before (two running, eight waiting):
    // every sentence is asked for at once, so which ten it takes is settled before any of them is spoken.
    const whole = reply(mac(2, 2, 8));
    const v1 = whole.start();
    for (const s of THIRTY) whole.say(s, v1);
    await whole.done();
    expect(whole.voices.join('')).toBe('M'.repeat(10) + 'd'.repeat(20));
    expect([changes(whole.voices), v1.own]).toEqual([1, true]);

    // A reply that trickles in at five sentences a second, as the re-review heard it. Which sentences that server
    // had room for is what it measured (MMMMMMMMMMMMMMMMddMMdddMdMdMdM: places came free as it spoke), written
    // down here sentence by sentence, so that nothing in this test depends on how fast anything runs.
    const HEARD = 'MMMMMMMMMMMMMMMMddMMdddMdMdMdM';
    const trickle = reply(async (text, n) => (HEARD[n] === 'M' ? ok(text) : no(429)));
    const v2 = trickle.start();
    for (const s of THIRTY) {
      trickle.say(s, v2);
      // Each sentence is spoken before the next arrives: the reply is still streaming in.
      await trickle.done();
    }
    // The server would have spoken sentences 19, 20, 24, 26, 28 and 30. The reply stays with the device from 17 on.
    expect(trickle.voices.join('')).toBe('M'.repeat(16) + 'd'.repeat(14));
    expect([changes(trickle.voices), v2.own]).toEqual([1, true]);
    // ...and from the sentence after the first refusal on it does not ask: 17 requests for 30 sentences.
    expect(trickle.asked).toHaveLength(17);

    // The same reply arriving whole (every sentence asked for before one is spoken): the audio that came back for
    // the later sentences is there, and is not played.
    const atOnce = reply(async (text, n) => (HEARD[n] === 'M' ? ok(text) : no(429)));
    const v3 = atOnce.start();
    for (const s of THIRTY) atOnce.say(s, v3);
    await atOnce.done();
    expect(atOnce.asked).toHaveLength(30);
    expect(atOnce.voices.join('')).toBe('M'.repeat(16) + 'd'.repeat(14));
  });

  it('a sentence whose audio had already come back is not played once the reply has gone to the device’s voice', async () => {
    // All five are asked for at once (the reply arrived whole). The server has audio for every one but the second.
    const r = reply(async (text, n) => (n === 1 ? no(429) : ok(text)));
    const vctx = r.start();
    for (const s of THIRTY.slice(0, 5)) r.say(s, vctx);
    await r.done();
    expect(r.asked).toHaveLength(5);
    expect(r.voices.join('')).toBe('Mdddd');
    // ...and whatever the refusal was: busy, a reply that stays here, a failure, the voice being out.
    for (const status of [409, 429, 500, 502, 503]) {
      const again = reply(async (text, n) => (n === 2 ? no(status) : ok(text)));
      const v = again.start();
      for (const s of THIRTY.slice(0, 6)) again.say(s, v);
      await again.done();
      expect(again.voices.join(''), String(status)).toBe('MMdddd');
    }
  });

  it('once it has, no more of that reply is asked of the server; and the next reply starts with the server’s voice again', async () => {
    const r = reply(async (text, n) => (n === 1 ? no(429) : ok(text)));
    const first = r.start();
    r.say(THIRTY[0]!, first);
    r.say(THIRTY[1]!, first);
    await r.done();
    expect([r.voices.join(''), first.own]).toEqual(['Md', true]);
    // The rest of the reply streams in: spoken by the device, and not one request is made for it.
    for (const s of THIRTY.slice(2, 8)) r.say(s, first);
    await r.done();
    expect(r.voices.join('')).toBe('Mddddddd');
    expect(r.asked).toHaveLength(2);
    // A new reply has a voice state of its own.
    const next = r.start();
    for (const s of THIRTY.slice(0, 3)) r.say(s, next);
    await r.done();
    expect(r.voices.join('')).toBe('MdddddddMMM');
    expect(r.asked).toHaveLength(5);
    expect(next.own).toBeUndefined();
  });

  it('a sentence with no words in it (only marks) changes nothing: it is not a fallback', async () => {
    const r = reply(async (text) => ok(text));
    const vctx = r.start();
    for (const s of ['One sentence.', ' *** ', 'Another sentence.']) r.say(s, vctx);
    await r.done();
    expect(r.voices.join('')).toBe('MM');
    expect(vctx.own).toBeUndefined();
    expect(r.asked).toEqual(['One sentence.', 'Another sentence.']);
  });

  it('a reply that stays here and is spoken by the device from its first sentence is one voice too: the device’s', async () => {
    const r = reply(async (text) => ok(text));
    const vctx = { ...r.start(), here: true };
    for (const s of THIRTY.slice(0, 4)) r.say(s, vctx);
    await r.done();
    expect(r.voices.join('')).toBe('dddd');
    expect(r.asked).toEqual([]);
  });

  it('the page wires it in: the reply’s own state holds it, it is set in one place, and read where a sentence is asked for and where it is spoken', () => {
    expect(html.match(/vctx\.own=true/g)).toHaveLength(1);
    expect(html).toContain('if(blob&&!vctx.own){');
    expect(html).toContain('function _speechBlob(clean,vctx){return(clean&&!vctx.own&&(!vctx.here||vctx.speechHere===true))?_neuralFetch(clean,vctx).catch(function(){return null;}):Promise.resolve(null);}');
    // Every reply starts without it: the state is made fresh for each one.
    expect(html).toContain("var vctx={displayed:'',gen:_ttsGen,conv:convId,here:true,turn:null};");
  });
});

// The final review's C3: "the browser's own voice" is not always this device's. A browser can list network voices
// (Chrome's "Google US English"): speaking with one sends the sentence to its maker.
describe('the browser voice for a reply that stays here is one this device makes itself', () => {
  const VOICE_SOURCE = [
    'var _flintVoice=null,_flintVoiceHere=null;',
    line(/^function _maleVoice\(name\)\{.*$/m),
    html.slice(html.indexOf('function pickVoice(here){'), html.indexOf('if(window.speechSynthesis)window.speechSynthesis.onvoiceschanged=')),
    line(/^function _localSpeak\(clean,here\)\{.*$/m),
  ].join('\n');
  interface Voice {
    name: string;
    lang: string;
    localService: boolean;
  }
  function browser(voices: Voice[]) {
    const spoken: Array<{ text: string; voice: string | null }> = [];
    const ctx = createContext({
      Promise,
      Array,
      String,
      window: {
        speechSynthesis: {
          getVoices: () => voices,
          speak: (u: { text: string; voice: Voice | null; onend: () => void }) => {
            spoken.push({ text: u.text, voice: u.voice ? u.voice.name : null });
            u.onend();
          },
        },
      },
      SpeechSynthesisUtterance: function (this: { text: string; voice: null }, text: string) {
        this.text = text;
        this.voice = null;
      },
    });
    runInContext(VOICE_SOURCE, ctx);
    const pick = (here: boolean) => (runInContext(`pickVoice(${here})`, ctx) as Voice | null)?.name ?? null;
    const say = (text: string, here: boolean) => runInContext(`_localSpeak(${JSON.stringify(text)},${here})`, ctx) as Promise<void>;
    return { pick, say, spoken };
  }
  const NETWORK: Voice = { name: 'Google UK English Male', lang: 'en-GB', localService: false };
  const DANIEL_NET: Voice = { name: 'Daniel (Enhanced, online)', lang: 'en-GB', localService: false };
  const SAMANTHA: Voice = { name: 'Samantha', lang: 'en-US', localService: true };
  const AARON: Voice = { name: 'Aaron', lang: 'en-US', localService: true };

  it('a reply that stays here never gets a network voice, even the one the page would otherwise prefer', () => {
    const b = browser([DANIEL_NET, NETWORK, SAMANTHA, AARON]);
    expect(b.pick(false)).toBe('Aaron'); // a preferred name, as before
    expect(b.pick(true)).toBe('Aaron');
    const netFirst = browser([DANIEL_NET, NETWORK, SAMANTHA]);
    expect(netFirst.pick(false)).toBe('Daniel (Enhanced, online)');
    expect(netFirst.pick(true)).toBe('Samantha');
  });

  it('with no voice of the device’s own, a reply that stays here is shown and not spoken; any other reply is spoken as before', async () => {
    const b = browser([NETWORK, DANIEL_NET]);
    expect(b.pick(true)).toBeNull();
    await b.say('A private sentence.', true);
    expect(b.spoken).toEqual([]);
    await b.say('An ordinary sentence.', false);
    expect(b.spoken).toEqual([{ text: 'An ordinary sentence.', voice: 'Daniel (Enhanced, online)' }]);
    // A browser that has not listed its voices yet: nothing of the device's own is known, so nothing is spoken.
    const none = browser([]);
    await none.say('A private sentence.', true);
    expect(none.spoken).toEqual([]);
    await none.say('An ordinary sentence.', false);
    expect(none.spoken).toEqual([{ text: 'An ordinary sentence.', voice: null }]);
  });

  it('with one, it is spoken by it', async () => {
    const b = browser([NETWORK, SAMANTHA]);
    await b.say('A private sentence.', true);
    expect(b.spoken).toEqual([{ text: 'A private sentence.', voice: 'Samantha' }]);
  });

  it('"male" and "man" are words of a voice’s name: "Female" and "Samantha" are neither', () => {
    const ctx = createContext({ String });
    runInContext(line(/^function _maleVoice\(name\)\{.*$/m), ctx);
    const is = (name: string) => runInContext(`_maleVoice(${JSON.stringify(name)})`, ctx) as boolean;
    for (const name of ['Google UK English Male', 'English (male)', 'male voice 2', 'Man', 'en-US-man-1']) expect(is(name), name).toBe(true);
    for (const name of ['Google UK English Female', 'Microsoft Zira Female', 'Samantha', 'Amanda', 'Roman', 'Germany', 'female', '']) expect(is(name), name).toBe(false);
    // The fallback rule that uses it: an English voice named as male before any other English voice.
    const b = browser([{ name: 'Google UK English Female', lang: 'en-GB', localService: true }, { name: 'English Male Two', lang: 'en-US', localService: true }]);
    expect(b.pick(true)).toBe('English Male Two');
    expect(b.pick(false)).toBe('English Male Two');
    const onlyFemale = browser([{ name: 'Google UK English Female', lang: 'en-GB', localService: true }]);
    expect(onlyFemale.pick(true)).toBe('Google UK English Female'); // the last rule: any English voice
  });
});

// `/speak` checks that the words a client sends are the named turn's own reply (../src/goals-chat speechStaysHere).
// The console does not send the reply as it came: it makes each sentence sayable first (`speakForVoice`). The server
// makes the reply sayable the same way before it compares, so the two must stay word for word the same.
describe('what the console sends to be spoken is still the reply’s own words to the server (../src/spoken-text)', () => {
  const start = html.indexOf('function speakForVoice(s){');
  const end = html.indexOf('\nfunction speakSynced(', start);
  const ctx = createContext({});
  runInContext(html.slice(start, end), ctx);
  const consoleSays = (text: string): string => {
    Object.assign(ctx, { __s: text });
    return runInContext('speakForVoice(__s)', ctx) as string;
  };
  const REPLIES = [
    'It is **97°F** (36°C) in Austin, RealFeel 104°, winds 5 mph, humidity 40%.',
    '# Heading\n\n> A quote with `code` and a [link](https://example.test/a_b).\n\n* one\n* two',
    'Plain words.   With   spaces\nand a line break.',
    '10 ° F and 3 °C; 50 MPH; realfeel 90°; 7 % done; _underscored_ words; no marks at all',
    '',
  ];

  it('the server makes a reply sayable exactly as the console does', () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    for (const reply of REPLIES) expect(forVoice(reply), reply).toBe(consoleSays(reply));
  });

  it('so a sentence the console sends is part of the reply it came from, and another reply’s sentence is not', () => {
    const reply = REPLIES[0]!;
    const sentences = ['It is **97°F** (36°C) in Austin,', ' RealFeel 104°, winds 5 mph,', ' humidity 40%.'];
    for (const sentence of sentences) expect(isPartOf(consoleSays(sentence), reply), sentence).toBe(true);
    expect(isPartOf(consoleSays(reply), reply)).toBe(true);
    expect(isPartOf(consoleSays('The synthetic appointment is on Tuesday.'), reply)).toBe(false);
    // The voice app sends the whole reply as it came.
    expect(isPartOf(reply.trim(), reply)).toBe(true);
    // Words in another order, a word missing from the middle, and no words at all are not it.
    expect(isPartOf('Austin in 97', reply)).toBe(false);
    expect(isPartOf('It is in Austin', reply)).toBe(false);
    expect(isPartOf(' ... ', reply)).toBe(false);
    expect(isPartOf('', '')).toBe(false);
  });
});
