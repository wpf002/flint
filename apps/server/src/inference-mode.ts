/**
 * The routing mode Flint is in right now: `local`, `cloud` or `hybrid`.
 *
 * Two places can set it:
 *  - the environment (FLINT_INFERENCE_MODE, ./inference-config): the default,
 *    `cloud` when unset, and `local` when the value is invalid (a typo must
 *    never send a private setup to the cloud);
 *  - Will, while Flint runs: Settings in the console, or the status command.
 *    That choice is saved to a small file and wins over the environment from
 *    then on, across restarts, until he resets it.
 *
 * The saved file holds the mode and when it was set, nothing else. It is
 * written 0600, through a temp file of its own (created, never opened if
 * something is already at that name) and a rename, and read back through a
 * schema. Reading it never waits and never reads much: it is looked at before
 * it is opened, and only a regular file of at most 4 KB is read (a pipe at
 * that path would hold the boot for ever, and a link to an endless device
 * would be read without end). Anything else found there is "damaged".
 *
 * A SAVED FILE THAT CANNOT BE READ RUNS AS LOCAL. If the file is there and is
 * not a mode Flint wrote (cut short, empty, another version, an extra field, a
 * mode it does not know, not readable at all), Will had chosen something and
 * Flint no longer knows what. It may have been Local. So the mode is `local`,
 * which never uses the cloud, with the source `invalid_saved`, until he sets
 * the mode again (which rewrites the file) or resets it (which removes it).
 * It used to fall back to the environment's value, which unset is `cloud`: a
 * damaged file turned a Local setup into a cloud one at the next restart. The
 * log line names no content.
 *
 * The mode is a setting for Will, never for a model: there is no tool that
 * changes it, so nothing a model reads can talk Flint out of Local mode.
 *
 * Kept free of index.ts so it is unit-testable (index.ts runs main() on import).
 */
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { z } from 'zod';
import { MODES, type InferenceConfig, type InferenceMode } from './inference-config';

/** Who set the mode: a button in the console, or the status command. */
export const MODE_SETTERS = ['console', 'cli'] as const;
export type ModeSetter = (typeof MODE_SETTERS)[number];

const Saved = z
  .object({
    version: z.literal(1),
    mode: z.enum(MODES),
    setAt: z.string().datetime(),
    setBy: z.enum(MODE_SETTERS),
  })
  .strict();
type Saved = z.infer<typeof Saved>;

/** The most a saved mode is ever read: the file Flint writes is under 120 bytes. */
export const SAVED_MODE_MAX_BYTES = 4096;

/**
 * Where the mode in force came from: `settings` (Will saved it), `invalid_saved`
 * (a saved file is there and cannot be read, so `local`), or the environment's
 * own three (./inference-config).
 */
export type ModeSource = 'settings' | 'invalid_saved' | InferenceConfig['modeSource'];

export interface ModeStoreOptions {
  /** Where the saved mode lives (`~/.flint/inference.json`). */
  file: string;
  /** What the environment asks for, and whether it did (./inference-config). */
  envMode: InferenceMode;
  envSource: InferenceConfig['modeSource'];
  log?: (msg: string) => void;
  now?: () => Date;
}

/** The mode could not be saved, so it was not changed. */
export class ModeNotSaved extends Error {
  constructor() {
    super('the mode could not be saved');
    this.name = 'ModeNotSaved';
  }
}

export class ModeStore {
  private saved: Saved | undefined;
  /** A saved file is there and could not be read: `local` until it is set again or reset. */
  private damaged = false;
  private readonly listeners: Array<(to: InferenceMode, from: InferenceMode) => void> = [];
  private readonly log: (msg: string) => void;

  constructor(private readonly opts: ModeStoreOptions) {
    this.log = opts.log ?? (() => {});
    const loaded = this.load();
    this.saved = loaded === 'damaged' ? undefined : loaded;
    this.damaged = loaded === 'damaged';
    const env = opts.envSource === 'default' ? 'env is unset' : opts.envSource === 'invalid_env' ? 'the env value is invalid' : `env says ${opts.envMode}`;
    this.log(
      this.damaged
        ? `[inference] mode=local (the saved mode could not be read, so local, which never uses the cloud; ${env}; set the mode again in Settings, or reset it)`
        : this.saved
          ? `[inference] mode=${this.saved.mode} (saved in Settings; ${env})`
          : `[inference] mode=${opts.envMode} (${opts.envSource === 'default' ? 'default' : opts.envSource === 'invalid_env' ? 'the env value is invalid, so local' : 'env'})`,
    );
  }

  /** The mode in force. */
  current(): InferenceMode {
    if (this.damaged) return 'local';
    return this.saved?.mode ?? this.opts.envMode;
  }

  /** Where the mode in force came from. */
  source(): ModeSource {
    if (this.damaged) return 'invalid_saved';
    return this.saved ? 'settings' : this.opts.envSource;
  }

  /** The mode the environment asks for (what `reset` goes back to). */
  envMode(): InferenceMode {
    return this.opts.envMode;
  }

  /**
   * Save the mode, then switch to it. Returns the mode it replaced. If the
   * file cannot be written the mode does not change and ModeNotSaved is
   * thrown: a switch that would be lost at the next restart is not made.
   */
  set(mode: InferenceMode, by: ModeSetter): InferenceMode {
    const next = Saved.parse({ version: 1, mode, setAt: (this.opts.now?.() ?? new Date()).toISOString(), setBy: by });
    const from = this.current();
    const fromSource = this.source();
    // Already saved as this mode: there is nothing to write and nothing changes.
    if (this.saved && !this.damaged && this.saved.mode === mode) return from;
    // A name of this write's own, created and never opened if something is already there (`wx`): a link planted
    // at a guessable temp name is not followed, and two writers never share a file.
    const tmp = `${this.opts.file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      mkdirSync(dirname(this.opts.file), { recursive: true });
      writeFileSync(tmp, `${JSON.stringify(next)}\n`, { mode: 0o600, flag: 'wx' });
      renameSync(tmp, this.opts.file);
    } catch {
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* nothing was left, or it cannot be removed: the mode is not changed either way */
      }
      this.log('[inference] the mode could not be saved, so it was not changed');
      throw new ModeNotSaved();
    }
    this.saved = next;
    this.damaged = false;
    this.changed(from, by, fromSource);
    return from;
  }

  /** Forget the saved mode (a damaged file too): back to the environment's. Returns the mode it replaced. */
  reset(by: ModeSetter = 'console'): InferenceMode {
    const from = this.current();
    const fromSource = this.source();
    try {
      rmSync(this.opts.file, { force: true });
    } catch {
      this.log('[inference] the saved mode could not be removed, so it was not changed');
      throw new ModeNotSaved();
    }
    this.saved = undefined;
    this.damaged = false;
    this.changed(from, by, fromSource);
    return from;
  }

  /** Told after each change (never when a set leaves the mode as it was). */
  onChange(fn: (to: InferenceMode, from: InferenceMode) => void): void {
    this.listeners.push(fn);
  }

  private changed(from: InferenceMode, by: ModeSetter, fromSource: ModeSource): void {
    const to = this.current();
    if (to === from) {
      // The mode in force is the same, but where it comes from is not: it is saved now (so it wins over the
      // environment at the next restart), or no longer saved. That is a change too, and it is said.
      if (this.source() !== fromSource) this.log(`[inference] mode ${to} ${this.saved ? 'saved' : 'no longer saved'} (${by}); it was already in force`);
      return;
    }
    this.log(`[inference] mode ${from} -> ${to} (${by})`);
    for (const fn of this.listeners) {
      try {
        fn(to, from);
      } catch {
        /* a listener's failure is not the store's */
      }
    }
  }

  /** The saved mode; undefined when there is no file; `damaged` when there is one and it is not a mode Flint wrote. */
  private load(): Saved | undefined | 'damaged' {
    let raw: string;
    let fd: number | undefined;
    try {
      // Looked at before it is opened, and never through a link: a link that points nowhere is still something
      // at that path (it used to read as "no file", and so as the environment's mode, which unset is cloud).
      const seen = lstatSync(this.opts.file);
      if (!seen.isFile() || seen.size > SAVED_MODE_MAX_BYTES) return 'damaged';
      // Opened without following a link and without waiting (what is there can change after the look: a pipe
      // would otherwise hold the boot until someone wrote to it), and checked again on the open file.
      fd = openSync(this.opts.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.size > SAVED_MODE_MAX_BYTES) return 'damaged';
      const buf = Buffer.alloc(SAVED_MODE_MAX_BYTES + 1);
      let n = 0;
      for (;;) {
        const got = readSync(fd, buf, n, buf.length - n, null);
        if (got === 0) break;
        n += got;
        if (n > SAVED_MODE_MAX_BYTES) return 'damaged'; // it grew while it was read
      }
      raw = buf.subarray(0, n).toString('utf8');
    } catch (err) {
      // No file at all is the ordinary case: nothing was ever saved (nothing at that path, a parent that is
      // not a directory, a path that is not one). Anything else there (a file that cannot be read, a
      // directory in its place) is something Flint cannot vouch for.
      const code = (err as { code?: unknown } | null)?.code;
      return code === 'ENOENT' || code === 'ENOTDIR' || code === 'ERR_INVALID_ARG_VALUE' ? undefined : 'damaged';
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          /* already closed */
        }
      }
    }
    try {
      const parsed = Saved.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
    } catch {
      /* not JSON */
    }
    return 'damaged';
  }
}
