/**
 * Goals and commitments from chat, handed to the runtime (Machine plan P3
 * part 5; FLINT_EXTRACT_CANDIDATES=1, off by default).
 *
 * The memory extractor (./memory-extract), on its LOCAL model only, proposes
 * the goals Will set and the things he said he would do, and keeps one only if
 * its quote is in his own message of that turn. Each one kept comes here, and
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
import { CandidateAnswer, ChatCandidate } from '@flint/policy';
import type { Runtime } from './audit-sink';
import type { ChatSuggestion, ExtractorOptions, SuggestionOutcome } from './memory-extract';
import { onThisMachine } from './policy';

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

/**
 * Is FLINT_EXTRACT_CANDIDATES on? Exactly "1". Anything else that is not unset
 * or "0" is said once and read as off, as the context blocks' settings are.
 */
export function candidatesSetting(env: Env, log: (m: string) => void): boolean {
  const raw = env.FLINT_EXTRACT_CANDIDATES?.trim();
  if (raw === '1') return true;
  if (raw !== undefined && raw !== '' && raw !== '0') log('[memory-extract] FLINT_EXTRACT_CANDIDATES is not "1" or "0"; reading it as off (no goals or commitments are suggested from chat)');
  return false;
}

/**
 * The extractor's options for goals and commitments from chat: none unless the
 * setting is on AND the extractor runs on the local model. On the frontier (or
 * with it off) the extractor is given nothing: its prompt is what it always
 * was, and no suggestion is read or filed.
 */
export function candidateOptions(
  env: Env,
  o: { kind: 'local' | 'frontier'; candidates: GoalCandidates; tz: string; log: (m: string) => void },
): Pick<ExtractorOptions, 'candidates' | 'onCandidate' | 'tz'> {
  if (!candidatesSetting(env, o.log)) return {};
  if (o.kind !== 'local') {
    o.log('[memory-extract] FLINT_EXTRACT_CANDIDATES=1 needs the local model (FLINT_MEMORY_BRAIN=local): no goals or commitments are suggested from chat');
    return {};
  }
  o.log('[memory-extract] goals and commitments Will sets in chat are suggested (FLINT_EXTRACT_CANDIDATES=1): each rests on his own quoted words and waits for his approval');
  return { candidates: true, onCandidate: (s) => o.candidates.file(s), tz: o.tz };
}
