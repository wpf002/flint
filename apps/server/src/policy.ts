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

/** What the attachments on a turn need, and what the frontier model can read. */
export interface MediaFlags {
  image?: boolean;
  pdf?: boolean;
}

export type TurnRoute =
  | {
      brain: Brain;
      /**
       * Whether a frontier failure may silently retry on the local brain. False
       * when the turn carries an image/PDF: the local model would answer
       * WITHOUT seeing the file, and a confident answer about a picture it never
       * saw is worse than an error.
       */
      localFallback: boolean;
    }
  | { error: string };

/**
 * judgeBrain, plus the one thing it can't know: an image or PDF can only be
 * read by a frontier model that supports it. Text-file attachments are just
 * text and route exactly like a plain message.
 *
 * Privacy still wins. If Local-only is on (or the message asks to stay
 * private), an image is NOT quietly shipped to the frontier — the turn is
 * refused with a message that says why, so the user decides.
 */
export function routeTurn(opts: {
  message: string;
  hasFrontier: boolean;
  localOnly: boolean;
  needs: MediaFlags;
  frontierCan: MediaFlags;
}): TurnRoute {
  const brain = judgeBrain(opts.message, opts.hasFrontier, opts.localOnly);
  const visual = !!opts.needs.image || !!opts.needs.pdf;
  if (!visual) return { brain, localFallback: true };

  const what = opts.needs.image && opts.needs.pdf ? 'images or PDFs' : opts.needs.image ? 'images' : 'PDFs';
  if (brain === 'local') {
    if (!opts.hasFrontier) {
      return { error: `The local brain can't read ${what}, and no frontier brain is configured. Send it as text instead.` };
    }
    return {
      error: `Local-only is on, and the on-device brain can't read ${what}. Turn Local-only off to send the file to the frontier brain, or remove the attachment.`,
    };
  }
  if ((opts.needs.image && !opts.frontierCan.image) || (opts.needs.pdf && !opts.frontierCan.pdf)) {
    return { error: `The frontier brain configured here can't read ${what}.` };
  }
  return { brain: 'frontier', localFallback: false };
}

/**
 * Segments that MEAN "read". A tool auto-approves only if one of its name
 * segments is in this set — nouns are deliberately NOT here.
 *
 * The previous version matched a substring regex that included `position`,
 * `order`, `trade`, `account` and `market`. Those are nouns, so `close_position`
 * was denied only because a hand-written blocklist named it, while its exact
 * mirrors — `open_position`, `exit_position`, `flatten_position`, `new_order`,
 * `market_order`, `fill_order`, `place_trade`, `fund_account` — all sailed
 * through. A blocklist of verbs against an allowlist of nouns is not
 * deny-by-default; this is.
 */
export const READ_SEGMENTS = new Set([
  'search', 'list', 'read', 'get', 'fetch', 'lookup', 'find', 'query', 'view',
  'show', 'describe', 'inspect', 'count', 'summary', 'summarize', 'summarise',
  'digest', 'report', 'status', 'health', 'check', 'forecast', 'predict',
  'score', 'scores', 'rank', 'rankings', 'compare', 'recent', 'latest',
  'upcoming', 'history', 'detail', 'details', 'snapshot', 'coverage', 'bias',
  'quote', 'quotes', 'signal', 'signals', 'top', 'best', 'recommend',
  'recommendations', 'info', 'stats', 'metrics', 'peek', 'browse', 'load',
]);

/** Split a tool name into comparable segments: `gcal.list_events` -> [gcal, list, events]. */
export function segmentsOf(tool: string): string[] {
  return tool.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

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
 * GENUINELY deny-by-default. A name must positively prove it is a read by
 * carrying a read verb as one of its segments; anything unrecognised is denied
 * and queues for one-tap approval. Denying a real read is a mild annoyance;
 * auto-running a real trade is not, so the asymmetry is deliberate.
 *
 * NOTE ON SCOPE: this gate only sees tools the MCP layer classified 'guarded'.
 * A connector that self-declares `readOnlyHint: true` is classified 'safe' in
 * packages/mcp/src/client.ts and never reaches this function at all.
 */
export function isSafeTool(tool: string): boolean {
  if (tool === 'remember') return true;
  // Judge the WHOLE name, not just the half after the dot — a namespace can
  // carry the dangerous word (e.g. `execute.trade`).
  if (NEVER_AUTO.test(tool)) return false; // absolute deny, wins over everything
  if (WRITE_TOOL.test(tool)) return false;
  const segs = segmentsOf(tool);
  if (segs.length === 0) return false;
  return segs.some((s) => READ_SEGMENTS.has(s));
}
