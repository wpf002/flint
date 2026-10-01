/**
 * responseFormat for providers whose only way to force a reply's shape is a
 * forced tool (Anthropic): the schema becomes one tool the model must call, and
 * that call's input comes back as the reply's text.
 */
import type { GenerateArgs, GenerateResult } from './adapter.js';
import type { StreamEvent } from '../types/stream.js';
import { decodeAssistantTurn, encodeAssistantText } from '../core/encoding.js';

export function responseFormatAsTool(args: GenerateArgs): { args: GenerateArgs; tool: string } | undefined {
  const rf = args.responseFormat;
  if (!rf) return undefined;
  const tool = /^[A-Za-z0-9_-]{1,64}$/.test(rf.name) ? rf.name : 'respond';
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

/** The forced tool's input, as the reply's text. */
export function toolResultAsText(r: GenerateResult, tool: string): GenerateResult {
  const call = decodeAssistantTurn(r.message).toolCalls.find((c) => c.toolName === tool);
  if (!call) return r;
  return { ...r, message: encodeAssistantText(r.message.id, JSON.stringify(call.args ?? {}), r.message.timestamp), reason: 'complete' };
}

export async function* toolStreamAsText(events: AsyncIterable<StreamEvent>, tool: string): AsyncIterable<StreamEvent> {
  for await (const ev of events) {
    if (ev.type === 'tool_call' && ev.call.toolName === tool) yield { type: 'text', delta: JSON.stringify(ev.call.args ?? {}) };
    else if (ev.type === 'done' && ev.reason === 'tool_call') yield { ...ev, reason: 'complete' };
    else yield ev;
  }
}
