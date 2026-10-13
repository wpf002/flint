/**
 * `/speak` behind the voice seam (../src/speech-route): which provider is
 * given which reply. The rule is the one the route has always had; what the
 * seam adds is that a provider on this Mac is given every reply, and a
 * provider that is somebody else's service is given none that stays here.
 *
 * The providers here are stand-ins that keep what they were asked to speak.
 * Nothing is spoken, no program runs and no network is used. One case runs the
 * real `speechStaysHere` over a real conversation store.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SPEECH_STAYS_HERE, speechStaysHere } from '../src/goals-chat';
import { GOALS_TURN } from '../src/goals-now';
import { PRIVATE_TURN } from '../src/private-turns';
import { SPEECH_BUSY, SPEECH_OFF, speak, speechMadeHere, type SpeakDeps } from '../src/speech-route';
import { SpendGuard, SpendLedger } from '../src/spend';
import { SpeechBusy, TTS_MAX_CHARS, macSayTts, offTts, type AudioType, type Run, type TtsProvider } from '../src/voice';
import { cleanup, storedTurn, tmpStore } from './goals-mini';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flint-speak-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  cleanup();
});

const NOON = Date.parse('2026-10-12T17:00:00.000Z');
const LOCAL_MODE = 'Flint is in Local mode, which never uses the cloud.';

/** A provider that keeps what it was asked to speak. */
function provider(over: Partial<TtsProvider> & Pick<TtsProvider, 'name' | 'local'>, type: AudioType = 'audio/mpeg') {
  const spoken: string[] = [];
  const tts: TtsProvider = {
    synthesize: async (text) => {
      spoken.push(text);
      return { audio: Buffer.from(`audio:${text}`), contentType: type };
    },
    ...over,
  };
  return { tts, spoken };
}
const openai = () => provider({ name: 'openai', local: false, vendor: 'openai', model: 'tts-1', voice: 'onyx' });
const say = () => provider({ name: 'say', local: true }, 'audio/mp4');
const localServer = () => provider({ name: 'local', local: true, model: 'kokoro', voice: 'af_heart' }, 'audio/wav');

/** The rest of what the route hands the rule, with every question it asks kept. */
function deps(tts: TtsProvider, o: { localMode?: boolean; stays?: boolean; caps?: ConstructorParameters<typeof SpendGuard>[1] } = {}) {
  const ledger = new SpendLedger({ dir: mkdtempSync(join(dir, 'l-')), timeZone: 'America/Chicago', now: () => NOON });
  const asked: string[] = [];
  const named: Array<{ conversationId?: unknown; turnId?: unknown; text?: unknown }> = [];
  const d: SpeakDeps = {
    tts,
    localMode: () => (asked.push('mode'), o.localMode ? LOCAL_MODE : undefined),
    mustStay: (said) => (asked.push('stays'), named.push(said), o.stays === true),
    mustStaySentence: SPEECH_STAYS_HERE,
    guard: new SpendGuard(ledger, o.caps ?? { anthropic: {}, openai: {}, perplexity: {}, tavily: {} }),
  };
  return { d, ledger, asked, named };
}
const REPLY = { text: 'It is sunny in Dallas.', conversationId: 'c1', turnId: 't1' };

describe('/speak: which provider is given which reply', () => {
  it('the whole rule, for every provider, in every mode, for a reply that stays here and one that does not', async () => {
    const cases: Array<{ make: () => ReturnType<typeof provider>; label: string; type?: AudioType }> = [
      { make: openai, label: 'openai' },
      { make: say, label: 'say', type: 'audio/mp4' },
      { make: localServer, label: 'local', type: 'audio/wav' },
    ];
    for (const c of cases) {
      for (const localMode of [false, true]) {
        for (const stays of [false, true]) {
          const { tts, spoken } = c.make();
          const { d } = deps(tts, { localMode, stays });
          const r = await speak({ ...REPLY }, d);
          const label = `${c.label} localMode=${localMode} stays=${stays}`;
          if (c.label === 'openai') {
            // An outside service: nothing in Local mode, and never a reply that stays here.
            if (localMode) expect(r, label).toEqual({ status: 503, body: { error: LOCAL_MODE, fallback: 'browser' } });
            else if (stays) expect(r, label).toEqual({ status: 409, body: { error: SPEECH_STAYS_HERE, fallback: 'browser' } });
            else expect(r, label).toEqual({ status: 200, audio: Buffer.from(`audio:${REPLY.text}`), contentType: 'audio/mpeg' });
            expect(spoken, label).toEqual(localMode || stays ? [] : [REPLY.text]);
          } else {
            // On this Mac: every reply, in every mode. The words go nowhere.
            expect(r, label).toEqual({ status: 200, audio: Buffer.from(`audio:${REPLY.text}`), contentType: c.type });
            expect(spoken, label).toEqual([REPLY.text]);
          }
        }
      }
    }
  });

  it('an outside service: Local mode is read first, then the reply is asked about by its conversation, its turn and its words, all before any speech is made', async () => {
    const { tts, spoken } = openai();
    const mode = deps(tts, { localMode: true, stays: true });
    await speak({ ...REPLY }, mode.d);
    expect(mode.asked).toEqual(['mode']); // refused there: the store is not asked
    const stays = deps(tts, { stays: true });
    expect((await speak({ text: `  ${REPLY.text}  `, conversationId: 'c1', turnId: 't1', private: false, anything: 'else' }, stays.d)).status).toBe(409);
    expect(stays.asked).toEqual(['mode', 'stays']);
    // The text goes with the names (a turn that may be spoken vouches only for its own words), as it will be sent.
    expect(stays.named).toEqual([{ conversationId: 'c1', turnId: 't1', text: REPLY.text }]);
    expect(spoken).toEqual([]);
    // A request that names nothing is asked about all the same: the answer is the store's, never the client's.
    const bare = deps(tts, { stays: true });
    expect((await speak({ text: 'Yeah?' }, bare.d)).status).toBe(409);
    expect(bare.named).toEqual([{ conversationId: undefined, turnId: undefined, text: 'Yeah?' }]);
    // ...and nothing a client can send switches the question off.
    for (const flag of [{ private: false }, { staysHere: false }, { here: true }, { speechHere: true }, { local: true }]) {
      const d = deps(tts, { stays: true });
      expect((await speak({ ...REPLY, ...flag }, d.d)).status, JSON.stringify(flag)).toBe(409);
    }
    expect(spoken).toEqual([]);
  });

  it('a provider on this Mac is asked neither question, and no client flag is needed for it to speak', async () => {
    for (const make of [say, localServer]) {
      const { tts, spoken } = make();
      const { d, asked, ledger } = deps(tts, { localMode: true, stays: true });
      expect((await speak({ text: 'A private reply.' }, d)).status).toBe(200);
      expect(asked).toEqual([]);
      expect(spoken).toEqual(['A private reply.']);
      // Nobody is billed for it.
      expect(ledger.totals('openai').day.calls).toBe(0);
    }
  });

  it('speech is off: the client is told to use its own voice, and nothing is asked or made', async () => {
    const off = deps(offTts());
    expect(await speak({ ...REPLY }, off.d)).toEqual({ status: 503, body: { error: SPEECH_OFF, fallback: 'browser' } });
    expect(off.asked).toEqual([]);
    // A provider that turns out unable to speak (it answers null) says the same.
    const mute = provider({ name: 'say', local: true, synthesize: async () => null });
    expect(await speak({ ...REPLY }, deps(mute.tts).d)).toEqual({ status: 503, body: { error: SPEECH_OFF, fallback: 'browser' } });
  });

  it('no text is a 400, before anything else', async () => {
    for (const body of [{}, { text: '' }, { text: '   ' }, { text: null }, { conversationId: 'c1', turnId: 't1' }]) {
      const { tts, spoken } = openai();
      const { d, asked } = deps(tts, { localMode: true, stays: true });
      expect(await speak(body as Record<string, unknown>, d), JSON.stringify(body)).toEqual({ status: 400, body: { error: 'text required' } });
      expect(asked).toEqual([]);
      expect(spoken).toEqual([]);
    }
  });

  it('what a provider throws is the route’s to answer: nothing is swallowed, and no words are in the error', async () => {
    const broken = provider({ name: 'local', local: true, synthesize: async () => Promise.reject(new Error('tts HTTP 500')) });
    await expect(speak({ ...REPLY }, deps(broken.tts).d)).rejects.toThrow('tts HTTP 500');
  });
});

describe('/speak: a billed provider speaks under its vendor’s budget, as before', () => {
  it('charges per character sent, to OpenAI, and hands the audio on', async () => {
    const { tts, spoken } = openai();
    const { d, ledger } = deps(tts);
    const long = 'x'.repeat(5000);
    const r = await speak({ text: long, conversationId: 'c1', turnId: 't1' }, d);
    expect(r.status).toBe(200);
    expect(spoken).toEqual([long]); // (the provider cuts what it sends at TTS_MAX_CHARS: test/voice.test.ts)
    // 4,000 characters at $15 per million.
    expect(TTS_MAX_CHARS).toBe(4000);
    expect(ledger.totals('openai').day).toMatchObject({ usd: 0.06, calls: 1 });
  });

  it('at the cap it is refused without a call; with no key the answer is the one it has always been', async () => {
    const { tts, spoken } = openai();
    const capped = deps(tts, { caps: { anthropic: {}, openai: { dailyUsd: 1 }, perplexity: {}, tavily: {} } });
    capped.ledger.record({ vendor: 'openai', model: 'tts-1', kind: 'tts', usd: 1 });
    expect(await speak({ ...REPLY }, capped.d)).toEqual({ status: 503, body: { error: "OpenAI budget reached: today's $1.00 cap is spent. Using the browser's voice.", budget: true, fallback: 'browser' } });
    expect(spoken).toEqual([]);
    const noKey = provider({ name: 'openai', local: false, vendor: 'openai', model: 'tts-1', synthesize: async () => null });
    const d = deps(noKey.tts);
    expect(await speak({ ...REPLY }, d.d)).toEqual({ status: 503, body: { error: 'no tts key' } });
    expect(d.ledger.totals('openai').day.calls).toBe(0);
  });
});

describe('/speak over a real conversation store: the rule main has, for each kind of provider', () => {
  it('a reply that stays here by either mark, and an ordinary one: an outside service gets only the last; a provider on this Mac speaks them all', async () => {
    const store = tmpStore();
    await storedTurn(store, { id: 'kept', context: PRIVATE_TURN, user: 'Keep this private: my code is 4417.', assistant: 'Noted, your code is 4417.', conversationId: 'p' });
    // (A private turn, and any turn taken in Local mode, carry the first mark; a turn answered with Will's goals the second.)
    await storedTurn(store, { id: 'goals', context: GOALS_TURN, user: 'How are my goals going?', assistant: 'The boat deck is on track.', conversationId: 'g' });
    await storedTurn(store, { id: 'open', user: 'What is the capital of France?', assistant: 'Paris.', conversationId: 'o' });
    const replies = [
      { conversationId: 'p', turnId: 'kept', text: 'Noted, your code is 4417.', stays: true },
      { conversationId: 'g', turnId: 'goals', text: 'The boat deck is on track.', stays: true },
      { conversationId: 'o', turnId: 'open', text: 'Paris.', stays: false },
      // The ordinary turn's name with another reply's words: the name vouches only for its own.
      { conversationId: 'o', turnId: 'open', text: 'Noted, your code is 4417.', stays: true },
    ];
    for (const make of [openai, say, localServer]) {
      const { tts, spoken } = make();
      const d: SpeakDeps = { ...deps(tts).d, mustStay: (said) => speechStaysHere(store, said) };
      for (const r of replies) {
        const out = await speak({ conversationId: r.conversationId, turnId: r.turnId, text: r.text }, d);
        if (tts.local) expect(out.status, `${tts.name} ${r.turnId}`).toBe(200);
        else expect(out, `${tts.name} ${r.turnId}`).toMatchObject(r.stays ? { status: 409, body: { error: SPEECH_STAYS_HERE, fallback: 'browser' } } : { status: 200 });
      }
      expect(spoken, tts.name).toEqual(tts.local ? replies.map((r) => r.text) : ['Paris.']);
    }
  });
});

// L2 and L9: this Mac's own voice is a program started for each reply.
describe("/speak when this Mac's own voice is busy, and when the client hangs up", () => {
  it('busy is a 429 with a sentence and the client’s own voice: not a 503, which a client reads as "stop asking for ten minutes"', async () => {
    const busy: TtsProvider = { name: 'say', local: true, synthesize: async () => Promise.reject(new SpeechBusy()) };
    const out = await speak(REPLY, deps(busy).d);
    expect(out).toEqual({ status: 429, body: { error: SPEECH_BUSY, fallback: 'browser' } });
    // A sentence a person can read, with no word of the reply in it.
    expect(SPEECH_BUSY).toMatch(/^this Mac is already speaking .*own voice$/);
    expect(SPEECH_BUSY).not.toContain('Dallas');
  });

  it('fifty replies at once through the real line: two are spoken at a time, forty wait, eight get the 429, and every one gets an answer', async () => {
    let running = 0;
    let most = 0;
    const run: Run = async (_file, args) => {
      running++;
      most = Math.max(most, running);
      await new Promise((r) => setTimeout(r, 4));
      writeFileSync(args[args.indexOf('-o') + 1]!, 'aac');
      running--;
      return { stdout: '' };
    };
    const d = deps(macSayTts({ run })).d;
    const all = await Promise.all(Array.from({ length: 50 }, (_, i) => speak({ text: `Sentence ${i}.` }, d)));
    expect(all.map((r) => r.status)).toEqual([...Array.from({ length: 42 }, () => 200), ...Array.from({ length: 8 }, () => 429)]);
    expect(most).toBe(2);
    // The line empties: the next reply is spoken.
    expect((await speak({ text: 'Again.' }, d)).status).toBe(200);
  });

  it('a provider on this Mac is handed the signal that fires when the client hangs up; a billed outside provider is not, as it never was', async () => {
    const gone = new AbortController();
    const got: Array<AbortSignal | undefined> = [];
    const here: TtsProvider = { name: 'say', local: true, synthesize: async (_t, o) => (got.push(o?.signal), { audio: Buffer.from('a'), contentType: 'audio/mp4' }) };
    await speak(REPLY, { ...deps(here).d, signal: gone.signal });
    expect(got).toEqual([gone.signal]);
    const seen: unknown[] = [];
    const out: TtsProvider = { name: 'openai', local: false, vendor: 'openai', model: 'tts-1', synthesize: async (_t, o) => (seen.push(o), { audio: Buffer.from('a'), contentType: 'audio/mpeg' }) };
    await speak(REPLY, { ...deps(out).d, signal: gone.signal });
    expect(seen).toEqual([undefined]);
    // With no signal, a provider is handed none.
    got.length = 0;
    await speak(REPLY, deps(here).d);
    expect(got).toEqual([undefined]);
  });

  it('a reply dropped because its client left is the provider’s own error, for the route: it is not turned into "busy"', async () => {
    const gone = new AbortController();
    gone.abort();
    const here = macSayTts({ run: async () => ({ stdout: '' }) });
    await expect(speak(REPLY, { ...deps(here).d, signal: gone.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('speechMadeHere: what the chat stream may tell a client', () => {
  it('true only for a provider that speaks on this Mac: never for an outside service, and never when speech is off', () => {
    expect(speechMadeHere({ name: 'say', local: true })).toBe(true);
    expect(speechMadeHere({ name: 'local', local: true })).toBe(true);
    expect(speechMadeHere({ name: 'openai', local: false })).toBe(false);
    expect(speechMadeHere(offTts())).toBe(false);
  });
});
