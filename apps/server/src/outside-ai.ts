/**
 * What may leave this Mac through a tool, on a turn that has promised
 * something about that. There are TWO promises, and they are not the same:
 *
 *  A PRIVATE turn (the Local Only switch, or a message that asks to stay
 *  private): NOTHING leaves this Mac. The turn is offered only the tools on an
 *  explicit list of ones that run here (`runsHere`): Flint's own memory, its
 *  own status, the calculator, and the runtime's reads of this Mac's own data.
 *  No web search of any kind (a keyless search still sends the question to
 *  search engines), no page fetch (the address carries words), no account
 *  tools (they ask Google), no deep research. Any other tool that is called
 *  anyway refuses (`keptHereOnPrivate`), whoever calls it. The model is told
 *  in one sentence (`privateTurnNote`).
 *
 *  LOCAL MODE, an ordinary turn: no outside AI and no paid service. Every
 *  tool in the paid-tool table (./spend paidToolSpecs) is one or the other:
 *  Perplexity's search is its model answering, and Tavily's search returns an
 *  answer its own model wrote. A paid tool with a keyless switch runs keyless
 *  (`web.web_search` on the SearXNG on this Mac), and any other paid tool is
 *  not offered and refuses if called. Keyless web search, the page fetch and
 *  Will's own account tools REMAIN: Local mode keeps the answer on this Mac,
 *  it does not cut Flint off from the web.
 *
 * So "stays here" (./private-turns turnStaysHere: private, or Local mode) and
 * "explicitly private" are kept apart. History, memory and speech follow the
 * first. Tools follow the second, and Local mode's narrower rule.
 *
 * Kept free of index.ts so it is unit-testable (index.ts runs main() on import).
 */
import { staysOn } from './inference-status';

/** Why paid tools are off, said to the model. */
export const OUTSIDE_OFF_LOCAL_MODE = 'Flint is in Local mode, which uses no outside AI and no paid service.';
/** Why every tool that is not on this Mac is off, said to the model. */
export const OUTSIDE_OFF_PRIVATE = `This message is private, so nothing outside ${staysOn(false)} is asked.`;
/**
 * The same, when the local model is on another machine that Will said is his
 * (FLINT_LOCAL_ALLOW_REMOTE): the message did go there, so the sentence names
 * it, in the words Settings uses (./inference-status staysOn).
 */
export const OUTSIDE_OFF_PRIVATE_SERVER = `This message is private, so nothing outside ${staysOn(true)} is asked.`;
export type OutsideOff = typeof OUTSIDE_OFF_LOCAL_MODE | typeof OUTSIDE_OFF_PRIVATE | typeof OUTSIDE_OFF_PRIVATE_SERVER;

/** The private rule's sentence, for where the local model is. */
export function outsideOffPrivate(allowedRemote: boolean): OutsideOff {
  return allowedRemote ? OUTSIDE_OFF_PRIVATE_SERVER : OUTSIDE_OFF_PRIVATE;
}

/** Is this the private rule's sentence (either wording), and not Local mode's? */
export function isPrivateOff(off: string): boolean {
  return off === OUTSIDE_OFF_PRIVATE || off === OUTSIDE_OFF_PRIVATE_SERVER;
}

/**
 * What a private turn's model is told, in its context, in one sentence: what
 * is not there, so it does not promise a search it cannot make. It says where
 * the message stays as Settings does: this Mac, or this Mac or the model
 * server Will allowed.
 */
export function privateTurnNote(allowedRemote: boolean): string {
  return `[Private message: nothing outside ${staysOn(allowedRemote)} is asked for it, so answer from this conversation and what you already know, with no web search, page reading, account lookup or research.]`;
}

/** The note when the local model is on this Mac. */
export const PRIVATE_TURN_NOTE = privateTurnNote(false);

/** A turn's context with that sentence at its end, for a private turn; as it is for any other. */
export function withPrivateNote(context: string, isPrivate: boolean, allowedRemote = false): string {
  if (!isPrivate) return context;
  const note = privateTurnNote(allowedRemote);
  return context ? `${context}\n\n${note}` : note;
}

/** The built-in tools that run on this Mac and reach nothing else. */
export const LOCAL_BUILTINS: ReadonlySet<string> = new Set(['remember', 'training_status', 'calculate', 'spend_status']);

/**
 * The MCP servers whose tools only read this Mac's own data: the runtime's
 * connector, over its loopback API. A server that reads this Mac's own files
 * would be listed here; one that asks anything elsewhere never is.
 */
export const LOCAL_SERVERS: ReadonlySet<string> = new Set(['runtime']);

/** Is this tool on the list of ones that run on this Mac? The list a private turn is offered from. */
export function runsHere(name: string): boolean {
  if (LOCAL_BUILTINS.has(name)) return true;
  const dot = name.indexOf('.');
  return dot > 0 && LOCAL_SERVERS.has(name.slice(0, dot));
}

/** What a tool that is not on this Mac answers when it is called on a private turn anyway. */
export function privateToolRefused(allowedRemote: boolean): string {
  return `${outsideOffPrivate(allowedRemote)} Answer from what you already know, and say that searching is not available for a private message.`;
}

/** The refusal when the local model is on this Mac. */
export const PRIVATE_TOOL_REFUSED = privateToolRefused(false);

/**
 * Hold every tool that does not run here to the private rule at call time:
 * called on a private turn, it refuses, whoever called it (a model that named
 * a tool it was not offered, or deep_research searching by itself). A tool
 * that runs here is returned as it is. `allowedRemote`: the local model is on
 * a server Will allowed, and the refusal says so.
 */
export function keptHereOnPrivate<T extends { definition: { name: string }; handler: (call: never) => unknown }>(
  tools: readonly T[],
  deps: { isPrivate: () => boolean; onRefused?: (name: string) => void; allowedRemote?: () => boolean },
): T[] {
  return tools.map((tool) => {
    if (runsHere(tool.definition.name)) return tool;
    const handler = ((call: never) => {
      if (!deps.isPrivate()) return tool.handler(call);
      deps.onRefused?.(tool.definition.name);
      return { isError: true, content: privateToolRefused(deps.allowedRemote?.() === true) };
    }) as T['handler'];
    return { ...tool, handler };
  });
}

interface ToolLike {
  definition: { name: string; inputSchema?: unknown };
}

/** The names of the tools an outside service answers, from the paid-tool table. */
export function outsideTools(specs: ReadonlyArray<{ name: string }>): ReadonlySet<string> {
  return new Set(specs.map((s) => s.name));
}

/**
 * The outside tools that can run with no outside service at all: the table
 * gives them a keyless switch, and the tool that is wired really has it (an
 * older server's does not, and is then as outside as any other).
 */
export function keylessCapable(tools: readonly ToolLike[], specs: ReadonlyArray<{ name: string; keylessArg?: string }>): ReadonlySet<string> {
  const arg = new Map(specs.filter((s) => s.keylessArg).map((s) => [s.name, s.keylessArg!] as const));
  return new Set(
    tools
      .filter((t) => {
        const a = arg.get(t.definition.name);
        const props = (t.definition.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
        return a !== undefined && !!props && Object.prototype.hasOwnProperty.call(props, a);
      })
      .map((t) => t.definition.name),
  );
}

/** The tools that are not offered while outside services are off: the outside ones that cannot run keyless. */
export function withheldWhenOff(tools: readonly ToolLike[], specs: ReadonlyArray<{ name: string; keylessArg?: string }>): ReadonlySet<string> {
  const keyless = keylessCapable(tools, specs);
  return new Set([...outsideTools(specs)].filter((name) => !keyless.has(name)));
}

/** The tools an ordinary turn is offered: all of them, minus the withheld paid ones while those are off (Local mode). */
export function offered<T extends { definition: { name: string } }>(tools: readonly T[], withheld: ReadonlySet<string>, off: boolean): T[] {
  return off ? tools.filter((t) => !withheld.has(t.definition.name)) : [...tools];
}

/** The tools a private turn is offered: the ones that run on this Mac, and no other. */
export function offeredPrivate<T extends { definition: { name: string } }>(tools: readonly T[]): T[] {
  return tools.filter((t) => runsHere(t.definition.name));
}

/**
 * What a refused paid tool tells the model: why, and what still works. In
 * Local mode it names the tools that are wired and are neither an outside AI
 * nor paid: a search that can run keyless, the page fetch. On a private turn
 * nothing outside this Mac works, and it names none.
 */
export function outsideOffText(off: string, opts: { wired: ReadonlySet<string>; keyless: ReadonlySet<string>; fetchTool?: string }): string {
  if (isPrivateOff(off)) return privateToolRefused(off === OUTSIDE_OFF_PRIVATE_SERVER);
  const still = [...opts.keyless].filter((t) => opts.wired.has(t));
  if (opts.fetchTool && opts.wired.has(opts.fetchTool)) still.push(opts.fetchTool);
  if (still.length > 0) return `${off} Use ${still.join(' or ')} instead, or answer from what you already know and say that live research is limited right now.`;
  return `${off} Answer from what you already know, and say that live search is not available right now.`;
}
