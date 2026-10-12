import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promptChange, promptRevisionsOf } from '../src/contestants.js';
import { describeFingerprintChange, serverFingerprint } from '../src/gate.js';

/**
 * Which exact prompts answered. The Flint server hashes each live brain's style
 * guide and engine paragraph (/health `promptRevisions`). A run records them, a
 * resume on other prompts is refused, and the gate counts a change between its
 * two sides as a changed server: a variant's name says which guide, and answers
 * cached under one contestant name must all be from one text.
 */

const V1 = { local: '6e63dcb7', frontier: '3fa9c1d2' };

describe('promptRevisionsOf', () => {
  it('reads the hashes /health reports, per brain', () => {
    expect(promptRevisionsOf({ ok: true, promptRevisions: V1 })).toEqual(V1);
    expect(promptRevisionsOf({ promptRevisions: { local: '6e63dcb7' } })).toEqual({ local: '6e63dcb7' });
  });

  it('is undefined from a server that reports none, or reports something that is not hashes', () => {
    expect(promptRevisionsOf({ ok: true })).toBeUndefined();
    expect(promptRevisionsOf(undefined)).toBeUndefined();
    expect(promptRevisionsOf({ promptRevisions: 'v1' })).toBeUndefined();
    expect(promptRevisionsOf({ promptRevisions: [] })).toBeUndefined();
    expect(promptRevisionsOf({ promptRevisions: { local: 'not a hash!', frontier: 7 } })).toBeUndefined();
  });
});

describe('promptChange (may this contestant\'s answers in a run be added to on this server?)', () => {
  it('the same prompts as its cached answers: yes', () => {
    expect(promptChange(V1, { frontier: '3fa9c1d2', local: '6e63dcb7' }, true)).toBeUndefined();
  });

  it('a prompt changed since they were given: no, and it says which', () => {
    expect(promptChange(V1, { ...V1, local: 'aaaa0000' }, true)).toBe(
      "its cached answers are from prompt revisions frontier 3fa9c1d2, local 6e63dcb7, and the server's are now frontier 3fa9c1d2, local aaaa0000",
    );
    // A brain that came or went counts too (the frontier was turned off, or on).
    expect(promptChange(V1, { local: '6e63dcb7' }, true)).toMatch(/and the server's are now local 6e63dcb7$/);
  });

  it('recorded revisions, and a server that reports none (an older build): no', () => {
    expect(promptChange(V1, undefined, true)).toMatch(/the server's are now none reported$/);
  });

  // Answers from before servers reported revisions were given without the engine paragraph.
  it('answers cached with no record, and a server that reports revisions now: no', () => {
    expect(promptChange(undefined, V1, true)).toMatch(/from before the server reported its prompt revisions/);
  });

  // `--flint-local` or `--local-model` added to an old run (to reuse the competitors' answers) starts clean.
  it('a contestant that has no answers in the run yet has nothing to mix with: yes', () => {
    expect(promptChange(undefined, V1, false)).toBeUndefined();
    expect(promptChange(undefined, undefined, false)).toBeUndefined();
  });

  it('an old run on an old server (neither knows of revisions): yes, as before', () => {
    expect(promptChange(undefined, undefined, true)).toBeUndefined();
  });
});

describe('the gate', () => {
  it('counts a prompt change between its first and last answer as a changed server', () => {
    const h = { provider: 'ollama', model: 'muse-glimmer:30b', tools: 67, evalMode: true, promptRevisions: V1 };
    const before = serverFingerprint(h, 'abc');
    expect(describeFingerprintChange(before, serverFingerprint({ ...h, promptRevisions: { ...V1 } }, 'abc'))).toBeUndefined();
    expect(describeFingerprintChange(before, serverFingerprint({ ...h, promptRevisions: { ...V1, local: 'aaaa0000' } }, 'abc'))).toBe(
      'promptRevisions: {"local":"6e63dcb7","frontier":"3fa9c1d2"} → {"local":"aaaa0000","frontier":"3fa9c1d2"}',
    );
    // A server from before revisions and one with them are two builds.
    const { promptRevisions: _gone, ...old } = h;
    expect(describeFingerprintChange(serverFingerprint(old, 'abc'), before)).toMatch(/^promptRevisions: null → /);
  });
});

// cli.ts and tasks-cli.ts run a command on import, so this reads them: each records what /health
// reported in the run's run.json and refuses to resume a run on other prompts, before any answer.
describe('run and tasks record the prompt revisions and refuse a resume on others', () => {
  const read = (f: string) => readFileSync(join(__dirname, '..', 'src', f), 'utf8');

  it('run', () => {
    const src = read('cli.ts');
    expect(src).toContain('flintPrompts = promptRevisionsOf(health);');
    // Per contestant: what run.json holds for this one, and whether it has answers cached here.
    expect(src).toContain("const hasAnswers = existsSync(cached) && readJsonl<{ contestant?: string }>(cached).some((a) => a.contestant === name);");
    expect(src).toContain('const changed = promptChange(resumed?.promptRevisions?.[name], flintPrompts, hasAnswers);');
    expect(src).toMatch(/if \(changed\) throw new Error\(`can't add \$\{name\} answers to \$\{basename\(runDir\)\}: \$\{changed\}\./);
    // A new run records them; a contestant new to an existing run is added to its record.
    expect(src).toContain('...(flintPrompts && flint ? { promptRevisions: { [flint.name]: flintPrompts } } : {}),');
    expect(src).toContain('promptRevisions: { ...(resumed?.promptRevisions ?? {}), [flint.name]: flintPrompts }');
    // Before any answer is asked for: the check is in the preflight, the answers come later.
    expect(src.indexOf('const changed = promptChange(')).toBeLessThan(src.indexOf('answerOne('));
    // --judge-only asks Flint nothing, so it is never refused.
    expect(src).toMatch(/if \(!judgeOnly\) \{\s*\/\/ This contestant's cached answers in the run must be from the prompts the server has now/);
  });

  it('tasks', () => {
    const src = read('tasks-cli.ts');
    expect(src).toContain('const changed = promptChange(promptRevisions?.[flint.name], now, hasAnswers);');
    expect(src).toContain('if (now) promptRevisions = { ...(promptRevisions ?? {}), [flint.name]: now };');
    expect(src).toContain('...(promptRevisions ? { promptRevisions } : {}),');
    expect(src).toContain('promptRevisions?: Record<string, Record<string, string>>;');
  });
});
