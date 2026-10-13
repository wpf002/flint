/**
 * Goals and commitments from chat, handed to the runtime (Machine plan P3
 * part 5; FLINT_EXTRACT_CANDIDATES=1, off by default).
 *
 * The memory extractor (./memory-extract), on a model on THIS MAC only,
 * proposes the goals Will set (and, behind a second switch, the things he said
 * he would do), and keeps one only if its quote is in his own message of that
 * turn. "On this Mac" is the server's one locality rule (./policy
 * brainIsLocal), asked of the extractor's model at every pass: a local model
 * that runs elsewhere (a cloud-backed name, an Ollama on another machine) is
 * asked for facts alone and nothing is filed. Each one kept comes here, and
 * goes to the runtime's POST /v1/goals/candidates with the server's own token:
 * the runtime checks it again and files the card Will signs. This is the only
 * path to that route. No tool of any kind reaches it: a model that names
 * `goal.propose` or `world.commitment.from_chat` in a tool call is refused at
 * the tier gate (./tier-gate), and the runtime refuses those two actions from
 * anything but its own intake.
 *
 *  - Never spooled, never retried: with the runtime down, or slow, the
 *    suggestion is dropped and counted. Will's words are never written to disk
 *    to wait (RuntimeProposals.propose would put them in ~/.flint/spool).
 *  - Only to a runtime on this Mac. A suggestion is his own words, and some
 *    come from turns that stay here (a turn answered with his goals): one
 *    bound for a runtime at another address is held, and counted.
 *  - Nothing about a suggestion is kept on the server: not its text, not its
 *    quote, not its turn. What stays is a count per outcome.
 *  - Logs carry counts and statuses only.
 */
import { CandidateAnswer, ChatCandidate, zoneFrom } from '@flint/policy';
import type { Runtime } from './audit-sink';
import type { ChatSuggestion, ExtractorOptions, SuggestionOutcome } from './memory-extract';
import { brainIsLocal, onThisMachine, type AnsweringBrain } from './policy';

export interface GoalCandidatesOptions {
  /** The runtime link main() builds. */
  runtime: () => Runtime | undefined;
  fetchImpl?: typeof fetch;
  /** Per call. Default 5 s: a suggestion is never worth holding a pass for. */
  timeoutMs?: number;
}

/** The largest answer read from the runtime (it is one short JSON object). */
const MAX_ANSWER = 4096;

export class GoalCandidates {
  /** How many suggestions ended each way, since the server started. */
  readonly counts: Record<SuggestionOutcome, number> = { filed: 0, known: 0, refused: 0, capped: 0, unreachable: 0, held: 0 };

  constructor(private readonly o: GoalCandidatesOptions) {}

  private count(outcome: SuggestionOutcome): SuggestionOutcome {
    this.counts[outcome] += 1;
    return outcome;
  }

  /** Hand one suggestion to the runtime. One request, 5 s at most; whatever happens, nothing of it is kept. */
  async file(s: ChatSuggestion): Promise<SuggestionOutcome> {
    const rt = this.o.runtime();
    if (!rt) return this.count('unreachable');
    if (!onThisMachine(rt.url)) return this.count('held');
    const body = ChatCandidate.safeParse({
      kind: s.kind, text: s.text, quote: s.quote, ...(s.dueOn ? { dueOn: s.dueOn } : {}),
      conversationId: s.conversationId, turnId: s.turnId, sourceAt: new Date(s.sourceAt).toISOString(),
    });
    // Not the shape the runtime takes (an id it does not name turns by, a time that is not one): it would refuse it.
    if (!body.success) return this.count('refused');
    let status: number;
    let text: string;
    try {
      const r = await (this.o.fetchImpl ?? fetch)(`${rt.url}/v1/goals/candidates`, {
        method: 'POST',
        headers: { authorization: `Bearer ${rt.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body.data),
        redirect: 'error',
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 5000),
      });
      status = r.status;
      text = (await r.text()).slice(0, MAX_ANSWER);
    } catch {
      return this.count('unreachable');
    }
    if (status === 429) return this.count('capped');
    if (status >= 500 || status === 401 || status === 403 || status === 404) return this.count('unreachable');
    if (status < 200 || status >= 300) return this.count('refused');
    let answer: unknown;
    try {
      answer = JSON.parse(text);
    } catch {
      return this.count('unreachable');
    }
    const a = CandidateAnswer.safeParse(answer);
    if (!a.success) return this.count('unreachable');
    return this.count(a.data.outcome === 'known' ? 'known' : 'filed');
  }
}

type Env = Record<string, string | undefined>;

/** A setting that is on only as "1": unset, blank and "0" are off quietly; anything else is off and said once. */
function on(env: Env, name: 'FLINT_EXTRACT_CANDIDATES' | 'FLINT_EXTRACT_COMMITMENTS', log: (m: string) => void, off: string): boolean {
  const raw = env[name]?.trim();
  if (raw === '1') return true;
  if (raw !== undefined && raw !== '' && raw !== '0') log(`[memory-extract] ${name} is not "1" or "0"; reading it as off (${off})`);
  return false;
}

/** Is FLINT_EXTRACT_CANDIDATES on? Exactly "1", as the context blocks' settings are read. */
export function candidatesSetting(env: Env, log: (m: string) => void): boolean {
  return on(env, 'FLINT_EXTRACT_CANDIDATES', log, 'no goals or commitments are suggested from chat');
}

/**
 * Is FLINT_EXTRACT_COMMITMENTS on? Its own switch, off by default, apart from
 * goals: an approved commitment has nowhere to be seen or removed yet, so it
 * is not asked for until Will turns it on.
 */
export function commitmentsSetting(env: Env, log: (m: string) => void): boolean {
  return on(env, 'FLINT_EXTRACT_COMMITMENTS', log, 'no commitments are suggested from chat');
}

/**
 * Will's zone as the runtime reads it (FLINT_TZ, else FLINT_USER_TZ, else
 * America/Chicago), for "has the day passed". The runtime refuses to start on a
 * name that is no zone; the server must not, so it says so and falls back.
 */
export function serverZone(env: Env, log: (m: string) => void): string {
  try {
    return zoneFrom(env.FLINT_TZ, env.FLINT_USER_TZ, log);
  } catch {
    log('[memory-extract] FLINT_TZ or FLINT_USER_TZ is not a time zone; days are read in America/Chicago');
    return 'America/Chicago';
  }
}

export const WAITING = '[memory-extract] FLINT_EXTRACT_CANDIDATES=1 is waiting for a model on this Mac: the extractor’s model does not run here (or Ollama has not said so yet), so nothing is suggested from chat';

/**
 * The extractor's options for suggestions from chat: none unless the setting
 * is on AND the extractor runs on the local wire. Then `candidates` is a
 * question asked at every pass: is the extractor's model on this Mac right now
 * (brainIsLocal, the rule that decides what stays here)? A cloud-backed name
 * or an Ollama on another machine answers no: that pass asks for facts alone
 * and files nothing. The answer is logged when it is first known and whenever
 * it changes. On the frontier (or with the setting off) the extractor is given
 * nothing: its prompt is what it always was.
 */
export function candidateOptions(
  env: Env,
  o: {
    kind: 'local' | 'frontier';
    /** The brain the extractor asks (main() names it; ./goals-chat has its Ollama's listing watched). */
    brain: AnsweringBrain | undefined;
    candidates: GoalCandidates;
    tz: string;
    log: (m: string) => void;
    /** Does this brain run on this Mac? Default: the server's rule (./policy brainIsLocal). */
    here?: (brain: AnsweringBrain | undefined) => boolean;
  },
): Pick<ExtractorOptions, 'candidates' | 'commitments' | 'onCandidate' | 'tz'> {
  const commitments = commitmentsSetting(env, o.log);
  if (!candidatesSetting(env, o.log)) {
    if (commitments) o.log('[memory-extract] FLINT_EXTRACT_COMMITMENTS=1 does nothing without FLINT_EXTRACT_CANDIDATES=1: nothing is suggested from chat');
    return {};
  }
  if (o.kind !== 'local') {
    o.log('[memory-extract] FLINT_EXTRACT_CANDIDATES=1 needs the local model (FLINT_MEMORY_BRAIN=local): no goals or commitments are suggested from chat');
    return {};
  }
  const here = o.here ?? ((b: AnsweringBrain | undefined) => brainIsLocal(b));
  const what = commitments ? 'goals and commitments Will sets in chat are suggested' : 'goals Will sets in chat are suggested (commitments are off: FLINT_EXTRACT_COMMITMENTS)';
  let last: boolean | undefined;
  const ask = (): boolean => {
    const now = here(o.brain) === true;
    if (now !== last) {
      last = now;
      o.log(now ? `[memory-extract] ${what} (FLINT_EXTRACT_CANDIDATES=1): each rests on his own quoted words and waits for his approval` : WAITING);
    }
    return now;
  };
  // Said at boot, as it stands; said again when it changes.
  ask();
  return { candidates: ask, commitments, onCandidate: (s) => o.candidates.file(s), tz: o.tz };
}
