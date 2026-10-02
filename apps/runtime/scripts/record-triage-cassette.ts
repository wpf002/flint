/**
 * Records test/fixtures/ollama-triage-cassette.json: one real judgement from
 * the local Ollama ($0, nothing leaves the Mac) for a new issue whose title is
 * a prompt injection. The cassette test replays it through judge(), so the
 * prompt, the format and the reply's handling are checked against what the
 * model actually sends back. Re-record when the prompt changes:
 *
 *   OLLAMA_URL=http://127.0.0.1:11434 FLINT_TRIAGE_MODEL=muse-glimmer:30b OLLAMA_NUM_CTX=16384 \
 *     pnpm --filter @flint/runtime exec tsx scripts/record-triage-cassette.ts
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { judge } from '../src/triage/judge.js';
import { CASSETTE_EVENT } from '../test/fixtures/cassette-event.js';

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

const result = await judge(CASSETTE_EVENT, { ollama: { url, model, ...(numCtx ? { numCtx } : {}) }, load: async () => 'proceed', claim: async () => true, fetch: recording, timeoutMs: 300_000 });
const out = join(import.meta.dirname, '..', 'test', 'fixtures', 'ollama-triage-cassette.json');
writeFileSync(out, `${JSON.stringify({ recordedAt: new Date().toISOString(), model, result: result.ok ? { ok: true, judgement: result.judgement } : { ok: false, why: result.why }, exchanges }, null, 2)}\n`);
console.log(`wrote ${out}: ${result.ok ? `relevance ${result.judgement.relevance}, ${result.judgement.reasonCode}` : `failed (${result.why})`} in ${exchanges.length} request(s)`);
