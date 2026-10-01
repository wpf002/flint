import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
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
const run = (bundle: string, ms = 5000) => spawnSync(process.execPath, [SMOKE, bundle, String(ms)], { encoding: 'utf8' });

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
});
