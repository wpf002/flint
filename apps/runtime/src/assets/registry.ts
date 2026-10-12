/**
 * The assets Flint can hand work to (P5): a closed list in code, mirrored into
 * the Asset table. A row that is missing is added, off; nothing here turns one
 * on. Will does, with a card that signs exactly what the asset is, so a changed
 * definition is a new entry (a new id and reference, `...:v2`) that he turns on
 * again: his signature always covers what the asset can do.
 *
 * The CI watcher is the only one so far. It calls nothing: it waits for a CI
 * run Flint already tracks and says how it ended.
 */
import { dispatchActionOf, type AssetKind, type TaskTemplateId } from '@flint/policy';

export interface AssetDef {
  id: string;
  kind: AssetKind;
  externalRef: string;
  /** Its name in the console, Title Case. */
  name: string;
  /** The task templates it runs, or `review`. */
  capabilities: readonly string[];
  dispatchAction: string;
  spends: boolean;
  /** The sentence under its row in Settings. */
  line: string;
}

/** An asset's definition; the action it is handed work under follows from its kind. */
export const assetOf = (d: Omit<AssetDef, 'dispatchAction'>): AssetDef => ({ ...d, dispatchAction: dispatchActionOf(d.kind) });

export const CI_WATCHER: AssetDef = assetOf({
  id: 'as-ci-watcher-v1', kind: 'ci_runner', externalRef: 'github:ci:v1', name: 'CI Watcher', capabilities: ['watch_ci'], spends: false,
  line: 'Flint reports how your CI runs end.',
});

/** Every asset there is. Adding one is a reviewed code change. */
export const ASSETS: readonly AssetDef[] = [CI_WATCHER];

export const assetDef = (id: string, registry: readonly AssetDef[] = ASSETS): AssetDef | undefined => registry.find((a) => a.id === id);
/** The asset that runs a template, if one is defined. */
export const assetFor = (template: TaskTemplateId, registry: readonly AssetDef[] = ASSETS): AssetDef | undefined => registry.find((a) => a.capabilities.includes(template));

/** What a row or a card says an asset is: the six fields Will signs. */
export interface AssetFacts {
  kind: string;
  externalRef: string;
  name: string;
  capabilities: readonly string[];
  dispatchAction: string;
  spends: boolean;
}
/** Is this exactly the definition (its list of what it can do in the same order)? */
export function sameAsset(d: AssetDef, x: AssetFacts): boolean {
  return d.kind === x.kind && d.externalRef === x.externalRef && d.name === x.name && d.dispatchAction === x.dispatchAction && d.spends === x.spends
    && d.capabilities.length === x.capabilities.length && d.capabilities.every((c, i) => c === x.capabilities[i]);
}
