/**
 * Flint's routing + auto-approval policy, extracted so it is TESTABLE.
 *
 * These two functions are the highest-consequence logic in the server — one
 * decides whether a message leaves the machine, the other decides whether a
 * tool runs without asking. They used to live inline in index.ts, which calls
 * main() at import time and therefore could not be unit-tested at all.
 */

export type Brain = 'local' | 'frontier';

/**
 * Keep a query on the LOCAL brain when the user asks to in plain language —
 * complements the explicit Local-only toggle.
 */
export const FORCE_LOCAL_RE =
  /\b(stay local|keep it local|keep this local|local only|on[- ]?device|on[- ]?machine|don'?t use claude|privately|keep this private|keep it private)\b/i;

/**
 * Which brain answers. Flint IS Claude by default — equal-to-Claude capability
 * on every query. The local model is used when no frontier is configured, when
 * the user flips Local-only, or when the message asks to stay on-device.
 *
 * `localOnly` is HONORED. It was ignored for a while because a sticky console
 * lock silently trapped answers on the weak 7B; the console now clears the flag
 * on every load, so the toggle is safe to obey — and a privacy switch that lies
 * is worse than no switch.
 */
export function judgeBrain(message: string, hasFrontier: boolean, localOnly: boolean): Brain {
  if (!hasFrontier) return 'local'; // no Claude configured → local fallback
  if (localOnly) return 'local'; // the user's explicit privacy choice
  if (FORCE_LOCAL_RE.test(message)) return 'local';
  return 'frontier'; // default: Flint runs on Claude
}

/** Read verbs may appear anywhere in the name (e.g. gmail_search, gcal_upcoming). */
export const READ_TOOL =
  /(search|list|read|get|fetch|lookup|find|query|upcoming|forecast|model|recent|summary|view|status|count|coverage|bias|quote|position|market|account|order|worker|\bbot|industr|digest|signal|score|ticker|detail|snapshot|trade|job|rule|recommend|health|latest|\btop|best)/i;

/**
 * Anything that writes, sends, acts, or moves money is denied — there is no
 * human in the loop at this layer, so it queues for one-tap approval instead.
 *
 * NOTE: these are ACTION VERBS, deliberately not the nouns. `get_positions` and
 * `list_orders` are reads and must stay auto-approved; `close_position` and
 * `submit_order` must not. Matching on the verb separates them; matching on the
 * noun would break every legitimate read of a trading system.
 */
export const WRITE_TOOL =
  /(send|create|update|delete|remove|trash|cancel|reply|draft|compose|schedule|book|insert|\bpost\b|\bput\b|transfer|\bpay\b|buy|sell|place_order|enable|disable|start_|stop_|move_|write_|add_to|set_|execut|submit|close_|liquidat|modify|archiv|terminat|withdraw|deposit|\bwire\b|\bfund\b|revoke|grant|approve|reject|trigger|\brun\b|\bexec\b|kill|restart|reset|purge|drop|truncate|rename|upload|share|invite|subscribe|publish|deploy|merge|push|commit|rollback)/i;

/**
 * The hardest rule Flint has: he observes and reports on markets, he NEVER
 * trades or moves money. This list wins over everything else, so a connector
 * that ever exposes an execution tool cannot be auto-approved by an accident of
 * naming — it queues for explicit human approval or it does not run.
 */
export const NEVER_AUTO =
  /(execut|liquidat|submit|withdraw|deposit|\bwire\b|transfer|\bpay\b|buy|sell|place_order|close_position|cancel_order|modify_order)/i;

/**
 * A tool that may run without human approval: read-only, or Flint's own memory
 * (`remember`, which only writes to local memory — never the outside world).
 *
 * Deny-by-default: a name must look like a read AND must not look like an
 * action. Anything unrecognised falls through to `false` and queues.
 */
export function isSafeTool(tool: string): boolean {
  if (tool === 'remember') return true;
  // MCP tools are namespaced `server.tool` — judge the tool half.
  const name = tool.includes('.') ? tool.slice(tool.indexOf('.') + 1) : tool;
  if (NEVER_AUTO.test(name)) return false; // absolute deny, wins over everything
  if (WRITE_TOOL.test(name)) return false;
  return READ_TOOL.test(name);
}
