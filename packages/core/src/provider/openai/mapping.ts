import type { Message } from '../../types/message.js';
import type { ToolDefinition } from '../../types/tool.js';
import type { StreamDoneReason } from '../../types/stream.js';
import { decodeAssistantTurn, decodeToolResult } from '../../core/encoding.js';

/** A message in the OpenAI chat-completions format. */
export interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

export interface OpenAiTool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

/**
 * Flatten canonical messages onto the chat-completions format.
 *
 * The shape differs from Anthropic's in one way that matters: a tool result is its
 * own `role: 'tool'` message keyed by `tool_call_id`, rather than a block inside a
 * user message. Everything else is a direct translation.
 */
export function mapMessages(messages: Message[], explicitSystem: string | undefined): OpenAiMessage[] {
  const out: OpenAiMessage[] = [];
  if (explicitSystem && explicitSystem.trim().length > 0) {
    out.push({ role: 'system', content: explicitSystem });
  }

  for (const msg of messages) {
    switch (msg.role) {
      case 'system':
        out.push({ role: 'system', content: msg.content });
        break;

      case 'user':
        out.push({ role: 'user', content: msg.content });
        break;

      case 'assistant':
        out.push({ role: 'assistant', content: msg.content });
        break;

      case 'tool': {
        const turn = decodeAssistantTurn(msg);
        out.push({
          role: 'assistant',
          content: turn.text.trim().length > 0 ? turn.text : null,
          tool_calls: turn.toolCalls.map((c) => ({
            id: c.id,
            type: 'function' as const,
            function: {
              name: toOpenAiToolName(c.toolName),
              arguments: JSON.stringify(c.args ?? {}),
            },
          })),
        });
        break;
      }

      case 'tool_result': {
        const res = decodeToolResult(msg);
        out.push({
          role: 'tool',
          tool_call_id: res.toolCallId,
          content: typeof res.result === 'string' ? res.result : JSON.stringify(res.result),
        });
        break;
      }
    }
  }

  return out;
}

/**
 * Function names must match ^[a-zA-Z0-9_-]{1,64}$ — no dots. Namespaced MCP tools
 * (`server.tool`) swap each `.` for `__` on the way out and back on the way in, the
 * same reversible scheme the Anthropic adapter uses, so a tool keeps one name across
 * providers.
 */
export function toOpenAiToolName(name: string): string {
  return name.replace(/\./g, '__');
}

export function fromOpenAiToolName(name: string): string {
  return name.replace(/__/g, '.');
}

export function mapTools(tools: ToolDefinition[] | undefined): OpenAiTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: toOpenAiToolName(t.name),
      description: t.description,
      parameters: { type: 'object', ...(t.inputSchema as Record<string, unknown>) },
    },
  }));
}

/** Map `finish_reason` onto the canonical done reason. */
export function mapFinishReason(finish: string | null | undefined): StreamDoneReason {
  switch (finish) {
    case 'tool_calls':
    case 'function_call':
      return 'tool_call';
    case 'length':
      return 'max_tokens';
    // `content_filter` is not a clean completion, but it is a terminated turn with
    // content the caller can inspect — the same treatment Anthropic's refusal gets.
    default:
      return 'complete';
  }
}

/** Tolerant parse of streamed function arguments; malformed JSON yields {}. */
export function parseArgs(json: string): unknown {
  if (json.trim().length === 0) return {};
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}
