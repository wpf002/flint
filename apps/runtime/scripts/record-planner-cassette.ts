/**
 * Records test/fixtures/ollama-planner-cassette.json: one real plan stage from
 * the local Ollama ($0, nothing leaves the Mac) for a synthetic goal linked to a
 * pull request whose title is a prompt injection. The cassette test replays it
 * through planDiff(), so the prompt, the format and the reply's handling are
 * checked against what the model actually sends back, and the title is shown
 * never to reach the prompt. Re-record when the prompt or the schema changes:
 *
 *   OLLAMA_URL=http://127.0.0.1:11434 FLINT_TRIAGE_MODEL=muse-glimmer:30b OLLAMA_NUM_CTX=16384 \
 *     pnpm --filter @flint/runtime exec tsx scripts/record-planner-cassette.ts
 *
 * Use the num_ctx the server runs the model with: another one makes Ollama
 * reload the model chat is using.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { planDiff } from '../src/goals/planner.js';
import { resolveReply } from '../src/goals/steps.js';
import { CASSETTE_NOW, CASSETTE_TZ, cassetteFacts } from '../test/fixtures/cassette-goal.js';

const url = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434';
const model = process.env.FLINT_TRIAGE_MODEL ?? 'muse-glimmer:30b';
const numCtx = process.env.OLLAMA_NUM_CTX ? Number(process.env.OLLAMA_NUM_CTX) : undefined;
if (!/^http:\/\/(\[::1\]|127\.0\.0\.1|localhost):\d+$/.test(url)) throw new Error('the cassette is recorded against a local Ollama only');

const exchanges: Array<{ request: unknown; response: unknown }> = [];
const recording = (async (u: string | URL | Request, init?: RequestInit) => {
  const res = await fetch(u, init);
  const body = (await res.json()) as Record<string, unknown>;
  // What the provider reads, and nothing about the machine.
  const { message, done, done_reason, prompt_eval_count, eval_count } = body as { message?: { role: string; content: string } } & Record<string, unknown>;
  exchanges.push({ request: JSON.parse(String(init?.body)), response: { model, message: message && { role: message.role, content: message.content }, done, done_reason, prompt_eval_count, eval_count } });
  return new Response(JSON.stringify(body), { status: res.status, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

const { facts, state } = cassetteFacts();
const result = await planDiff(facts, {
  ollama: { url, model, ...(numCtx ? { numCtx } : {}) }, load: async () => 'proceed', claim: async () => true,
  resolve: (ops) => resolveReply(ops, state, CASSETTE_TZ, CASSETTE_NOW), fetch: recording, timeoutMs: 300_000,
});
const out = join(import.meta.dirname, '..', 'test', 'fixtures', 'ollama-planner-cassette.json');
writeFileSync(out, `${JSON.stringify({
  recordedAt: new Date().toISOString(), model, ...(numCtx ? { numCtx } : {}),
  result: result.ok ? { ok: true, reasonCode: result.reasonCode, value: result.value } : { ok: false, why: result.why },
  exchanges,
}, null, 2)}\n`);
console.log(`wrote ${out}: ${result.ok ? `${result.reasonCode}, ${result.value.length} operation(s)` : `failed (${result.why})`} in ${exchanges.length} request(s)`);
