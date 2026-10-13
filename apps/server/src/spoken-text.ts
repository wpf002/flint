/**
 * Is this text part of that reply? Asked by `/speak` (./goals-chat
 * speechStaysHere): a client names the turn whose reply it wants spoken, and
 * the words it sends must be that turn's own. Otherwise a client that names an
 * ordinary turn and sends another reply's words (one that stays on this Mac)
 * would have them sent to the outside speech service.
 *
 * What a client sends is not the reply byte for byte. The console speaks a
 * sentence at a time, and first makes it sayable (`speakForVoice` in
 * apps/console/index.html: markdown marks dropped, "97°F" said as "97 degrees
 * Fahrenheit"). The voice app sends the whole reply as it came. So the test is
 * on WORDS: the text's words, in order and next to each other, are in the
 * reply's words, with the reply taken as it came or made sayable the same way.
 *
 * Kept free of index.ts so it is unit-testable (index.ts runs main() on import).
 */

/**
 * A reply made sayable, as the console does it before it asks for speech. Kept
 * word for word with `speakForVoice` in apps/console/index.html
 * (test/console-speech.test.ts runs both on the same text).
 */
export function forVoice(s: string): string {
  return s
    .replace(/[*_`#>[\]]/g, '')
    .replace(/(\d)\s*°\s*F\b/g, '$1 degrees Fahrenheit')
    .replace(/(\d)\s*°\s*C\b/g, '$1 degrees Celsius')
    .replace(/°/g, ' degrees')
    .replace(/\bmph\b/gi, ' miles per hour')
    .replace(/(\d)\s*%/g, '$1 percent')
    .replace(/\bRealFeel\b/gi, 'real feel')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A text as its words alone: lower case, letters and digits, one space between. */
function wordsOf(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Are the words of `text`, in order and together, in `reply` (as it came, or made sayable)? Text with no words is part of nothing. */
export function isPartOf(text: string, reply: string): boolean {
  const said = wordsOf(text);
  if (!said) return false;
  const within = (whole: string): boolean => ` ${wordsOf(whole)} `.includes(` ${said} `);
  return within(reply) || within(forVoice(reply));
}
