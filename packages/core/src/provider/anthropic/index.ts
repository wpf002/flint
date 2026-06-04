import Anthropic from '@anthropic-ai/sdk';
import type {
  ProviderAdapter,
  GenerateArgs,
  GenerateResult,
} from '../adapter.js';
import type { Message } from '../../types/message.js';
import type { StreamEvent, TokenUsage } from '../../types/stream.js';
import type { ToolCall } from '../../types/tool.js';
import type { ModelCapabilities } from '../../types/capabilities.js';
import { FlintError } from '../../types/error.js';
import {
  encodeAssistantText,
  encodeToolCallTurn,
} from '../../core/encoding.js';
import { anthropicCapabilities } from './capabilities.js';
import { toAiError } from './errors.js';
import { mapMessages, mapTools, mapStopReason } from './mapping.js';

export interface AnthropicProviderOptions {
  /** API key. Passed explicitly — `@flint/core` never reads process.env. */
  apiKey?: string;
  /** A pre-constructed SDK client (e.g. for tests / cassettes). Wins over apiKey. */
  client?: Anthropic;
  baseURL?: string;
  /** Fallback max_tokens when a call doesn't specify one. */
  defaultMaxTokens?: number;
}

const DEFAULT_MAX_TOKENS = 4096;

/**
 * Phase 1 provider. Implements `ProviderAdapter` against `@anthropic-ai/sdk`.
 * This is the ONLY file (plus its siblings) that imports the vendor SDK;
 * nothing in `core/` does (locked invariant #1).
 */
export class AnthropicProvider implements ProviderAdapter {
  readonly name = 'anthropic';
  private readonly client: Anthropic;
  private readonly defaultMaxTokens: number;

  constructor(opts: AnthropicProviderOptions) {
    if (opts.client) {
      this.client = opts.client;
    } else {
      if (!opts.apiKey) {
        throw new Error(
          'AnthropicProvider requires an apiKey or a client (Flint never reads process.env).',
        );
      }
      this.client = new Anthropic({
        apiKey: opts.apiKey,
        ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
      });
    }
    this.defaultMaxTokens = opts.defaultMaxTokens ?? DEFAULT_MAX_TOKENS;
  }

  getCapabilities(model: string): ModelCapabilities {
    return anthropicCapabilities(model);
  }

  estimateTokens(messages: Message[], _model: string): number {
    // Best-effort heuristic (~4 chars/token). Budgeting only, not billing.
    const chars = messages.reduce((sum, m) => sum + m.content.length, 0);
    return Math.ceil(chars / 4);
  }

  async generate(args: GenerateArgs): Promise<GenerateResult> {
    const { system, messages } = mapMessages(args.messages, args.system);
    const tools = mapTools(args.tools);
    try {
      const resp = await this.client.messages.create(
        {
          model: args.model,
          max_tokens: args.maxTokens ?? this.defaultMaxTokens,
          messages,
          ...(system ? { system } : {}),
          ...(tools ? { tools } : {}),
        },
        args.signal ? { signal: args.signal } : {},
      );

      const text = resp.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');

      const toolCalls: ToolCall[] = resp.content
        .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
        .map((b) => ({
          id: b.id,
          toolName: b.name,
          args: b.input,
          rawProviderPayload: b,
        }));

      const usage: TokenUsage = {
        input: resp.usage.input_tokens,
        output: resp.usage.output_tokens,
      };
      const reason = mapStopReason(resp.stop_reason);
      const id = resp.id;
      const message =
        toolCalls.length > 0
          ? encodeToolCallTurn(id, text, toolCalls, 0)
          : encodeAssistantText(id, text, 0);

      return { message, usage, reason };
    } catch (err) {
      throw new FlintError(toAiError(err));
    }
  }

  async *stream(args: GenerateArgs): AsyncIterable<StreamEvent> {
    const { system, messages } = mapMessages(args.messages, args.system);
    const tools = mapTools(args.tools);

    let inputTokens = 0;
    let outputTokens = 0;
    let stopReason: string | null = null;

    // Active tool_use blocks being assembled, keyed by content-block index.
    const toolBuilders = new Map<
      number,
      { id: string; name: string; json: string }
    >();

    try {
      const stream = this.client.messages.stream(
        {
          model: args.model,
          max_tokens: args.maxTokens ?? this.defaultMaxTokens,
          messages,
          ...(system ? { system } : {}),
          ...(tools ? { tools } : {}),
        },
        args.signal ? { signal: args.signal } : {},
      );

      for await (const event of stream) {
        switch (event.type) {
          case 'message_start':
            inputTokens = event.message.usage.input_tokens;
            break;

          case 'content_block_start':
            if (event.content_block.type === 'tool_use') {
              toolBuilders.set(event.index, {
                id: event.content_block.id,
                name: event.content_block.name,
                json: '',
              });
            }
            break;

          case 'content_block_delta':
            if (event.delta.type === 'text_delta') {
              yield { type: 'text', delta: event.delta.text };
            } else if (event.delta.type === 'input_json_delta') {
              const b = toolBuilders.get(event.index);
              if (b) b.json += event.delta.partial_json;
            }
            break;

          case 'content_block_stop': {
            const b = toolBuilders.get(event.index);
            if (b) {
              toolBuilders.delete(event.index);
              const call: ToolCall = {
                id: b.id,
                toolName: b.name,
                args: b.json.trim().length > 0 ? safeParse(b.json) : {},
              };
              yield { type: 'tool_call', call };
            }
            break;
          }

          case 'message_delta':
            stopReason = event.delta.stop_reason ?? stopReason;
            outputTokens = event.usage.output_tokens;
            break;

          case 'message_stop':
            break;
        }
      }

      yield {
        type: 'done',
        reason: mapStopReason(stopReason),
        usage: { input: inputTokens, output: outputTokens },
      };
    } catch (err) {
      // ALWAYS terminate with an error event (never just stop). Invariant for
      // the streaming contract: exactly one terminal `done` or `error`.
      yield { type: 'error', error: toAiError(err) };
    }
  }
}

/** Tolerant JSON parse for streamed tool args; returns {} on malformed input. */
function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}

export { anthropicCapabilities } from './capabilities.js';
export { toAiError } from './errors.js';
