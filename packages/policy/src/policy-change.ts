/**
 * What a policy change card says: ONE thing. It adds rules (`rows`), or it
 * switches rules off (`off`), and it holds nothing else.
 *
 * The two halves are checked by two guards in the database (a row is made only
 * as its card's `rows` list it; a row that holds an action back goes off only
 * when its card's `off` names it). A card that carried both would serve both
 * under one signature: it could read "Switch Off 1 Rule" and add a rule that
 * lets something run on its own. So the shape is held everywhere a card is
 * handled, each on its own: the database refuses to file any other, the
 * runtime refuses to file or carry one out, the server refuses to start a
 * signature for one, and the console never titles one as a switch-off.
 */
export type PolicyChangeKind = 'rows' | 'off';

/**
 * Which one thing a policy change's args say, or undefined when they are not
 * exactly one of the two shapes: an object with one key, `rows` or `off`,
 * holding a list that is not empty.
 */
export function policyChangeKind(args: unknown): PolicyChangeKind | undefined {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return undefined;
  const keys = Object.keys(args);
  if (keys.length !== 1) return undefined;
  const key = keys[0];
  if (key !== 'rows' && key !== 'off') return undefined;
  const list = (args as Record<string, unknown>)[key];
  return Array.isArray(list) && list.length > 0 ? key : undefined;
}

/** What Will reads when a rule card is neither: it is not signed, and nothing it says is carried out. */
export const POLICY_CHANGE_SHAPE = 'It can’t be signed: a rule card adds rules or switches rules off, never both.';

/**
 * Does a rule's pattern cover a policy change itself (`policy.change`, `policy.*`, anything under `policy.`)?
 * No rule may: a policy change always takes Will's signature, and a rule that forbade it could never be
 * signed away (the card that switches it off is a policy change too).
 */
export function coversPolicyChange(pattern: string): boolean {
  return pattern === 'policy' || pattern.startsWith('policy.');
}
