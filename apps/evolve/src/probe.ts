/**
 * Can this model actually answer? A vendor's model list is not the answer.
 *
 * OpenAI still lists `gpt-5.2-codex` in /v1/models long after deprecating it;
 * the refusal only appears when you call it. So the "is it served" screen let a
 * dead model through, Flint was reconfigured onto it, and a full measurement was
 * paid for before the fallback made the result meaningless — $0.41 to learn the
 * model was gone.
 *
 * This asks for one token instead. Cheaper than a rounding error, and it is the
 * only check that reflects what happens at call time.
 */

export interface ProbeResult {
  ok: boolean;
  detail: string;
}

const TIMEOUT_MS = 45_000;

async function post(url: string, headers: Record<string, string>, body: unknown): Promise<{ status: number; text: string }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return { status: res.status, text: (await res.text()).slice(0, 300) };
}

/**
 * A minimal generation against the real endpoint Flint would use.
 *
 * Reasoning models spend their budget thinking before emitting anything, so the
 * cap is high enough that a healthy model is not mistaken for a broken one. An
 * empty completion still counts as alive: the call was accepted, which is what
 * is being tested.
 */
export async function probe(opts: {
  provider: string;
  model: string;
  env: NodeJS.ProcessEnv;
}): Promise<ProbeResult> {
  const { provider, model, env } = opts;
  try {
    if (provider === 'openai') {
      const key = env.OPENAI_API_KEY?.trim();
      if (!key) return { ok: false, detail: 'no OPENAI_API_KEY' };
      const r = await post(
        'https://api.openai.com/v1/chat/completions',
        { authorization: `Bearer ${key}` },
        { model, messages: [{ role: 'user', content: 'hi' }], max_completion_tokens: 1200 },
      );
      return r.status === 200 ? { ok: true, detail: 'answered' } : { ok: false, detail: `HTTP ${r.status}: ${r.text}` };
    }
    if (provider === 'anthropic') {
      const key = env.ANTHROPIC_API_KEY?.trim();
      if (!key) return { ok: false, detail: 'no ANTHROPIC_API_KEY' };
      const r = await post(
        'https://api.anthropic.com/v1/messages',
        { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        { model, max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] },
      );
      return r.status === 200 ? { ok: true, detail: 'answered' } : { ok: false, detail: `HTTP ${r.status}: ${r.text}` };
    }
    if (provider === 'google') {
      const key = env.GEMINI_API_KEY?.trim();
      if (!key) return { ok: false, detail: 'no GEMINI_API_KEY' };
      const r = await post(
        'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
        { authorization: `Bearer ${key}` },
        { model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1200 },
      );
      return r.status === 200 ? { ok: true, detail: 'answered' } : { ok: false, detail: `HTTP ${r.status}: ${r.text}` };
    }
    if (provider === 'ollama') {
      const host = env.OLLAMA_HOST?.trim() || 'http://127.0.0.1:11434';
      const r = await post(`${host.replace(/\/$/, '')}/api/chat`, {}, {
        model,
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
        options: { num_predict: 1 },
      });
      return r.status === 200 ? { ok: true, detail: 'answered' } : { ok: false, detail: `HTTP ${r.status}: ${r.text}` };
    }
    // An unknown provider is not something to gamble a config swap on.
    return { ok: false, detail: `no probe for provider ${provider}` };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}
