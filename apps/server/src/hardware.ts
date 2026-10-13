/**
 * What this machine can run a local model on: its platform, an NVIDIA GPU and
 * its VRAM, or an Apple Silicon Mac's unified memory. The hardware tier table
 * (@flint/core HARDWARE_TIERS) turns that into a recommended model.
 *
 * It asks the operating system with two programs (`sysctl` on a Mac,
 * `nvidia-smi` elsewhere) and four fixed commands, and nothing here can be
 * talked into running anything else:
 *  - every command is a row of `COMMANDS`, a frozen table of absolute paths
 *    and a fixed argument list. A caller passes a KEY of that table, never a
 *    string; there is no code path that builds a command or an argument;
 *  - the paths are chosen by platform, and a path that is not absolute on the
 *    platform it is for is never run;
 *  - `execFile`, never a shell: no interpolation, no globbing, no `$PATH`
 *    lookup (a shadowed binary earlier on PATH cannot be run by mistake);
 *  - an empty environment, and 64 KB of output at most;
 *  - a hard time limit. At 3 seconds the child is killed with SIGKILL, which a
 *    program cannot ignore; and whatever the child or its pipes do, the answer
 *    is "nothing" 250 ms after that (a clock, not the child, ends the wait);
 *  - what comes back is read with anchored patterns and length caps, and a
 *    line that does not match is dropped. A chip's name keeps only letters,
 *    digits, spaces and + - . (a parenthesis becomes a space: "GTX 1650
 *    (Max-Q)" is shown as "GTX 1650 Max-Q"), because it ends up on screen.
 *
 * Nothing here throws: a command that is missing, slow or strange is a note in
 * the result. What the machine is then taken for depends on what was not
 * learned:
 *  - an Apple Silicon Mac whose `sysctl` does not answer is still an Apple
 *    Silicon Mac (the runtime itself reports arm64 on macOS), and its memory
 *    is the runtime's own count (`os.totalmem()`, the same number), with a
 *    note. It is tiered by that, not dropped to a CPU row;
 *  - anywhere else, an `nvidia-smi` that is missing or silent means no
 *    accelerator: a CPU row, by the machine's RAM;
 *  - RAM that is not known is the smallest CPU row, the least to ask of a
 *    machine (@flint/core hardwareTierFor).
 * FLINT_HARDWARE_TIER overrides all of it.
 * The server looks at the machine behind its boot (./inference): detection is
 * never between Flint and listening.
 *
 * Kept free of index.ts so it is unit-testable (index.ts runs main() on import).
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { arch as osArch, platform as osPlatform, totalmem } from 'node:os';
import { posix, win32 } from 'node:path';
import type { Accelerator } from '@flint/core';

export interface Hardware {
  platform: NodeJS.Platform;
  arch: string;
  accelerator: Accelerator;
  /** VRAM of the largest NVIDIA GPU, or Apple unified memory, in GiB. 0 with no accelerator. */
  memoryGb: number;
  /** The machine's RAM in GiB. */
  systemMemoryGb: number;
  /** "Apple M5 Max", "NVIDIA GeForce RTX 4090": letters, digits, spaces and + - . only (no parentheses: the console shows none), 60 characters. */
  chip?: string;
  /** Checks that did not answer, by name. */
  notes: string[];
}

/** One fixed command: where the program may be, by platform, and its arguments. */
export interface CommandSpec {
  /** Absolute paths to try, first that exists wins. A platform that is not listed has none: the command is not run there. */
  readonly files: Readonly<Partial<Record<NodeJS.Platform, readonly string[]>>>;
  readonly args: readonly string[];
}

const SYSCTL = Object.freeze({ darwin: Object.freeze(['/usr/sbin/sysctl']) });

/** The ONLY commands hardware detection may run. A caller passes a key, never a string. */
export const COMMANDS = Object.freeze({
  'sysctl.memsize': Object.freeze({ files: SYSCTL, args: Object.freeze(['-n', 'hw.memsize']) }),
  'sysctl.chip': Object.freeze({ files: SYSCTL, args: Object.freeze(['-n', 'machdep.cpu.brand_string']) }),
  'sysctl.arm64': Object.freeze({ files: SYSCTL, args: Object.freeze(['-n', 'hw.optional.arm64']) }),
  'nvidia.query': Object.freeze({
    files: Object.freeze({
      // The last is where WSL2 puts the Windows driver's nvidia-smi.
      linux: Object.freeze(['/usr/bin/nvidia-smi', '/usr/local/bin/nvidia-smi', '/usr/lib/wsl/lib/nvidia-smi']),
      win32: Object.freeze(['C:\\Windows\\System32\\nvidia-smi.exe']),
    }),
    args: Object.freeze(['--query-gpu=name,memory.total', '--format=csv,noheader,nounits']),
  }),
} as const satisfies Readonly<Record<string, CommandSpec>>);
export type CommandKey = keyof typeof COMMANDS;

/** Run one of COMMANDS: its output, or undefined when it is not there, failed, or took too long. */
export type Run = (cmd: CommandKey) => Promise<string | undefined>;

const TIMEOUT_MS = 3_000;
/** After the kill, how long the clock waits for the child to be reaped before answering without it. */
const KILL_GRACE_MS = 250;
const MAX_OUTPUT = 64 * 1024;

/** Is `file` absolute on `platform`? (`C:\x` is absolute on Windows and a relative name anywhere else.) */
export function isAbsoluteOn(platform: NodeJS.Platform, file: string): boolean {
  return platform === 'win32' ? win32.isAbsolute(file) && /^[A-Za-z]:[\\/]/.test(file) : posix.isAbsolute(file);
}

/** The program a command runs on this platform: the first listed path that is absolute here and exists. */
export function fileFor(spec: CommandSpec, platform: NodeJS.Platform, exists: (f: string) => boolean = existsSync): string | undefined {
  return (spec.files[platform] ?? []).find((f) => isAbsoluteOn(platform, f) && exists(f));
}

export interface RunnerOptions {
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  graceMs?: number;
  exists?: (f: string) => boolean;
  /** Start the program (tests: one that never calls back, to show that the clock alone ends the wait). */
  execFile?: typeof execFile;
}

/**
 * A runner over a table of fixed commands. The server's is `runFixed`, over
 * COMMANDS; a test builds one over its own table to exercise the limits.
 * Never throws, never a shell, and always answers within `timeoutMs + graceMs`.
 */
export function runnerFor<T extends Readonly<Record<string, CommandSpec>>>(table: T, opts: RunnerOptions = {}): (cmd: keyof T & string) => Promise<string | undefined> {
  const platform = opts.platform ?? osPlatform();
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  const graceMs = opts.graceMs ?? KILL_GRACE_MS;
  return (cmd) =>
    new Promise((resolve) => {
      const spec = Object.prototype.hasOwnProperty.call(table, cmd) ? table[cmd] : undefined;
      const file = spec ? fileFor(spec, platform, opts.exists) : undefined;
      if (!spec || !file) return resolve(undefined);
      let settled = false;
      let clock: NodeJS.Timeout | undefined;
      const done = (out: string | undefined): void => {
        if (settled) return;
        settled = true;
        if (clock) clearTimeout(clock);
        resolve(out);
      };
      try {
        // SIGKILL: a child that ignores SIGTERM would otherwise outlive the timeout.
        const child = (opts.execFile ?? execFile)(file, [...spec.args], { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: MAX_OUTPUT, env: {}, windowsHide: true, shell: false }, (err, stdout) => {
          done(err ? undefined : String(stdout));
        });
        // The clock. execFile's own limit kills the child and lets go of its pipes, which ends the wait in every
        // case this code has met; the clock is what ends it if that ever does not call back (a kill that fails, a
        // runtime that behaves otherwise). A test gives it a program that never calls back.
        clock = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            /* already gone */
          }
          done(undefined);
        }, timeoutMs + graceMs);
        clock.unref();
        child.on('error', () => done(undefined));
      } catch {
        done(undefined);
      }
    });
}

/** The real runner: one of COMMANDS, on this platform. */
export const runFixed: Run = runnerFor(COMMANDS);

const GIB = 2 ** 30;

/** A name as a status line may show it: the characters hardware names use, nothing else. */
export function cleanChip(raw: string): string | undefined {
  // Trademark marks first, whole ("Intel(R) Core(TM)" is "Intel Core", not "Intel R Core TM"); then anything that
  // is not a letter, a digit, a space or + - . becomes a space, a parenthesis included.
  const s = raw.replace(/\((?:R|TM|C)\)/gi, ' ').replace(/[^A-Za-z0-9 +.-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60).trim();
  return s.length > 0 ? s : undefined;
}

/** `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits`: the largest single GPU. */
export function parseNvidia(out: string): { chip?: string; memoryGb: number } | undefined {
  let best: { name: string; mib: number } | undefined;
  for (const line of out.split('\n').slice(0, 64)) {
    const m = /^(.{1,80}),\s*(\d{1,7})$/.exec(line.trim());
    if (!m) continue;
    const mib = Number(m[2]);
    if (mib > 0 && (!best || mib > best.mib)) best = { name: m[1]!, mib };
  }
  if (!best) return undefined;
  const chip = cleanChip(best.name);
  return { memoryGb: Math.round((best.mib / 1024) * 10) / 10, ...(chip ? { chip } : {}) };
}

/** A whole number of bytes from `sysctl -n hw.memsize`, as GiB; undefined when it is not one. */
function bytesToGb(out: string | undefined): number | undefined {
  const m = /^(\d{6,15})$/.exec((out ?? '').trim());
  if (!m) return undefined;
  const gb = Number(m[1]) / GIB;
  return gb > 0 && gb < 65536 ? Math.round(gb * 10) / 10 : undefined;
}

export interface DetectDeps {
  run?: Run;
  platform?: NodeJS.Platform;
  arch?: string;
  totalmem?: () => number;
}

/**
 * Look at the machine once. Apple Silicon first (its unified memory is what a
 * model runs in), then an NVIDIA GPU, else no accelerator.
 */
export async function detectHardware(deps: DetectDeps = {}): Promise<Hardware> {
  const run = deps.run ?? runFixed;
  const platform = deps.platform ?? osPlatform();
  const arch = deps.arch ?? osArch();
  const systemMemoryGb = Math.round(((deps.totalmem ?? totalmem)() / GIB) * 10) / 10;
  // (Not named `notes`: the notes inventory test reads every push onto a `notes` as a note to Will.)
  const remarks: string[] = [];
  const base = { platform, arch, systemMemoryGb };

  if (platform === 'darwin') {
    // arm64, or an x64 Node running under Rosetta on an Apple Silicon Mac (hw.optional.arm64 says 1).
    const apple = arch === 'arm64' || (await run('sysctl.arm64'))?.trim() === '1';
    if (apple) {
      const fromSysctl = bytesToGb(await run('sysctl.memsize'));
      if (fromSysctl === undefined) remarks.push('sysctl hw.memsize did not answer: memory is from the runtime');
      const chip = cleanChip((await run('sysctl.chip')) ?? '');
      if (!chip) remarks.push('sysctl machdep.cpu.brand_string did not answer');
      const memoryGb = fromSysctl ?? systemMemoryGb;
      return { ...base, accelerator: 'apple-silicon', memoryGb, ...(chip ? { chip } : {}), notes: remarks };
    }
    remarks.push('an Intel Mac: no accelerator Flint knows how to use');
    return { ...base, accelerator: 'none', memoryGb: 0, notes: remarks };
  }

  const nvidiaOut = await run('nvidia.query');
  const nvidia = nvidiaOut === undefined ? undefined : parseNvidia(nvidiaOut);
  if (nvidia) return { ...base, accelerator: 'nvidia', memoryGb: nvidia.memoryGb, ...(nvidia.chip ? { chip: nvidia.chip } : {}), notes: remarks };
  remarks.push(nvidiaOut === undefined ? 'nvidia-smi is not installed or did not answer' : 'nvidia-smi listed no GPU');
  return { ...base, accelerator: 'none', memoryGb: 0, notes: remarks };
}
