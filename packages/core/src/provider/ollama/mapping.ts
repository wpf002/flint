import type { Message } from '../../types/message.js';
import { decodeAssistantTurn, decodeToolResult } from '../../core/encoding.js';

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Flatten canonical messages onto Ollama's chat format. Ollama (in the prompted
 * regime) has no tool/tool_result roles, so:
 *  - a `tool` turn (assistant tool call) becomes an assistant message whose
 *    content is the model's own emitted tool-call JSON,
 *  - a `tool_result` becomes a user message describing the result, fed back so
 *    the model can use it on the next pass.
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
        const calls = turn.toolCalls
          .map((c) => JSON.stringify({ tool_call: { name: c.toolName, arguments: c.args } }))
          .join('\n');
        const content = [turn.text, calls].filter((s) => s.trim().length > 0).join('\n');
        out.push({ role: 'assistant', content });
        break;
      }
      case 'tool_result': {
        const res = decodeToolResult(msg);
        const body = typeof res.result === 'string' ? res.result : JSON.stringify(res.result);
        out.push({
          role: 'user',
          content: `Tool "${res.toolName}" returned:\n${body}`,
        });
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
