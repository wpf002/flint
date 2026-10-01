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

// The tool-name rules (isSafeTool and the sets behind it) moved to @flint/policy,
// where the runtime's tier engine uses them too. Re-exported so imports here hold.
export {
  READ_SEGMENTS,
  MONEY_SEGMENTS,
  WRITE_SEGMENTS,
  WRITE_TOOL,
  NEVER_AUTO,
  segmentsOf,
  isSafeTool,
} from '@flint/policy';
