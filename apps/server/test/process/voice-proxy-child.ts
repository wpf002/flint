/**
 * Run by ./voice-proxy.test.ts as a process of its own, under a real Node with
 * its env proxy on and one spelling of the no-proxy list. For each of this
 * Mac's two addresses (the speech stand-ins the test started) it does three
 * things, and prints what happened:
 *   1. a plain request with nothing private in it, to see where NODE sends a
 *      request for that address: straight to it, or to the proxy;
 *   2. what FLINT decides about a speech server at that address, from the same
 *      environment (config, then the plan);
 *   3. when Flint took the address: a reply spoken and a recording
 *      transcribed through the providers main() would build, with the speech
 *      server's key.
 * It runs no program (afconvert's part is played here) and reaches nothing
 * but the test's own stand-ins on loopback.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { readInferenceConfig } from '../../src/inference-config';
import { buildVoice, planVoice } from '../../src/voice';

const TAG = process.env.CASE_TAG ?? 'case';
const out: Record<string, unknown> = {};
for (const [family, base] of [
  ['v4', process.env.SPEECH_V4!],
  ['v6', process.env.SPEECH_V6!],
] as const) {
  const r: Record<string, unknown> = {};
  try {
    const probe = await fetch(`${new URL(base).origin}/probe/${TAG}/${family}`, { signal: AbortSignal.timeout(5_000) });
    r.probe = await probe.text();
  } catch (e) {
    r.probe = `failed: ${(e as Error).message}`;
  }
  const env: Record<string, string | undefined> = {
    ...process.env,
    FLINT_TTS_PROVIDER: 'local',
    FLINT_STT_PROVIDER: 'local',
    FLINT_LOCAL_TTS_BASE_URL: base,
    FLINT_LOCAL_STT_BASE_URL: base,
    FLINT_LOCAL_VOICE_API_KEY: process.env.VOICE_KEY,
  };
  const cfg = readInferenceConfig(env);
  const plan = planVoice(cfg, env, { platform: 'darwin', home: '/nonexistent' });
  r.tts = plan.tts.name;
  r.stt = plan.stt.name;
  r.problems = cfg.problems.map((p) => `${p.key}:${p.kind}`);
  const voice = buildVoice(plan, {
    env,
    connectTimeoutMs: 2_000,
    fileExists: () => true,
    run: async (_file, args) => {
      writeFileSync(args[1]!, Buffer.concat([Buffer.from('RIFF'), readFileSync(args[0]!)]));
      return { stdout: '' };
    },
  });
  if (plan.tts.name === 'local') {
    try {
      r.spoke = (await voice.tts.synthesize(`PRIVATE WORDS ${TAG} ${family}`))?.audio.toString('utf8');
    } catch (e) {
      r.spoke = `failed: ${(e as Error).message}`;
    }
  }
  if (plan.stt.name === 'local') {
    try {
      r.heard = (await voice.stt.transcribe(Buffer.from(`PRIVATE RECORDING ${TAG} ${family}`))).text;
    } catch (e) {
      r.heard = `failed: ${(e as Error).message}`;
    }
  }
  out[family] = r;
}
console.log(`RESULT ${JSON.stringify(out)}`);
process.exit(0);
