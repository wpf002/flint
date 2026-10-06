/**
 * How index.ts wires the P2 pieces (it runs main() on import, so this reads
 * its source): /chat turns are counted after auth and validation, never an
 * eval /generate; "World now" reaches frontier calls only (never the local
 * fallback, never /generate); a chat.turn event ends each /chat turn and no
 * /generate turn; an eval replay's 5xx is not a route.error.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(__dirname, '..', 'src', 'index.ts'), 'utf8');
const between = (a: string, b: string) => {
  const i = src.indexOf(a);
  const j = src.indexOf(b, i + 1);
  expect(i).toBeGreaterThan(0);
  expect(j).toBeGreaterThan(i);
  return src.slice(i, j);
};
const generate = between("url === '/generate'", "url === '/chat'");
const chat = between("url === '/chat'", "url === '/eval/tools'");

describe('index.ts wiring', () => {
  it('counts /chat turns after the bearer check and the request checks, and never /generate', () => {
    expect(src.indexOf('bearerScope(req.headers.authorization')).toBeLessThan(src.indexOf("url === '/chat'"));
    expect(chat.indexOf("if ('error' in route)")).toBeLessThan(chat.indexOf('ctx.chatLoad.run('));
    expect(chat.indexOf('ctx.chatLoad.run(')).toBeGreaterThan(0);
    expect(generate).not.toContain('chatLoad');
  });

  it('World now is off unless FLINT_WORLD_NOW=1 (it costs tokens on every frontier turn)', () => {
    expect(src).toContain("process.env.FLINT_WORLD_NOW?.trim() === '1' ? new WorldNow(");
  });

  it('asks for World now only for a planned frontier turn, and hands it only to the frontier tiers', () => {
    expect(generate).not.toMatch(/worldNow|frontierCtx/);
    expect(chat).toContain("brain === 'frontier' && plan && ctx.worldNow ? ctx.worldNow.block()");
    // The frontier chain gets it; the local brain (first choice or fallback) does not.
    expect(chat).toMatch(/await pump\(b\.persona, [^;]*, frontierCtx\)/);
    expect(chat.match(/await pump\(ctx\.persona\)/g)).toHaveLength(2);
    expect(chat.match(/frontierCtx/g)).toHaveLength(2); // defined once, used once
  });

  it('ends each /chat turn with a chat.turn event, and no /generate turn with one', () => {
    expect(chat).toContain('ctx.events.push(chatTurnEvent(');
    expect(generate).not.toMatch(/events\.push|chatTurnEvent/);
  });

  it("reports a 5xx answer as route.error, except an eval replay's", () => {
    expect(src).toMatch(/res\.statusCode >= 500 && res\.statusCode <= 599 && route && !turn\?\.eval\) events\.push\(\{ type: 'route\.error'/);
  });

  it('a reply stopped mid-stream because no brain has budget left sends Will the reason beside the raw error', () => {
    // The refusal the stream throws is the one Will reads: set just before that throw, and only there.
    expect(chat).toMatch(/stopWords = budget\.localRefusal;\s*throw new Error\(`frontier failed: \$\{String\(err\)\}\. \$\{budget\.localRefusal\}`\);/);
    expect(chat.match(/stopWords = /g)).toHaveLength(1);
    expect(chat).toContain("res.write(`data: ${JSON.stringify({ type: 'error', error: String(err), ...(stopWords ? { message: stopWords } : {}) })}\\n\\n`);");
  });

  it('the Watcher starts only while FLINT_WATCHER is not off (P2.5)', () => {
    expect(src).toContain('if (watcherEnabled()) new Watcher(notes, buildChecks(tools, knowledge)).start();');
    expect(src.match(/new Watcher\(/g)).toHaveLength(1);
  });
});
