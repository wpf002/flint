import type { RunResult } from './workspace.js';

/**
 * A build runner that is not this machine.
 *
 * Docker on a laptop protects the filesystem and leaves one path open: an escape reaches
 * the machine holding every credential and repository you own. Sending the build
 * somewhere disposable closes it — the worst case becomes a service you redeploy.
 *
 * The exchange is deliberately whole-directory rather than incremental. The sandbox
 * keeps nothing between calls, so each build carries the files it needs and returns
 * whatever it produced. That costs bandwidth on a large project and buys a runner with
 * no state worth attacking and no way for one thread's build to see another's.
 */

export interface RemoteBuild {
  results: RunResult[];
  /** Everything the build produced, so a compile step's output is not lost. */
  files: Record<string, string>;
  /** Screenshots from a `screenshot` command, at desktop and phone width. */
  images?: Array<{ name: string; width: number; height: number; base64: string }>;
}

export interface RemoteSandbox {
  url: string;
  token: string;
}

/** Long enough for an install and a test run; short enough to fail rather than hang. */
const TIMEOUT_MS = 240_000;

export async function buildRemotely(
  sandbox: RemoteSandbox,
  files: Record<string, string>,
  commands: string[][],
): Promise<RemoteBuild> {
  const response = await fetch(`${sandbox.url.replace(/\/$/, '')}/build`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${sandbox.token}`,
    },
    body: JSON.stringify({ files, commands }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    /*
     * Reported as a failed command rather than thrown. A sandbox that is down is a
     * result the thread needs to see and can act on — throwing would make it look like
     * the code was wrong, and send the next participant off rewriting something fine.
     */
    return {
      results: [
        {
          command: commands.map((c) => c.join(' ')).join('; '),
          ok: false,
          code: null,
          output: `The build sandbox refused this (${response.status}): ${detail.slice(0, 300)}`,
        },
      ],
      files: {},
    };
  }

  return (await response.json()) as RemoteBuild;
}

/**
 * Runs `node --version` through the sandbox, once, at startup.
 *
 * A wrong URL, a token that doesn't match, or a sandbox running the wrong program all
 * look fine until the first real build fails, which may be days later, inside a thread,
 * as a failed command a participant then tries to fix. Checked when the responder starts,
 * it's one log line saying which.
 */
export async function probeSandbox(sandbox: RemoteSandbox): Promise<string> {
  const build = await buildRemotely(sandbox, {}, [['node', '--version']]);
  const result = build.results?.[0];
  return result?.ok
    ? `build sandbox answered (node ${result.output.trim()})`
    : `build sandbox is not usable: ${result?.output ?? 'it returned no result'}`;
}
