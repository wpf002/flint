/**
 * Records test/fixtures/ollama-estimate-cassette.json: one real second opinion
 * from the local Ollama ($0, nothing leaves the Mac) on a synthetic number
 * (made-up deploy counts with a weekday shape: test/predict/reason-facts.ts).
 * The cassette test replays it through estimate(), so the prompt, the format
 * and the reply's handling are checked against what the model actually sends
 * back. Re-record when the prompt or the schema changes:
 *
 *   OLLAMA_URL=http://127.0.0.1:11434 FLINT_TRIAGE_MODEL=muse-glimmer:30b OLLAMA_NUM_CTX=16384 \
 *     pnpm --filter @flint/runtime exec tsx scripts/record-estimate-cassette.ts
 *
 * Use a model Ollama already has loaded, and the num_ctx the server runs it
 * with: another one makes Ollama reload the model chat is using. The estimate
 * asks Ollama's own listing first, as every local call does (model/here.ts): a
 * model that Ollama serves from elsewhere is refused here too, and nothing is
 * recorded. Only the chat exchange is kept: the listing names this Mac's
 * models, and is no part of the cassette.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { estimate } from '../src/predict/reason.js';
import { SYNTHETIC_FACTS } from '../test/predict/reason-facts.js';

const url = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434';
const model = process.env.FLINT_TRIAGE_MODEL ?? 'muse-glimmer:30b';
const numCtx = process.env.OLLAMA_NUM_CTX ? Number(process.env.OLLAMA_NUM_CTX) : undefined;
if (!/^http:\/\/(\[::1\]|127\.0\.0\.1|localhost):\d+$/.test(url)) throw new Error('the cassette is recorded against a local Ollama only');

const exchanges: Array<{ request: unknown; response: unknown }> = [];
const recording = (async (u: string | URL | Request, init?: RequestInit) => {
  const res = await fetch(u, init);
  // The listing is asked and answered, and not kept.
  if (new URL(String(u)).pathname !== '/api/chat') return res;
  const body = (await res.json()) as Record<string, unknown>;
  // What the provider reads, and nothing about the machine.
  const { message, done, done_reason, prompt_eval_count, eval_count } = body as { message?: { role: string; content: string } } & Record<string, unknown>;
  exchanges.push({ request: JSON.parse(String(init?.body)), response: { model, message: message && { role: message.role, content: message.content }, done, done_reason, prompt_eval_count, eval_count } });
  return new Response(JSON.stringify(body), { status: res.status, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

const result = await estimate(SYNTHETIC_FACTS, {
  ollama: { url, model, ...(numCtx ? { numCtx } : {}) }, load: async () => 'proceed', claim: async () => true, fetch: recording, timeoutMs: 300_000,
});
const out = join(import.meta.dirname, '..', 'test', 'fixtures', 'ollama-estimate-cassette.json');
writeFileSync(out, `${JSON.stringify({
  recordedAt: new Date().toISOString(), model, ...(numCtx ? { numCtx } : {}),
  result: result.ok ? { ok: true, estimate: result.estimate } : { ok: false, why: result.why },
  exchanges,
}, null, 2)}\n`);
console.log(`wrote ${out}: ${result.ok ? `${Math.round(result.estimate.probability * 100)}%, ${result.estimate.reasonCode}` : `failed (${result.why})`} in ${exchanges.length} request(s)`);
