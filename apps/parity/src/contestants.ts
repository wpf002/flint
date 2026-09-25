import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import {
  AnthropicProvider,
  OpenAiProvider,
  PerplexityProvider,
  decodeAssistantTurn,
  parseBrainLabel,
  type ProviderAdapter,
  type TokenUsage,
} from '@flint/core';
import { parseGrounding, type FlintGrounding } from './grounding.js';
import { costOf, estimateCost, type Vendor } from './pricing.js';
import type { EvalPrompt } from './prompts.js';

export interface AnswerResult {
  text: string;
  usage?: TokenUsage;
  costUsd: number;
  /** Contestant-specific extras (Flint: brain, model, tools used). */
  meta?: Record<string, unknown>;
  /** Flint only: the memory and tool results the answer was grounded on (the eval response's `grounding`). */
  grounding?: FlintGrounding;
}

/**
 * What a contestant is asked: parity's EvalPrompt and a Flint-tasks prompt both
 * fit. `system` (Flint tasks) replaces a vendor contestant's own system prompt for
 * this one call: a competitor is told the time Flint answered, not the time it is asked.
 */
export type AskPrompt = Pick<EvalPrompt, 'id' | 'prompt'> & { system?: string };

export interface Contestant {
  /** Stable key: 'flint' | 'openai' | 'claude' | 'perplexity' | 'google' | 'amazon' | a --openai-compatible name. */
  name: string;
  /** What actually answered, for the report. */
  model: string;
  /** Pre-call spend estimate for the budget guard. */
  estimate(p: AskPrompt): number;
  answer(p: AskPrompt, signal: AbortSignal): Promise<AnswerResult>;
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
    estimate: (p) => estimateCost(vendor, model, p.prompt.length + (p.system ?? system).length),
    async answer(p, signal) {
      const res = await provider.generate({
        model,
        system: p.system ?? system,
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

/**
 * Claude models whose thinking can't be turned off (Fable, Mythos, Opus 5.5):
 * the thinking counts against max_tokens, so a short cap can end the reply
 * before any text, which would read as a failure rather than an answer.
 */
export function claudeAlwaysThinks(model: string): boolean {
  return /^claude-(fable|mythos)-|^claude-opus-5-5/.test(model);
}

/** The output cap an always-thinking Claude model gets at least (as Gemini's, compat.ts). */
export const THINKING_MIN_MAX_TOKENS = 16_384;

export function claudeContestant(apiKey: string, model: string, system: string, maxTokens: number, name = 'claude'): Contestant {
  const cap = claudeAlwaysThinks(model) ? Math.max(maxTokens, THINKING_MIN_MAX_TOKENS) : maxTokens;
  return providerContestant({ name, vendor: 'anthropic', model, provider: new AnthropicProvider({ apiKey }), maxTokens: cap, system });
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
  /** Set when no model answered and `text` is the server's honest fallback message instead. */
  unanswered?: 'refusal' | 'empty';
  brain?: 'local' | 'frontier';
  model?: string;
  /** Echo of the request's `localThink`, from a server that honoured it. */
  localThink?: boolean;
  /** Echo of the request's `groundingChars` (Flint tasks), from a server that honoured it. */
  groundingChars?: number;
  /** Echo of the request's `recall` (Flint tasks), from a server that honoured it. */
  recall?: boolean;
  /** The style variant the answering persona used, from a server with style variants. */
  styleVariant?: string;
  /** What the turn was grounded on (recalled memory, tool results), from a server that reports it. */
  grounding?: unknown;
  tools?: Array<{ tool: string; outcome?: string }>;
  proposed?: string[];
  eval?: boolean;
  error?: string;
  /**
   * What the replay's paid calls cost, as the server's spend ledger priced them:
   * every model pass and fallback attempt, the research planner, paid searches.
   * Sent with every eval response (errors and unanswered ones too) by a server
   * with eval spend scopes; absent from older ones.
   */
  costUsd?: number;
  /** Paid tools the server refused for budget during the replay (Flint's own cap for them is spent). */
  budgetBlocked?: string[];
}

/** Attach what a failed call still cost, so the budget guard charges it (steps.ts answerOne). */
export function withCost<E extends Error>(err: E, costUsd: number): E & { costUsd: number } {
  return Object.assign(err, { costUsd });
}

/** The cost a failed call carries (withCost), if any. */
export function costOfFailure(err: unknown): number | undefined {
  const c = (err as { costUsd?: unknown } | null | undefined)?.costUsd;
  return typeof c === 'number' && Number.isFinite(c) && c >= 0 ? c : undefined;
}

/**
 * What one Flint replay cost. The server's own `costUsd` when it sends one (it
 * covers every paid call of the turn, fallback attempts and searches too).
 * Otherwise, from an older server, the answer's usage priced at the answering
 * model's list price: `model` is a brain label (`anthropic:claude-opus-5-5`),
 * split before pricing, since the whole label matches no row and would be
 * priced at the unlisted rate (cache reads at $10/M instead of $0.20/M).
 */
export function flintReplayCost(body: Pick<FlintGenerateResponse, 'costUsd' | 'usage' | 'brain' | 'model'>, fallbackModel: string): number {
  if (typeof body.costUsd === 'number' && Number.isFinite(body.costUsd) && body.costUsd >= 0) return body.costUsd;
  if (!body.usage || body.brain === 'local') return 0;
  const { provider, vendor, model } = parseBrainLabel(body.model ?? fallbackModel);
  if (provider && !vendor) return 0; // a frontier tier on Ollama: free
  return costOf(vendor ?? 'anthropic', model, body.usage);
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
  /**
   * Bake-offs: Ollama's `think` for the candidate (the server's eval-only
   * `localThink`; `--local-think on|off`). Only with `localModel`. Adds `~think`
   * or `~nothink` to the contestant name; left out, the name and the request are
   * exactly as before, so answers cached without it stay valid and separate.
   */
  localThink?: boolean;
  /**
   * A/B tests: the persona style variant to answer with (the server's eval-only
   * `styleVariant`; `--flint-variant <v>`). Adds `#<v>` to the contestant name;
   * left out, the name and the request are exactly as before. A reply that
   * doesn't echo the same variant stops the run.
   */
  styleVariant?: string;
  /**
   * `--judge-grounding`: every answer must carry `grounding`, since a grounded
   * judge can't judge one without it. A server that doesn't send it stops the run.
   */
  requireGrounding?: boolean;
  /**
   * Flint tasks: ask for tool excerpts this long in `grounding` (the server's
   * eval-only `groundingChars`), since competitors are handed that grounding as
   * their data. A reply that doesn't echo it stops the run. Left out, the
   * request is exactly as before (800-character excerpts).
   */
  groundingChars?: number;
  /**
   * Flint tasks: the prompts to answer WITHOUT long-term memory (the server's
   * eval-only `recall: false`): every task whose point isn't memory, since the
   * competitors are handed Flint's data and that data leaves Will's memory out.
   * A reply that doesn't echo `recall: false`, or still carries recalled memory,
   * stops the run. Left out, the request is exactly as before.
   */
  withholdMemory?: (p: AskPrompt) => boolean;
  /** How long to keep retrying while the server is unreachable (a deploy restart). */
  restartWaitMs?: number;
}): Contestant {
  const localModel = opts.localModel;
  if (localModel !== undefined) assertLocalModelName(localModel);
  const localThink = opts.localThink;
  if (localThink !== undefined && localModel === undefined) throw new Error('--local-think needs --local-model');
  const styleVariant = opts.styleVariant;
  if (styleVariant !== undefined) assertStyleVariantName(styleVariant);
  const localOnly = opts.localOnly === true || localModel !== undefined;
  // Flint's prompt carries the persona and a dozen tool schemas, and tool loops
  // re-send it: estimate generously. The local brain costs nothing.
  const estimate = (p: AskPrompt): number =>
    localOnly ? 0 : estimateCost('anthropic', opts.frontierModel, p.prompt.length, { overheadTokens: 12_000, expectedOutputTokens: 1500 });
  return {
    name: flintContestantName({ localOnly, localModel, localThink, styleVariant }),
    model: `flint@${opts.url}`,
    estimate,
    async answer(p, signal) {
      const noRecall = opts.withholdMemory?.(p) === true;
      const r = await fetchWhileRestarting(
        () =>
          fetch(`${opts.url.replace(/\/$/, '')}/generate`, {
            method: 'POST',
            headers: { authorization: `Bearer ${opts.token}`, 'content-type': 'application/json' },
            body: JSON.stringify({
              prompt: p.prompt,
              eval: true,
              ...(localOnly ? { localOnly: true } : {}),
              ...(localModel ? { localModel } : {}),
              ...(localThink !== undefined ? { localThink } : {}),
              ...(styleVariant !== undefined ? { styleVariant } : {}),
              ...(opts.groundingChars !== undefined ? { groundingChars: opts.groundingChars } : {}),
              ...(noRecall ? { recall: false } : {}),
            }),
            signal: AbortSignal.any([signal, AbortSignal.timeout(opts.timeoutMs)]),
          }),
        signal,
        opts.restartWaitMs ?? 120_000,
      );
      const body = (await r.json().catch(() => ({}))) as FlintGenerateResponse;
      // A 400 is the server refusing the request's shape (an eval-only field it
      // doesn't accept, e.g. an unknown styleVariant), so every prompt would fail
      // the same way. Stop, rather than record hundreds of "Flint failures" that
      // the strict tally would count as losses.
      if (r.status === 400) throw new FatalError(`flint rejected the request (HTTP 400: ${body.error ?? 'no body'})`);
      // What this replay cost, answered or not: every failure below still charges it.
      // A 5xx from a server that doesn't report cost may have spent: charge the estimate.
      const spent = typeof body.costUsd !== 'number' && r.status >= 500 ? estimate(p) : flintReplayCost(body, opts.frontierModel);
      const fail = (err: Error) => withCost(err, spent);
      if (!r.ok) throw fail(new Error(`flint HTTP ${r.status}: ${body.error ?? 'no body'}`));
      if (body.eval !== true && !opts.allowTrainingLog) {
        throw fail(
          new FatalError(
            'the Flint server ignored eval:true (it predates eval mode), so this replay was just logged to the training corpus. ' +
              'Deploy the server from this branch, or pass --allow-training-log to accept that.',
          ),
        );
      }
      if (localOnly && body.brain !== 'local') throw fail(new FatalError(`asked for localOnly but brain=${body.brain ?? '?'} answered`));
      if (localModel !== undefined && body.model !== localModel) {
        throw fail(
          new FatalError(
            `asked for localModel ${localModel} but the server answered with ${body.model ?? '?'} — it predates the local-model override, or ignored it`,
          ),
        );
      }
      if (localThink !== undefined && body.localThink !== localThink) {
        throw fail(
          new FatalError(
            `asked for localThink ${String(localThink)} but the server didn't echo it (got ${String(body.localThink)}) — it predates the think override, or ignored it`,
          ),
        );
      }
      // The server's "no model answered" message is not an answer. A failure, as the
      // empty reply it replaced was: not judged, not a loss, retried on resume.
      if (body.unanswered) {
        throw fail(
          new Error(
            `flint did not answer (unanswered=${body.unanswered}, reason=${body.reason ?? '?'}, model=${body.model ?? '?'}): it sent its fallback message, which is not judged`,
          ),
        );
      }
      // A paid search refused because Flint's own cap for it is spent: the answer was
      // made without the search, so judging it would score a crippled Flint. A failure
      // like `unanswered`: not judged, retried on resume (after the cap resets).
      if (body.budgetBlocked && body.budgetBlocked.length > 0) {
        throw fail(
          new Error(
            `flint answered without ${body.budgetBlocked.join(', ')} (refused: Flint's own spend cap for it is spent), so the answer is not judged`,
          ),
        );
      }
      if (styleVariant !== undefined && body.styleVariant !== styleVariant) {
        throw fail(
          new FatalError(
            `asked for styleVariant ${styleVariant} but the server answered with ${body.styleVariant ?? '(no styleVariant echoed)'} — it predates style variants, or ignored it`,
          ),
        );
      }
      if (opts.groundingChars !== undefined && body.groundingChars !== opts.groundingChars) {
        throw fail(
          new FatalError(
            `asked for groundingChars ${opts.groundingChars} but the server echoed ${String(body.groundingChars)} — it predates longer eval excerpts, or ignored them`,
          ),
        );
      }
      const grounding = parseGrounding(body.grounding, opts.groundingChars);
      if (opts.requireGrounding && !grounding) {
        throw fail(
          new FatalError(
            '--judge-grounding: the Flint server sent no `grounding` with its eval answer (it predates it), so the grounded judge would have nothing to show. Deploy the server with eval grounding first.',
          ),
        );
      }
      // Flint must not have read memory the competitors won't get: the head-to-head
      // (and the judges' "both had the same data") would be false.
      if (noRecall && (body.recall !== false || (grounding?.memory.length ?? 0) > 0)) {
        throw fail(
          new FatalError(
            `asked for recall: false but the server ${body.recall !== false ? `didn't echo it (got ${String(body.recall)})` : `still recalled ${grounding!.memory.length} memory fact(s)`} — it predates the recall override, or ignored it`,
          ),
        );
      }
      const text = (body.text ?? '').trim();
      if (!text) throw fail(new Error(`flint returned an empty answer (reason=${body.reason ?? '?'}, brain=${body.brain ?? '?'})`));
      const usage = body.usage;
      const model = body.model ?? opts.frontierModel;
      return {
        text,
        ...(usage ? { usage } : {}),
        costUsd: spent,
        meta: {
          brain: body.brain,
          model,
          tools: body.tools ?? [],
          proposed: body.proposed ?? [],
          reason: body.reason,
          ...(body.styleVariant !== undefined ? { styleVariant: body.styleVariant } : {}),
          ...(opts.groundingChars !== undefined ? { groundingChars: opts.groundingChars } : {}),
          ...(noRecall ? { recall: false } : {}),
        },
        ...(grounding ? { grounding } : {}),
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

/**
 * 'flint', 'flint-local', or 'flint-local@<model>' for a bake-off candidate, with
 * '~think' / '~nothink' appended only when `localThink` is set, then '#<variant>'
 * only when `styleVariant` is set. Without them the name is unchanged, so earlier
 * runs' answers and verdicts still match. (`~` and `#` can't occur in a model
 * name, and `#` can't occur in a variant, so the suffixes are unambiguous.)
 */
export function flintContestantName(opts: {
  localOnly?: boolean;
  localModel?: string | undefined;
  localThink?: boolean | undefined;
  styleVariant?: string | undefined;
}): string {
  const variant = opts.styleVariant === undefined ? '' : `#${opts.styleVariant}`;
  if (opts.localModel) {
    const think = opts.localThink === undefined ? '' : opts.localThink ? '~think' : '~nothink';
    return `flint-local@${opts.localModel}${think}${variant}`;
  }
  return `${opts.localOnly ? 'flint-local' : 'flint'}${variant}`;
}

/** Style variant names: `v1`, `v2`, `local-v1`. Letters, digits, `.`, `_`, `-`; nothing that could collide with a name suffix. */
export const STYLE_VARIANT_RE = /^[a-z0-9][a-z0-9._-]*$/i;
export const STYLE_VARIANT_MAX_LEN = 40;

export function assertStyleVariantName(v: string): void {
  if (!v || v.length > STYLE_VARIANT_MAX_LEN || !STYLE_VARIANT_RE.test(v)) {
    throw new Error(`--flint-variant: "${v}" isn't a style variant name (letters, digits, . _ -, at most ${STYLE_VARIANT_MAX_LEN} chars, e.g. v2 or local-v1)`);
  }
}

/** The `--flint-variant` flag: trimmed and checked; absent → undefined. */
export function flintVariantFlag(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  const s = v.trim();
  assertStyleVariantName(s);
  return s;
}

/**
 * Before sending anything with `--flint-variant`: the server's /health must list
 * the variant in `styleVariants`. A server without the field predates style
 * variants and would ignore (or 400) the request.
 */
export function assertStyleVariantSupported(health: Record<string, unknown>, variant: string, url: string): void {
  const known = health.styleVariants;
  if (!Array.isArray(known)) {
    throw new Error(
      `--flint-variant ${variant}: the Flint server at ${url} doesn't support style variants (/health has no styleVariants). ` +
        'Deploy the server with style variants first (FLINT_STYLE_VARIANT / styleVariant on /generate).',
    );
  }
  const names = known.filter((k): k is string => typeof k === 'string');
  if (!names.includes(variant)) {
    throw new Error(`--flint-variant ${variant}: the Flint server at ${url} doesn't know that variant (it has: ${names.join(', ') || 'none'})`);
  }
}

/** `--local-think on|off` → true / false; absent → undefined. Anything else throws. */
export function parseLocalThink(v: string | undefined): boolean | undefined {
  if (v === undefined) return undefined;
  const s = v.trim().toLowerCase();
  if (s === 'on') return true;
  if (s === 'off') return false;
  throw new Error(`--local-think must be on or off, not "${v}"`);
}

/** The `--local-think` flag as `localThink`, refused without `--local-model` (it has nothing to apply to). */
export function localThinkFlag(v: string | undefined, localModel: string | undefined): boolean | undefined {
  const think = parseLocalThink(v);
  if (think !== undefined && !localModel) throw new Error('--local-think needs --local-model (it sets think for that candidate only)');
  return think;
}

/**
 * What Ollama says `model` can do (`POST /api/show` → `capabilities`, e.g.
 * ["completion","tools","thinking"]). Undefined when this Ollama doesn't report
 * capabilities. Throws if Ollama can't be reached or doesn't know the model.
 */
export async function ollamaModelCapabilities(model: string, host: string, fetchFn: typeof fetch = fetch): Promise<string[] | undefined> {
  const r = await fetchFn(`${host.replace(/\/$/, '')}/api/show`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model }),
    signal: AbortSignal.timeout(5000),
  });
  if (!r.ok) throw new Error(`Ollama at ${host} answered /api/show for ${model} with HTTP ${r.status}`);
  const body = (await r.json()) as { capabilities?: unknown };
  return Array.isArray(body.capabilities) ? body.capabilities.filter((c): c is string => typeof c === 'string') : undefined;
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

/**
 * What `run` checks on the Flint server before sending it a prompt: /health
 * answers, the server has eval mode (without it every replay is logged to the
 * training corpus) unless `allowTrainingLog`, and it supports every eval-only
 * override asked for (`--local-model`, `--local-think`, `--flint-variant`).
 * Returns /health's body. `--judge-only` checks nothing and calls nothing: it
 * never asks Flint anything, so the server needn't be up.
 */
export async function preflightFlint(opts: {
  url: string;
  judgeOnly: boolean;
  allowTrainingLog: boolean;
  localModel?: string | undefined;
  localThink?: boolean | undefined;
  styleVariant?: string | undefined;
  /** Flint tasks: the tool-excerpt length the run will ask for (`groundingChars`). */
  groundingChars?: number | undefined;
  /** Flint tasks' builder: the server must have GET /eval/tools and POST /eval/tool. */
  discovery?: boolean | undefined;
  /** Flint tasks: the run will send `recall: false`, so the server must honour it. */
  recallOverride?: boolean | undefined;
  fetchFn?: typeof fetch;
}): Promise<Record<string, unknown>> {
  const { url } = opts;
  if (opts.judgeOnly) return {};
  const health = await flintHealth(url, opts.fetchFn);
  if (!health) throw new Error(`Flint isn't answering at ${url}/health`);
  if (health.evalMode !== true && !opts.allowTrainingLog) {
    throw new Error(
      `the Flint server at ${url} predates eval mode (/health has no evalMode), so every replay would be logged to the training corpus. ` +
        'Deploy the server with eval mode, point --flint-url at one that has it, or pass --allow-training-log.',
    );
  }
  if (opts.localModel && health.localModelOverride !== true) {
    throw new Error(`the Flint server at ${url} doesn't support the eval-only local-model override (/health has no localModelOverride, or its local brain isn't Ollama). Deploy this branch first.`);
  }
  if (opts.localThink !== undefined && health.localThinkOverride !== true) {
    throw new Error(`the Flint server at ${url} doesn't support --local-think (/health has no localThinkOverride). Deploy this branch first.`);
  }
  if (opts.styleVariant !== undefined) assertStyleVariantSupported(health, opts.styleVariant, url);
  if (opts.groundingChars !== undefined) {
    const max = health.groundingCharsMax;
    if (typeof max !== 'number') {
      throw new Error(
        `the Flint server at ${url} can't send longer tool excerpts (/health has no groundingCharsMax), so competitors would get 800 characters of each tool result Flint read in full. ` +
          'Deploy the server with eval groundingChars first, or pass --allow-short-context to run anyway (the report says so).',
      );
    }
    if (opts.groundingChars > max) throw new Error(`--context-chars ${opts.groundingChars}: the Flint server at ${url} allows at most ${max}`);
  }
  if (opts.recallOverride && health.evalRecallOverride !== true) {
    throw new Error(
      `the Flint server at ${url} can't answer without long-term memory (/health has no evalRecallOverride), so on every task that isn't about memory Flint would read facts the competitors don't get. ` +
        'Deploy the server with the eval recall override first, or pass --allow-short-context to run against an older server (tasks where it recalled something are then not compared).',
    );
  }
  if (opts.discovery && health.evalDiscovery !== true) {
    throw new Error(`the Flint server at ${url} has no eval discovery (/health has no evalDiscovery). Deploy the server with it first, or pass --no-discover (templates that need it are skipped).`);
  }
  return health;
}

export async function flintHealth(url: string, fetchFn: typeof fetch = fetch): Promise<Record<string, unknown> | undefined> {
  try {
    const r = await fetchFn(`${url.replace(/\/$/, '')}/health`, { signal: AbortSignal.timeout(5000) });
    return r.ok ? ((await r.json()) as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
