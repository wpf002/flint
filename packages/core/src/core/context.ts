import type { Message } from '../types/message.js';
import type { ContextStrategy } from '../types/config.js';
import { FlintError, makeAiError } from '../types/error.js';

export interface AssembleArgs {
  messages: Message[];
  /** Total token budget available for the INPUT (context window minus reserved output). */
  budgetTokens: number;
  strategy: ContextStrategy;
  /** Token estimator, typically `provider.estimateTokens(_, model)`. */
  estimate: (messages: Message[]) => number;
}

export interface AssembleResult {
  messages: Message[];
  /** How many messages were elided to fit. */
  dropped: number;
  strategy: ContextStrategy;
}

/**
 * Budget-aware context assembly. The strategy is ALWAYS explicit — Flint never
 * silently stuffs the whole history into the window (spec §7.7).
 *
 * System messages are never dropped. `truncate_oldest` and `summarize` shed the
 * oldest non-system messages until the estimate fits; `summarize` additionally
 * leaves a synthetic system note recording the elision.
 */
export function assembleContext(args: AssembleArgs): AssembleResult {
  const { messages, budgetTokens, strategy, estimate } = args;

  if (estimate(messages) <= budgetTokens) {
    return { messages, dropped: 0, strategy };
  }

  if (strategy === 'full') {
    throw new FlintError(
      makeAiError(
        'context_overflow',
        `Context (~${estimate(messages)} tokens) exceeds budget (${budgetTokens}); ` +
          `strategy 'full' will not truncate.`,
        { retryable: false },
      ),
    );
  }

  const system = messages.filter((m) => m.role === 'system');
  const rest = messages.filter((m) => m.role !== 'system');

  let dropCount = 0;
  // Drop oldest non-system messages until it fits (or nothing is left to drop).
  while (dropCount < rest.length) {
    const kept = rest.slice(dropCount);
    const candidate =
      strategy === 'summarize'
        ? [...system, summaryNote(dropCount), ...kept]
        : [...system, ...kept];
    if (estimate(candidate) <= budgetTokens) {
      return { messages: candidate, dropped: dropCount, strategy };
    }
    dropCount++;
  }

  // Could not fit even with everything droppable removed — system alone too big.
  const minimal =
    strategy === 'summarize' ? [...system, summaryNote(rest.length)] : [...system];
  if (estimate(minimal) > budgetTokens) {
    throw new FlintError(
      makeAiError(
        'context_overflow',
        `Context cannot fit budget (${budgetTokens}) even after dropping all ` +
          `non-system messages.`,
        { retryable: false },
      ),
    );
  }
  return { messages: minimal, dropped: rest.length, strategy };
}

/** A deterministic synthetic note marking elided history. */
function summaryNote(count: number): Message {
  return {
    id: `summary-${count}`,
    role: 'system',
    content: `[${count} earlier message(s) omitted to fit the context window.]`,
    timestamp: 0,
  };
}
