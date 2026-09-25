/**
 * Which conversations are for measuring Flint and which are for training him.
 *
 * parity_prompts.jsonl was built from the same corpus the local model trained on,
 * so the eval and the training data were the same data. From now on every
 * conversation belongs, forever, to one pool:
 *
 *   'eval'  if int(sha256(key)[:8], 16) % 10 < 3   (30%)
 *   'train' otherwise
 *
 * - A set of Will's real tasks for the gate (flint_tasks.jsonl) must be built
 *   only from 'eval' conversations.
 * - apps/train/mlx/build_data.py trains only on 'train' conversations.
 *
 * The key is the conversation id, except for the server's shared buckets
 * ('console', 'generate', ...), which hold unrelated turns: those are keyed by
 * the prompt's parity id, so the same question always lands in the same pool.
 *
 * apps/train/mlx/pool.py is the Python twin; test/fixtures/pool-cases.json is
 * checked by both test suites, so the two can't drift.
 */
import { createHash } from 'node:crypto';
import { normalize } from './prompts.js';
import { sha } from './util.js';

export type Pool = 'eval' | 'train';

export const EVAL_SHARE_TENTHS = 3;

export const SHARED_CONVERSATION_IDS: ReadonlySet<string> = new Set(['', 'console', 'generate', 'default', 'chat', 'api']);

export function poolKey(conversationId: string, prompt: string): string {
  const cid = (conversationId ?? '').trim();
  if (SHARED_CONVERSATION_IDS.has(cid.toLowerCase())) return `prompt:${sha(normalize(prompt.trim()))}`;
  return `conv:${cid}`;
}

export function poolOf(conversationId: string, prompt: string): Pool {
  const h = createHash('sha256').update(poolKey(conversationId, prompt)).digest('hex');
  return parseInt(h.slice(0, 8), 16) % 10 < EVAL_SHARE_TENTHS ? 'eval' : 'train';
}
