/**
 * The responseFormat seam every provider shares: the one name check, and for
 * providers whose only way to force a reply's shape is a forced tool
 * (Anthropic), the conversion of that tool's call into the reply's text.
 */
import type { GenerateArgs, GenerateResult, ResponseFormat } from './adapter.js';
import type { StreamEvent } from '../types/stream.js';
import { decodeAssistantTurn, encodeAssistantText } from '../core/encoding.js';

/**
 * The name every provider sends for a responseFormat. OpenAI rejects a
 * json_schema name outside ^[A-Za-z0-9_-]{1,64}$ with a 400, and Anthropic's
 * tool-name mapping reads `__` back as `.`, so a forced tool named `a__b` comes
 * back as `a.b` and is never recognised. The name only labels the schema, so
 * any other name is sent as `respond` rather than failing on one provider.
 */
export function responseFormatName(rf: ResponseFormat): string {
  return /^[A-Za-z0-9_-]{1,64}$/.test(rf.name) && !rf.name.includes('__') ? rf.name : 'respond';
}

export function responseFormatAsTool(args: GenerateArgs): { args: GenerateArgs; tool: string } | undefined {
  const rf = args.responseFormat;
  if (!rf) return undefined;
  const tool = responseFormatName(rf);
  // The forced tool replaces the caller's tools (see GenerateArgs.responseFormat).
  const { responseFormat: _rf, ...rest } = args;
  return {
    tool,
    args: {
      ...rest,
      tools: [{ name: tool, description: 'Give the answer in exactly this shape.', inputSchema: rf.schema, idempotent: true }],
      toolChoice: { name: tool },
    },
  };
}

/**
 * The forced tool's input, as the reply's text. Only a finished call becomes
 * `complete`: a call cut off at max_tokens (or refused) keeps that reason, so
 * the caller can tell a partial object from the answer.
 */
export function toolResultAsText(r: GenerateResult, tool: string): GenerateResult {
  const call = decodeAssistantTurn(r.message).toolCalls.find((c) => c.toolName === tool);
  if (!call) return r;
  return {
    ...r,
    message: encodeAssistantText(r.message.id, JSON.stringify(call.args ?? {}), r.message.timestamp),
    reason: r.reason === 'tool_call' ? 'complete' : r.reason,
  };
}

export async function* toolStreamAsText(events: AsyncIterable<StreamEvent>, tool: string): AsyncIterable<StreamEvent> {
  for await (const ev of events) {
    if (ev.type === 'tool_call' && ev.call.toolName === tool) yield { type: 'text', delta: JSON.stringify(ev.call.args ?? {}) };
    else if (ev.type === 'done' && ev.reason === 'tool_call') yield { ...ev, reason: 'complete' };
    else yield ev;
  }
}
