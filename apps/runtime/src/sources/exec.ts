/** Running a fixed local command (launchctl, plutil, git) with no shell, a timeout, a size cap and a minimal environment. */
import { execFile } from 'node:child_process';

export type Run = (cmd: string, args: readonly string[], opts?: { cwd?: string }) => Promise<string>;

export function makeRun(home: string): Run {
  return (cmd, args, opts = {}) =>
    new Promise((resolve, reject) => {
      execFile(
        cmd,
        args as string[],
        { timeout: 10_000, maxBuffer: 4 * 1024 * 1024, ...(opts.cwd ? { cwd: opts.cwd } : {}), env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin', HOME: home } },
        (err, stdout) => (err ? reject(err) : resolve(stdout)),
      );
    });
}
