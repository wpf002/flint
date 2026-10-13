import type { Message } from '../../types/message.js';
import { decodeAssistantTurn, decodeToolResult } from '../../core/encoding.js';
import { attachmentNote, hasPayload, renderTextAttachment, type Attachment } from '../../types/attachment.js';

export interface OllamaToolCall {
  function: { name: string; arguments: unknown };
}

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** A user turn's pictures, as Ollama's /api/chat takes them: base64, one string an image, no `data:` prefix. */
  images?: string[];
  tool_calls?: OllamaToolCall[];
  tool_name?: string;
}

/** What a mapping may send besides text. Unset, every message is exactly what it was before this existed. */
export interface OllamaMedia {
  /**
   * The model being asked can see. A user turn's image is then sent in that
   * message's `images`, and not as a note saying it cannot be seen. Only the
   * caller knows this (the model server says which of its models can see): a
   * picture sent to a model that cannot see is dropped by Ollama without a
   * word, and the model answers about a picture it never saw.
   */
  images?: boolean;
}

/**
 * The kinds of picture Ollama's own decoder takes: the four Flint accepts as a
 * picture at all. (Each was checked against Ollama 0.34 with a model that
 * sees: a PNG, a JPEG, a GIF and a WebP of the same words were all read
 * back.) Any other kind is said to be unreadable, not sent.
 */
const OLLAMA_IMAGE_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** Is this attachment a picture that can be sent to a model that sees? */
function sendable(a: Attachment, media: OllamaMedia): boolean {
  return media.images === true && a.kind === 'image' && hasPayload(a) && OLLAMA_IMAGE_TYPES.has(a.mediaType);
}

/**
 * Flatten canonical messages onto Ollama's NATIVE chat format (the `/api/chat`
 * tools API). Unlike the old prompted regime, tool calls and results travel as
 * structured fields, not free text:
 *  - a `tool` turn (assistant tool call) → an assistant message carrying
 *    structured `tool_calls`,
 *  - a `tool_result` → a `role: 'tool'` message with the result body.
 */
export function mapMessages(messages: Message[], systemPrefix?: string, media: OllamaMedia = {}): OllamaMessage[] {
  const out: OllamaMessage[] = [];
  if (systemPrefix && systemPrefix.trim().length > 0) {
    out.push({ role: 'system', content: systemPrefix });
  }

  for (const msg of messages) {
    switch (msg.role) {
      case 'system':
        out.push({ role: 'system', content: msg.content });
        break;
      case 'user': {
        const images = (msg.attachments ?? []).filter((a) => sendable(a, media)).map((a) => a.data!);
        out.push({ role: 'user', content: userText(msg, media), ...(images.length > 0 ? { images } : {}) });
        break;
      }
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

/**
 * A user turn as text. A text file is inlined. A picture that is being sent
 * with the message (`media.images`, see `sendable`) needs no words here: the
 * model has the picture. Anything else that cannot be delivered becomes a note
 * saying so, never silently dropped: a PDF, a picture of a kind that is not one
 * of the four above, any picture at all for a model that cannot see (the default, and what
 * this did for every picture before). No attachments: the content string,
 * unchanged.
 */
function userText(msg: Message, media: OllamaMedia = {}): string {
  const attachments = msg.attachments ?? [];
  if (attachments.length === 0) return msg.content;
  const parts = attachments
    .filter((a) => !sendable(a, media))
    .map((a) =>
      !hasPayload(a)
        ? attachmentNote(a, 'shed')
        : a.kind === 'text'
          ? renderTextAttachment(a)
          : attachmentNote(a, 'unsupported'),
    );
  if (msg.content.trim().length > 0) parts.push(msg.content);
  return parts.join('\n\n');
}

/** Map Ollama's `done_reason` onto the canonical stream reason (text turns). */
export function mapDoneReason(reason: string | undefined): 'complete' | 'max_tokens' {
  return reason === 'length' ? 'max_tokens' : 'complete';
}
