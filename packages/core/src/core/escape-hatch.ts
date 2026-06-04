import {
  DEFAULT_RETRY_POLICY,
  type CallOptions,
  type ContextStrategy,
  type FlintConfig,
  type RetryPolicy,
} from '../types/config.js';

/**
 * A fully-resolved per-call configuration: app overrides (CallOptions) layered
 * over the client defaults (FlintConfig). This is the per-call escape hatch
 * (spec §7.9) made concrete — every public method funnels through here so an
 * app can override model / retry / context strategy / maxTokens / debug for a
 * single call without touching the rest of its code.
 */
export interface ResolvedCall {
  model: string;
  retryPolicy: RetryPolicy;
  contextStrategy: ContextStrategy;
  maxTokens: number | undefined;
  debug: boolean;
  signal: AbortSignal | undefined;
  context: unknown;
}

export function resolveCall(
  config: FlintConfig,
  options: CallOptions | undefined,
): ResolvedCall {
  const o = options ?? {};
  return {
    model: o.model ?? config.defaultModel,
    retryPolicy: o.retryPolicy ?? config.retryPolicy ?? DEFAULT_RETRY_POLICY,
    contextStrategy: o.contextStrategy ?? config.contextStrategy ?? 'truncate_oldest',
    maxTokens: o.maxTokens,
    debug: o.debug ?? false,
    signal: o.signal,
    context: o.context,
  };
}
