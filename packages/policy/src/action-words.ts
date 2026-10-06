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
};

/** The words for an action, or its name when it has none. */
export function actionWords(fullName: string): string {
  return ACTION_WORDS[fullName] ?? fullName;
}
