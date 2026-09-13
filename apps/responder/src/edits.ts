import type { TurnEdit, TurnFile } from './prompt.js';

/*
 * Changing part of a file without resending it.
 *
 * Every revision used to be the whole file again: a three-line CSS fix cost the page's
 * 2,500 output tokens, and revision turns in the fifth product build ran to 9,000. An
 * edit names the exact text to replace and what to put there, and the file it lands in
 * is written whole from here, so nothing downstream changes.
 *
 * Exact and unique, or refused. A find that matches nowhere or in two places is not a
 * change anyone asked for, and applying a guess would be worse than applying nothing.
 * A refused edit is reported back to the thread, where the next turn can send the
 * right text or the whole file.
 */

export interface EditFailure {
  name: string;
  reason: string;
}

export interface Applied {
  /** Files to write: those sent whole, then those changed by edits. */
  files: TurnFile[];
  failed: EditFailure[];
}

export function applyEdits(
  edits: TurnEdit[],
  files: TurnFile[],
  built: Array<{ name: string; content: string }>,
): Applied {
  const out = new Map<string, TurnFile>(files.map((f) => [f.name, { ...f }]));
  const failed: EditFailure[] = [];

  for (const edit of edits) {
    const current = out.get(edit.name)?.content ?? built.find((b) => b.name === edit.name)?.content;
    if (current === undefined) {
      failed.push({ name: edit.name, reason: 'no such file in the thread; send it whole in "files"' });
      continue;
    }

    const at = locate(current, edit.find);
    if (at === 'missing') {
      failed.push({ name: edit.name, reason: 'the text to find is not in the file as it stands' });
      continue;
    }
    if (at === 'ambiguous') {
      failed.push({ name: edit.name, reason: 'the text to find appears more than once; include more of the surrounding lines' });
      continue;
    }

    const content = current.slice(0, at.index) + edit.replace + current.slice(at.index + at.length);
    if (content.trim().length === 0) {
      failed.push({ name: edit.name, reason: 'would leave the file empty' });
      continue;
    }
    const before = out.get(edit.name);
    out.set(edit.name, { name: edit.name, content, note: edit.note ?? before?.note ?? null });
  }

  return { files: [...out.values()], failed };
}

/**
 * Where one exact occurrence of `find` sits, allowing for the whitespace a model adds
 * around a snippet it quotes: the text is tried as sent, then without its leading and
 * trailing line breaks.
 */
function locate(haystack: string, find: string): { index: number; length: number } | 'missing' | 'ambiguous' {
  for (const needle of [find, find.replace(/^\n+|\n+$/g, '')]) {
    if (needle.length === 0) continue;
    const index = haystack.indexOf(needle);
    if (index === -1) continue;
    if (haystack.indexOf(needle, index + needle.length) !== -1) return 'ambiguous';
    return { index, length: needle.length };
  }
  return 'missing';
}
