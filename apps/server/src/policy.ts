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
  'digest', 'status', 'health', 'forecast', 'predict',
  'score', 'scores', 'rank', 'rankings', 'compare', 'recent', 'latest',
  'upcoming', 'history', 'detail', 'details', 'snapshot', 'coverage', 'bias',
  'quote', 'quotes', 'signal', 'signals', 'top', 'best', 'recommend',
  'recommendations', 'info', 'stats', 'metrics', 'peek', 'browse',
  // Removed, each because it is also an action verb and let a write through:
  //   'load'   -> load_funds, load_card
  //   'report' -> report_spam, report_user
  //   'check'  -> check_in, check_out (a purchase), check_and_rebalance
]);

/**
 * Segments that move or commit money. Any one of them denies the tool, EVEN
 * WHEN a read segment is present, because the read verb proves nothing about
 * the rest of the name: `bank.load_funds`, `top_up` and `check_and_rebalance`
 * all carried a read segment and auto-approved before this set existed.
 *
 * Deliberately broad. It will deny a few genuine reads (`get_funding_rate`,
 * `list_charges`); those queue for one tap. The asymmetry is the same one
 * isSafeTool is built on.
 *
 * Matched per segment, never as a substring: `market` must not hit `mark`,
 * and `balance` (a read noun: `get_balance`) is not in here.
 */
export const MONEY_SEGMENTS = new Set([
  'fund', 'funds', 'funding', 'topup', 'rebalance', 'rebalancing',
  'payout', 'payouts', 'payment', 'payments', 'payee', 'refund', 'refunds',
  'charge', 'charges', 'invoice', 'invoices', 'debit', 'credit', 'credits',
  'loan', 'loans', 'borrow', 'lend', 'repay', 'stake', 'unstake', 'staking',
  'swap', 'bridge', 'mint', 'wager', 'bet', 'bets', 'donate', 'donation',
  'allocate', 'allocation', 'hedge', 'short', 'margin', 'collateral',
  'redeem', 'cashout', 'checkout', 'purchase', 'order', 'orders', 'trade',
  'trades', 'position', 'positions',
]);

/**
 * Money nouns that are ALSO the object of ordinary reads (`list_orders`,
 * `get_positions`, `recent_trades`). For these the read is allowed only when a
 * read verb is the FIRST segment of the tool name, i.e. the name is shaped
 * like `<read>_<noun>`. `bank.orders` or `fill_order` still deny.
 */
const READABLE_MONEY = new Set(['order', 'orders', 'trade', 'trades', 'position', 'positions']);

/**
 * Segments that act on the outside world but were missing from WRITE_TOOL.
 * Matched per segment for the same reason as MONEY_SEGMENTS: `mark` must not
 * hit `market`, `label` must not hit a read of labels unless it is the verb.
 */
export const WRITE_SEGMENTS = new Set([
  'mark', 'flag', 'label', 'unlabel', 'spam', 'star', 'unstar', 'pin', 'unpin',
  'snooze', 'mute', 'unmute', 'block', 'unblock', 'follow', 'unfollow', 'like',
  'react', 'vote', 'rsvp', 'accept', 'decline', 'forward', 'import', 'sync',
]);

/** Joining words mean a compound action: `check_and_rebalance`, `fetch_then_send`. */
const COMPOUND_SEGMENTS = new Set(['and', 'then']);

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

  // The tool's own name, without its server namespace: `hive.list_orders` -> [list, orders].
  const dot = tool.lastIndexOf('.');
  const own = dot >= 0 ? segmentsOf(tool.slice(dot + 1)) : segs;

  if (segs.some((s) => COMPOUND_SEGMENTS.has(s))) return false;
  // `top` is a read (`top_scores`) except in `top_up`, which adds money.
  if (segs.some((s, i) => s === 'top' && segs[i + 1] === 'up')) return false;
  if (segs.some((s) => WRITE_SEGMENTS.has(s))) return false;

  for (const s of segs) {
    if (!MONEY_SEGMENTS.has(s)) continue;
    // A readable money noun passes only in `<read>_<noun>` shape.
    if (READABLE_MONEY.has(s) && own.length > 0 && READ_SEGMENTS.has(own[0]!)) continue;
    return false;
  }

  return segs.some((s) => READ_SEGMENTS.has(s));
}
