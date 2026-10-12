/**
 * The CI watcher's adapter (P5): it waits for a CI run Flint already tracks
 * (the GitHub source keeps each repo's latest run) and hands in how it ended.
 * It calls nothing and costs nothing. While the run is not finished, or the
 * finished one is for another commit than the one asked for, it waits.
 */
import type { AdapterInput, AdapterResult, TaskAdapter } from './types.js';

const CONCLUSIONS = ['success', 'failure', 'cancelled', 'skipped', 'timed_out', 'neutral', 'action_required'];

/** How a finished run ended, in a sentence. */
export function ciSummary(conclusion: string | null): string {
  return conclusion === 'success' ? 'The run passed.' : conclusion === 'failure' || conclusion === 'timed_out' ? 'The run failed.' : 'The run ended without passing.';
}

export const ciWatch: TaskAdapter = {
  kind: 'ci_runner',
  estimate: () => 0,
  async run({ spec, items }: AdapterInput): Promise<AdapterResult> {
    if (spec.template !== 'watch_ci') return { failure: 'invalid' };
    const item = items[0];
    // The run it was to watch is gone (archived items stay; a forgotten one does not).
    if (!item || item.kind !== 'ci_run' || item.id !== spec.params.item) return { failure: 'invalid' };
    const { status, conclusion, sha } = item.state;
    const commit = typeof sha === 'string' && /^[0-9a-f]{7,40}$/.test(sha) ? sha : null;
    if (status !== 'completed') return { wait: true };
    if (spec.params.sha !== null && !(commit !== null && commit.startsWith(spec.params.sha))) return { wait: true };
    const ended = typeof conclusion === 'string' && CONCLUSIONS.includes(conclusion) ? conclusion : null;
    return { output: { ref: item.ref, status: 'completed', conclusion: ended, sha: commit }, summary: ciSummary(ended) };
  },
};
