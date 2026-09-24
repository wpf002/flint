import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import {
  AnthropicProvider,
  OpenAiProvider,
  PerplexityProvider,
  decodeAssistantTurn,
  type ProviderAdapter,
  type TokenUsage,
} from '@flint/core';
import { costOf, estimateCost, type Vendor } from './pricing.js';
import type { EvalPrompt } from './prompts.js';

export interface AnswerResult {
  text: string;
  usage?: TokenUsage;
  costUsd: number;
  /** Contestant-specific extras (Flint: brain, model, tools used). */
  meta?: Record<string, unknown>;
}

export interface Contestant {
  /** Stable key: 'flint' | 'openai' | 'claude' | 'perplexity'. */
  name: string;
  /** What actually answered, for the report. */
  model: string;
  /** Pre-call spend estimate for the budget guard. */
  estimate(p: EvalPrompt): number;
  answer(p: EvalPrompt, signal: AbortSignal): Promise<AnswerResult>;
}

/**
 * The context Flint gets on every turn (apps/server userContext), given to the
 * competitors too. Without it a vendor model can't know the date or that Will is
 * in Dallas, and loses on "what's the weather" for a reason that has nothing to
 * do with how good it is.
 */
export function competitorSystem(now: Date, location = 'Dallas, Texas, USA', tz = 'America/Chicago'): string {
  const when = now.toLocaleString('en-US', {
    timeZone: tz,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
  return `You are a helpful assistant for Will. Right now it is ${when}. Will is located in ${location}.`;
}

/** A vendor model called directly through @flint/core's provider adapter. No tools. */
export function providerContestant(opts: {
  name: string;
  vendor: Vendor;
  model: string;
  provider: ProviderAdapter;
  maxTokens: number;
  system: string;
}): Contestant {
  const { name, vendor, model, provider, maxTokens, system } = opts;
  return {
    name,
    model,
    estimate: (p) => estimateCost(vendor, model, p.prompt.length + system.length),
    async answer(p, signal) {
      const res = await provider.generate({
        model,
        system,
        messages: [{ id: `eval-${p.id}`, role: 'user', content: p.prompt, timestamp: Date.now() }],
        maxTokens,
        signal,
      });
      const text = decodeAssistantTurn(res.message).text.trim();
      if (!text) throw new Error(`empty answer (reason=${res.reason})`);
      return { text, usage: res.usage, costUsd: costOf(vendor, model, res.usage), meta: { reason: res.reason } };
    },
  };
}

export function claudeContestant(apiKey: string, model: string, system: string, maxTokens: number): Contestant {
  return providerContestant({ name: 'claude', vendor: 'anthropic', model, provider: new AnthropicProvider({ apiKey }), maxTokens, system });
}

export function openaiContestant(apiKey: string, model: string, system: string, maxTokens: number): Contestant {
  return providerContestant({ name: 'openai', vendor: 'openai', model, provider: new OpenAiProvider({ apiKey }), maxTokens, system });
}

export function perplexityContestant(apiKey: string, model: string, system: string, maxTokens: number): Contestant {
  return providerContestant({
    name: 'perplexity',
    vendor: 'perplexity',
    model,
    provider: new PerplexityProvider({ apiKey }),
    maxTokens,
    system,
  });
}

/**
 * Flint's bearer token, from the first place that has it: $FLINT_TOKEN, then
 * ~/.flint/token, then the launchd plist the server runs from (what the Python
 * scripts in apps/train/mlx read). Never printed.
 */
export function resolveFlintToken(opts: { env: NodeJS.ProcessEnv; tokenFile: string; plist: string }): string | undefined {
  const fromEnv = opts.env.FLINT_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  if (existsSync(opts.tokenFile)) {
    const t = readFileSync(opts.tokenFile, 'utf8').trim();
    if (t) return t;
  }
  if (existsSync(opts.plist)) {
    try {
      const t = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :EnvironmentVariables:FLINT_TOKEN', opts.plist], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (t) return t;
    } catch {
      /* no such key */
    }
  }
  return undefined;
}

interface FlintGenerateResponse {
  text?: string;
  usage?: TokenUsage;
  reason?: string;
  brain?: 'local' | 'frontier';
  model?: string;
  tools?: Array<{ tool: string; outcome?: string }>;
  proposed?: string[];
  eval?: boolean;
  error?: string;
}

/**
 * Flint end to end: POST /generate on the running server, so the answer goes
 * through the real router, persona, memory recall and tools — what Will gets.
 * `eval: true` keeps the replay out of the training corpus and long-term memory
 * (see apps/server /generate). A server that doesn't echo `eval: true` predates
 * that flag and WOULD log the replay as training data, so it's refused unless
 * the caller explicitly allows it.
 */
export function flintContestant(opts: {
  url: string;
  token: string;
  /** Model the server's frontier brain runs on, for pricing (the server reports it when it can). */
  frontierModel: string;
  allowTrainingLog: boolean;
  timeoutMs: number;
  /**
   * Answer with the local brain only (the server's `localOnly`), no Claude: how
   * Flint does on his own. A separate contestant name, so its answers and
   * verdicts never mix with normal Flint's in the same run.
   */
  localOnly?: boolean;
  /**
   * Bake-offs: answer with this Ollama model instead of the server's own local
   * one (the server's eval-only `localModel`). Implies localOnly. The contestant
   * becomes `flint-local@<model>` so each candidate's answers and verdicts stay
   * separate, and a reply from any other model stops the run.
   */
  localModel?: string;
  /** How long to keep retrying while the server is unreachable (a deploy restart). */
  restartWaitMs?: number;
}): Contestant {
  const localModel = opts.localModel;
  if (localModel !== undefined) assertLocalModelName(localModel);
  const localOnly = opts.localOnly === true || localModel !== undefined;
  return {
    name: flintContestantName({ localOnly, localModel }),
    model: `flint@${opts.url}`,
    // Flint's prompt carries the persona and a dozen tool schemas, and tool loops
    // re-send it: estimate generously. The local brain costs nothing.
    estimate: (p) =>
      localOnly ? 0 : estimateCost('anthropic', opts.frontierModel, p.prompt.length, { overheadTokens: 12_000, expectedOutputTokens: 1500 }),
    async answer(p, signal) {
      const r = await fetchWhileRestarting(
        () =>
          fetch(`${opts.url.replace(/\/$/, '')}/generate`, {
            method: 'POST',
            headers: { authorization: `Bearer ${opts.token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ prompt: p.prompt, eval: true, ...(localOnly ? { localOnly: true } : {}), ...(localModel ? { localModel } : {}) }),
            signal: AbortSignal.any([signal, AbortSignal.timeout(opts.timeoutMs)]),
          }),
        signal,
        opts.restartWaitMs ?? 120_000,
      );
      const body = (await r.json().catch(() => ({}))) as FlintGenerateResponse;
      if (!r.ok) throw new Error(`flint HTTP ${r.status}: ${body.error ?? 'no body'}`);
      if (body.eval !== true && !opts.allowTrainingLog) {
        throw new FatalError(
          'the Flint server ignored eval:true (it predates eval mode), so this replay was just logged to the training corpus. ' +
            'Deploy the server from this branch, or pass --allow-training-log to accept that.',
        );
      }
      if (localOnly && body.brain !== 'local') throw new FatalError(`asked for localOnly but brain=${body.brain ?? '?'} answered`);
      if (localModel !== undefined && body.model !== localModel) {
        throw new FatalError(
          `asked for localModel ${localModel} but the server answered with ${body.model ?? '?'} — it predates the local-model override, or ignored it`,
        );
      }
      const text = (body.text ?? '').trim();
      if (!text) throw new Error(`flint returned an empty answer (reason=${body.reason ?? '?'}, brain=${body.brain ?? '?'})`);
      const usage = body.usage;
      const model = body.model ?? opts.frontierModel;
      const costUsd = usage && body.brain !== 'local' ? costOf('anthropic', model, usage) : 0;
      return {
        text,
        ...(usage ? { usage } : {}),
        costUsd,
        meta: { brain: body.brain, model, tools: body.tools ?? [], proposed: body.proposed ?? [], reason: body.reason },
      };
    },
  };
}

/**
 * Auto-deploy restarts Flint on every commit to main. A restart takes ~10s, and
 * with no retry a run fired its whole prompt list into that window: 299 prompts
 * failed as "fetch failed" in 80ms. A request the server never received (no HTTP
 * response at all) is retried with backoff until `waitMs` runs out; an HTTP error
 * or a timeout on a request that did connect is returned/thrown as before.
 */
export async function fetchWhileRestarting(
  attempt: () => Promise<Response>,
  signal: AbortSignal,
  waitMs: number,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<Response> {
  let waited = 0;
  let delay = 1000;
  for (;;) {
    try {
      return await attempt();
    } catch (err) {
      const unreachable = err instanceof TypeError && /fetch failed/i.test(err.message);
      if (!unreachable || signal.aborted || waited >= waitMs) throw err;
      await sleep(delay);
      waited += delay;
      delay = Math.min(delay * 2, 15_000);
    }
  }
}

/** Same rule as the server's apps/server/src/local-model.ts. */
export const LOCAL_MODEL_RE = /^[a-z0-9._:\-/]+$/i;

export function assertLocalModelName(name: string): void {
  if (!name || name.length > 100 || !LOCAL_MODEL_RE.test(name)) {
    throw new Error(`--local-model: "${name}" isn't an Ollama model name (letters, digits, . _ : - /, at most 100 chars)`);
  }
}

/** 'flint', 'flint-local', or 'flint-local@<model>' for a bake-off candidate. */
export function flintContestantName(opts: { localOnly?: boolean; localModel?: string | undefined }): string {
  if (opts.localModel) return `flint-local@${opts.localModel}`;
  return opts.localOnly ? 'flint-local' : 'flint';
}

/**
 * Is `model` pulled on the Ollama at `host`? (`GET /api/tags`). A bare name
 * matches its `:latest` tag, as `ollama run` does. Throws if Ollama can't be reached.
 */
export async function ollamaHasModel(model: string, host: string, fetchFn: typeof fetch = fetch): Promise<{ ok: boolean; available: string[] }> {
  const r = await fetchFn(`${host.replace(/\/$/, '')}/api/tags`, { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`Ollama at ${host} answered /api/tags with HTTP ${r.status}`);
  const body = (await r.json()) as { models?: Array<{ name?: string; model?: string }> };
  const available = (body.models ?? []).map((m) => m.name ?? m.model ?? '').filter(Boolean);
  const want = model.includes(':') ? [model] : [model, `${model}:latest`];
  return { ok: available.some((a) => want.includes(a)), available };
}

/** An error that should stop the whole run, not just fail one prompt. */
export class FatalError extends Error {}

export async function flintHealth(url: string): Promise<Record<string, unknown> | undefined> {
  try {
    const r = await fetch(`${url.replace(/\/$/, '')}/health`, { signal: AbortSignal.timeout(5000) });
    return r.ok ? ((await r.json()) as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
