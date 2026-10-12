/**
 * What an Ollama says runs on it (../src/ollama-locality): the server's record
 * behind ./policy brainIsLocal. It answers from what it last heard, asks only
 * what it is told to watch, and fails closed.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { OllamaLocality } from '../src/ollama-locality';

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

  it('an Ollama that is down, slow, or answers with something else teaches nothing', async () => {
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
