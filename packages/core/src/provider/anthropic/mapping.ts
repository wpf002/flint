import type Anthropic from '@anthropic-ai/sdk';
import type { Message } from '../../types/message.js';
import type { ToolDefinition } from '../../types/tool.js';
import type { StreamDoneReason } from '../../types/stream.js';
import { decodeAssistantTurn, decodeToolResult } from '../../core/encoding.js';

type MessageParam = Anthropic.MessageParam;
type ContentBlockParam = Anthropic.ContentBlockParam;
type Tool = Anthropic.Tool;

export interface MappedRequest {
  system: string | undefined;
  messages: MessageParam[];
}

/**
 * Map canonical messages onto Anthropic's request shape:
 *  - `system` messages are hoisted into the top-level `system` string,
 *  - `tool` turns become assistant messages with text + tool_use blocks,
 *  - `tool_result` messages become user messages with tool_result blocks,
 *  - consecutive same-role blocks are merged (Anthropic wants grouped blocks).
 */
export function mapMessages(
  messages: Message[],
  explicitSystem: string | undefined,
): MappedRequest {
  const systemParts: string[] = [];
  if (explicitSystem) systemParts.push(explicitSystem);

  const out: MessageParam[] = [];

  const pushBlocks = (role: 'user' | 'assistant', blocks: ContentBlockParam[]) => {
    if (blocks.length === 0) return;
    const last = out[out.length - 1];
    if (last && last.role === role && Array.isArray(last.content)) {
      last.content.push(...blocks);
    } else {
      out.push({ role, content: blocks });
    }
  };

  for (const msg of messages) {
    switch (msg.role) {
      case 'system':
        systemParts.push(msg.content);
        break;

      case 'user':
        pushBlocks('user', [{ type: 'text', text: msg.content }]);
        break;

      case 'assistant':
        pushBlocks('assistant', [{ type: 'text', text: msg.content }]);
        break;

      case 'tool': {
        const turn = decodeAssistantTurn(msg);
        const blocks: ContentBlockParam[] = [];
        if (turn.text.trim().length > 0) {
          blocks.push({ type: 'text', text: turn.text });
        }
        for (const call of turn.toolCalls) {
          blocks.push({
            type: 'tool_use',
            id: call.id,
            name: call.toolName,
            input: (call.args ?? {}) as Record<string, unknown>,
          });
        }
        pushBlocks('assistant', blocks);
        break;
      }

      case 'tool_result': {
        const res = decodeToolResult(msg);
        pushBlocks('user', [
          {
            type: 'tool_result',
            tool_use_id: res.toolCallId,
            content: stringifyResult(res.result),
            ...(res.isError ? { is_error: true } : {}),
          },
        ]);
        break;
      }
    }
  }

  return {
    system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
    messages: out,
  };
}

function stringifyResult(result: unknown): string {
  if (typeof result === 'string') return result;
  return JSON.stringify(result);
}

/** Map canonical tool definitions onto Anthropic's tool shape. */
export function mapTools(tools: ToolDefinition[] | undefined): Tool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => {
    const schema = t.inputSchema as Record<string, unknown>;
    return {
      name: t.name,
      description: t.description,
      input_schema: {
        type: 'object' as const,
        ...schema,
      },
    } satisfies Tool;
  });
}

/** Map Anthropic's stop_reason onto the canonical done reason. */
export function mapStopReason(stop: string | null): StreamDoneReason {
  switch (stop) {
    case 'end_turn':
    case 'stop_sequence':
      return 'complete';
    case 'tool_use':
      return 'tool_call';
    case 'max_tokens':
      return 'max_tokens';
    case 'refusal':
    case 'pause_turn':
      // Neither is a clean completion nor a tool call; surface as complete and
      // let the caller inspect content. (refusal carries its own message.)
      return 'complete';
    default:
      return 'complete';
  }
}
