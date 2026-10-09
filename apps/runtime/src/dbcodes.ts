/**
 * A database trigger or check refusing a row for what it contains (23514
 * check_violation). A privilege fault (42501) is the runtime's own problem, not
 * the caller's input: it stays a 500, so the caller keeps the entry and retries.
 * Prisma puts the SQLSTATE in `code`, in `meta.code` (a raw query, P2010), or
 * only in the message, by the path the query took.
 */
export function dbRefused(err: unknown): boolean {
  const e = err as { code?: unknown; meta?: { code?: unknown }; message?: unknown };
  return [e.code, e.meta?.code].map(String).includes('23514') || (typeof e.message === 'string' && /code: "23514"|Code: `23514`/.test(e.message));
}

/**
 * The SQLSTATE of a database error, wherever Prisma put it, or undefined. Only
 * the code: a Postgres message can carry the row it refused ("Failing row
 * contains (...)"), and a goal's row holds Will's words.
 */
export function sqlState(err: unknown): string | undefined {
  const e = (err ?? {}) as { name?: unknown; code?: unknown; meta?: { code?: unknown }; message?: unknown };
  const state = (c: unknown) => (typeof c === 'string' && /^[0-9A-Z]{5}$/.test(c) ? c : undefined);
  // A Prisma error's own `code` is Prisma's (P2010), not Postgres's; pg's `code` is the SQLSTATE.
  const own = typeof e.name === 'string' && e.name.startsWith('PrismaClient') ? undefined : state(e.code);
  const found = state(e.meta?.code) ?? own;
  if (found) return found;
  const m = typeof err === 'string' ? err : typeof e.message === 'string' ? e.message : '';
  return /code: "([0-9A-Z]{5})"|Code: `([0-9A-Z]{5})`/.exec(m)?.slice(1).find(Boolean);
}

/** The constraint a database error names (a CHECK's or an index's name, never a value), or undefined. */
export function constraintOf(message: string): string | undefined {
  return /constraint \\?"([A-Za-z0-9_]{1,63})\\?"/.exec(message)?.[1] ?? /Constraint: `([A-Za-z0-9_]{1,63})`/.exec(message)?.[1];
}

/** `TypeError`, `PrismaClientKnownRequestError P2002`, `Error ECONNREFUSED`: what failed, not what it said. */
export function failureClass(err: unknown): string {
  if (!(err instanceof Error)) return 'error';
  const code = (err as { code?: unknown }).code;
  return `${err.name.slice(0, 60)}${typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? ` ${code}` : ''}`;
}

/**
 * What failed and, for a database error, its SQLSTATE and the constraint it
 * names: all a log line or a card may say about an error. An error already
 * reduced to that (a goal executor's GoalFailure) says its own.
 */
export function failureOf(err: unknown): string {
  const reduced = (err as { name?: unknown; failure?: unknown } | null)?.failure;
  if (err instanceof Error && err.name === 'GoalFailure' && typeof reduced === 'string') return reduced;
  const what = failureClass(err);
  const state = sqlState(err);
  // Only a database error's constraint: the first one named is Postgres's own (the row's DETAIL comes after it).
  const constraint = state && err instanceof Error ? constraintOf(err.message) : undefined;
  return [what, state && !what.endsWith(` ${state}`) ? state : '', constraint ?? ''].filter(Boolean).join(' ');
}

/**
 * A stack frame as V8 writes it, and nothing else: `    at fn (/abs/file.ts:1:2)`,
 * `    at async Obj.fn (node:internal/x:3:4)`, `    at file:///abs/file.ts:1:2`. A
 * name never has a space, and the place is an absolute path or node's own.
 */
const FRAME = /^ {4}at (?:(?:async |new )?[\w$.<>[\]]{1,200}(?: \[as [\w$]{1,100}\])? \()?(?:file:\/\/|node:)?\/?[^\s()]{1,300}:\d+:\d+\)?$/;

/**
 * The top frames of an error's stack, to see where it failed. Only what comes
 * after the message (which may span lines, and a line of it may look like a
 * frame), and only lines in a frame's exact shape.
 */
export function framesOf(err: unknown, max = 6): string[] {
  const own = (err as { frames?: unknown } | null)?.frames;
  if (Array.isArray(own)) return own.filter((f): f is string => typeof f === 'string').slice(0, max);
  if (!(err instanceof Error) || typeof err.stack !== 'string') return [];
  const at = err.message ? err.stack.indexOf(err.message) : -1;
  const rest = at >= 0 ? err.stack.slice(at + err.message.length) : err.stack;
  return rest.split('\n').filter((l) => FRAME.test(l) && (l.includes('/') || l.includes('node:'))).slice(0, max).map((l) => l.trim());
}

/**
 * One failure as a log line: a refusal of Flint's own as its status and sentence
 * (its words are Flint's), anything else as failureOf; then the top frames.
 */
export function failureReport(err: unknown): string {
  const r = err as { name?: unknown; status?: unknown; message?: unknown } | null;
  const head = err instanceof Error && r?.name === 'Refused' && typeof r.status === 'number' ? `Refused ${r.status}: ${String(r.message).slice(0, 300)}` : failureOf(err);
  const frames = framesOf(err);
  return frames.length ? `${head}\n  ${frames.join('\n  ')}` : head;
}

/**
 * The schema is not the one the code expects (a table, column, function or
 * schema missing: 42P01, 42703, 42883, 3F000/42P02): a deploy out of order,
 * which a later deploy clears. Running the same thing again may well work.
 */
export function schemaSkew(state: string | undefined): boolean {
  return state === '42P01' || state === '42703' || state === '42883' || state === '42P02' || state === '3F000';
}
