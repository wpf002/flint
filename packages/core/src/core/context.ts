import type { Message } from '../types/message.js';
import type { ContextStrategy } from '../types/config.js';
import type { ToolDefinition } from '../types/tool.js';
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
  // Drop oldest non-system messages until it fits. The last try keeps the NEWEST one alone, and it is never
  // dropped: it is what is being asked. (A request left with no message at all used to be sent as
  // `"messages": []`, which every provider refuses.)
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

  // Could not fit even with everything older removed: the newest message (with the system messages) is too big
  // for this model's window on its own. Said, not sent.
  throw new FlintError(
    makeAiError(
      'context_overflow',
      rest.length > 0
        ? `The newest message (about ${estimate([rest[rest.length - 1]!])} tokens with its files) does not fit this model's window (${budgetTokens} for the prompt), even with every earlier message left out.`
        : `Context cannot fit budget (${budgetTokens}): the system messages alone are too big.`,
      { retryable: false },
    ),
  );
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

/**
 * The part of every request that is not a message: the system prompt and the
 * tool schemas, by the same ~4 characters per token as messages. They ride on
 * each pass of a turn and share the model's window with the history. Budgeting
 * only, never billing.
 */
export function fixedPromptTokens(system: string | undefined, tools: readonly ToolDefinition[]): number {
  let chars = system?.length ?? 0;
  for (const t of tools) chars += t.name.length + t.description.length + JSON.stringify(t.inputSchema ?? {}).length;
  return Math.ceil(chars / 4);
}

/**
 * The same, counted for a prompt that MUST fit (FlintConfig.fitToWindow), so on
 * the safe side: each tool as it goes on the wire (a wrapper of about 60
 * characters around its name, description and schema) and at 3 characters a
 * token, since a schema is JSON, and JSON's brackets and quotes are tokens of
 * their own. The system prompt is prose: 4.
 */
export function fittedPromptTokens(system: string | undefined, tools: readonly ToolDefinition[]): number {
  let n = Math.ceil((system?.length ?? 0) / 4);
  for (const t of tools) n += Math.ceil((t.name.length + t.description.length + JSON.stringify(t.inputSchema ?? {}).length + TOOL_WIRE_CHARS) / 3);
  return n;
}

/** What a tool's wire form adds around its name, description and schema (`{"type":"function","function":{...}}`). */
const TOOL_WIRE_CHARS = 60;

/**
 * The share of a window a fitted prompt leaves free, beyond the reply's
 * reserve: for what no estimate sees (the chat template's role markers, a
 * tokenizer that splits finer than 4 characters a token).
 */
export const FIT_MARGIN = 0.05;

/**
 * Tokens the messages may take: the input window (context minus the reply's
 * reserve) minus the fixed prompt.
 *
 * The fixed prompt never takes more than half the input window from them. On a
 * small window a large system prompt and tool list would otherwise leave no
 * room at all, and assembly would drop the whole conversation, the newest
 * message included. With at least half kept, the history is trimmed against a
 * real number and a window that still overflows is the provider's to report
 * (Ollama trims the oldest messages itself).
 */
export function messageBudget(inputTokens: number, fixedTokens: number): number {
  const input = Math.max(0, Math.floor(inputTokens));
  return Math.max(input - Math.max(0, fixedTokens), Math.floor(input / 2));
}
