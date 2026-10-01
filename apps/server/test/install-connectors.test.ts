import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(__dirname, '..', '..', '..');
const SCRIPT = readFileSync(join(REPO, 'apps', 'server', 'install-server.sh'), 'utf8');
/** The connector loop exactly as install-server.sh has it. */
const LOOP = SCRIPT.slice(SCRIPT.indexOf('echo "rebuilding installed connectors from source..."'), SCRIPT.indexOf('\ndone\n', SCRIPT.indexOf('rebuilding installed connectors')) + 6);
const ESBUILD = spawnSync('/bin/sh', ['-c', `find "${REPO}/node_modules/.pnpm" -path '*esbuild*/bin/esbuild' -type f | head -1`], { encoding: 'utf8' }).stdout.trim();

/** A connector source with no imports: answers initialize and tools/list over stdio. */
const WORKING = `let buf='';process.stdin.on('data',(d)=>{buf+=d;for(const l of buf.split('\\n')){let m;try{m=JSON.parse(l)}catch{continue}
if(m.id===1)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:1,result:{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'x',version:'1'}}})+'\\n');
if(m.id===2)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:2,result:{tools:[{name:'t',inputSchema:{type:'object'}}]}})+'\\n');}
buf=buf.slice(buf.lastIndexOf('\\n')+1)});`;

function deploy(sources: Record<string, string>, installed: string[], mcp?: (data: string) => object) {
  const root = mkdtempSync(join(tmpdir(), 'install-'));
  const repo = join(root, 'repo');
  const data = join(root, 'data');
  mkdirSync(join(repo, 'packages', 'mcp', 'connectors'), { recursive: true });
  mkdirSync(join(repo, 'apps', 'server'), { recursive: true });
  mkdirSync(join(data, 'connectors'), { recursive: true });
  cpSync(join(REPO, 'apps', 'server', 'connector-smoke.mjs'), join(repo, 'apps', 'server', 'connector-smoke.mjs'));
  for (const [name, src] of Object.entries(sources)) writeFileSync(join(repo, 'packages', 'mcp', 'connectors', `${name}.ts`), src);
  for (const name of installed) writeFileSync(join(data, 'connectors', `${name}.mjs`), 'old bundle');
  if (mcp) writeFileSync(join(data, 'mcp.json'), JSON.stringify(mcp(data)));
  const loop = () => spawnSync('/bin/zsh', ['-c', `set -e\nREPO=${repo}\nDATA=${data}\nESBUILD=${ESBUILD}\n${LOOP}\necho END`], { encoding: 'utf8' });
  const r = loop();
  const read = (f: string) => readFileSync(join(data, 'connectors', f), 'utf8');
  const files = () => readdirSync(join(data, 'connectors')).sort();
  const again = () => {
    const r2 = loop();
    return { out: r2.stdout + r2.stderr, status: r2.status, files: files() };
  };
  return { out: r.stdout + r.stderr, status: r.status, files: files(), read, again };
}

// Review of #33: auto-deploy never rebuilt the connectors, so a connector fix
// "deployed" without going live; and a rebuilt bundle that dies at startup must
// not replace a working one. A first version of the swap built to <name>.mjs.new,
// which node refuses to run, so every connector was "rejected": this test runs the
// script's own loop, end to end, so that cannot recur.
describe('install-server.sh connector rebuild', () => {
  it('swaps in a rebuilt connector that starts, keeping the old one as .prev', () => {
    const r = deploy({ 'web-server': WORKING }, ['web-server']);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/✓ web-server \(1 tools\)/);
    expect(r.read('web-server.mjs')).toContain('jsonrpc');
    expect(r.read('web-server.mjs.prev')).toBe('old bundle');
    expect(r.files).toEqual(['web-server.mjs', 'web-server.mjs.prev']);
  });

  it('keeps the old bundle when the new one builds but dies at startup', () => {
    const r = deploy({ 'tdl-server': 'const dir = tdlDirFromConfig(); export {};' }, ['tdl-server']);
    expect(r.out).toMatch(/✗ tdl-server built but did not start \(.*tdlDirFromConfig is not defined.*\); the old bundle stays/);
    expect(r.read('tdl-server.mjs')).toBe('old bundle');
    expect(r.files).toEqual(['tdl-server.mjs']);
    expect(r.out).toMatch(/END/); // the deploy carries on
  });

  it('keeps the old bundle when the new one does not build, and leaves no-source bundles alone', () => {
    const r = deploy({ 'hive-server': 'this is not typescript (' }, ['hive-server', 'legacy-server']);
    expect(r.out).toMatch(/✗ hive-server failed to build; the old bundle stays/);
    expect(r.out).toMatch(/= legacy-server: no source in this repo, kept/);
    expect(r.read('hive-server.mjs')).toBe('old bundle');
    expect(r.files).toEqual(['hive-server.mjs', 'legacy-server.mjs']);
    expect(r.out).toMatch(/END/);
  });

  // Third review of #33: every deploy rebuilt every connector and overwrote .prev
  // with the live bundle, so the last-known-good copy lasted one more push.
  it('leaves an unchanged connector alone, so .prev keeps the bundle from before the last real change', () => {
    const r = deploy({ 'web-server': WORKING }, ['web-server']);
    expect(r.read('web-server.mjs.prev')).toBe('old bundle');
    const r2 = r.again();
    expect(r2.out).toMatch(/= web-server unchanged/);
    expect(r.read('web-server.mjs.prev')).toBe('old bundle');
    expect(r2.files).toEqual(['web-server.mjs', 'web-server.mjs.prev']);
  });

  it("test-starts a connector with its mcp.json env, as the server would start it", () => {
    const needsEnv = `if (process.env.TDL_DIR !== '/data/tdl') throw new Error('TDL_DIR not set');\n${WORKING}`;
    const r = deploy({ 'tdl-server': needsEnv }, ['tdl-server'], (data) => ({
      servers: [{ name: 'tdl', command: process.execPath, args: [join(data, 'connectors', 'tdl-server.mjs')], env: { TDL_DIR: '/data/tdl' } }],
    }));
    expect(r.out).toMatch(/✓ tdl-server \(1 tools as tdl\)/);
  });
});

