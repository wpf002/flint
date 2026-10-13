import { properWords } from './health-names.js';

/**
 * Plain words for an action Will approves, as his notes and cards show it: never
 * the action's internal name ("runtime.world_now"). The console's approval cards
 * use the same words (APPR_TOOLS in apps/console/index.html; a test keeps the two
 * in step). An action without words here is shown as it is named.
 */
export const ACTION_WORDS: Readonly<Record<string, string>> = {
  'runtime.world_now': 'Check What’s Happening Now',
  'runtime.world_entity': 'Look Up One Item',
  'runtime.ledger_open': 'Read Open Predictions',
  'runtime.ledger_calibration': 'Check Prediction Accuracy',
  'runtime.ledger_record_prediction': 'Record a Prediction',
  'runtime.inbox_recent': 'Read What Triage Decided',
  'runtime.escalations_open': 'Read Open Escalations',
  'runtime.explain_decision': 'Explain a Triage Decision',
  // P4: the card that turns Flint's forecasts on (the console's card says the same title).
  'forecast.series.enable': 'Turn On Predictions',
  // P3 part 5: what Flint takes from chat (the console's cards say the same titles).
  'goal.propose': 'Suggest a Goal from Chat',
  'world.commitment.from_chat': 'Add a Commitment from Chat',
  // P5: the cards for assets and tasks (the console's cards say more: which asset, which way).
  'asset.enable': 'Turn On an Asset',
  'review.enforce': 'Change Whether Reviews Are Required',
  'task.dispatch.local_worker': 'Run a Task',
  'task.dispatch.ci_runner': 'Watch a CI Run',
  'task.dispatch.nexus_participant': 'Run a Paid Task',
  'review.local': 'Review a Card',
  'review.trident_panel': 'Review a Card with an Outside Panel',
  'task.check_bar': 'Accept a Task Result',
  'task.cancel': 'Stop a Task',
  'task.bar_override': 'Overrule a Task’s Checks',
};

/**
 * What each action did, as a sentence (the "Action done" note's body): Flint in
 * the third person, past tense. Its title above is a command ("Check What’s
 * Happening Now"), which reads wrong as the subject of a sentence. Every action
 * in ACTION_WORDS has one (a test keeps the two in step).
 */
export const ACTION_DONE: Readonly<Record<string, string>> = {
  'runtime.world_now': 'Flint checked what’s happening now.',
  'runtime.world_entity': 'Flint looked up one item.',
  'runtime.ledger_open': 'Flint read its open predictions.',
  'runtime.ledger_calibration': 'Flint checked its prediction accuracy.',
  'runtime.ledger_record_prediction': 'Flint recorded a prediction.',
  'runtime.inbox_recent': 'Flint read what triage decided.',
  'runtime.escalations_open': 'Flint read the open escalations.',
  'runtime.explain_decision': 'Flint explained a triage decision.',
  'forecast.series.enable': 'Flint turned on predictions.',
  'goal.propose': 'Flint added a goal to your suggestions.',
  'world.commitment.from_chat': 'Flint noted something you said you’d do.',
  'asset.enable': 'Flint turned on an asset.',
  'review.enforce': 'Flint changed whether reviews are required.',
  'task.dispatch.local_worker': 'Flint started a task.',
  'task.dispatch.ci_runner': 'Flint started watching a run.',
  'task.dispatch.nexus_participant': 'Flint started a paid task.',
  'review.local': 'Flint reviewed a card.',
  'review.trident_panel': 'Flint asked an outside panel about a card.',
  'task.check_bar': 'Flint accepted a task’s result.',
  'task.cancel': 'Flint stopped a task.',
  'task.bar_override': 'Flint ended a task the way you chose.',
};

/** The words for an action, or its name when it has none. */
export function actionWords(fullName: string): string {
  return ACTION_WORDS[fullName] ?? fullName;
}

/**
 * The jobs Flint runs on a schedule, as a note names them ("Offsite Backup
 * Failed"): never the action's internal name ("backup.offsite"). Settings >
 * Health says the same words (HEALTH_NAMES). The console keeps a copy to show a
 * note an older Flint stored (NOTE_JOBS in apps/console/index.html; a test keeps
 * the two in step).
 */
export const JOB_WORDS: Readonly<Record<string, string>> = {
  'backup.local': 'Backup',
  'backup.offsite': 'Offsite Backup',
  'restore.drill': 'Restore Test',
  'maintenance.retention': 'Cleanup',
  'backup.prune': 'Backup Cleanup',
  'backup.nexus': 'Nexus Backup',
  'backup.nexus.offsite': 'Nexus Offsite Backup',
  'restore.drill.nexus': 'Nexus Restore Test',
};

/**
 * A rule's action in words, for a sentence that lists what Flint may do on its
 * own or what is limited ("Backup, Offsite Backup and Restore Test"): never the
 * action's internal name. A job or an action with words of its own takes them
 * (JOB_WORDS, ACTION_WORDS: the names the console shows). Anything else is its
 * name's own parts as words (`world.sync.github` is World Sync Github), and a
 * rule for a whole family (`mcp:*`, `backup.*`) says so (Everything Under MCP).
 */
export function ruleWords(pattern: string): string {
  const known = JOB_WORDS[pattern] ?? ACTION_WORDS[pattern] ?? ACTION_WORDS[`runtime.${pattern}`];
  if (known) return known;
  const family = /[.:]\*$/.test(pattern);
  const words = properWords(pattern.replace(/[.:]\*$/, ''));
  if (!words) return family ? 'Everything' : 'An Action';
  return family ? `Everything Under ${words}` : words;
}

/** The nightly jobs that tell Will when they fail (apps/runtime/src/cli.ts): Flint's own backup, and Nexus's (P7). */
export type NightlyJob = 'backup.local' | 'backup.offsite' | 'restore.drill' | 'backup.nexus' | 'backup.nexus.offsite' | 'restore.drill.nexus';
/** The ones that run on Sundays only: their next run, and their next card, are a week away. */
export const WEEKLY_JOBS: ReadonlySet<string> = new Set(['restore.drill', 'restore.drill.nexus']);

export interface JobFailure {
  /**
   * What happens next, which is all the note promises:
   *  - `retry`: the job runs on its own (Will promoted it), so its next run is certain;
   *  - `card`: it ran on a card he approved, and its next card is in Approvals now;
   *  - `card_later`: the same, but the next card could not be filed: the next run files it;
   *  - `setup`: it failed for a reason another try cannot change (no key, no folder, a
   *    write macOS refuses): it says so, never "tries again";
   *  - `stopped`: it stopped before it could tell what it may do (the database did not
   *    answer), so nothing is known about its next run: the note points at Health.
   */
  next: 'retry' | 'card' | 'card_later' | 'setup' | 'stopped';
  /** An offsite copy: it goes to iCloud Drive (the default folder), not a folder Will set. */
  icloud?: boolean;
  /** A restore test: it finished and the restored copy differed from the backup. */
  mismatch?: boolean;
}

/**
 * The note for a nightly job that failed: what happened and what happens next,
 * and nothing else. The error itself is in the job's log and the audit.
 */
export function jobFailedNote(job: NightlyJob, f: JobFailure): { title: string; body: string } {
  const what =
    job === 'backup.local' ? 'Last night’s database backup didn’t finish.'
    : job === 'backup.offsite' ? `Last night’s encrypted ${f.icloud ? 'copy to iCloud' : 'offsite copy'} didn’t finish.`
    : job === 'backup.nexus' ? 'Last night’s Nexus backup didn’t finish.'
    : job === 'backup.nexus.offsite' ? `Last night’s encrypted ${f.icloud ? 'copy of the Nexus backup to iCloud' : 'offsite copy of the Nexus backup'} didn’t finish.`
    : job === 'restore.drill.nexus' ? (f.mismatch ? 'This week’s practice restore of Nexus found a problem.' : 'This week’s practice restore of Nexus didn’t finish.')
    : f.mismatch ? 'This week’s practice restore found a problem.'
    : 'This week’s practice restore didn’t finish.';
  const weekly = WEEKLY_JOBS.has(job);
  const next =
    f.next === 'setup' ? 'It won’t work until its setup is fixed.'
    : f.next === 'stopped' ? 'Flint couldn’t reach its database. Check Health in Settings.'
    : f.next === 'retry' ? `Flint tries again ${weekly ? 'next Sunday' : 'tonight'}.`
    : f.next === 'card' ? 'It runs again once you approve its next card in Approvals.'
    : `Its next card will be in Approvals ${weekly ? 'next Sunday' : 'tomorrow morning'}.`;
  return { title: `${JOB_WORDS[job]!} Failed`, body: `${what} ${next}` };
}
