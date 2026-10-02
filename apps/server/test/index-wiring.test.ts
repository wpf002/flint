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
});
