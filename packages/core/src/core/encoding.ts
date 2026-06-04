import type { Message } from '../types/message.js';
import { ToolCallSchema, type ToolCall, type ToolResult } from '../types/tool.js';
import { z } from 'zod';

/**
 * How assistant turns and tool exchanges round-trip through canonical
 * `Message`s. `Message.content` is always a string (locked type), so the
 * structured pieces of a turn are JSON-encoded here and decoded at the loop /
 * adapter boundary. Centralizing the encoding keeps the wire shape identical
 * across providers and package versions.
 *
 * Canonical encoding:
 *  - plain assistant text  → role 'assistant', content = text
 *  - assistant tool calls  → role 'tool',        content = JSON {text, toolCalls}
 *  - a tool's result       → role 'tool_result', content = JSON result, toolCallId set
 */

const AssistantTurnPayload = z.object({
  text: z.string(),
  toolCalls: z.array(ToolCallSchema),
});

export interface AssistantTurn {
  text: string;
  toolCalls: ToolCall[];
}

/** Normalize a parsed tool call into the canonical ToolCall (args always present). */
function toToolCall(c: z.infer<typeof ToolCallSchema>): ToolCall {
  const call: ToolCall = { id: c.id, toolName: c.toolName, args: c.args };
  if (c.rawProviderPayload !== undefined) call.rawProviderPayload = c.rawProviderPayload;
  return call;
}

/** A plain assistant text message (no tool calls). */
export function encodeAssistantText(
  id: string,
  text: string,
  timestamp: number,
): Message {
  return { id, role: 'assistant', content: text, timestamp };
}

/** An assistant turn that requested one or more tool calls. */
export function encodeToolCallTurn(
  id: string,
  text: string,
  toolCalls: ToolCall[],
  timestamp: number,
): Message {
  const payload: AssistantTurn = { text, toolCalls };
  return { id, role: 'tool', content: JSON.stringify(payload), timestamp };
}

/** True if this message encodes an assistant tool-call turn. */
export function isToolCallTurn(message: Message): boolean {
  return message.role === 'tool';
}

/** Decode an assistant turn from either a plain assistant or a tool message. */
export function decodeAssistantTurn(message: Message): AssistantTurn {
  if (message.role === 'assistant') {
    return { text: message.content, toolCalls: [] };
  }
  if (message.role === 'tool') {
    const parsed = AssistantTurnPayload.parse(JSON.parse(message.content));
    return { text: parsed.text, toolCalls: parsed.toolCalls.map(toToolCall) };
  }
  return { text: '', toolCalls: [] };
}

/** Extract just the tool calls (empty if none). */
export function decodeToolCalls(message: Message): ToolCall[] {
  return decodeAssistantTurn(message).toolCalls;
}

/** Encode a tool result to feed back into the loop. */
export function encodeToolResult(
  id: string,
  result: ToolResult,
  timestamp: number,
): Message {
  return {
    id,
    role: 'tool_result',
    content: JSON.stringify({
      toolName: result.toolName,
      result: result.result,
      isError: result.isError ?? false,
    }),
    toolCallId: result.toolCallId,
    timestamp,
  };
}

const ToolResultPayload = z.object({
  toolName: z.string(),
  result: z.unknown(),
  isError: z.boolean(),
});

/** Decode a tool_result message back into a ToolResult. */
export function decodeToolResult(message: Message): ToolResult {
  const payload = ToolResultPayload.parse(JSON.parse(message.content));
  const out: ToolResult = {
    toolCallId: message.toolCallId ?? '',
    toolName: payload.toolName,
    result: payload.result,
    isError: payload.isError,
  };
  return out;
}
