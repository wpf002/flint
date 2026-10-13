import { describe, it, expect, afterAll } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hardwareTierFor, hardwareTiersMarkdown } from '@flint/core';
import { COMMANDS, cleanChip, detectHardware, fileFor, isAbsoluteOn, parseNvidia, runnerFor, type CommandKey, type Run, type RunnerOptions } from '../src/hardware';

/**
 * Hardware detection. `run` is injected in every test: nothing is spawned.
 * The outputs are what the real commands print (the Apple ones from Will's Mac).
 */

const GIB = 2 ** 30;
const runner = (answers: Partial<Record<CommandKey, string | undefined>>): { run: Run; asked: CommandKey[] } => {
  const asked: CommandKey[] = [];
  return {
    asked,
    run: async (cmd) => {
      asked.push(cmd);
      return answers[cmd];
    },
  };
};

describe('detectHardware: Apple Silicon', () => {
  it('reads unified memory and the chip from sysctl', async () => {
    const { run, asked } = runner({ 'sysctl.memsize': '68719476736\n', 'sysctl.chip': 'Apple M5 Max\n', 'sysctl.arm64': '1\n' });
    const h = await detectHardware({ run, platform: 'darwin', arch: 'arm64', totalmem: () => 64 * GIB });
    expect(h).toEqual({ platform: 'darwin', arch: 'arm64', systemMemoryGb: 64, accelerator: 'apple-silicon', memoryGb: 64, chip: 'Apple M5 Max', notes: [] });
    expect(hardwareTierFor(h).id).toBe('48gb');
    // nvidia-smi is never asked on a Mac.
    expect(asked).not.toContain('nvidia.query');
  });

  it('a Node running under Rosetta on an Apple Silicon Mac is still Apple Silicon', async () => {
    const { run } = runner({ 'sysctl.memsize': '17179869184\n', 'sysctl.chip': 'Apple M1\n', 'sysctl.arm64': '1\n' });
    const h = await detectHardware({ run, platform: 'darwin', arch: 'x64', totalmem: () => 16 * GIB });
    expect(h).toMatchObject({ accelerator: 'apple-silicon', memoryGb: 16, chip: 'Apple M1' });
    // Three quarters of unified memory is a model's to use: 12 GB of 16, the 8 GB tier.
    expect(hardwareTierFor(h).id).toBe('8gb');
  });

  it('an Intel Mac has no accelerator: CPU Only', async () => {
    const { run } = runner({ 'sysctl.arm64': '0\n', 'sysctl.memsize': '34359738368\n' });
    const h = await detectHardware({ run, platform: 'darwin', arch: 'x64', totalmem: () => 32 * GIB });
    expect(h).toMatchObject({ accelerator: 'none', memoryGb: 0 });
    expect(h.notes).toEqual(['an Intel Mac: no accelerator Flint knows how to use']);
    expect(hardwareTierFor(h).id).toBe('cpu');
  });

  it('a real Intel Mac: sysctl has no hw.optional.arm64 and answers nothing, so it is CPU Only', async () => {
    const { run, asked } = runner({});
    const h = await detectHardware({ run, platform: 'darwin', arch: 'x64', totalmem: () => 16 * GIB });
    expect(h).toEqual({ platform: 'darwin', arch: 'x64', systemMemoryGb: 16, accelerator: 'none', memoryGb: 0, notes: ['an Intel Mac: no accelerator Flint knows how to use'] });
    expect(asked).toEqual(['sysctl.arm64']);
    expect(hardwareTierFor(h).id).toBe('cpu');
  });

  it("when sysctl does not answer, memory comes from the runtime and the note says so", async () => {
    const { run } = runner({});
    const h = await detectHardware({ run, platform: 'darwin', arch: 'arm64', totalmem: () => 24 * GIB });
    expect(h).toMatchObject({ accelerator: 'apple-silicon', memoryGb: 24 });
    expect(h.chip).toBeUndefined();
    expect(h.notes).toEqual(['sysctl hw.memsize did not answer: memory is from the runtime', 'sysctl machdep.cpu.brand_string did not answer']);
  });

  it('output that is not a byte count is not believed', async () => {
    for (const bad of ['', 'lots\n', '-5\n', '68719476736; rm -rf ~\n', '1e11\n', '9'.repeat(40)]) {
      const { run } = runner({ 'sysctl.memsize': bad, 'sysctl.chip': 'Apple M5 Max\n' });
      const h = await detectHardware({ run, platform: 'darwin', arch: 'arm64', totalmem: () => 8 * GIB });
      expect(h.memoryGb, JSON.stringify(bad)).toBe(8);
    }
  });
});

describe('detectHardware: NVIDIA', () => {
  it('one GPU: its name and VRAM', async () => {
    const { run } = runner({ 'nvidia.query': 'NVIDIA GeForce RTX 4090, 24564\n' });
    const h = await detectHardware({ run, platform: 'linux', arch: 'x64', totalmem: () => 128 * GIB });
    expect(h).toMatchObject({ accelerator: 'nvidia', memoryGb: 24, chip: 'NVIDIA GeForce RTX 4090', systemMemoryGb: 128, notes: [] });
    expect(hardwareTierFor(h).id).toBe('24gb');
  });

  it('two GPUs: the largest single one counts (a model is not split across them here)', async () => {
    const { run } = runner({ 'nvidia.query': 'NVIDIA GeForce RTX 3060, 12288\nNVIDIA RTX A6000, 49140\n' });
    const h = await detectHardware({ run, platform: 'linux', arch: 'x64', totalmem: () => 64 * GIB });
    expect(h).toMatchObject({ accelerator: 'nvidia', memoryGb: 48, chip: 'NVIDIA RTX A6000' });
    expect(hardwareTierFor(h).id).toBe('48gb');
  });

  it('cards sold at a tier size land in it, as nvidia-smi reports them', async () => {
    const tierOf = async (line: string): Promise<string> => hardwareTierFor(await detectHardware({ run: runner({ 'nvidia.query': `${line}\n` }).run, platform: 'linux', arch: 'x64', totalmem: () => 32 * GIB })).id;
    expect(await tierOf('Tesla T4, 15360')).toBe('16gb');
    expect(await tierOf('NVIDIA A10G, 23028')).toBe('24gb');
    expect(await tierOf('NVIDIA L4, 23034')).toBe('24gb');
    expect(await tierOf('NVIDIA A40, 46068')).toBe('48gb');
    expect(await tierOf('NVIDIA GeForce RTX 3060, 12288')).toBe('8gb');
  });

  it('a 2 to 4 GB card cannot hold a model: the machine is a CPU row, chosen by its RAM', async () => {
    const small = runner({ 'nvidia.query': 'NVIDIA GeForce GTX 1650, 4096\n' }).run;
    const h = await detectHardware({ run: small, platform: 'linux', arch: 'x64', totalmem: () => 16 * GIB });
    expect(h).toMatchObject({ accelerator: 'nvidia', memoryGb: 4, systemMemoryGb: 16 });
    expect(hardwareTierFor(h).id).toBe('cpu');
    expect(hardwareTierFor(await detectHardware({ run: small, platform: 'linux', arch: 'x64', totalmem: () => 4 * GIB })).id).toBe('cpu-small');
  });

  it('no GPU and little RAM: the smallest model alone', async () => {
    const h = await detectHardware({ run: runner({}).run, platform: 'linux', arch: 'x64', totalmem: () => 4 * GIB });
    expect(hardwareTierFor(h).id).toBe('cpu-small');
    expect(hardwareTierFor(h).fallbackModel).toBeUndefined();
    // A machine sold with 8 GB reports a little under it, and is not "low memory".
    expect(hardwareTierFor(await detectHardware({ run: runner({}).run, platform: 'linux', arch: 'x64', totalmem: () => 7.7 * GIB })).id).toBe('cpu');
  });

  it('a small GPU is the 8 GB tier', async () => {
    const { run } = runner({ 'nvidia.query': 'NVIDIA GeForce GTX 1070, 8192\n' });
    expect(hardwareTierFor(await detectHardware({ run, platform: 'win32', arch: 'x64', totalmem: () => 16 * GIB })).id).toBe('8gb');
  });

  it('no nvidia-smi, or one that lists nothing: no accelerator, CPU Only, with a note', async () => {
    const none = await detectHardware({ run: runner({}).run, platform: 'linux', arch: 'x64', totalmem: () => 32 * GIB });
    expect(none).toMatchObject({ accelerator: 'none', memoryGb: 0, notes: ['nvidia-smi is not installed or did not answer'] });
    expect(hardwareTierFor(none).id).toBe('cpu');
    const empty = await detectHardware({ run: runner({ 'nvidia.query': '\n' }).run, platform: 'linux', arch: 'x64', totalmem: () => 32 * GIB });
    expect(empty.notes).toEqual(['nvidia-smi listed no GPU']);
  });

  it('garbage output is dropped line by line, never trusted', async () => {
    const { run } = runner({ 'nvidia.query': 'NVIDIA-SMI has failed because it could not communicate with the driver\n$(reboot), 99999999999\n, 24000\nname only\nGPU, 0\n' });
    const h = await detectHardware({ run, platform: 'linux', arch: 'x64', totalmem: () => 32 * GIB });
    expect(h.accelerator).toBe('none');
  });
});

describe('parseNvidia / cleanChip', () => {
  it('reads MiB as GiB, to one decimal', () => {
    expect(parseNvidia('Tesla T4, 15360')).toEqual({ chip: 'Tesla T4', memoryGb: 15 });
    expect(parseNvidia('NVIDIA GeForce RTX 4080, 16376')).toEqual({ chip: 'NVIDIA GeForce RTX 4080', memoryGb: 16 });
    expect(parseNvidia('nope')).toBeUndefined();
  });

  it('a chip name keeps only the characters hardware names use, and is capped', () => {
    expect(cleanChip('Apple M5 Max')).toBe('Apple M5 Max');
    // The final review's C9: a parenthesis reached the screen ("NVIDIA GeForce GTX 1650 (Max-Q)"). None does now.
    expect(cleanChip('Intel(R) Core(TM) i9-9900K CPU @ 3.60GHz')).toBe('Intel Core i9-9900K CPU 3.60GHz');
    expect(cleanChip('NVIDIA GeForce GTX 1650 (Max-Q)')).toBe('NVIDIA GeForce GTX 1650 Max-Q');
    expect(cleanChip('AMD Ryzen(tm) 9 (c) 2024')).toBe('AMD Ryzen 9 2024');
    expect(cleanChip('Evil"; rm -rf ~ #`$(id)`\n<script>')).toBe('Evil rm -rf id script');
    for (const raw of ['a(b)c', '((()))x', 'NVIDIA (R) (TM)', 'x(', ')x']) expect(cleanChip(raw) ?? '', raw).not.toMatch(/[()]/);
    expect(cleanChip('x'.repeat(200))).toHaveLength(60);
    expect(cleanChip('   ')).toBeUndefined();
    expect(cleanChip('\u0000\u001b[31m')).toBe('31m');
  });
});

describe('the commands: fixed, absolute, and the only way anything is run', () => {
  it('COMMANDS is frozen all the way down', () => {
    expect(Object.isFrozen(COMMANDS)).toBe(true);
    for (const spec of Object.values(COMMANDS)) {
      expect(Object.isFrozen(spec)).toBe(true);
      expect(Object.isFrozen(spec.files)).toBe(true);
      for (const list of Object.values(spec.files)) expect(Object.isFrozen(list)).toBe(true);
      expect(Object.isFrozen(spec.args)).toBe(true);
    }
  });

  it('two programs, four commands: every path is absolute on the platform it is listed for, and every argument is a plain literal', () => {
    const programs = new Set<string>();
    for (const [key, spec] of Object.entries(COMMANDS)) {
      for (const [platform, list] of Object.entries(spec.files) as Array<[NodeJS.Platform, readonly string[]]>) {
        for (const f of list) {
          expect(isAbsoluteOn(platform, f), `${key} ${f}`).toBe(true);
          expect(f, key).toMatch(platform === 'win32' ? /^[A-Z]:\\[A-Za-z0-9\\._-]+$/ : /^(\/[A-Za-z0-9._-]+)+$/);
          programs.add(f.replace(/^.*[\\/]/, '').replace(/\.exe$/, ''));
        }
      }
      for (const a of spec.args) expect(a, key).toMatch(/^[A-Za-z0-9=,._-]+$/);
    }
    expect([...programs].sort()).toEqual(['nvidia-smi', 'sysctl']);
    expect(Object.keys(COMMANDS).sort()).toEqual(['nvidia.query', 'sysctl.arm64', 'sysctl.chip', 'sysctl.memsize']);
  });

  it('nvidia-smi is looked for where each platform puts it, WSL2 included, and sysctl only on a Mac', () => {
    expect(COMMANDS['nvidia.query'].files.linux).toEqual(['/usr/bin/nvidia-smi', '/usr/local/bin/nvidia-smi', '/usr/lib/wsl/lib/nvidia-smi']);
    expect(COMMANDS['nvidia.query'].files.win32).toEqual(['C:\\Windows\\System32\\nvidia-smi.exe']);
    expect(Object.keys(COMMANDS['sysctl.memsize'].files)).toEqual(['darwin']);
    const all = (): boolean => true;
    // The Windows path is a relative name on POSIX: it is never the program there, even if a file by that name exists.
    expect(fileFor(COMMANDS['nvidia.query'], 'linux', all)).toBe('/usr/bin/nvidia-smi');
    expect(fileFor(COMMANDS['nvidia.query'], 'linux', (f) => f.includes('wsl'))).toBe('/usr/lib/wsl/lib/nvidia-smi');
    expect(fileFor(COMMANDS['nvidia.query'], 'win32', all)).toBe('C:\\Windows\\System32\\nvidia-smi.exe');
    expect(fileFor(COMMANDS['nvidia.query'], 'darwin', all)).toBeUndefined();
    expect(fileFor(COMMANDS['sysctl.chip'], 'linux', all)).toBeUndefined();
  });

  it('a path that is not absolute on its platform is never run, whatever the table says', () => {
    expect(isAbsoluteOn('linux', 'C:\\Windows\\System32\\nvidia-smi.exe')).toBe(false);
    expect(isAbsoluteOn('darwin', 'nvidia-smi')).toBe(false);
    expect(isAbsoluteOn('win32', '/usr/bin/nvidia-smi')).toBe(false);
    expect(isAbsoluteOn('win32', '\\\\server\\share\\nvidia-smi.exe')).toBe(false);
    const all = (): boolean => true;
    expect(fileFor({ files: { linux: ['nvidia-smi', './nvidia-smi', 'C:\\x.exe'] }, args: [] }, 'linux', all)).toBeUndefined();
  });

  const src = readFileSync(join(__dirname, '..', 'src', 'hardware.ts'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

  it('the module runs programs with execFile only: no shell, no exec, no spawn, no string-built command', () => {
    // execFile is the only thing taken from child_process (a regular expression's own .exec is not a program).
    expect(code.match(/from 'node:child_process'/g)).toHaveLength(1);
    expect(code).toContain("import { execFile } from 'node:child_process';");
    expect(code).not.toMatch(/\bexecSync\b|\bspawn\b|\bspawnSync\b|\bfork\b|shell:\s*true|child_process'\)\.exec\b/);
    // One place starts a program. It takes the table's file and the table's args, spread into a fresh array: nothing
    // is concatenated in. (`opts.execFile` is a test's stand-in for the starter itself, never a command: the file,
    // the arguments and the limits are the same whoever starts it, and no module of the server passes one.)
    expect(code.match(/execFile\)?\(/g)).toHaveLength(1);
    expect(code).toContain("(opts.execFile ?? execFile)(file, [...spec.args], { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: MAX_OUTPUT, env: {}, windowsHide: true, shell: false }");
    for (const f of readdirSync(join(__dirname, '..', 'src')).filter((n) => n.endsWith('.ts'))) {
      expect(readFileSync(join(__dirname, '..', 'src', f), 'utf8'), f).not.toMatch(/runnerFor\([^)]*execFile\s*:/);
    }
    expect(code).toContain('const file = spec ? fileFor(spec, platform, opts.exists) : undefined;');
    // The server's runner is the one over COMMANDS, and nothing else in the server builds another.
    expect(code).toContain('export const runFixed: Run = runnerFor(COMMANDS);');
    expect(code.match(/\brunnerFor\b/g)).toHaveLength(2);
  });

  it('no other module of the server builds a runner or imports the command table', () => {
    const dir = join(__dirname, '..', 'src');
    for (const name of readdirSync(dir).filter((n) => n.endsWith('.ts') && n !== 'hardware.ts')) {
      expect(readFileSync(join(dir, name), 'utf8'), name).not.toMatch(/\brunnerFor\b|\bCOMMANDS\b.*from '\.\/hardware'/);
    }
  });

  it('no argument in the table is built from anything: the args are string literals in the source', () => {
    const table = /export const COMMANDS = Object\.freeze\(\{([\s\S]*?)\} as const satisfies/.exec(src)![1]!;
    expect(table).not.toMatch(/\$\{|`|\+\s*[a-zA-Z_]|process\.env|\bconcat\b/);
  });

  it('the runner takes a key of the table, so a caller cannot pass a command', () => {
    expect(src).toContain('export type Run = (cmd: CommandKey) => Promise<string | undefined>;');
    expect(src).toContain('export type CommandKey = keyof typeof COMMANDS;');
  });
});

describe('the time limit is a hard one (real children, started and ended by this test)', () => {
  const here = process.platform;
  const node = process.execPath;
  const dir = mkdtempSync(join(tmpdir(), 'flint-hw-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const pidIn = async (file: string): Promise<number> => {
    for (let i = 0; i < 100 && !existsSync(file); i++) await new Promise((r) => setTimeout(r, 20));
    return Number(readFileSync(file, 'utf8'));
  };

  it('a command that answers is read', async () => {
    const run = runnerFor({ hello: { files: { [here]: [node] }, args: ['-e', "process.stdout.write('68719476736')"] } }, { timeoutMs: 5000 });
    expect(await run('hello')).toBe('68719476736');
  });

  it('a child that ignores SIGTERM is killed at the limit, and the answer is "nothing"', async () => {
    const pidFile = join(dir, 'stubborn.pid');
    const script = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`;
    const run = runnerFor({ stubborn: { files: { [here]: [node] }, args: ['-e', script] } }, { timeoutMs: 600, graceMs: 200 });
    const started = Date.now();
    expect(await run('stubborn')).toBeUndefined();
    // Not the four seconds a SIGTERM that is ignored used to cost: the limit, and a little.
    expect(Date.now() - started).toBeLessThan(1500);
    const pid = await pidIn(pidFile);
    for (let i = 0; i < 50 && alive(pid); i++) await new Promise((r) => setTimeout(r, 20));
    expect(alive(pid)).toBe(false);
  });

  // The final review's L9: the test below was said to show that "the clock ends the wait", and it passes with the
  // clock taken out (execFile's own limit kills the child and lets go of its pipes). This one is about the clock
  // alone: a program that never calls back, and cannot be killed.
  it('the clock ends the wait even when the program never calls back and the kill does nothing', async () => {
    const kills: string[] = [];
    let started = 0;
    const never = ((_file: string, _args: readonly string[], _opts: unknown, _cb: unknown) => {
      started += 1;
      return { kill: (signal: string) => (kills.push(signal), false), on: () => undefined };
    }) as unknown as RunnerOptions['execFile'];
    const run = runnerFor({ silent: { files: { [here]: [node] }, args: [] } }, { timeoutMs: 150, graceMs: 100, execFile: never });
    const t0 = Date.now();
    expect(await run('silent')).toBeUndefined();
    const took = Date.now() - t0;
    // Not before the limit and its grace, and not long after: only the clock can have answered.
    expect(took).toBeGreaterThanOrEqual(240);
    expect(took).toBeLessThan(1500);
    expect(started).toBe(1);
    expect(kills).toEqual(['SIGKILL']);
  });

  it('a program whose start throws is "nothing" too, at once', async () => {
    const boom = (() => {
      throw new Error('spawn EACCES');
    }) as unknown as RunnerOptions['execFile'];
    const run = runnerFor({ broken: { files: { [here]: [node] }, args: [] } }, { timeoutMs: 5000, execFile: boom });
    const t0 = Date.now();
    expect(await run('broken')).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it('a grandchild that holds the pipes open cannot hold the answer: the limit lets go of the pipes', async () => {
    const pidFile = join(dir, 'grandchild.pid');
    // The grandchild inherits stdout and outlives its parent; execFile's own callback waits for that pipe to close.
    const inner = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 20000);`;
    const script = `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(inner)}], { stdio: 'inherit' }); setInterval(() => {}, 1000);`;
    const run = runnerFor({ holder: { files: { [here]: [node] }, args: ['-e', script] } }, { timeoutMs: 500, graceMs: 200 });
    const started = Date.now();
    expect(await run('holder')).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1500);
    // This test started the grandchild, and ends it.
    const pid = await pidIn(pidFile);
    if (alive(pid)) process.kill(pid, 'SIGKILL');
    for (let i = 0; i < 50 && alive(pid); i++) await new Promise((r) => setTimeout(r, 20));
    expect(alive(pid)).toBe(false);
  });

  it('a program that is not there, a key that is not in the table, and a platform with no path are all "nothing"', async () => {
    const table = { missing: { files: { [here]: ['/nonexistent/flint-no-such-program'] }, args: [] }, elsewhere: { files: { aix: [node] }, args: [] } } as const;
    const run = runnerFor(table, { timeoutMs: 500 });
    expect(await run('missing')).toBeUndefined();
    expect(await run('elsewhere')).toBeUndefined();
    expect(await (run as (k: string) => Promise<string | undefined>)('constructor')).toBeUndefined();
  });
});

describe('the tier table is documented from the data', () => {
  it("the server's README and the root README carry exactly the table in the code", () => {
    const table = hardwareTiersMarkdown();
    for (const readme of [join(__dirname, '..', 'README.md'), join(__dirname, '..', '..', '..', 'README.md')]) {
      expect(readFileSync(readme, 'utf8'), readme).toContain(table);
    }
  });

  it('rows Flint has not measured say so', () => {
    expect(hardwareTiersMarkdown()).toContain('recommended, unmeasured');
  });
});
