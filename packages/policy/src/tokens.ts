/**
 * A text's cost in tokens, estimated without a tokenizer: shared by the server's
 * context blocks (World now) and the runtime's local-model prompts (a goal
 * review's plan stage), so both fit their budgets by the same measure.
 */

/**
 * Tokens a text costs, estimated a little high: letters at four to a token,
 * every digit and every symbol a token of its own (ids and refs are where a
 * chars/4 estimate runs low).
 */
export function estimateTokens(text: string): number {
  let n = 0;
  for (const m of text.matchAll(/[A-Za-z]+|[^\sA-Za-z]/g)) n += /^[A-Za-z]/.test(m[0]) ? Math.ceil(m[0].length / 4) : 1;
  return n;
}
