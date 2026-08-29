import type { Participant } from './participant.js';

/*
 * A short thread the participants hold about themselves rather than about work.
 *
 * Everything else here puts them in contact only when there is a job to do, so they
 * learn nothing about each other except through whatever the goal happened to require.
 * Their roles — which is what routing and every nomination reads — were written once, by
 * me, from guesswork, and have never been revised by the only parties who know whether
 * they are true.
 *
 * The prompt varies because a standing question gets a standing answer. Asked the same
 * thing weekly, a model reproduces last week's reply from the shape of the question; the
 * point is to catch what has actually changed.
 *
 * Deliberately small and capped. This produces no artifact and closes no work — it is
 * overhead, justified only if it stays cheap enough not to think about.
 */

/** Questions worth a participant's turn. Each asks about the group, not about itself. */
const PROMPTS: string[] = [
  'Which of the others has surprised you — done something better than you would have expected from their stated strength?',
  'What kind of ask keeps landing with you that you are not actually the best placed to answer?',
  'Name something you now know about how this group works that was not true a week ago.',
  'Where does the handoff between you and the others waste a turn?',
  'What would you stop doing in threads if the others could be relied on for it?',
  'Which of your own declared strengths has turned out to be wrong, and what should it say instead?',
  'What does the group keep re-deciding that should have been settled once?',
  'If you could see one thing about a thread before taking your turn that you cannot see now, what is it?',
];

/** A goal that reads as its own explanation in the console, dated so it is not a duplicate. */
export function standupGoal(today: string): string {
  return `Standup for ${today}: how this group is working, and what should change`;
}

/*
 * Turns-per-participant at which one of them is carrying the group.
 *
 * Deliberately not a round number. A thread cannot advance by nominating yourself, so
 * with three participants the most anyone can take is every other turn — which scores
 * exactly 1.5. Anything above that means the turns are not merely alternating: someone is
 * being handed the work repeatedly while the others fill in around them.
 */
const CARRYING = 1.5;

/** True when today's standup has not been held. */
export function dueToday(today: string, lastHeld: string | null): boolean {
  return lastHeld !== today;
}

/**
 * The question, chosen by what the group's own numbers say is wrong.
 *
 * A rotating prompt is better than a fixed one and worse than a relevant one. When
 * somebody has taken no turns at all, asking about mis-routing is the question worth a
 * paid round; when one participant is carrying everything, asking what the others could
 * be relied on for is. Otherwise the date decides, as before.
 */
export function promptFrom(
  today: string,
  signal: { silent: string[]; imbalance: number },
): string {
  if (signal.silent.length > 0) {
    return 'What kind of ask keeps landing with you that you are not actually the best placed to answer?';
  }
  if (signal.imbalance > CARRYING) {
    return 'What would you stop doing in threads if the others could be relied on for it?';
  }
  return promptFor(today);
}

/**
 * Picks the question.
 *
 * Seeded by the date rather than randomly, so every participant in a given standup is
 * answering the same thing and two runs on one day do not ask twice. Random per call
 * would make the answers incomparable, which defeats the point of asking.
 */
export function promptFor(today: string, prompts: string[] = PROMPTS): string {
  let hash = 0;
  for (let i = 0; i < today.length; i += 1) hash = (hash * 31 + today.charCodeAt(i)) >>> 0;
  return prompts[hash % prompts.length]!;
}

export const STANDUP_ASK = (question: string): string =>
  `${question} Answer from what has actually happened, not from what would be nice. ` +
  `If your own role is now wrong, call set_role and fix it — that is the one change here ` +
  `that outlives this thread.`;

/**
 * Opens a standup, unless today's already exists.
 *
 * Refused rather than skipped when a duplicate: Nexus already declines a goal that is
 * open, and letting this discover that itself keeps one rule in one place.
 */
export async function openStandup(
  opener: Participant,
  today: string,
  firstSpeaker: string,
  question: string = promptFor(today),
): Promise<{ opened: boolean; threadId?: string; why?: string }> {
  try {
    const thread = await opener.call<{ threadId: string }>('thread_open', {
      goal: standupGoal(today),
      selfRunning: true,
      firstSpeaker,
      ask: STANDUP_ASK(question),
    });
    return { opened: true, threadId: thread.threadId };
  } catch (err) {
    return { opened: false, why: err instanceof Error ? err.message : String(err) };
  }
}
