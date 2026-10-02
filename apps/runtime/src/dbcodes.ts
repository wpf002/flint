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
