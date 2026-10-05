/**
 * Chat history for the console's sidebar: GET /threads lists the conversations,
 * GET /threads/:id reads one back. Pure functions over the conversation store
 * (./persistent-store), so the routes in index.ts only match the path.
 *
 * Only `complete` turns count, the same ones the model is handed as history: a
 * pending or failed turn is not part of the conversation. And only text leaves
 * here: the user's words, the assistant's final answer, and each attachment's
 * name and kind, never its body.
 */
import { decodeAssistantTurn, type AttachmentKind, type Message, type Turn } from '@flint/core';

/** What the routes read: PersistentStore has both. */
export interface ThreadSource {
  conversationIds(): string[];
  getTurns(conversationId: string): Promise<Turn[]>;
}

/** The most threads GET /threads lists. */
export const THREAD_LIMIT = 100;
/** A title is cut to this many characters, plus "…". */
export const TITLE_MAX = 60;
/** A thread id GET /threads/:id accepts. */
export const THREAD_ID = /^[A-Za-z0-9_-]{1,80}$/;

export interface ThreadSummary {
  id: string;
  title: string;
  /** Epoch ms of the last complete turn. */
  updatedAt: number;
  /** How many complete turns. */
  turns: number;
}

export interface ThreadTurn {
  /** Epoch ms the turn was asked. */
  ts: number;
  user: string;
  assistant: string;
  attachments: Array<{ name: string; kind: AttachmentKind }>;
}

export interface Thread {
  id: string;
  title: string;
  turns: ThreadTurn[];
}

export type ThreadResult =
  | { status: 200; body: Thread }
  | { status: 400; body: { error: 'bad thread id' } }
  | { status: 404; body: { error: 'no such thread' } };

const complete = (turns: Turn[]): Turn[] => turns.filter((t) => t.status === 'complete');

const firstUser = (t: Turn | undefined): Message | undefined => t?.messages.find((m) => m.role === 'user');

/** Whitespace collapsed, trimmed, cut to TITLE_MAX characters (never mid-emoji) with "…" when longer. */
function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const chars = Array.from(flat);
  return chars.length > TITLE_MAX ? `${chars.slice(0, TITLE_MAX).join('').trimEnd()}…` : flat;
}

/**
 * A thread's title: its first user message's text, never re-cased. A message
 * with no text is titled by its first named attachment, else "Untitled".
 */
export function threadTitle(turns: Turn[]): string {
  const m = firstUser(complete(turns)[0]);
  const text = clip(m?.content ?? '');
  if (text) return text;
  const named = clip(m?.attachments?.find((a) => a.name?.trim())?.name ?? '');
  return named || 'Untitled';
}

/** The assistant's final text, the way Flint.chat picks it: the last assistant message, else a tool turn's text. */
function finalText(messages: Message[]): string {
  let text = '';
  for (const m of messages) {
    if (m.role === 'assistant') text = m.content;
    else if (m.role === 'tool') {
      try {
        const said = decodeAssistantTurn(m).text;
        if (said) text = said;
      } catch {
        // A malformed tool turn says nothing.
      }
    }
  }
  return text;
}

function toThreadTurn(t: Turn): ThreadTurn {
  const user = t.messages.filter((m) => m.role === 'user');
  return {
    ts: t.createdAt,
    user: user[0]?.content ?? '',
    assistant: finalText(t.messages),
    // Built field by field so a body (data / text) can never ride along.
    attachments: user.flatMap((m) => m.attachments ?? []).map((a) => ({ name: a.name ?? 'unnamed', kind: a.kind })),
  };
}

/**
 * Every conversation with a complete turn, newest first by its last complete
 * turn, at most `limit`. Ids GET /threads/:id would refuse are left out, so
 * every thread listed can be opened.
 */
export async function listThreads(store: ThreadSource, limit = THREAD_LIMIT): Promise<ThreadSummary[]> {
  const out: ThreadSummary[] = [];
  for (const id of store.conversationIds()) {
    if (!THREAD_ID.test(id)) continue;
    const turns = complete(await store.getTurns(id));
    const last = turns[turns.length - 1];
    if (!last) continue;
    out.push({ id, title: threadTitle(turns), updatedAt: last.updatedAt, turns: turns.length });
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out.slice(0, limit);
}

/** One thread's complete turns, oldest first. 400 for an id that isn't one, 404 for one with no complete turn. */
export async function readThread(store: ThreadSource, id: string): Promise<ThreadResult> {
  if (!THREAD_ID.test(id)) return { status: 400, body: { error: 'bad thread id' } };
  const turns = complete(await store.getTurns(id));
  if (turns.length === 0) return { status: 404, body: { error: 'no such thread' } };
  return { status: 200, body: { id, title: threadTitle(turns), turns: turns.map(toThreadTurn) } };
}
