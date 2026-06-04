import type Anthropic from '@anthropic-ai/sdk';
import AnthropicSDK from '@anthropic-ai/sdk';
import { AnthropicProvider } from '../../src/provider/anthropic/index.js';
import type { ProviderAdapter } from '../../src/index.js';

/**
 * Cassette-backed test harness. The Section 8 contract suite runs OFFLINE,
 * deterministically, and free against these recorded fixtures (cost/flakiness
 * rule). A separate, manually-triggered live run (FLINT_LIVE=1 + a real key)
 * is what refreshes them and catches drift — see test/contracts/README.md.
 *
 * The harness injects a fake SDK client into the REAL AnthropicProvider, so the
 * adapter's own mapping logic is exercised — only the network is replaced.
 */

type RawEvent = Anthropic.RawMessageStreamEvent;

export interface StreamCassette {
  kind: 'stream';
  events: RawEvent[];
  /** If set, the stream throws this AFTER yielding `throwAfter` events. */
  throwAfter?: number;
  makeError?: () => Error;
}

export interface GenerateCassette {
  kind: 'generate';
  response: Anthropic.Message;
}

export interface ErrorCassette {
  kind: 'error';
  on: 'create' | 'stream';
  makeError: () => Error;
}

export type Cassette = StreamCassette | GenerateCassette | ErrorCassette;

/** Build a ProviderAdapter that replays the given cassette. */
export function providerFromCassette(cassette: Cassette): ProviderAdapter {
  const fake = {
    messages: {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      async create(_body: unknown, _options?: { signal?: AbortSignal }) {
        if (cassette.kind === 'error' && cassette.on === 'create') {
          throw cassette.makeError();
        }
        if (cassette.kind === 'generate') return cassette.response;
        throw new Error('cassette has no non-streaming response');
      },
      stream(_body: unknown, options?: { signal?: AbortSignal }) {
        if (cassette.kind === 'error' && cassette.on === 'stream') {
          // Throw synchronously on iteration start.
          return errorIterable(cassette.makeError());
        }
        if (cassette.kind !== 'stream') {
          throw new Error('cassette has no stream events');
        }
        return replay(cassette, options?.signal);
      },
    },
  };

  return new AnthropicProvider({ client: fake as unknown as Anthropic });
}

async function* replay(
  cassette: StreamCassette,
  signal?: AbortSignal,
): AsyncGenerator<RawEvent, void, void> {
  let emitted = 0;
  for (const event of cassette.events) {
    // Simulate user abort surfacing mid-stream.
    if (signal?.aborted) {
      throw new AnthropicSDK.APIUserAbortError({ message: 'Request was aborted' });
    }
    if (
      cassette.throwAfter !== undefined &&
      emitted >= cassette.throwAfter &&
      cassette.makeError
    ) {
      throw cassette.makeError();
    }
    yield event;
    emitted++;
  }
}

async function* errorIterable(err: Error): AsyncGenerator<RawEvent, void, void> {
  throw err;
}

// --- raw event builders (the recorded shapes) -------------------------------

export function messageStart(inputTokens: number, id = 'msg_test'): RawEvent {
  return {
    type: 'message_start',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: usage(inputTokens, 0),
    } as unknown as Anthropic.Message,
  };
}

export function textBlockStart(index: number): RawEvent {
  return {
    type: 'content_block_start',
    index,
    content_block: { type: 'text', text: '', citations: null } as Anthropic.TextBlock,
  };
}

export function textDelta(index: number, text: string): RawEvent {
  return {
    type: 'content_block_delta',
    index,
    delta: { type: 'text_delta', text },
  };
}

export function toolUseBlockStart(index: number, id: string, name: string): RawEvent {
  return {
    type: 'content_block_start',
    index,
    content_block: {
      type: 'tool_use',
      id,
      name,
      input: {},
    } as unknown as Anthropic.ToolUseBlock,
  };
}

export function inputJsonDelta(index: number, partialJson: string): RawEvent {
  return {
    type: 'content_block_delta',
    index,
    delta: { type: 'input_json_delta', partial_json: partialJson },
  };
}

export function blockStop(index: number): RawEvent {
  return { type: 'content_block_stop', index };
}

export function messageDelta(
  stopReason: Anthropic.StopReason,
  outputTokens: number,
): RawEvent {
  return {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null } as unknown as Anthropic.RawMessageDeltaEvent['delta'],
    usage: {
      input_tokens: null,
      output_tokens: outputTokens,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      server_tool_use: null,
    } as unknown as Anthropic.MessageDeltaUsage,
  };
}

export function messageStop(): RawEvent {
  return { type: 'message_stop' };
}

function usage(input: number, output: number): Anthropic.Usage {
  return {
    input_tokens: input,
    output_tokens: output,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    server_tool_use: null,
    service_tier: null,
  } as unknown as Anthropic.Usage;
}

/** A complete non-streaming Message fixture. */
export function generatedMessage(opts: {
  text?: string;
  toolUses?: Array<{ id: string; name: string; input: unknown }>;
  stopReason: Anthropic.StopReason;
  inputTokens: number;
  outputTokens: number;
}): Anthropic.Message {
  const content: Anthropic.ContentBlock[] = [];
  if (opts.text) {
    content.push({ type: 'text', text: opts.text, citations: null } as Anthropic.TextBlock);
  }
  for (const t of opts.toolUses ?? []) {
    content.push({
      type: 'tool_use',
      id: t.id,
      name: t.name,
      input: t.input,
    } as unknown as Anthropic.ToolUseBlock);
  }
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-6',
    content,
    stop_reason: opts.stopReason,
    stop_sequence: null,
    usage: usage(opts.inputTokens, opts.outputTokens),
  } as unknown as Anthropic.Message;
}
