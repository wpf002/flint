import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SMOKE = join(__dirname, '..', 'connector-smoke.mjs');
const dir = mkdtempSync(join(tmpdir(), 'smoke-'));

/** A stand-in connector: answers initialize and tools/list over stdio like an MCP server. */
function fakeConnector(name: string, tools: number): string {
  const f = join(dir, name);
  writeFileSync(
    f,
    `let buf='';process.stdin.on('data',d=>{buf+=d;for(const l of buf.split('\\n')){let m;try{m=JSON.parse(l)}catch{continue}
     if(m.id===1)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:1,result:{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'x',version:'1'}}})+'\\n');
     if(m.id===2)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:2,result:{tools:Array.from({length:${tools}},(_,i)=>({name:'t'+i,inputSchema:{type:'object'}}))}})+'\\n');}
     buf=buf.slice(buf.lastIndexOf('\\n')+1)});`,
  );
  return f;
}
const run = (bundle: string, ms = 5000, extra: string[] = [], env: NodeJS.ProcessEnv = process.env) =>
  spawnSync(process.execPath, [SMOKE, bundle, String(ms), ...extra], { encoding: 'utf8', env });

/** A connector that starts only when `check` (a JS expression) holds, else throws `why`. */
function picky(name: string, check: string, why: string): string {
  const f = fakeConnector(name, 1);
  writeFileSync(f, `if (!(${check})) throw new Error(${JSON.stringify(why)});\n` + readFileSync(f, 'utf8'));
  return f;
}
function config(entries: object[]): string {
  const f = join(dir, `mcp-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(f, JSON.stringify({ servers: entries }));
  return f;
}

// Review of #33: a connector that builds can still die at startup, and the
// server's /health would not notice its tools were gone. Deploy swaps a rebuilt
// bundle in only when this passes.
describe('connector-smoke.mjs', () => {
  it('passes a connector that starts and lists its tools', () => {
    const r = run(fakeConnector('ok.mjs', 3));
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('3 tools');
  });

  it('fails one that crashes at startup, naming the error', () => {
    const f = join(dir, 'crash.mjs');
    writeFileSync(f, 'const x = tdlDirFromConfig();');
    const r = run(f);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/exited 1 before listing tools: .*tdlDirFromConfig is not defined/);
  });

  it('fails one that never answers', () => {
    const f = join(dir, 'silent.mjs');
    writeFileSync(f, 'setInterval(() => {}, 1000);');
    const r = run(f, 1500);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/no tool list within 1500ms/);
  });

  it('fails one that lists no tools', () => {
    const r = run(fakeConnector('empty.mjs', 0));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/listed no tools/);
  });

  // Third review of #33: the server starts a connector with its mcp.json command,
  // args, cwd and env; a smoke that didn't would pass a bundle that only breaks
  // under its real config, and fail one that needs its config to start.
  it('starts it the way the server would: mcp.json env, args and cwd', () => {
    const installed = join(dir, 'installed', 'needy-server.mjs');
    const work = join(dir, 'work');
    mkdirSync(work, { recursive: true });
    // argv: [node, bundle, --flag]; cwd compared by real path (macOS tmp is a symlink).
    const candidate = picky('needy.new.mjs', `process.env.NEEDED === 'yes' && process.cwd() === ${JSON.stringify(realpathSync(work))} && process.argv[2] === '--flag'`, 'missing config');
    const cfg = config([{ name: 'needy', command: process.execPath, args: [installed, '--flag'], env: { NEEDED: 'yes' }, cwd: work }]);
    const r = run(candidate, 5000, [installed, cfg]);
    expect(r.stderr).toBe('');
    expect(r.stdout.trim()).toBe('1 tools as needy');
    expect(run(candidate).status).toBe(1); // without its entry it can't start
  });

  it('catches a bundle that breaks only under its real config', () => {
    const installed = join(dir, 'installed', 'web-server.mjs');
    const candidate = picky('envy.new.mjs', `process.env.SEARCH_PROVIDER !== 'auto'`, 'auto config parse bug');
    const cfg = config([{ name: 'web', command: process.execPath, args: [installed], env: { SEARCH_PROVIDER: 'auto' } }]);
    const r = run(candidate, 5000, [installed, cfg]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/exited 1 before listing tools as web: .*auto config parse bug/);
  });

  it("fills ${NAME} from the environment, and passes nothing else of the deploy's", () => {
    const installed = join(dir, 'installed', 'filled-server.mjs');
    const candidate = picky('filled.new.mjs', `process.env.TOKEN_FROM_ENV === 'abc' && process.env.LEAKY === undefined`, 'env not as the server sets it');
    const cfg = config([{ name: 'filled', command: process.execPath, args: [installed], env: { TOKEN_FROM_ENV: '${FLINT_TEST_TOKEN}' } }]);
    const r = run(candidate, 5000, [installed, cfg], { ...process.env, FLINT_TEST_TOKEN: 'abc', LEAKY: '1' });
    expect(r.stdout.trim()).toBe('1 tools as filled');
  });

  it('reports a connector that dies at once by its own exit, not an EPIPE', () => {
    const f = join(dir, 'quick-exit.mjs');
    writeFileSync(f, 'console.error("Error: no database"); process.exit(3);');
    for (let i = 0; i < 5; i++) {
      const r = run(f);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/exited 3 before listing tools: Error: no database/);
      expect(r.stderr).not.toMatch(/EPIPE/);
    }
  });
});

