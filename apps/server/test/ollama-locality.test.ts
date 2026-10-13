/**
 * What an Ollama says runs on it (../src/ollama-locality): the server's record
 * behind ./policy brainIsLocal. It answers from what it last heard, asks only
 * what it is told to watch, and fails closed.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { OllamaLocality, placeSaid } from '../src/ollama-locality';

const HERE = 'http://127.0.0.1:11434';
const tags = (models: unknown) => new Response(JSON.stringify({ models }));

afterEach(() => vi.useRealTimers());

describe('OllamaLocality', () => {
  it('knows nothing until an Ollama has been heard from, and asks nothing on its own', () => {
    const fetchImpl = vi.fn();
    const l = new OllamaLocality({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(l.runsHere(HERE, 'qwen2.5:14b')).toBe(false);
    expect(l.runsHere(undefined, 'qwen2.5:14b')).toBe(false);
    expect(l.runsHere(HERE, '')).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('watch asks that Ollama for its models, and a model is local only when its row has no remote host', async () => {
    const urls: string[] = [];
    const l = new OllamaLocality({
      fetchImpl: (async (url: string) => {
        urls.push(url);
        return tags([{ name: 'qwen2.5:14b' }, { name: 'mine:latest', remote_host: 'https://ollama.com:443' }, { model: 'by-model-key:7b' }, { name: '' }, null, { name: 7 }]);
      }) as unknown as typeof fetch,
    });
    await l.watch(`${HERE}/`);
    expect(urls).toEqual([`${HERE}/api/tags`]);
    expect(l.runsHere(HERE, 'qwen2.5:14b')).toBe(true);
    expect(l.runsHere(`${HERE}/`, 'QWEN2.5:14b')).toBe(true);
    expect(l.runsHere(HERE, 'mine')).toBe(false);
    expect(l.runsHere(HERE, 'by-model-key:7b')).toBe(true);
    expect(l.runsHere(HERE, 'not-pulled')).toBe(false);
    expect(l.runsHere('http://localhost:11434', 'qwen2.5:14b')).toBe(false);
    l.clear();
    expect(l.runsHere(HERE, 'qwen2.5:14b')).toBe(false);
  });

  it('a row that says anything at all of a remote host or model is not local, whatever type the value is', async () => {
    const remotes: unknown[] = ['https://ollama.com', 1, 0, true, false, { url: 'https://ollama.com' }, [], ['x']];
    for (const value of remotes) {
      for (const key of ['remote_host', 'remote_model']) {
        const l = new OllamaLocality();
        l.learn(HERE, [{ name: 'm', [key]: value }, { name: 'plain' }]);
        expect(l.runsHere(HERE, 'm'), `${key}: ${JSON.stringify(value)}`).toBe(false);
        expect(l.runsHere(HERE, 'plain')).toBe(true);
      }
    }
    // Only a row that says nothing of one is local: the key absent, null, or an empty string.
    for (const value of [undefined, null, '']) {
      const l = new OllamaLocality();
      l.learn(HERE, [{ name: 'm', remote_host: value, remote_model: value }]);
      expect(l.runsHere(HERE, 'm'), JSON.stringify(value)).toBe(true);
    }
  });

  it('the other definite answer: a model its listing gives a remote host runs elsewhere; what is not known is neither', () => {
    let now = 1_000_000;
    const l = new OllamaLocality({ now: () => now });
    expect(l.runsElsewhere(HERE, 'mine')).toBe(false); // nothing heard yet
    expect(l.said(HERE)).toBeUndefined();
    l.learn(HERE, [{ name: 'qwen2.5:14b' }, { name: 'mine:latest', remote_host: 'https://ollama.com:443' }]);
    expect(l.said(`${HERE}/`)).toBe('ollama');
    expect(l.runsElsewhere(HERE, 'mine')).toBe(true);
    expect(l.runsElsewhere(HERE, 'MINE:latest')).toBe(true);
    expect(l.runsElsewhere(HERE, 'qwen2.5:14b')).toBe(false);
    // A model the listing does not hold: not here, and not known to be elsewhere either.
    expect(l.runsElsewhere(HERE, 'not-pulled')).toBe(false);
    expect(l.runsHere(HERE, 'not-pulled')).toBe(false);
    expect(l.runsElsewhere(undefined, 'mine')).toBe(false);
    expect(l.runsElsewhere(HERE, '')).toBe(false);
    // An old listing is believed for neither answer, nor for what the server is: another server can take an address.
    now += 5 * 60_000 + 1;
    expect(l.runsElsewhere(HERE, 'mine')).toBe(false);
    expect(l.runsHere(HERE, 'qwen2.5:14b')).toBe(false);
    expect(l.said(HERE)).toBeUndefined();
    l.learn(HERE, [{ name: 'qwen2.5:14b' }]);
    expect(l.said(HERE)).toBe('ollama');
    l.clear();
    expect(l.said(HERE)).toBeUndefined();
  });

  // The privacy review's N1: `…:11434` (Ollama's own API) and `…:11434/v1` (the same Ollama, asked the
  // OpenAI-compatible way) were two servers here, so what one said of a model was not known of the other.
  it('a server is known by its origin: what it lists holds at every path it is asked through, and at no other origin', () => {
    const l = new OllamaLocality();
    l.learn(HERE, [{ name: 'qwen2.5:14b' }, { name: 'mine', remote_host: 'https://ollama.com:443' }]);
    for (const url of [`${HERE}/v1`, `${HERE}/v1/`, 'HTTP://127.0.0.1:11434/v1', `${HERE}/some/prefix`]) {
      expect(l.said(url), url).toBe('ollama');
      expect(l.runsHere(url, 'qwen2.5:14b'), url).toBe(true);
      expect(l.runsElsewhere(url, 'mine'), url).toBe(true);
    }
    for (const url of ['http://localhost:11434/v1', 'http://127.0.0.1:11435/v1', 'https://127.0.0.1:11434/v1', 'not a url']) {
      expect(l.said(url), url).toBeUndefined();
      expect(l.runsHere(url, 'qwen2.5:14b'), url).toBe(false);
    }
    // Learned through the other path, it holds for Ollama's own API too.
    const other = new OllamaLocality();
    other.learn(`${HERE}/v1`, [{ name: 'mine', remote_host: 'https://ollama.com:443' }]);
    expect(other.runsElsewhere(HERE, 'mine')).toBe(true);
  });

  it('a server can say it is no Ollama: that is its own word, believed as long as a listing is, and it never unsays a listing still believed', () => {
    let now = 1_000_000;
    const l = new OllamaLocality({ now: () => now });
    const lm = 'http://127.0.0.1:1234';
    l.notOllama(`${lm}/v1`);
    expect(l.said(lm)).toBe('other');
    expect(l.runsHere(lm, 'any')).toBe(false); // it lists nothing: whoever asks decides what "other" means
    expect(l.runsElsewhere(lm, 'any')).toBe(false);
    now += 5 * 60_000 + 1;
    expect(l.said(lm)).toBeUndefined(); // too old: it has to say so again
    // An Ollama's listing is not replaced by a "no" from another path on the same origin while it is believed...
    l.learn(HERE, [{ name: 'mine', remote_host: 'https://ollama.com:443' }]);
    now += 60_000;
    l.notOllama(`${HERE}/v1`);
    expect(l.said(HERE)).toBe('ollama');
    expect(l.runsElsewhere(`${HERE}/v1`, 'mine')).toBe(true);
    // ...and once it is too old to believe, the newer word stands. A listing always replaces a "no".
    now += 5 * 60_000;
    l.notOllama(`${HERE}/v1`);
    expect(l.said(HERE)).toBe('other');
    l.learn(HERE, [{ name: 'qwen2.5:14b' }]);
    expect(l.said(HERE)).toBe('ollama');
    expect(l.runsHere(`${HERE}/v1`, 'qwen2.5:14b')).toBe(true);
  });

  it('asked for its listing, a server that answers with none is some other server; one that says nothing either way teaches nothing', async () => {
    const answer = async (r: () => Response | Promise<Response>): Promise<OllamaLocality> => {
      const l = new OllamaLocality({ fetchImpl: (async () => r()) as unknown as typeof fetch });
      await l.watch(HERE);
      return l;
    };
    // llama.cpp and vLLM answer 404 (or 405, 501); LM Studio answers 200 with something that is no listing.
    for (const r of [() => new Response('not found', { status: 404 }), () => new Response('', { status: 405 }), () => new Response('', { status: 501 }), () => new Response('not json'), () => new Response(JSON.stringify({ error: 'Unexpected endpoint' })), () => new Response(JSON.stringify({ models: 'qwen2.5:14b' })), () => new Response('null')]) {
      expect((await answer(r)).said(HERE)).toBe('other');
    }
    // An Ollama with nothing pulled is still an Ollama: nothing on it is known to run there.
    for (const r of [() => tags([]), () => tags(null)]) {
      const l = await answer(r);
      expect(l.said(HERE)).toBe('ollama');
      expect(l.runsHere(HERE, 'qwen2.5:14b')).toBe(false);
    }
    // Not let through, busy, broken, or down: nothing is learned (an Ollama whose listing failed is still an Ollama).
    for (const r of [() => new Response('', { status: 401 }), () => new Response('', { status: 403 }), () => new Response('', { status: 429 }), () => new Response('nope', { status: 500 }), () => new Response('', { status: 503 }), () => { throw new Error('ECONNREFUSED'); }]) {
      expect((await answer(r)).said(HERE)).toBeUndefined();
    }
  });

  it('the listing is asked at the address it was told, and a redirect is an error: another address’s word is not this one’s', async () => {
    const seen: Array<{ url: string; redirect: unknown }> = [];
    const l = new OllamaLocality({
      fetchImpl: (async (url: string, init: RequestInit) => {
        seen.push({ url, redirect: init.redirect });
        return tags([{ name: 'qwen2.5:14b' }]);
      }) as unknown as typeof fetch,
    });
    await l.watch('http://127.0.0.1:11434');
    expect(seen).toEqual([{ url: 'http://127.0.0.1:11434/api/tags', redirect: 'error' }]);
    l.clear();
  });

  it('an Ollama that is down or slow, or an answer that is no listing, makes no model local', async () => {
    for (const fetchImpl of [
      async () => { throw new Error('ECONNREFUSED'); },
      async () => new Response('nope', { status: 500 }),
      async () => new Response('not json'),
      async () => new Response(JSON.stringify({ models: 'qwen2.5:14b' })),
      async () => new Response(JSON.stringify({})),
    ]) {
      const l = new OllamaLocality({ fetchImpl: fetchImpl as unknown as typeof fetch });
      await expect(l.watch(HERE)).resolves.toBeUndefined();
      expect(l.runsHere(HERE, 'qwen2.5:14b')).toBe(false);
      l.clear();
    }
  });

  it('an Ollama that never answers is given up on: 2 s unless told otherwise', async () => {
    const deadline = vi.spyOn(AbortSignal, 'timeout');
    await new OllamaLocality({ fetchImpl: (async () => tags([])) as unknown as typeof fetch }).refresh(HERE);
    expect(deadline).toHaveBeenLastCalledWith(2_000);
    deadline.mockRestore();
    let signal: AbortSignal | undefined;
    const l = new OllamaLocality({
      timeoutMs: 40,
      fetchImpl: ((_url: string, init: RequestInit) => {
        signal = init.signal ?? undefined;
        return new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
      }) as unknown as typeof fetch,
    });
    const started = Date.now();
    await l.watch(HERE);
    expect(signal?.aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(l.runsHere(HERE, 'qwen2.5:14b')).toBe(false);
    l.clear();
  });

  it('what it heard is believed for five minutes: an Ollama that stops answering is then not known to run anything', async () => {
    let now = 1_000_000;
    let up = true;
    const l = new OllamaLocality({
      now: () => now,
      fetchImpl: (async () => {
        if (!up) throw new Error('down');
        return tags([{ name: 'qwen2.5:14b' }]);
      }) as unknown as typeof fetch,
    });
    await l.watch(HERE);
    expect(l.runsHere(HERE, 'qwen2.5:14b')).toBe(true);
    up = false;
    now += 4 * 60_000;
    await l.refresh(HERE);
    expect(l.runsHere(HERE, 'qwen2.5:14b')).toBe(true); // a failed ask leaves what was known
    now += 61_000;
    expect(l.runsHere(HERE, 'qwen2.5:14b')).toBe(false); // ...until it is too old to believe
    up = true;
    await l.refresh(HERE);
    expect(l.runsHere(HERE, 'qwen2.5:14b')).toBe(true);
    l.clear();
  });

  it('a watched Ollama is asked again every minute, so a model it stops running stops being local', async () => {
    vi.useFakeTimers();
    let rows: unknown[] = [{ name: 'qwen2.5:14b' }];
    let asked = 0;
    const l = new OllamaLocality({
      fetchImpl: (async () => {
        asked++;
        return tags(rows);
      }) as unknown as typeof fetch,
    });
    await l.watch(HERE);
    await l.watch(HERE); // already watched and known: not asked twice
    expect(asked).toBe(1);
    expect(l.runsHere(HERE, 'qwen2.5:14b')).toBe(true);
    rows = [{ name: 'qwen2.5:14b', remote_host: 'https://ollama.com' }];
    await vi.advanceTimersByTimeAsync(60_000);
    expect(asked).toBe(2);
    expect(l.runsHere(HERE, 'qwen2.5:14b')).toBe(false);
    l.clear();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(asked).toBe(2); // cleared: it asks no more
  });

  it('two asks of one Ollama at once are one request', async () => {
    let asked = 0;
    let release: (r: Response) => void = () => {};
    const l = new OllamaLocality({
      fetchImpl: (() => {
        asked++;
        return new Promise<Response>((resolve) => (release = resolve));
      }) as unknown as typeof fetch,
    });
    const a = l.refresh(HERE);
    const b = l.refresh(`${HERE}/`);
    release(tags([{ name: 'qwen2.5:14b' }]));
    await Promise.all([a, b]);
    expect(asked).toBe(1);
    expect(l.runsHere(HERE, 'qwen2.5:14b')).toBe(true);
  });
});

describe('placeSaid: one server\'s answer to the question an Ollama answers with a listing', () => {
  it('reads the status first, and the body only of an answer that could be a listing', async () => {
    const never = async (): Promise<unknown> => {
      throw new Error('the body of a refusal is not read');
    };
    expect(await placeSaid(200, async () => ({ models: [{ name: 'a' }] }))).toEqual({ ollama: [{ name: 'a' }] });
    expect(await placeSaid(200, async () => ({ models: [] }))).toEqual({ ollama: [] });
    expect(await placeSaid(200, async () => ({ models: null }))).toEqual({ ollama: [] });
    expect(await placeSaid(200, async () => ({ data: [] }))).toBe('other');
    expect(await placeSaid(200, async () => 'a string')).toBe('other');
    expect(await placeSaid(200, async () => null)).toBe('other');
    expect(await placeSaid(200, async () => { throw new SyntaxError('not json'); })).toBe('other');
    for (const status of [404, 405, 501]) expect(await placeSaid(status, never), String(status)).toBe('other');
    for (const status of [301, 302, 400, 401, 403, 408, 429, 500, 502, 503]) expect(await placeSaid(status, never), String(status)).toBeUndefined();
  });
});
