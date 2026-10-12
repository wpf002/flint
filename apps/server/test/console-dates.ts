/**
 * Dates in the console's tests. The console formats a date in the browser's
 * own locale, and leaves the year off a date in the current year, so a test
 * that expected "Apr 5, 2027" passed only in en-US and only until 2027. These
 * keep the tests true wherever and whenever they run.
 */
import { runInContext, type Context } from 'node:vm';

/** Run in a console script's own context, before its code: dates and times are formatted as en-US. */
export function pinLocale(ctx: object): void {
  runInContext(
    `(function(){var d=Date.prototype,names=['toLocaleDateString','toLocaleTimeString','toLocaleString'];
      names.forEach(function(n){var f=d[n];d[n]=function(_locales,options){return f.call(this,'en-US',options);};});})();`,
    ctx as Context,
  );
}

/** A year the console always writes out: never the current one, in any time zone, on any day. */
export const LATER_YEAR = new Date().getUTCFullYear() + 2;

/** Midnight UTC on a day of that year (a policy row's last day), as the server sends it. */
export const laterDay = (month: number, day: number): string => new Date(Date.UTC(LATER_YEAR, month - 1, day)).toISOString();

/** That day as the console shows it: "Apr 5, 2028". */
export const shownDay = (month: number, day: number): string =>
  `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][month - 1]} ${day}, ${LATER_YEAR}`;
