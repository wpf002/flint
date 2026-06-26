import type { Message } from '../../types/message.js';
import { decodeAssistantTurn, decodeToolResult } from '../../core/encoding.js';

export interface OllamaToolCall {
  function: { name: string; arguments: unknown };
}

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: OllamaToolCall[];
  tool_name?: string;
}

/**
 * Flatten canonical messages onto Ollama's NATIVE chat format (the `/api/chat`
 * tools API). Unlike the old prompted regime, tool calls and results travel as
 * structured fields, not free text:
 *  - a `tool` turn (assistant tool call) → an assistant message carrying
 *    structured `tool_calls`,
 *  - a `tool_result` → a `role: 'tool'` message with the result body.
 */
export function mapMessages(messages: Message[], systemPrefix?: string): OllamaMessage[] {
  const out: OllamaMessage[] = [];
  if (systemPrefix && systemPrefix.trim().length > 0) {
    out.push({ role: 'system', content: systemPrefix });
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
          content: turn.text ?? '',
          tool_calls: turn.toolCalls.map((c) => ({
            function: { name: c.toolName, arguments: c.args },
          })),
        });
        break;
      }
      case 'tool_result': {
        const res = decodeToolResult(msg);
        const body = typeof res.result === 'string' ? res.result : JSON.stringify(res.result);
        out.push({ role: 'tool', content: body, tool_name: res.toolName });
        break;
      }
    }
  }

  return out;
}

/** Map Ollama's `done_reason` onto the canonical stream reason (text turns). */
export function mapDoneReason(reason: string | undefined): 'complete' | 'max_tokens' {
  return reason === 'length' ? 'max_tokens' : 'complete';
}
