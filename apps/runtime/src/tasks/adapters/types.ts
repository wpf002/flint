/**
 * What every asset's adapter is (P5): a pure function from a task's signed spec
 * and the facts it may see to a result, a wait, or a failure's class. It is
 * handed no database, no bus and no files: the runner does every read and write
 * around it, and nothing under this directory may import node's file, process
 * or network modules or call fetch (a test holds that).
 *
 * A result is data. The runner reads what an adapter gives back strictly (one
 * of the three shapes below and nothing else, whatever this type says), checks
 * a result against the template's shape before it stores it, always marked as
 * outside text, and nothing ever runs it.
 */
import type { AssetKind, TaskFailure, TaskSpec } from '@flint/policy';

/** One item a task names, as an adapter may see it: its ref, its kind, its clean state fields, and its title only where the signed spec asked for titles. */
export interface ItemFact {
  id: string;
  /** kind#<last 6 of its id>. */
  ref: string;
  kind: string;
  /** Structural fields only (enums, numbers, a commit's hex): never text someone else wrote. */
  state: Readonly<Record<string, string | number | boolean | null>>;
  /**
   * The item's own title, which is text someone else wrote. It is here only
   * when the spec Will signed says `titles` (TASK_PARAMS: the task is then
   * marked tainted), and the runner leaves it out otherwise. Clipped, and
   * never part of a state field.
   */
  title?: string;
}

export interface AdapterInput {
  taskId: string;
  spec: TaskSpec;
  /** The items the signed spec names that are still there, in the spec's order. */
  items: readonly ItemFact[];
  now: Date;
}

export type AdapterResult =
  /** The result, and a sentence or two about it built by the template's own code (never by a second model call). */
  | { output: Record<string, unknown>; summary: string }
  /** Nothing to hand in yet: the runner asks again later, until the task's time is up. */
  | { wait: true }
  | { failure: TaskFailure };

export interface TaskAdapter {
  kind: AssetKind;
  /** What a task would cost, in millionths of a dollar, known before its card is filed. Zero for an asset on this Mac. */
  estimate(spec: TaskSpec): number;
  run(input: AdapterInput): Promise<AdapterResult>;
  /** A spending asset's alone: what a finished run cost, and whether that is an estimate. */
  meter?(input: AdapterInput): Promise<{ micros: number; estimate: boolean }>;
}

/** The adapters by asset kind. */
export type AdapterSet = Readonly<Partial<Record<AssetKind, TaskAdapter>>>;
