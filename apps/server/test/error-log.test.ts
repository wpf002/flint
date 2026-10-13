/**
 * What the server log may carry of an error (./error-log): its class, never a
 * provider's words. Every case plants a canary in the error's message and in
 * its raw body, and looks for it in what was logged: the lines index.ts and
 * deep_research write (errorRef, the tier fallback, the hand-off to the local
 * model, the planner). FLINT_DEBUG_ERRORS=1 is the one way to see it all.
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FlintError, makeAiError } from '@flint/core';
import { debugErrors, errorClass, errorSummary, logError } from '../src/error-log';
import { deepResearchTool, errorHint, planQueries } from '../src/deep-research';
import { KnowledgeStore } from '../src/knowledge';
import { Notifications } from '../src/notifications';
import { openConversationStore } from '../src/persistent-store';
import { safeHandler } from '../src/safe-handler';
import { NoAnswer } from '../src/unanswered';

const CANARY = 'CANARY-7f3a-what-will-typed';

/** A provider error as the adapters build one: the vendor's words in `message`, the whole response in `raw`. */
function providerError(kind: Parameters<typeof makeAiError>[0], providerCode: string | undefined, words: string): FlintError {
  return new FlintError(
    makeAiError(kind, `${words} ${CANARY}`, {
      retryable: false,
      ...(providerCode !== undefined ? { providerCode } : {}),
      raw: Object.assign(new Error(`upstream said: ${CANARY}`), { body: { error: { message: `model output echoed: ${CANARY}` } }, status: 500 }),
    }),
  );
}

function capture() {
  const lines: string[] = [];
  const log = (...args: unknown[]) => lines.push(args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? `${a.stack ?? a.message} ${JSON.stringify(a, Object.getOwnPropertyNames(a))}` : JSON.stringify(a))).join(' '));
  return { lines, log, text: () => lines.join('\n') };
}

describe('errorSummary', () => {
  it('a provider error is its kind, its code and the breaker\'s reason: code words only', () => {
    expect(errorSummary(providerError('validation', '400', '400 Your credit balance is too low'))).toBe('validation 400 credit');
    expect(errorSummary(providerError('provider_unavailable', '529', 'Overloaded'))).toBe('provider_unavailable 529 transient');
    expect(errorSummary(providerError('validation', 'insufficient_quota', 'openai: You exceeded your current quota'))).toBe('validation insufficient_quota credit');
    expect(errorSummary(providerError('timeout', undefined, 'Request timed out'))).toBe('timeout');
    expect(errorSummary(providerError('rate_limit', '429', 'slow down'))).toBe('rate_limit 429');
  });

  it('a provider "code" that is not one (free text) is left out', () => {
    expect(errorSummary(providerError('validation', `see ${CANARY}`, 'bad'))).toBe('validation');
    expect(errorSummary(providerError('validation', 'x'.repeat(41), 'bad'))).toBe('validation');
  });

  it('the server\'s own errors are their name, with their reason code when they carry one', () => {
    expect(errorSummary(new NoAnswer('refusal'))).toBe('NoAnswer refusal');
    expect(errorSummary(new TypeError(`cannot read ${CANARY}`))).toBe('TypeError');
    expect(errorSummary(Object.assign(new Error('x'), { why: `free text ${CANARY}` }))).toBe('Error');
    expect(errorSummary(`a string ${CANARY}`)).toBe('error');
    expect(errorClass(new DOMException('late', 'TimeoutError'))).toBe('timeout');
  });

  it('never carries the canary, for any error', () => {
    for (const err of [providerError('validation', '400', 'x'), providerError('internal', undefined, 'x'), new Error(CANARY), { message: CANARY }, null, undefined]) {
      expect(errorSummary(err)).not.toContain(CANARY);
    }
  });
});

describe('logError (what errorRef, the tier fallback and the hand-off to local write)', () => {
  it('a provider error: one line of code words; not its message, not its raw body', () => {
    const c = capture();
    logError('[generate] ref=ab12cd', providerError('validation', '400', '400 {"error":{"message":"Your credit balance is too low"}}'), { log: c.log, env: {} });
    logError('[brain] anthropic:claude-opus-5-5 failed, falling back to anthropic:claude-sonnet-5:', providerError('provider_unavailable', '529', 'Overloaded'), { log: c.log, env: {} });
    logError('[brain] frontier failed pre-output, falling back to local:', providerError('provider_unavailable', undefined, 'ollama 500: the model wrote'), { log: c.log, env: {} });
    expect(c.lines).toEqual([
      '[generate] ref=ab12cd validation 400 credit',
      '[brain] anthropic:claude-opus-5-5 failed, falling back to anthropic:claude-sonnet-5: provider_unavailable 529 transient',
      '[brain] frontier failed pre-output, falling back to local: provider_unavailable transient',
    ]);
    expect(c.text()).not.toContain(CANARY);
    expect(c.text()).not.toMatch(/balance|Overloaded|the model wrote/);
  });

  it('an error of the server\'s own: its name and where it was thrown, not its message', () => {
    const c = capture();
    logError('[approvals] ref=zz', new RangeError(`row for ${CANARY} is missing`), { log: c.log, env: {} });
    expect(c.lines).toHaveLength(1);
    expect(c.lines[0]).toMatch(/^\[approvals\] ref=zz RangeError at .*error-log\.test\.ts:\d+:\d+/);
    expect(c.text()).not.toContain(CANARY);
  });

  // The review's case: the first line that began "    at " was taken for a frame, and a message can have one.
  it('a message that runs over several lines, one of them shaped like a stack frame, is still not logged', () => {
    const c = capture();
    const sly = new Error(`could not parse the reply:\n    at ${CANARY} (secret.ts:1:1)\n    at line two of what Will typed`);
    logError('[generate] ref=m1', sly, { log: c.log, env: {} });
    expect(c.lines).toHaveLength(1);
    expect(c.text()).not.toContain(CANARY);
    expect(c.text()).not.toContain('what Will typed');
    expect(c.lines[0]).toMatch(/^\[generate\] ref=m1 Error at .*error-log\.test\.ts:\d+:\d+/);
  });

  it('nor when the message was changed after the stack was written: with no telling where the old one ends, no frame is logged', () => {
    const c = capture();
    const err = new Error(`first words\n    at ${CANARY} (secret.ts:2:2)`);
    expect(err.stack).toContain(CANARY); // the stack is written now, with the first message in it
    err.message = 'rewritten';
    logError('[generate] ref=m2', err, { log: c.log, env: {} });
    expect(c.lines).toEqual(['[generate] ref=m2 Error']);
  });

  it('an error with no stack, or a stack with no frames, is its name alone', () => {
    const c = capture();
    const bare = new Error(`only ${CANARY}`);
    bare.stack = `Error: only ${CANARY}`;
    logError('[x] ref=1', bare, { log: c.log, env: {} });
    const none = new Error(CANARY);
    delete (none as { stack?: string }).stack;
    logError('[x] ref=2', none, { log: c.log, env: {} });
    expect(c.lines).toEqual(['[x] ref=1 Error', '[x] ref=2 Error']);
  });

  it('a string the caller wrote is logged as written', () => {
    const c = capture();
    logError('[inbox] ref=q1', 'the runtime answered 502 for a feedback request', { log: c.log, env: {} });
    expect(c.lines).toEqual(['[inbox] ref=q1 the runtime answered 502 for a feedback request']);
  });

  it('FLINT_DEBUG_ERRORS=1 logs the whole error; anything else does not', () => {
    const err = providerError('validation', '400', 'x');
    const on = capture();
    logError('[generate] ref=1', err, { log: on.log, env: { FLINT_DEBUG_ERRORS: '1' } });
    expect(on.text()).toContain(CANARY);
    for (const v of [undefined, '', '0', 'true', 'yes']) {
      const off = capture();
      logError('[generate] ref=1', err, { log: off.log, env: { FLINT_DEBUG_ERRORS: v } });
      expect(off.text(), String(v)).not.toContain(CANARY);
      expect(debugErrors({ FLINT_DEBUG_ERRORS: v })).toBe(false);
    }
    expect(debugErrors({ FLINT_DEBUG_ERRORS: ' 1 ' })).toBe(true);
  });
});

describe('deep_research: the planner\'s failure', () => {
  it('is logged as its class, and the heuristic queries take over', async () => {
    const logs: string[] = [];
    const out = await planQueries(
      'what changed in the tax code this year',
      { complete: async () => Promise.reject(providerError('provider_unavailable', '500', 'ollama: the model wrote')), log: (m) => logs.push(m) },
      new Date('2026-10-12T12:00:00Z'),
      { minQueries: 2, maxQueries: 4, planTimeoutMs: 1000 } as Parameters<typeof planQueries>[3],
    );
    expect(out.planner).toBe('heuristic');
    expect(logs).toEqual(['[research] planner failed (provider_unavailable 500 transient); using heuristics']);
    expect(logs.join('\n')).not.toContain(CANARY);
  });
});

describe('index.ts logs errors through error-log, and nowhere hands a provider error to console.error', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'index.ts'), 'utf8');

  it('errorRef, the tier fallback and the hand-off to the local model', () => {
    expect(src).toContain('logError(`[${tag}] ref=${ref}`, err);');
    expect(src).toContain('else logError(`[brain] ${from.label} failed, falling back to ${to.label}:`, err);');
    expect(src).toContain('else logError(`[brain] ${how}, falling back to local:`, err);');
    expect(src).not.toMatch(/describeError/);
  });

  it('the secrets file and the MCP config (which can hold tokens) are logged as an error class only', () => {
    expect(src).toContain('console.error(`[secrets] failed to read ~/.flint/secrets.env (${errorSummary(err)})`);');
    expect(src).toContain('console.error(`[mcp] failed to read MCP_CONFIG (${errorSummary(err)})`);');
    expect(src).toContain("logError('Flint server failed to start:', err);");
  });
});

// The lines the log pass changed, run: each is given the canary and none writes it.
describe('what the server writes when something breaks, line by line', () => {
  /** Everything console.error is given while `fn` runs, as text. */
  async function written(fn: () => unknown): Promise<string[]> {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? `${a.stack ?? ''} ${a.message}` : JSON.stringify(a))).join(' '));
    });
    try {
      await fn();
    } finally {
      spy.mockRestore();
    }
    return lines;
  }
  const tmp = () => mkdtempSync(join(tmpdir(), 'flint-logs-'));

  it('a store whose file will not parse: the class of the error, not the file\'s contents (a SyntaxError quotes them)', async () => {
    const dir = tmp();
    // Unparseable from its first character, so JSON.parse's message quotes the start of the file.
    const corrupt = `${CANARY} said Will to Flint {"turns": [`;
    for (const f of ['notifications.json', 'knowledge.json', 'conversations.json', 'corpus.jsonl']) writeFileSync(join(dir, f), corrupt, 'utf8');
    const lines = await written(() => {
      new Notifications(join(dir, 'notifications.json'));
      new KnowledgeStore(join(dir, 'knowledge.json'), { embed: async () => [] } as unknown as ConstructorParameters<typeof KnowledgeStore>[1]);
      openConversationStore(join(dir, 'conversations.json'), {});
    });
    expect(lines.filter((l) => /failed to load/.test(l))).toHaveLength(3);
    for (const l of lines) {
      expect(l).not.toContain(CANARY);
      expect(l).not.toContain('said Will');
    }
    expect(lines.find((l) => l.startsWith('[notify]'))).toMatch(/^\[notify\] failed to load \(starting fresh\): SyntaxError( at .*:\d+:\d+\)?)?$/);
    expect(lines.find((l) => l.includes('knowledge store'))).toMatch(/: SyntaxError/);
    expect(lines.find((l) => l.includes('conversation store'))).toMatch(/: SyntaxError/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('a store that cannot be written: the system\'s code for it, not the path', async () => {
    const dir = tmp();
    const blocker = join(dir, 'a-file');
    writeFileSync(blocker, 'x', 'utf8');
    // The store's directory is a file: mkdir fails with ENOTDIR (or EEXIST), and its message names the path.
    const lines = await written(() => new Notifications(join(blocker, 'sub', 'notifications.json')).push('T', 'Body.', 'k', 'd1', { channels: ['inapp'] }));
    const line = lines.find((l) => l.startsWith('[notify] failed to persist:'))!;
    expect(line).toMatch(/^\[notify\] failed to persist: Error E[A-Z]+/);
    expect(line).not.toContain('a-file');
    rmSync(dir, { recursive: true, force: true });
  });

  it('a route that throws: the method, the path without its query string, and the error\'s class', async () => {
    const lines = await written(async () => {
      const handler = safeHandler(async () => {
        throw providerError('provider_unavailable', '500', 'ollama: the model wrote');
      });
      const res = { writableEnded: false, headersSent: false, writeHead: () => {}, end: () => {} };
      handler({ method: 'POST', url: `/threads/abc?search=${CANARY}` } as never, res as never);
      await new Promise((r) => setTimeout(r, 5));
    });
    expect(lines).toEqual(['[http] POST /threads/abc failed: provider_unavailable 500 transient']);
  });

  it('deep_research: its line after a search is counts, and never the question', async () => {
    const tool = deepResearchTool({ callTool: async () => '[]', now: () => new Date('2026-10-12T12:00:00Z') });
    const lines = await written(() => tool.handler({ id: 'c1', toolName: 'deep_research', args: { question: `what did ${CANARY} say about my scan` } }));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l).not.toContain(CANARY);
    expect(lines.at(-1)).toMatch(/^\[research\] \d+ queries \((brain|heuristic)\), \d+ pages, \d+ cited, (semantic|lexical|none)$/);
  });

  it('a search tool\'s reported error becomes a hint: a missing key\'s name or an HTTP status, never its words', () => {
    expect(errorHint('PERPLEXITY_API_KEY not set')).toBe('PERPLEXITY_API_KEY not set');
    expect(errorHint(`tavily HTTP 432 (quota) for "${CANARY}"; fallback searxng unreachable`)).toBe('HTTP 432');
    expect(errorHint(`the provider said: ${CANARY}`)).toBe('it reported an error');
  });

  it('a file or socket error keeps its system code; an answer from another service keeps its status', () => {
    expect(errorSummary(Object.assign(new Error(`ENOENT: no such file or directory, open '/Users/will/${CANARY}'`), { code: 'ENOENT' }))).toBe('Error ENOENT');
    expect(errorSummary(Object.assign(new Error(`the runtime said ${CANARY}`), { name: 'RuntimeError', status: 422 }))).toBe('RuntimeError 422');
    expect(errorSummary(Object.assign(new Error('x'), { code: `not a code ${CANARY}`, status: 9999 }))).toBe('Error');
  });
});

/**
 * No log line in apps/server/src hands over a caught error or its message. A
 * provider's error message is the provider's words, a JSON parse error quotes
 * the file it was reading (Will's conversations, his notes, a config with
 * tokens in it), a database error can quote a row. Every such line goes
 * through logError or errorSummary. This scans the source, so a new one fails
 * here; a line that really is safe is listed in AUDITED, with why.
 *
 * The scan reads each log call whole (console.*, an injected `log` or `warn`
 * callback, a `logOnce`), sets its string literals aside, and flags the call
 * when what is left NAMES a caught error anywhere outside errorSummary,
 * errorClass or breakerReason: alone, first or last among the arguments, in an
 * object, added to a string, through a method, a cast or an optional chain.
 * A caught error is `err`, `error` or `cause`, and any name the file binds in
 * a `catch (name)`, a `.catch((name) =>`, an `on('error', (name) =>` or a
 * rejection handler.
 */
describe('no log line carries a caught error or its message', () => {
  const dir = join(__dirname, '..', 'src');
  /** `file: trimmed line` → why it is safe. */
  const AUDITED: Record<string, string> = {
    // error-log itself: the one place that may, behind FLINT_DEBUG_ERRORS=1; and a string the caller wrote.
    'error-log.ts: if (debugErrors(opts.env)) log(prefix, err);': 'the debug switch, off by default',
    'error-log.ts: else if (typeof err === \'string\') log(`${prefix} ${err}`);': 'a string the caller wrote, not an error',
    // FrontierPaused's message is the server's own: `paused: <reason code>`.
    'index.ts: if (err instanceof FrontierPaused) console.error(`[brain] ${from.label} skipped (${err.message}) — moving on to ${to.label}`);': "FrontierPaused.message is 'paused: <reason code>', written by the server",
    // safeHandler's `log` is logError unless a test injects its own: the error is summarised there.
    "safe-handler.ts: log(`[http] ${req.method ?? '?'} ${(req.url ?? '?').split('?')[0]} failed:`, err);": 'its `log` defaults to logError, which summarises',
    // A provider error is summarised; anything else here is a reason the server wrote (no frontier brain, a budget pause, the timeout).
    'deep-research.ts: deps.log?.(`[research] planner failed (${isFlintError(err) ? errorSummary(err) : errMsg(err)}); using heuristics`);': "a provider's error is summarised; the rest are the server's own reasons",
    // logError's own line: the summary, and where the error was thrown (thrownAt: a stack frame, found only after the message, never the message).
    'error-log.ts: else log(`${prefix} ${errorSummary(err)}${thrownAt(err)}`);': 'thrownAt is one stack frame (a function and a file), never the message',
    // FrontierPaused carries the server's own brain and reason: a label from config and a reason code.
    'index.ts: if (err instanceof FrontierPaused) console.error(`[brain] ${err.brain.label} is paused (${err.brain.reason}); the local model answers`);': "FrontierPaused.brain is the server's own: a configured label and a reason code",
    // errorKind is memory extraction's own summariser (./memory-extract): a kind or name and a code, cut to word characters, never the message.
    'memory-extract.ts: console.error(`[memory-extract] pass failed: ${errorKind(err)}`);': "errorKind keeps an error's kind or name and a code, never its message",
    'memory-extract.ts: console.error(`[memory-extract] could not persist watermarks: ${errorKind(err)}`);': "errorKind keeps an error's kind or name and a code, never its message",
    'memory-extract.ts: console.error(`[memory-extract] the suggestions step failed (${errorKind(err)}); the facts are kept and the pass goes on`);': "errorKind keeps an error's kind or name and a code, never its message",
  };

  /** A call that writes a log line: console.*, an injected `log` / `warn` callback, or a `logOnce`. */
  const CALL = /(?:\bconsole\.(?:error|warn|log|info|debug)|(?<![\w.$])(?:log|warn|logOnce)|\.(?:log|warn|logOnce))(?:\?\.)?\(/g;
  /** Wrappers that turn an error into code words: naming the error inside one is the point. */
  const SAFE = ['errorSummary', 'errorClass', 'breakerReason'];
  /** Names that are a caught error wherever they appear. */
  const ALWAYS = ['err', 'error', 'cause'];

  /** From an opening bracket at `open`, the index just past its closing one (strings and templates skipped). */
  const closeOf = (src: string, open: number): number => {
    let depth = 0;
    let i = open;
    const skipString = (q: string): void => {
      i++;
      while (i < src.length && src[i] !== q) {
        if (src[i] === '\\') i++;
        else if (q === '`' && src[i] === '$' && src[i + 1] === '{') {
          let d = 1;
          i += 2;
          while (i < src.length && d > 0) {
            if (src[i] === '`' || src[i] === "'" || src[i] === '"') skipString(src[i]!);
            else if (src[i] === '{') d++;
            else if (src[i] === '}') d--;
            if (d > 0) i++;
          }
        }
        i++;
      }
    };
    for (; i < src.length; i++) {
      const ch = src[i]!;
      if (ch === "'" || ch === '"' || ch === '`') skipString(ch);
      else if (ch === '(') depth++;
      else if (ch === ')' && --depth === 0) return i + 1;
    }
    return src.length;
  };

  /** Code with its string literals emptied: what a template interpolates is kept, as code. */
  const codeOnly = (src: string): string => {
    let out = '';
    let i = 0;
    const template = (): void => {
      i++; // the opening backtick
      while (i < src.length && src[i] !== '`') {
        if (src[i] === '\\') i += 2;
        else if (src[i] === '$' && src[i + 1] === '{') {
          i += 2;
          out += ' (';
          let d = 1;
          while (i < src.length && d > 0) {
            const ch = src[i]!;
            if (ch === '`') template();
            else if (ch === "'" || ch === '"') quoted(ch);
            else {
              if (ch === '{') d++;
              else if (ch === '}') d--;
              if (d > 0) out += ch;
              i++;
            }
          }
          out += ') ';
        } else i++;
      }
      i++;
    };
    const quoted = (q: string): void => {
      i++;
      while (i < src.length && src[i] !== q) i += src[i] === '\\' ? 2 : 1;
      i++;
      out += "''";
    };
    while (i < src.length) {
      const ch = src[i]!;
      if (ch === '`') template();
      else if (ch === "'" || ch === '"') quoted(ch);
      else {
        out += ch;
        i++;
      }
    }
    return out;
  };

  /** The names a file binds to a caught error or a rejection, beside the three that always are one. */
  const errorNames = (src: string): string[] => {
    const names = new Set(ALWAYS);
    for (const re of [
      /\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g,
      /\.catch\(\s*(?:async\s*)?\(?\s*([A-Za-z_$][\w$]*)\s*(?::[^)=]*)?\)?\s*=>/g,
      /\bon(?:ce)?\(\s*['"]error['"]\s*,\s*(?:async\s*)?\(?\s*([A-Za-z_$][\w$]*)/g,
      /,\s*\(\s*([A-Za-z_$][\w$]*)\s*:\s*unknown\s*\)\s*=>/g, // a rejection handler: `.then(ok, (x: unknown) => ...)`
    ]) {
      for (const m of src.matchAll(re)) names.add(m[1]!);
    }
    return [...names];
  };

  /** Does this call's text name one of `names` outside a safe wrapper? `call` starts at the callee. */
  const namesError = (call: string, names: readonly string[]): boolean => {
    let code = codeOnly(call.slice(call.indexOf('(')));
    for (const fn of SAFE) {
      for (let at = code.search(new RegExp(`\\b${fn}\\(`)); at >= 0; at = code.search(new RegExp(`\\b${fn}\\(`))) {
        code = `${code.slice(0, at)}0${code.slice(closeOf(code, at + fn.length))}`;
      }
    }
    const word = new RegExp(`(?<![\\w$.])(?:${names.map((n) => n.replace(/\$/g, '\\$')).join('|')})(?![\\w$])`, 'g');
    for (const m of code.matchAll(word)) {
      const before = code.slice(0, m.index).trimEnd();
      const after = code.slice(m.index! + m[0].length).trimStart();
      // An object's key (`{ error: 'x' }`), not the variable: but `{ err }` and `x ? err : y` are the variable.
      if (after.startsWith(':') && !after.startsWith('::') && /[{,]$/.test(before)) continue;
      return true;
    }
    return false;
  };

  /** Every flagged call in a file, as `file: the trimmed line it starts on`. */
  const scan = (file: string, src: string): string[] => {
    const names = errorNames(src);
    const out: string[] = [];
    for (const m of src.matchAll(CALL)) {
      const lineStart = src.lastIndexOf('\n', m.index!) + 1;
      const lineEnd = src.indexOf('\n', m.index!);
      const line = src.slice(lineStart, lineEnd < 0 ? src.length : lineEnd).trim();
      if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) continue;
      const call = src.slice(m.index!, closeOf(src, m.index! + m[0].length - 1));
      if (namesError(call, names)) out.push(`${file}: ${line}`);
    }
    return [...new Set(out)];
  };

  const lines = (): string[] => readdirSync(dir).filter((n) => n.endsWith('.ts')).flatMap((f) => scan(f, readFileSync(join(dir, f), 'utf8')));

  it('every such line is one that was looked at and listed', () => {
    expect(lines().filter((k) => !(k in AUDITED))).toEqual([]);
  });

  it('the list holds no line that is gone (keep it honest)', () => {
    const found = new Set(lines());
    expect(Object.keys(AUDITED).filter((k) => !found.has(k))).toEqual([]);
    for (const why of Object.values(AUDITED)) expect(why.length).toBeGreaterThan(10);
  });

  it('the scan sees what it is meant to: a line that hands over an error, in every shape', () => {
    const flagged = (code: string): boolean => scan('x.ts', code).length > 0;
    for (const bad of [
      // The shapes found so far...
      "console.error('[x] failed:', err);",
      'console.warn(`[x] failed: ${err.message}`);',
      'console.log(`[x] ${String(err)}`);',
      'this.log(`[x] could not save: ${err instanceof Error ? err.message : String(err)}`);',
      'deps.log?.(`[x] failed (${errMsg(err)})`);',
      "try { f(); } catch (e) { log('[x]', e); }",
      'this.o.log?.(`[x] ${error}`);',
      'try { f(); } catch (e) { console.error(`[x] ${e.stack}`); }',
      // ...and the ones the breaker's last review found the old scan blind to (F4):
      'console.error(err);', // the error alone
      "console.error(err, '[x] failed');", // not the last argument
      "console.error('[x] failed', { err });", // in an object
      "console.error('[x] failed', { cause: err });",
      "console.error('[x] failed: ' + err);", // added to a string
      'console.error(`[x] ${err.toString()}`);', // through a method
      'console.error(`[x] ${(err as Error).message}`);', // through a cast
      'console.error(`[x] ${err?.message}`);', // through an optional chain
      'console.error(`[x] ${JSON.stringify(err)}`);',
      'console.error(`[x] ${String(\n  err,\n)}`);', // over several lines
      'warn(`[x] failed: ${err.message}`);', // a `warn` callback
      "opts.warn?.('[x]', err);",
      'this.logOnce(\'write\', `[x] could not write: ${err instanceof Error ? err.message : String(err)}`);', // a logOnce
      'void go().catch((problem) => this.logOnce(\'flush\', `[x] flush failed: ${problem}`));', // another name, from .catch
      'try { f(); } catch (ex) { console.error(`[x] ${ex}`); }', // another name, from catch
      "sock.on('error', (boom) => console.error('[x]', boom.message));", // another name, from an error event
      'p.then(ok, (why: unknown) => console.error(`[x] ${String(why)}`));', // another name, from a rejection handler
      'console.error(`[x] ${errorSummary(err)} ${err.message}`);', // summarised, and then handed over anyway
    ]) {
      expect(flagged(bad), bad).toBe(true);
    }
    for (const fine of [
      'logError(`[x] failed:`, err);',
      'console.error(`[x] failed (${errorSummary(err)})`);',
      'this.log(`[x] could not save ${this.file} (${errorSummary(err)})`);',
      'this.logOnce(\'write\', `[x] could not write the spool (${errorSummary(err)})`);',
      'console.error(`[x] ${errorClass(err)} ${breakerReason(err.error) ?? \'\'}`);',
      "console.error('[x] started');",
      "console.error('[x] an error, the cause of which is in err');", // the words, in a string
      "console.error('[x]', { error: 'the address was refused', cause: reason });", // an object's keys
      'console.error(`[x] ${r.error} ${res.err}`);', // another thing's property
      'try { f(); } catch (e) { g(); }\nconsole.error(`[x] ${ev.type}`);', // `e` is bound, `ev` is not it
      '// console.error(err)',
    ]) {
      expect(flagged(fine), fine).toBe(false);
    }
  });
});
