import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_THRESHOLDS,
  decideGate,
  describeFingerprintChange,
  exitCodeOf,
  gateHistoryRow,
  parseManifest,
  parseSetsSpec,
  parseSpent,
  planSetRuns,
  poolSets,
  preflightChecks,
  preflightExitCode,
  preflightVerdict,
  promotionCommands,
  renderGate,
  serverFingerprint,
  setOutcome,
  type GateInput,
  type ManifestInfo,
  type SetOutcome,
  type SubjectSummary,
} from '../src/gate.js';
import { pairScores, type PromptScore } from '../src/paired.js';
import type { EvalPrompt } from '../src/prompts.js';
import type { AnswerRow, JudgmentRow } from '../src/report.js';
import { readJsonl } from '../src/util.js';

const FIX = fileURLToPath(new URL('./fixtures/gate/', import.meta.url));
const JUDGE = 'panel:anthropic:claude-opus-5-5+openai:gpt-5';
const CAND = 'flint-local@flint-muse:c20261001-0230~think';
const manifestAt = (name: string): ManifestInfo => parseManifest(join(FIX, name), readFileSync(join(FIX, name), 'utf8'));
const fixtureSha = createHash('sha256').update(readFileSync(join(FIX, 'gate_prompts.jsonl'))).digest('hex');

/** The committed fixture run dir, scored the way the gate scores a real one. */
function fixtureSet() {
  return setOutcome({
    name: 'gate_prompts',
    path: join(FIX, 'gate_prompts.jsonl'),
    sha256: fixtureSha,
    runDir: FIX,
    prompts: readJsonl<EvalPrompt>(join(FIX, 'gate_prompts.jsonl')),
    answers: readJsonl<AnswerRow>(join(FIX, 'answers.jsonl')),
    judgments: readJsonl<JudgmentRow>(join(FIX, 'judgments.jsonl')),
    baselineSubject: 'flint-local',
    candidateSubject: CAND,
    competitor: 'openai',
    competitorModel: 'gpt-5',
    judgeModel: JUDGE,
    ciLevel: 0.9,
  });
}

function fixtureInput(over: Partial<GateInput> = {}): GateInput {
  const s = fixtureSet();
  const { baselineScores: _b, candidateScores: _c, ...set } = s;
  return {
    candidate: 'flint-muse:c20261001-0230',
    baseline: 'muse-glimmer:30b',
    sets: [set],
    pooled: poolSets([s], 0.9),
    manifest: manifestAt('manifest.json'),
    missingSets: [],
    thresholds: DEFAULT_THRESHOLDS,
    ...over,
  };
}

describe('the gate on fixture judgments', () => {
  it('scores the fixture run: 12 better, 3 worse, +15 points', () => {
    const s = fixtureSet();
    expect(s.paired).toMatchObject({ n: 59, better: 12, worse: 3 });
    expect(s.paired.delta).toBeCloseTo(9 / 59, 6);
    expect(s.paired.p).toBeCloseTo(0.0176, 4);
    // The live model failed prompt 59 (a loss); the candidate has one judge error (prompt 58).
    expect(s.baseline).toMatchObject({ answered: 59, failed: 1, judgeErrors: 0 });
    expect(s.candidate).toMatchObject({ answered: 60, failed: 0, judgeErrors: 1 });
  });

  it('PROMOTEs a significant, large, clean improvement', () => {
    const input = fixtureInput();
    const d = decideGate(input);
    expect(d.verdict).toBe('PROMOTE');
    expect(d.reasons).toEqual([]);
    expect(d.checks.every((c) => c.ok)).toBe(true);
    expect(exitCodeOf(d.verdict)).toBe(0);
    const md = renderGate(input, d);
    expect(md).toContain('**Verdict: PROMOTE**');
    expect(md).toContain('+15.3 pts');
  });

  it('HOLDs a candidate trained against another version of the eval set', () => {
    const d = decideGate(fixtureInput({ manifest: manifestAt('manifest-stale.json') }));
    expect(d.verdict).toBe('HOLD');
    expect(d.reasons.join(' ')).toMatch(/not guarded against this version of gate_prompts/);
    expect(exitCodeOf(d.verdict)).toBe(3);
  });

  it('REJECTs a contaminated candidate outright, whatever else is true', () => {
    const d = decideGate(fixtureInput({ manifest: manifestAt('manifest-contaminated.json'), serverChanged: 'model: a → b' }));
    expect(d.verdict).toBe('REJECT');
    expect(d.reasons.join(' ')).toMatch(/2 training rows overlap an eval set/);
    expect(exitCodeOf(d.verdict)).toBe(1);
  });

  it('HOLDs without a manifest, unless the candidate is an untrained base swap', () => {
    expect(decideGate(fixtureInput({ manifest: undefined })).verdict).toBe('HOLD');
    expect(decideGate(fixtureInput({ manifest: 'not-required' })).verdict).toBe('PROMOTE');
  });

  it('HOLDs when the measurement itself is suspect', () => {
    expect(decideGate(fixtureInput({ serverChanged: 'deployHead: "a" → "b"' })).reasons[0]).toMatch(/server changed/);
    expect(decideGate(fixtureInput({ runErrors: ['gate_prompts/candidate: stopped at the budget'] })).verdict).toBe('HOLD');
    expect(decideGate(fixtureInput({ missingSets: ['/x/flint_tasks.jsonl'] })).reasons[0]).toMatch(/flint_tasks/);
    expect(decideGate(fixtureInput({ thresholds: { ...DEFAULT_THRESHOLDS, minPaired: 100 } })).reasons[0]).toMatch(/59 paired prompts/);
    expect(decideGate(fixtureInput({ thresholds: { ...DEFAULT_THRESHOLDS, maxJudgeErrorRate: 0.01 } })).reasons[0]).toMatch(/judge error/);
  });
});

// ---- synthetic scenarios for each REJECT rule

const summary = (subject: string, over: Partial<SubjectSummary> = {}): SubjectSummary => ({
  subject,
  answered: 100,
  failed: 0,
  answerRate: 1,
  medianMs: 20_000,
  judgeErrors: 0,
  unscored: 0,
  ...over,
});

/** n prompts; `better`/`worse` flips from a baseline that loses everything else; categories round-robin. */
function scores(n: number, better: number, worse: number, cats = ['knowledge']): { b: Map<string, PromptScore>; c: Map<string, PromptScore> } {
  const b = new Map<string, PromptScore>();
  const c = new Map<string, PromptScore>();
  for (let i = 0; i < n; i++) {
    const id = `q${i}`;
    const category = cats[i % cats.length]!;
    const bs = i < worse ? 1 : 0;
    const cs = i < worse ? 0 : i < worse + better ? 1 : 0;
    b.set(id, { promptId: id, category, score: bs as 0 | 1, failed: false });
    c.set(id, { promptId: id, category, score: cs as 0 | 1, failed: false });
  }
  return { b, c };
}

function scenario(sets: Array<{ name: string; n: number; better: number; worse: number; cats?: string[]; base?: Partial<SubjectSummary>; cand?: Partial<SubjectSummary> }>): GateInput {
  const scored = sets.map((s) => {
    const { b, c } = scores(s.n, s.better, s.worse, s.cats);
    // Distinct prompt ids per set, so pooling doesn't collapse them.
    const rename = (m: Map<string, PromptScore>) => new Map([...m].map(([k, v]) => [`${s.name}:${k}`, { ...v, promptId: `${s.name}:${k}` }]));
    return { s, b: rename(b), c: rename(c) };
  });
  const outcomes: SetOutcome[] = scored.map(({ s, b, c }) => ({
    name: s.name,
    path: `/x/${s.name}.jsonl`,
    sha256: s.name,
    runDir: '/x',
    competitor: 'openai',
    competitorModel: 'gpt-5',
    judgeModel: JUDGE,
    baseline: summary('flint-local', s.base),
    candidate: summary('cand', s.cand),
    paired: pairScores(b, c, { resamples: 2000 }),
  }));
  return {
    candidate: 'cand',
    baseline: 'live',
    sets: outcomes,
    pooled: poolSets(scored.map(({ b, c }) => ({ baselineScores: b, candidateScores: c })), 0.9),
    manifest: 'not-required',
    missingSets: [],
    thresholds: DEFAULT_THRESHOLDS,
  };
}

const failedIds = (i: GateInput) => decideGate(i).checks.filter((c) => !c.ok).map((c) => c.id);

describe('REJECT rules', () => {
  it('qwen3.8 vs muse (31 better, 18 worse, +3.4 pts on 291) fails the margin even though p < 0.05', () => {
    const input = scenario([{ name: 'parity', n: 291, better: 31, worse: 18 }]);
    const d = decideGate(input);
    expect(d.verdict).toBe('REJECT');
    expect(input.pooled.p).toBeLessThan(0.05);
    expect(failedIds(input)).toContain('margin');
    expect(failedIds(input)).not.toContain('significance');
  });

  it('a real +9 points (12 better, 3 worse on 100) passes', () => {
    expect(decideGate(scenario([{ name: 'parity', n: 100, better: 12, worse: 3 }])).verdict).toBe('PROMOTE');
  });

  it('a big but noisy gain fails significance', () => {
    const input = scenario([{ name: 'parity', n: 60, better: 7, worse: 3 }]);
    expect(input.pooled.delta).toBeGreaterThanOrEqual(0.05);
    expect(failedIds(input)).toContain('significance');
  });

  it("Will's own tasks may not pay for textbook gains", () => {
    const input = scenario([
      { name: 'parity_prompts', n: 100, better: 20, worse: 2 },
      { name: 'flint_tasks', n: 60, better: 2, worse: 4 },
    ]);
    expect(input.pooled.delta).toBeGreaterThan(0.05);
    expect(failedIds(input)).toEqual(['no-regression:flint_tasks']);
  });

  it('protects a category the local model is already good at', () => {
    // research: 20 prompts, 4 worse and 0 better = -20 pts; knowledge carries the pooled gain.
    const b = new Map<string, PromptScore>();
    const c = new Map<string, PromptScore>();
    for (let i = 0; i < 100; i++) {
      const cat = i < 20 ? 'research' : 'knowledge';
      const id = `r${i}`;
      const bs = i < 4 ? 1 : 0;
      const cs = i < 4 ? 0 : i >= 20 && i < 40 ? 1 : 0;
      b.set(id, { promptId: id, category: cat, score: bs as 0 | 1, failed: false });
      c.set(id, { promptId: id, category: cat, score: cs as 0 | 1, failed: false });
    }
    const input = scenario([{ name: 'parity', n: 100, better: 12, worse: 3 }]);
    input.pooled = pairScores(b, c, { resamples: 2000 });
    expect(failedIds(input)).toEqual(['category:research']);
  });

  it('small categories are not judged on their own', () => {
    const input = scenario([{ name: 'parity', n: 100, better: 12, worse: 3, cats: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'] }]);
    expect(input.pooled.byCategory.a!.n).toBeLessThan(10);
    expect(failedIds(input).filter((id) => id.startsWith('category:'))).toEqual([]);
  });

  it('answering less often or much more slowly is a regression', () => {
    expect(failedIds(scenario([{ name: 'p', n: 100, better: 12, worse: 3, base: { answerRate: 1 }, cand: { answerRate: 0.97 } }]))).toEqual(['answer-rate:p']);
    expect(failedIds(scenario([{ name: 'p', n: 100, better: 12, worse: 3, base: { medianMs: 20_000 }, cand: { medianMs: 27_000 } }]))).toEqual(['latency:p']);
    expect(failedIds(scenario([{ name: 'p', n: 100, better: 12, worse: 3, base: { medianMs: 20_000 }, cand: { medianMs: 25_000 } }]))).toEqual([]);
  });
});

describe('gate plumbing', () => {
  it('parses --sets', () => {
    expect(parseSetsSpec('parity_prompts.jsonl:100, flint_tasks.jsonl')).toEqual([
      { name: 'parity_prompts', file: 'parity_prompts.jsonl', limit: 100 },
      { name: 'flint_tasks', file: 'flint_tasks.jsonl' },
    ]);
    expect(() => parseSetsSpec('a.jsonl,a.jsonl:5')).toThrow(/twice/);
    expect(() => parseSetsSpec(' , ')).toThrow();
  });

  it('plans the live model as plain --flint-local and the candidate through the override, in one run dir', () => {
    const [b, c] = planSetRuns({
      runDir: '/r',
      promptsPath: '/e/parity_prompts.jsonl',
      limit: 100,
      competitor: 'openai',
      competitorModel: 'gpt-5',
      judgeArgs: ['--judge-panel', 'anthropic:claude-opus-5-5,openai:gpt-5'],
      flintUrl: 'http://127.0.0.1:8080',
      candidate: 'flint-muse:c1',
      candidateThink: 'on',
    });
    expect(b!.subject).toBe('baseline');
    expect(b!.args).toContain('--flint-local');
    expect(b!.args).not.toContain('--local-model');
    expect(c!.args.join(' ')).toContain('--local-model flint-muse:c1 --local-think on');
    for (const step of [b!, c!]) {
      expect(step.args.join(' ')).toContain('--run /r --prompts /e/parity_prompts.jsonl --limit 100 --contestants flint,openai --openai-model gpt-5');
    }
  });

  it('notices a deploy between the first and the last answer', () => {
    const h = { provider: 'ollama', model: 'muse-glimmer:30b', tools: 67, evalMode: true };
    const a = serverFingerprint(h, 'abc');
    expect(describeFingerprintChange(a, serverFingerprint({ ...h }, 'abc'))).toBeUndefined();
    expect(describeFingerprintChange(a, serverFingerprint(h, 'def'))).toBe('deployHead: "abc" → "def"');
    expect(describeFingerprintChange(a, serverFingerprint({ ...h, model: 'x' }, 'abc'))).toMatch(/model/);
  });

  it('reads the spend a run reports', () => {
    expect(parseSpent('spent $3.1415 this invocation; report -> /x')).toBe(3.1415);
    expect(parseSpent('something else')).toBeUndefined();
  });

  it('writes a history row', () => {
    const input = fixtureInput();
    const row = gateHistoryRow('2026-10-01T09:00:00Z', input, decideGate(input));
    expect(row.split(',').slice(0, 9)).toEqual(['2026-10-01T09:00:00Z', 'flint-muse:c20261001-0230', 'muse-glimmer:30b', 'gate_prompts', 'openai:gpt-5', JUDGE, '59', '12', '3']);
    expect(row).toContain('PROMOTE');
  });

  it('refuses a file that is not a build_data manifest', () => {
    expect(() => parseManifest('x.json', '{"status":"ok"}')).toThrow(/not a build_data.py manifest/);
  });

  it('the free checks alone: PROCEED, HOLD, or REJECT for contamination first', () => {
    const sets = [{ name: 'gate_prompts', path: join(FIX, 'gate_prompts.jsonl'), sha256: fixtureSha }];
    const v = (over: Partial<Parameters<typeof preflightChecks>[0]>) => preflightVerdict(preflightChecks({ missingSets: [], manifest: manifestAt('manifest.json'), sets, ...over }));
    expect(v({})).toEqual({ verdict: 'PROCEED', reasons: [] });
    expect(v({ missingSets: ['/e/flint_tasks.jsonl'] }).verdict).toBe('HOLD');
    expect(v({ manifest: manifestAt('manifest-stale.json') }).reasons.join(' ')).toMatch(/not guarded against this version/);
    // Contamination outranks a missing set, as in decideGate.
    expect(v({ manifest: manifestAt('manifest-contaminated.json'), missingSets: ['/e/x.jsonl'] }).verdict).toBe('REJECT');
    expect([preflightExitCode('PROCEED'), preflightExitCode('REJECT'), preflightExitCode('HOLD')]).toEqual([0, 1, 3]);
  });
});

describe('promotionCommands', () => {
  const cmds = (think: boolean | undefined, variant?: string) =>
    promotionCommands({ candidate: 'flint-muse:c20261001-0230', think, variant, flintUrl: 'http://127.0.0.1:8080/' });

  it('reloads the edited plist (launchd re-reads it) and checks /health serves the candidate', () => {
    const text = cmds(true).join('\n');
    // kickstart restarts the definition launchd already holds: the old OLLAMA_MODEL.
    expect(text).not.toMatch(/kickstart/);
    expect(text).toContain('launchctl bootout gui/$(id -u)/com.flint.server');
    expect(text).toContain('launchctl bootstrap gui/$(id -u) "$P"');
    expect(text.indexOf('OLLAMA_MODEL')).toBeLessThan(text.indexOf('bootout'));
    expect(text).toContain('Set :EnvironmentVariables:OLLAMA_MODEL flint-muse:c20261001-0230');
    expect(text).toContain('curl -fsS -m 3 http://127.0.0.1:8080/health');
    expect(text).toContain('[ "$M" = "flint-muse:c20261001-0230" ]');
  });

  it('serves the think flag and style variant it was judged with', () => {
    expect(cmds(true).join('\n')).toContain('Add :EnvironmentVariables:OLLAMA_THINK string true');
    expect(cmds(false).join('\n')).toContain('Add :EnvironmentVariables:OLLAMA_THINK string false');
    // Judged with no think flag (the model's default): serve with none.
    const none = cmds(undefined).join('\n');
    expect(none).toContain('Delete :EnvironmentVariables:OLLAMA_THINK');
    expect(none).not.toContain('Add :EnvironmentVariables:OLLAMA_THINK');
    expect(none).not.toContain('FLINT_LOCAL_STYLE_VARIANT');
    expect(cmds(true, 'v2').join('\n')).toContain('Add :EnvironmentVariables:FLINT_LOCAL_STYLE_VARIANT string v2');
  });

  // Runs only the PlistBuddy lines, against a scratch copy (never the real plist, never launchctl or curl).
  it.runIf(existsSync('/usr/libexec/PlistBuddy'))('its plist edits work on a plist with and without the keys', () => {
    const dir = mkdtempSync(join(tmpdir(), 'promote-'));
    const plist = join(dir, 'com.flint.server.plist');
    const env = (extra: string) =>
      `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>Label</key><string>com.flint.server</string>` +
      `<key>EnvironmentVariables</key><dict><key>OLLAMA_MODEL</key><string>muse-glimmer:30b</string>${extra}</dict></dict></plist>\n`;
    const read = (key: string) => spawnSync('/usr/libexec/PlistBuddy', ['-c', `Print :EnvironmentVariables:${key}`, plist], { encoding: 'utf8' });
    const apply = (lines: string[]) => {
      const edits = lines.filter((l) => l.startsWith('/usr/libexec/PlistBuddy'));
      expect(edits.join('\n')).not.toMatch(/launchctl|curl/);
      for (const line of edits) spawnSync('/bin/zsh', ['-fc', line], { env: { PATH: '/usr/bin:/bin', P: plist }, encoding: 'utf8' });
    };
    for (const extra of ['', '<key>OLLAMA_THINK</key><string>false</string>']) {
      writeFileSync(plist, env(extra));
      apply(cmds(true, 'v2'));
      expect(read('OLLAMA_MODEL').stdout.trim()).toBe('flint-muse:c20261001-0230');
      expect(read('OLLAMA_THINK').stdout.trim()).toBe('true');
      expect(read('FLINT_LOCAL_STYLE_VARIANT').stdout.trim()).toBe('v2');
      apply(cmds(undefined));
      expect(read('OLLAMA_THINK').status).not.toBe(0);
      expect(read('OLLAMA_MODEL').stdout.trim()).toBe('flint-muse:c20261001-0230');
    }
  });
});

// ---- the CLI end to end on the fixture run dir (no network: --decide-only)

describe('gate CLI --decide-only', () => {
  const tsx = createRequire(import.meta.url).resolve('tsx/cli');
  const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'gate-cli.ts');
  const run = (args: string[]) => {
    const out = mkdtempSync(join(tmpdir(), 'gate-'));
    const r = spawnSync(process.execPath, [tsx, cli, '--decide-only', '--out-dir', out, ...args], {
      encoding: 'utf8',
      env: { ...process.env, PARITY_DIR: join(out, 'eval'), FLINT_BRAIN_DIR: join(out, 'brain') },
      timeout: 60_000,
    });
    return { ...r, out };
  };
  const common = ['--runs', `gate_prompts=${FIX}`, '--sets', join(FIX, 'gate_prompts.jsonl'), '--candidate', 'flint-muse:c20261001-0230', '--candidate-think', 'on', '--baseline-label', 'muse-glimmer:30b'];

  it('PROMOTEs the fixture and writes the verdict, report and history', () => {
    const r = run([...common, '--manifest', join(FIX, 'manifest.json')]);
    expect(r.stderr).toContain('verdict: PROMOTE');
    expect(r.status).toBe(0);
    const files = readdirSync(r.out);
    expect(files.filter((f) => f.endsWith('.json'))).toHaveLength(1);
    expect(files).toContain('gate_history.csv');
    const record = JSON.parse(readFileSync(join(r.out, files.find((f) => f.endsWith('.json'))!), 'utf8')) as { decision: { verdict: string }; promote?: string[] };
    expect(record.decision.verdict).toBe('PROMOTE');
    expect(r.stdout).toContain('**Verdict: PROMOTE**');
    // How to serve it as judged (--candidate-think on), kept in the record for cycle.sh and printed.
    expect(record.promote).toEqual(promotionCommands({ candidate: 'flint-muse:c20261001-0230', think: true, flintUrl: 'http://127.0.0.1:8080' }));
    expect(r.stderr).toContain('OLLAMA_THINK string true');
    expect(r.stderr).toContain('launchctl bootout');
    expect(r.stderr).not.toContain('kickstart');
  }, 60_000);

  it('HOLDs before scoring anything when the manifest was guarded against another set version', () => {
    const r = run([...common, '--manifest', join(FIX, 'manifest-stale.json')]);
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('stopping before any paid call');
  }, 60_000);

  it('HOLDs when a requested set is missing, and REJECTs a contaminated manifest', () => {
    const missing = run([...common.slice(0, 2), '--sets', `${join(FIX, 'gate_prompts.jsonl')},${join(FIX, 'flint_tasks.jsonl')}`, ...common.slice(4), '--no-manifest']);
    expect(missing.status).toBe(3);
    const bad = run([...common, '--manifest', join(FIX, 'manifest-contaminated.json')]);
    expect(bad.status).toBe(1);
    expect(existsSync(join(bad.out, 'eval'))).toBe(false);
  }, 60_000);
});

describe('gate CLI --preflight-only', () => {
  const tsx = createRequire(import.meta.url).resolve('tsx/cli');
  const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'gate-cli.ts');
  const run = (args: string[]) => {
    const out = mkdtempSync(join(tmpdir(), 'gate-pre-'));
    // No --candidate: a cycle asks this before it has one. The server URL goes nowhere: nothing may call it.
    const r = spawnSync(process.execPath, [tsx, cli, '--preflight-only', '--out-dir', out, '--flint-url', 'http://127.0.0.1:9', ...args], {
      encoding: 'utf8',
      env: { ...process.env, PARITY_DIR: join(out, 'eval'), FLINT_BRAIN_DIR: join(out, 'brain') },
      timeout: 60_000,
    });
    const record = JSON.parse(r.stdout.trim().split('\n').at(-1)!) as { preflight: boolean; decision: { verdict: string; reasons: string[] } };
    return { ...r, out, record };
  };
  const sets = ['--sets', join(FIX, 'gate_prompts.jsonl')];

  it('PROCEEDs (exit 0) on a clean manifest guarded against the same set, and writes nothing', () => {
    const r = run([...sets, '--manifest', join(FIX, 'manifest.json')]);
    expect(r.status).toBe(0);
    expect(r.record).toMatchObject({ preflight: true, decision: { verdict: 'PROCEED', reasons: [] } });
    expect(readdirSync(r.out)).toEqual([]);
  }, 60_000);

  it('HOLDs (exit 3) on a missing set or a stale manifest, REJECTs (exit 1) a contaminated one', () => {
    const missing = run(['--sets', `${join(FIX, 'gate_prompts.jsonl')},${join(FIX, 'flint_tasks.jsonl')}`, '--no-manifest']);
    expect([missing.status, missing.record.decision.verdict]).toEqual([3, 'HOLD']);
    expect(missing.record.decision.reasons[0]).toMatch(/flint_tasks/);
    const stale = run([...sets, '--manifest', join(FIX, 'manifest-stale.json')]);
    expect([stale.status, stale.record.decision.verdict]).toEqual([3, 'HOLD']);
    const bad = run([...sets, '--manifest', join(FIX, 'manifest-contaminated.json')]);
    expect([bad.status, bad.record.decision.verdict]).toEqual([1, 'REJECT']);
    for (const r of [missing, stale, bad]) expect(readdirSync(r.out)).toEqual([]);
  }, 60_000);
});
