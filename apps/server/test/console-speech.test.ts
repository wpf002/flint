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
    // (The tag under the reply also says when the standby local model answered: `ev.standby`.)
    expect(html).toContain("if(ev.type==='meta'){if(ev.brain)setBrainChip(body,ev.brain,ev.standby);voiceMeta(vctx,ev);}");
    expect(html).toContain('var blobP=_speechBlob(clean,vctx);');
    // Nothing else in the page sets the voice state: not Local Only, not the route the brain's own event carries.
    expect(html).not.toContain('vctx.priv');
    expect(html.match(/vctx\.here=[^=]/g)).toHaveLength(1); // voiceMeta's own assignment
    // The browser's own voice is told whether the reply stays here.
    expect(html).toContain('}else{reveal();_localSpeak(clean,vctx.here===true).then(res);}');
    // /speak is asked from one place.
    expect(html.match(/\/speak'/g)).toHaveLength(1);
    expect(html.match(/_neuralFetch\(/g)).toHaveLength(2); // its definition, and _speechBlob's call
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
