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

/** What failed and, for a database error, its SQLSTATE: all a log line or a card may say about an error. */
export function failureOf(err: unknown): string {
  const what = failureClass(err);
  const state = sqlState(err);
  return state && !what.endsWith(` ${state}`) ? `${what} ${state}` : what;
}
