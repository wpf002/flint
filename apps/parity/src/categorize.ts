/**
 * Cheap, deterministic category tags for a prompt. Tools the original turn used
 * are the strongest signal (they say what the task actually needed); keywords
 * decide the rest. No model call: the tag has to be reproducible for the set to
 * stay frozen.
 */

export const CATEGORIES = [
  'research',
  'email-calendar-drive',
  'finance-systems',
  'coding',
  'planning-writing',
  'knowledge',
  'chit-chat',
] as const;
export type Category = (typeof CATEGORIES)[number];

export interface Taggable {
  input: string;
  tools?: Array<{ tool: string }> | undefined;
  /**
   * Written by a seeding script. The teacher web-searched plenty of timeless
   * textbook questions ("what caused the Bronze Age collapse?"), so for these a
   * search tool alone doesn't make the prompt current-events research.
   */
  synthetic?: boolean;
}

const FINANCE_TOOL = /^(vantage|bellwether|meridian|prophet|tdl)\./i;
const GOOGLE_TOOL = /(gmail|gcal|gdrive|calendar|drive|email)/i;
const RESEARCH_TOOL = /(web_search|fetch_url|perplexity|search)/i;

// Keyword sets lean toward precision: "portfolio theory" is a knowledge question,
// "my portfolio" is Will's systems. A missed tag costs a little balance; a wrong
// one puts a textbook question in the finance bucket and skews the breakdown.
const FINANCE_KW =
  /\b(vantage|bellwether|meridian|prophet|watchlists?|my (portfolio|positions|holdings|trades|stocks)|trading signals?|market signals?|market digest)\b/i;
const GOOGLE_KW =
  /\b(gmail|gcal|inbox|google drive|gdrive|google docs?|my (e-?mails?|calendar|meetings|schedule|drive|docs|appointments)|(any|new|unread) e-?mails?|on my calendar)\b/i;
const CODING_KW =
  /(```|\b(coding|my code|this code|code review|typescript|javascript|python|rust|golang|sql|regex|stack ?trace|compiler?|refactor|repo|github|npm|pnpm|unit tests?|dockerfile|kubernetes|segfault|null pointer|type ?error)\b|\b\w+\.(ts|js|py|rs|go|tsx)\b)/i;
const RESEARCH_KW =
  /\b(today|tonight|tomorrow|yesterday|this week|latest|currently|right now|news|weather|forecast|standings|rankings?|odds|price of|who won|will win|search the web|look up|20[2-3]\d|ufc|nfl|nba|mlb|playoffs?|election)\b/i;
const WRITING_KW =
  /(^(write|rewrite|draft|outline|plan|make me|create|summari[sz]e|edit|proofread|help me|give me)\b|\b(essay|blog post|tweet|cover letter|subject lines?|itinerary|checklist|agenda)\b)/i;
const KNOWLEDGE_KW =
  /^(what|why|how|explain|describe|compare|when|which|who|is|are|was|were|does|do|did|can|tell me about)\b|\b(difference between|mechanism|vs\.?|versus)\b/i;
/** About Flint or Will himself — conversation, not a knowledge question. */
const PERSONAL = /\b(are you|do you (know|remember|think|like)|have you|can you|your (own|brain|training|memory|name)|you'?re|flint|my|me)\b/i;

/**
 * First match wins, in this order: the user's own systems (finance, Google) are
 * the most specific; then coding; then live research; then writing/planning; then
 * explanatory knowledge questions; chit-chat is what's left.
 */
export function categorize(rec: Taggable): Category {
  const text = rec.input;
  const tools = (rec.tools ?? []).map((t) => t.tool);

  if (tools.some((t) => FINANCE_TOOL.test(t))) return 'finance-systems';
  if (tools.some((t) => GOOGLE_TOOL.test(t))) return 'email-calendar-drive';
  if (FINANCE_KW.test(text)) return 'finance-systems';
  if (GOOGLE_KW.test(text)) return 'email-calendar-drive';
  if (CODING_KW.test(text)) return 'coding';
  if (!rec.synthetic && tools.some((t) => RESEARCH_TOOL.test(t))) return 'research';
  if (RESEARCH_KW.test(text)) return 'research';
  if (WRITING_KW.test(text.trim())) return 'planning-writing';
  const words = wordCount(text);
  if (words >= 3 && !PERSONAL.test(text) && (KNOWLEDGE_KW.test(text.trim()) || (text.trim().endsWith('?') && words >= 6))) {
    return 'knowledge';
  }
  return 'chit-chat';
}

export function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}
