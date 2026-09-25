import type Anthropic from '@anthropic-ai/sdk';
import type { Message } from '../../types/message.js';
import type { ToolDefinition } from '../../types/tool.js';
import type { StreamDoneReason } from '../../types/stream.js';
import type { CacheHints } from '../adapter.js';
import { decodeAssistantTurn, decodeToolResult } from '../../core/encoding.js';
import {
  attachmentNote,
  hasPayload,
  renderTextAttachment,
  type Attachment,
} from '../../types/attachment.js';

type MessageParam = Anthropic.MessageParam;
type ContentBlockParam = Anthropic.ContentBlockParam;
type TextBlockParam = Anthropic.TextBlockParam;
type Tool = Anthropic.Tool;

export interface MappedRequest {
  /**
   * A plain string, unless a cache breakpoint was asked for — then the SAME
   * bytes, split into two text blocks with `cache_control` on the first.
   */
  system: string | TextBlockParam[] | undefined;
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
  cache?: CacheHints,
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
        pushBlocks('user', userBlocks(msg));
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
            name: toAnthropicToolName(call.toolName),
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
    system: splitSystemAtBreakpoint(
      systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
      cache,
    ),
    messages: out,
  };
}

/**
 * Split the system prompt at its cache breakpoint. The stable half is marked
 * `cache_control`, so every repeat call inside the cache's 5-minute window bills
 * it at the cache-read rate instead of re-charging full input price for the same
 * few thousand tokens of style guide — which is most of what a tool loop's
 * second, third and fourth provider calls otherwise pay for.
 *
 * Byte-preserving by construction: block A is the prompt MINUS the volatile
 * suffix, so the `\n\n` that separated the two halves stays on the END of block
 * A and `A + B` is the original string exactly. If the declared suffix isn't
 * actually a suffix — e.g. a `system` message got hoisted in behind it — we fail
 * open and send the single unsplit string rather than reorder the prompt.
 */
function splitSystemAtBreakpoint(
  system: string | undefined,
  cache: CacheHints | undefined,
): string | TextBlockParam[] | undefined {
  if (system === undefined || !cache?.system) return system;
  try {
    const tail = cache.systemSuffix ?? '';
    if (tail.length === 0) {
      return [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
    }
    if (tail.length >= system.length || !system.endsWith(tail)) return system;
    return [
      {
        type: 'text',
        text: system.slice(0, system.length - tail.length),
        cache_control: { type: 'ephemeral' },
      },
      { type: 'text', text: tail },
    ];
  } catch {
    // A cache breakpoint is an optimization, never a requirement — on anything
    // unexpected, send the prompt exactly as it would have been sent before.
    return system;
  }
}

/** Anthropic's accepted image media types (anything else is refused at the boundary). */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

/**
 * A user turn's blocks. Attachments go FIRST, then the typed text — Anthropic's
 * own guidance for image/document prompts, and it keeps the question as the
 * last thing the model reads. A message with no attachments maps exactly as it
 * always did: one text block.
 */
function userBlocks(msg: Message): ContentBlockParam[] {
  const attachments = msg.attachments ?? [];
  if (attachments.length === 0) return [{ type: 'text', text: msg.content }];
  const blocks = attachments.map(attachmentBlock);
  if (msg.content.trim().length > 0) blocks.push({ type: 'text', text: msg.content });
  return blocks;
}

export function attachmentBlock(a: Attachment): ContentBlockParam {
  if (!hasPayload(a)) return { type: 'text', text: attachmentNote(a, 'shed') };
  switch (a.kind) {
    case 'text':
      return { type: 'text', text: renderTextAttachment(a) };
    case 'image':
      if (!IMAGE_TYPES.has(a.mediaType)) return { type: 'text', text: attachmentNote(a, 'unsupported') };
      return {
        type: 'image',
        source: { type: 'base64', media_type: a.mediaType as ImageMediaType, data: a.data as string },
      };
    case 'document':
      if (a.mediaType !== 'application/pdf') return { type: 'text', text: attachmentNote(a, 'unsupported') };
      return {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: a.data as string },
        ...(a.name ? { title: a.name } : {}),
      };
  }
}

function stringifyResult(result: unknown): string {
  if (typeof result === 'string') return result;
  return JSON.stringify(result);
}

/**
 * Anthropic requires tool names to match ^[a-zA-Z0-9_-]{1,128}$ — no dots. Our
 * MCP tools are namespaced `server.tool`, so swap each `.` for `__` on the way
 * out and back on the way in. Reversible because our tool names never contain
 * `__` (single underscores in names like `gcal_upcoming` are untouched).
 */
export function toAnthropicToolName(name: string): string {
  return name.replace(/\./g, '__');
}
export function fromAnthropicToolName(name: string): string {
  return name.replace(/__/g, '.');
}

/** Map canonical tool definitions onto Anthropic's tool shape. */
export function mapTools(
  tools: ToolDefinition[] | undefined,
  cache?: CacheHints,
): Tool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  const mapped = tools.map((t) => {
    const schema = t.inputSchema as Record<string, unknown>;
    return {
      name: toAnthropicToolName(t.name),
      description: t.description,
      input_schema: {
        type: 'object' as const,
        ...schema,
      },
    } satisfies Tool;
  });
  return markToolBreakpoint(mapped, cache);
}

/**
 * Mark one tool as the end of a cacheable prefix. Tools render BEFORE the system
 * prompt, so this is the cheaper of the two breakpoints to hit: a request whose
 * router appended extra tools misses the system breakpoint entirely but still
 * reads the fixed core schemas from cache instead of paying for them again.
 *
 * Order is never touched — exactly one entry is copied with `cache_control`
 * added — and an index outside the array is ignored, so a mis-sized hint costs
 * nothing rather than dropping tools.
 */
function markToolBreakpoint(tools: Tool[], cache: CacheHints | undefined): Tool[] {
  if (!cache) return tools;
  try {
    const at =
      cache.toolsThrough !== undefined
        ? cache.toolsThrough
        : cache.tools
          ? tools.length - 1
          : -1;
    if (!Number.isInteger(at) || at < 0 || at >= tools.length) return tools;
    const target = tools[at];
    if (!target) return tools;
    const out = tools.slice();
    out[at] = { ...target, cache_control: { type: 'ephemeral' } };
    return out;
  } catch {
    return tools;
  }
}

/**
 * Map the canonical tool choice onto Anthropic's shape. `none` keeps the tools
 * defined but forbids calling them: a request whose history holds tool_use /
 * tool_result blocks must still define tools, so dropping them isn't an option.
 */
export function mapToolChoice(
  choice: 'auto' | 'required' | 'none' | { name: string } | undefined,
): { type: 'auto' } | { type: 'any' } | { type: 'none' } | { type: 'tool'; name: string } | undefined {
  if (!choice) return undefined;
  if (choice === 'auto') return { type: 'auto' };
  if (choice === 'required') return { type: 'any' };
  if (choice === 'none') return { type: 'none' };
  return { type: 'tool', name: toAnthropicToolName(choice.name) };
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
      // The streaming classifiers stopped the turn. It used to be reported as
      // `complete`, so an empty refused turn read as a finished answer and no
      // fallback ever fired.
      return 'refusal';
    case 'pause_turn':
      // Not a clean completion nor a tool call; surface as complete and let the
      // caller inspect content.
      return 'complete';
    default:
      return 'complete';
  }
}
