/**
 * The console's version, for auto-update: a short hash of the page as
 * deployed. The server stamps it into the page it serves (window.__FLINT_UI__)
 * and answers GET /ui-version with the current one, so an open console (the
 * Mac app, the phone) can tell a deploy replaced it and reload itself at a
 * quiet moment. Read fresh on every request, as the page is: a deploy copies
 * the new page over the old without restarting the server.
 */
import { createHash } from 'node:crypto';

/** 16 hex characters of the page's SHA-256. */
export function uiVersionOf(page: string): string {
  return createHash('sha256').update(page, 'utf8').digest('hex').slice(0, 16);
}

/** The page with its own version stamped in, just before </head>. */
export function stampUiVersion(page: string): string {
  return page.replace('</head>', `<script>window.__FLINT_UI__=${JSON.stringify(uiVersionOf(page))}</script></head>`);
}
