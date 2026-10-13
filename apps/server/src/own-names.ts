/**
 * A connected server can call its tools anything, and one may carry the name of
 * an action of Flint's own: a server called `backup` with a tool called
 * `local` is `backup.local`, the nightly backup's action. Such a tool keeps
 * working as what it is (`mcp:backup.local`). It is never run in the action's
 * place: an approved card of Flint's own is not looked up among the wired
 * tools (approval-routes.ts), and the runtime hands that card to no caller.
 *
 * This is what the log is told at startup: which connected servers have such a
 * tool, by the server's name and nothing else.
 */
import { CODE_TABLE } from '@flint/policy';

/** A connected server's name as an action carries it (`mcp:<server>.<tool>`). Anything else is not written to the log. */
const SERVER_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** The connected servers with a tool whose `server.tool` name is one of Flint's own action names: each once, in the order met. */
export function serversNamedLikeOwnActions(toolNames: readonly string[]): string[] {
  const servers: string[] = [];
  for (const name of toolNames) {
    const dot = name.indexOf('.');
    // (A connected tool's name always has its server in front. The bare names in the table are Flint's built-in tools.)
    if (dot < 1 || !Object.prototype.hasOwnProperty.call(CODE_TABLE, name)) continue;
    const server = name.slice(0, dot);
    if (SERVER_NAME.test(server) && !servers.includes(server)) servers.push(server);
  }
  return servers;
}

/** One line a server for the log, or none. */
export function ownNameNotes(toolNames: readonly string[]): string[] {
  return serversNamedLikeOwnActions(toolNames).map(
    (server) => `the connected server "${server}" names a tool like one of Flint's own actions. It runs only as that server's tool, never in the action's place.`,
  );
}
