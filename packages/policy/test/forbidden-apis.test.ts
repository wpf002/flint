/**
 * Forbidden APIs (Machine plan 3.0.10), checked over the whole repository on
 * every CI run and every deploy:
 *  - no `$queryRawUnsafe` / `$executeRawUnsafe` anywhere: SQL is parameterized;
 *  - no `process.env` in the runtime outside its config.ts, nor anywhere in this
 *    package: configuration is read in one place, validated, and never logged;
 *  - no `pull_request_target` and no `secrets.` in a workflow: the repo is public
 *    and CI runs code from forks.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const ROOT = join(__dirname, '..', '..', '..');
const SKIP = new Set(['node_modules', 'dist', '.git', '.turbo', 'coverage', '.claude']);
const CODE = /\.(ts|mts|cts|js|mjs|cjs)$/;

function files(dir: string, match: RegExp): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p, match));
    else if (match.test(name)) out.push(p);
  }
  return out;
}

const rel = (p: string) => relative(ROOT, p);

/**
 * Parse each file with the TypeScript compiler and look at real syntax, so a
 * comment or a string that merely names an API is not a use, and a string that
 * looks like a comment opener cannot hide one.
 */
function uses(path: string, isHit: (n: ts.Node) => boolean): boolean {
  const sf = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (isHit(n)) found = true;
    else ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

/** `process`, `(process)`, `globalThis.process`, `global.process`. */
const isProcess = (e: ts.Node): boolean => {
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (ts.isIdentifier(e)) return e.text === 'process';
  return ts.isPropertyAccessExpression(e) && e.name.text === 'process' && ts.isIdentifier(e.expression) && ['globalThis', 'global'].includes(e.expression.text);
};
const PROCESS_MODULES = new Set(['process', 'node:process']);
/**
 * Any way to reach the environment: `process.env`, `process['env']`,
 * destructuring or aliasing `process`, or importing `node:process` at all.
 */
const processEnv = (n: ts.Node): boolean =>
  (ts.isPropertyAccessExpression(n) && isProcess(n.expression) && n.name.text === 'env') ||
  (ts.isElementAccessExpression(n) && isProcess(n.expression)) ||
  ((ts.isVariableDeclaration(n) || ts.isBinaryExpression(n)) && !!(ts.isVariableDeclaration(n) ? n.initializer : n.right) && isProcess((ts.isVariableDeclaration(n) ? n.initializer : n.right)!)) ||
  (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && PROCESS_MODULES.has(n.moduleSpecifier.text)) ||
  (ts.isCallExpression(n) && n.expression.getText() === 'require' && n.arguments.some((a) => ts.isStringLiteralLike(a) && PROCESS_MODULES.has(a.text)));
const UNSAFE_SQL = new Set(['$queryRawUnsafe', '$executeRawUnsafe']);
/** `.$queryRawUnsafe(...)`, or the name as a string anywhere (`db[m]` with `m = '$queryRawUnsafe'`). */
const unsafeSql = (n: ts.Node): boolean => (ts.isIdentifier(n) || ts.isStringLiteralLike(n)) && UNSAFE_SQL.has(n.text);

const hits = (paths: string[], isHit: (n: ts.Node) => boolean) => paths.filter((p) => uses(p, isHit)).map(rel);

/**
 * Secrets are reachable only through a `${{ }}` expression, so any expression
 * naming the secrets context is a use (`secrets.X`, `toJSON(secrets)`).
 */
const badWorkflow = (text: string) => {
  const code = text.replace(/^\s*#.*$/gm, '');
  const expressions = code.match(/\$\{\{[\s\S]*?\}\}/g) ?? [];
  return expressions.some((e) => /\bsecrets\b/.test(e)) || /^\s*secrets\s*:/m.test(code) || /pull_request_target/.test(code);
};

const sources = [
  ...readdirSync(join(ROOT, 'apps')).flatMap((a) => files(join(ROOT, 'apps', a, 'src'), CODE)),
  ...readdirSync(join(ROOT, 'packages')).flatMap((a) => [
    ...files(join(ROOT, 'packages', a, 'src'), CODE),
    ...files(join(ROOT, 'packages', a, 'connectors'), CODE),
  ]),
];

describe('forbidden APIs', () => {
  it('finds the source tree (the scan is not silently empty)', () => {
    expect(sources.length).toBeGreaterThan(50);
  });

  it('no unsafe raw SQL', () => {
    expect(hits(sources, unsafeSql)).toEqual([]);
  });

  it('the runtime reads process.env only in src/config.ts', () => {
    const runtime = files(join(ROOT, 'apps', 'runtime', 'src'), CODE).filter((p) => rel(p) !== join('apps', 'runtime', 'src', 'config.ts'));
    expect(hits(runtime, processEnv)).toEqual([]);
  });

  it('@flint/policy never reads process.env', () => {
    expect(hits(files(join(ROOT, 'packages', 'policy', 'src'), CODE), processEnv)).toEqual([]);
  });

  it('workflows never use pull_request_target or secrets', () => {
    // .github/pending-workflows holds ci.yml until the push token can write workflows.
    const wf = files(join(ROOT, '.github'), /\.ya?ml$/);
    expect(wf.length).toBeGreaterThan(0);
    expect(wf.filter((p) => badWorkflow(readFileSync(p, 'utf8'))).map(rel)).toEqual([]);
  });

  it('the checks catch what they claim to (each detector on a planted sample)', () => {
    const tmp = (name: string, body: string) => {
      const p = join(__dirname, `.${name}.sample.ts`);
      writeFileSync(p, body);
      return p;
    };
    const samples = {
      env: tmp('env', "const g = 'packages/mcp/connectors/*';\nexport const leak = process.env.FLINT_TOKEN;\n/** doc */\n"),
      envIndex: tmp('envi', "export const e = process['env'];\n"),
      envDestructure: tmp('envd', 'const { env } = process;\nexport default env;\n'),
      comment: tmp('comment', '// process.env is read in config.ts\nexport const s = "process.env";\n'),
      sql: tmp('sql', 'declare const db: any;\ndb.$queryRawUnsafe("x");\n'),
      sqlIndex: tmp('sqli', "declare const db: any;\ndb['$executeRawUnsafe']('x');\n"),
      sqlVar: tmp('sqlv', "declare const db: any;\nconst m = '$queryRawUnsafe';\ndb[m]('x');\n"),
      envImport: tmp('envm', "import { env } from 'node:process';\nexport default env;\n"),
      envGlobal: tmp('envg', 'export const t = globalThis.process.env.X;\n'),
      envParen: tmp('envp', 'export const t = (process).env;\n'),
      envAlias: tmp('enva', 'const p = process;\nexport const t = p.env;\n'),
      exitOnly: tmp('exit', 'process.exitCode = 1;\nprocess.on("SIGTERM", () => {});\n'),
    };
    try {
      expect(uses(samples.env, processEnv)).toBe(true);
      expect(uses(samples.envIndex, processEnv)).toBe(true);
      expect(uses(samples.envDestructure, processEnv)).toBe(true);
      expect(uses(samples.comment, processEnv)).toBe(false);
      expect(uses(samples.sql, unsafeSql)).toBe(true);
      expect(uses(samples.sqlIndex, unsafeSql)).toBe(true);
      expect(uses(samples.sqlVar, unsafeSql)).toBe(true);
      for (const k of ['envImport', 'envGlobal', 'envParen', 'envAlias'] as const) expect(uses(samples[k], processEnv), k).toBe(true);
      expect(uses(samples.exitOnly, processEnv)).toBe(false);
      expect(badWorkflow("env:\n  T: ${{ format('{0}', secrets.X) }}\n")).toBe(true);
      expect(badWorkflow('jobs:\n  call:\n    uses: ./.github/workflows/x.yml\n    secrets: inherit\n')).toBe(true);
      expect(badWorkflow('env:\n  ALL: ${{ toJSON(secrets) }}\n')).toBe(true);
      expect(badWorkflow('on:\n  pull_request_target:\n')).toBe(true);
      expect(badWorkflow('# no secrets here; not pull_request_target\nrun: echo ${{ github.sha }}\n')).toBe(false);
    } finally {
      for (const p of Object.values(samples)) rmSync(p, { force: true });
    }
  });
});
