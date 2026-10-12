/**
 * How a task's failure may be told (P5). A task's title, spec and result are
 * Will's words or a model's, and a database error can carry them. So past an
 * executor an error is its class and SQLSTATE only (goals/errors.ts's sanitize),
 * a log line is `task <id>: <status> (<class>)`, and what Will reads is one of
 * the fixed sentences below.
 */
import { TASK_SAYS, TASK_STATUS_SAYS, type TaskStatus } from '@flint/policy';

/** What Will reads under a task card or from a task route: sentences, never a task's words. */
export const SAY = TASK_SAYS;

/** Why a task cannot take this step from where it stands, as a sentence. */
export function taskStatusWords(status: string): string {
  return Object.prototype.hasOwnProperty.call(TASK_STATUS_SAYS, status) ? TASK_STATUS_SAYS[status as TaskStatus] : 'This task can’t change now.';
}

/** A task's log line: its id, where it stands and a class. Never its words. */
export const taskLog = (id: string, status: string, what?: string): string => `task ${id}: ${status}${what ? ` (${what})` : ''}`;
