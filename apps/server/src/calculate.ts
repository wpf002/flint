/**
 * `calculate` — a built-in tool that does arithmetic for the model.
 *
 * Models are unreliable at multi-step arithmetic (compound growth, powers, logs)
 * and confident when wrong. This hands the numbers to a small hand-written
 * parser instead: no eval, no Function, no dependency. Anything outside the
 * grammar below is rejected with a message the model can act on.
 *
 * Grammar (loosest binding first):
 *   sum     := product (('+' | '-') product)*
 *   product := unary (('*' | '/' | '%') unary)*
 *   unary   := ('-' | '+') unary | power
 *   power   := primary ('^' unary)?          right-associative: 2^3^2 = 2^9
 *   primary := number | pi | e | name '(' args ')' | '(' sum ')'
 * So -2^2 = -4 (the power binds tighter than the sign) and 2^-1 = 0.5.
 * `**` is accepted as `^`, and × ÷ − as * / -.
 * Functions: sqrt ln log10 log2 exp abs floor ceil (one argument), round(x) or
 * round(x, digits) (half away from zero), min and max (one or more arguments).
 *
 * Kept free of index.ts so it is unit-testable (index.ts runs main() on import).
 */
import type { Tool } from '@flint/core';

export const MAX_EXPRESSION_LENGTH = 500;

type Op = '+' | '-' | '*' | '/' | '%' | '^';
type Unary = 'sqrt' | 'ln' | 'log10' | 'log2' | 'exp' | 'abs' | 'floor' | 'ceil';
type Fn = Unary | 'round' | 'min' | 'max';

const UNARY: Record<Unary, (x: number) => number> = {
  sqrt: (x) => {
    if (x < 0) throw new CalcError('sqrt of a negative number');
    return Math.sqrt(x);
  },
  ln: (x) => log(x, Math.log, 'ln'),
  log10: (x) => log(x, Math.log10, 'log10'),
  log2: (x) => log(x, Math.log2, 'log2'),
  exp: Math.exp,
  abs: Math.abs,
  floor: Math.floor,
  ceil: Math.ceil,
};
const FUNCTIONS: readonly Fn[] = [...(Object.keys(UNARY) as Unary[]), 'round', 'min', 'max'];
const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E };

function log(x: number, f: (x: number) => number, name: string): number {
  if (x <= 0) throw new CalcError(`${name} of ${x === 0 ? 'zero' : 'a negative number'}`);
  return f(x);
}

class CalcError extends Error {}

type Node =
  | { kind: 'num'; value: number }
  | { kind: 'const'; name: string }
  | { kind: 'neg'; arg: Node }
  | { kind: 'bin'; op: Op; left: Node; right: Node }
  | { kind: 'call'; fn: Fn; args: Node[] };

type Token =
  | { t: 'num'; value: number; pos: number }
  | { t: 'name'; name: string; pos: number }
  | { t: 'op'; op: Op; pos: number }
  | { t: '(' | ')' | ','; pos: number };

// ---------------------------------------------------------------------------
// tokens

const NUMBER_RE = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/;
const NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*/;
const SINGLE: Record<string, Op | '(' | ')' | ','> = {
  '+': '+', '-': '-', '−': '-', '*': '*', '×': '*', '/': '/', '÷': '/', '%': '%', '^': '^', '(': '(', ')': ')', ',': ',',
};

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    const rest = src.slice(i);
    const num = NUMBER_RE.exec(rest);
    if (num) {
      const value = Number(num[0]);
      if (!Number.isFinite(value)) throw new CalcError(`the number ${num[0]} is too large`);
      out.push({ t: 'num', value, pos: i });
      i += num[0].length;
      continue;
    }
    const name = NAME_RE.exec(rest);
    if (name) {
      out.push({ t: 'name', name: name[0].toLowerCase(), pos: i });
      i += name[0].length;
      continue;
    }
    if (ch === 'π') {
      out.push({ t: 'name', name: 'pi', pos: i++ });
      continue;
    }
    if (rest.startsWith('**')) {
      out.push({ t: 'op', op: '^', pos: i });
      i += 2;
      continue;
    }
    const single = Object.hasOwn(SINGLE, ch) ? SINGLE[ch] : undefined;
    if (single === undefined) throw new CalcError(`unexpected character ${JSON.stringify(ch)} at position ${i + 1}`);
    out.push(single === '(' || single === ')' || single === ',' ? { t: single, pos: i } : { t: 'op', op: single, pos: i });
    i++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// parser

class Parser {
  private i = 0;
  constructor(private readonly tokens: Token[]) {}

  parse(): Node {
    if (this.tokens.length === 0) throw new CalcError('empty expression');
    const node = this.sum();
    const extra = this.peek();
    if (extra) throw new CalcError(this.unexpected(extra, 'expected an operator or the end'));
    return node;
  }

  private peek(): Token | undefined {
    return this.tokens[this.i];
  }

  private isOp(...ops: Op[]): Op | undefined {
    const t = this.peek();
    return t?.t === 'op' && ops.includes(t.op) ? t.op : undefined;
  }

  private sum(): Node {
    let left = this.product();
    for (let op = this.isOp('+', '-'); op; op = this.isOp('+', '-')) {
      this.i++;
      left = { kind: 'bin', op, left, right: this.product() };
    }
    return left;
  }

  private product(): Node {
    let left = this.unary();
    for (let op = this.isOp('*', '/', '%'); op; op = this.isOp('*', '/', '%')) {
      this.i++;
      if (op === '%') this.notAPercentage();
      left = { kind: 'bin', op, left, right: this.unary() };
    }
    return left;
  }

  /**
   * `%` is the remainder. "200 * 15% + 3" would otherwise parse as 15 % (+3)
   * and quietly return nonsense, so a `%` followed by nothing, a closer or
   * any operator (a sign included) is taken for a percentage and refused.
   */
  private notAPercentage(): void {
    const next = this.peek();
    if (!next || next.t === ')' || next.t === ',' || next.t === 'op') {
      throw new CalcError(
        '% is the remainder operator, not a percentage: write 15% as 0.15 or 15/100 (for a remainder by a negative number, use parentheses: 7 % (-3))',
      );
    }
  }

  private unary(): Node {
    const op = this.isOp('+', '-');
    if (op) {
      this.i++;
      const arg = this.unary();
      return op === '-' ? { kind: 'neg', arg } : arg;
    }
    return this.power();
  }

  private power(): Node {
    const base = this.primary();
    if (!this.isOp('^')) return base;
    this.i++;
    return { kind: 'bin', op: '^', left: base, right: this.unary() };
  }

  private primary(): Node {
    const t = this.peek();
    if (!t) throw new CalcError('the expression ends too early');
    this.i++;
    switch (t.t) {
      case 'num':
        return { kind: 'num', value: t.value };
      case '(': {
        const inner = this.sum();
        this.expect(')', 'a closing parenthesis');
        return inner;
      }
      case 'name':
        return this.named(t);
      default:
        this.i--;
        throw new CalcError(this.unexpected(t, 'expected a number, a name or "("'));
    }
  }

  private named(t: Extract<Token, { t: 'name' }>): Node {
    const called = this.peek()?.t === '(';
    // hasOwn, not `in`: "constructor" or "__proto__" must not resolve to anything.
    if (Object.hasOwn(CONSTANTS, t.name)) {
      if (called) throw new CalcError(`${t.name} is a constant, not a function`);
      return { kind: 'const', name: t.name };
    }
    if (t.name === 'log') throw new CalcError('log is ambiguous: use ln (natural), log10 or log2');
    if (!(FUNCTIONS as readonly string[]).includes(t.name)) {
      throw new CalcError(`unknown name "${t.name}". Allowed: ${FUNCTIONS.join(', ')}, pi, e`);
    }
    const fn = t.name as Fn;
    if (!called) throw new CalcError(`${fn} needs parentheses, like ${fn}(2)`);
    this.i++; // (
    const args: Node[] = [this.sum()];
    while (this.peek()?.t === ',') {
      this.i++;
      args.push(this.sum());
    }
    this.expect(')', `")" to close ${fn}(`);
    const arity = fn === 'min' || fn === 'max' ? 'any' : fn === 'round' ? [1, 2] : [1];
    if (arity !== 'any' && !arity.includes(args.length)) {
      throw new CalcError(`${fn} takes ${fn === 'round' ? '1 or 2 arguments' : '1 argument'}, got ${args.length}`);
    }
    return { kind: 'call', fn, args };
  }

  private expect(kind: ')', what: string): void {
    const t = this.peek();
    if (t?.t !== kind) throw new CalcError(t ? this.unexpected(t, `expected ${what}`) : `missing ${what}`);
    this.i++;
  }

  private unexpected(t: Token, expected: string): string {
    const shown = t.t === 'num' ? String(t.value) : t.t === 'name' ? t.name : t.t === 'op' ? t.op : t.t;
    const hint =
      t.t === ','
        ? ' (commas only separate function arguments: write 1000, not 1,000)'
        : t.t === 'num' || t.t === 'name' || t.t === '('
          ? ' (a missing operator? write 2*pi, not 2pi)'
          : '';
    return `unexpected "${shown}" at position ${t.pos + 1}: ${expected}${hint}`;
  }
}

// ---------------------------------------------------------------------------
// evaluation

/** A node's value, refusing to carry an overflow or undefined value any further. */
function evalNode(n: Node): number {
  const v = compute(n);
  if (Number.isNaN(v)) throw new CalcError(`${render(n)} is undefined`);
  if (!Number.isFinite(v)) throw new CalcError(`${render(n)} overflows (beyond ±1.8e308)`);
  return v;
}

function compute(n: Node): number {
  switch (n.kind) {
    case 'num':
      return n.value;
    case 'const':
      return CONSTANTS[n.name]!;
    case 'neg':
      return -evalNode(n.arg);
    case 'bin':
      return binary(n.op, evalNode(n.left), evalNode(n.right));
    case 'call': {
      const args = n.args.map(evalNode);
      if (n.fn === 'min') return Math.min(...args);
      if (n.fn === 'max') return Math.max(...args);
      if (n.fn === 'round') return round(args[0]!, args[1]);
      return UNARY[n.fn](args[0]!);
    }
  }
}

function binary(op: Op, a: number, b: number): number {
  switch (op) {
    case '+':
      return a + b;
    case '-':
      return a - b;
    case '*':
      return a * b;
    case '/':
      if (b === 0) throw new CalcError('division by zero');
      return a / b;
    case '%':
      if (b === 0) throw new CalcError('remainder by zero');
      return a % b;
    case '^': {
      const r = a ** b;
      if (Number.isNaN(r)) throw new CalcError('a negative number to a fractional power has no real value');
      return r;
    }
  }
}

/** Round half away from zero, to `digits` decimals (an integer 0..15). */
function round(x: number, digits = 0): number {
  if (!Number.isInteger(digits) || digits < 0 || digits > 15) {
    throw new CalcError('round(x, digits) needs a whole number of digits from 0 to 15');
  }
  const f = 10 ** digits;
  return (Math.sign(x) * Math.round(Math.abs(x) * f)) / f;
}

// ---------------------------------------------------------------------------
// normalized rendering (shows how the expression was read)

const PREC: Record<Op, number> = { '+': 1, '-': 1, '*': 2, '/': 2, '%': 2, '^': 4 };

function prec(n: Node): number {
  if (n.kind === 'bin') return PREC[n.op];
  if (n.kind === 'neg') return 3;
  return 5;
}

function render(n: Node): string {
  switch (n.kind) {
    case 'num':
      return String(n.value);
    case 'const':
      return n.name;
    case 'neg':
      return prec(n.arg) === 5 ? `-${render(n.arg)}` : `-(${render(n.arg)})`;
    case 'call':
      return `${n.fn}(${n.args.map(render).join(', ')})`;
    case 'bin': {
      const p = PREC[n.op];
      const rightAssoc = n.op === '^';
      const l = render(n.left);
      const r = render(n.right);
      const wrapL = rightAssoc ? prec(n.left) <= p : prec(n.left) < p;
      // A negated right operand is always parenthesised: `7 % -3` is refused as
      // a percentage (notAPercentage), so the form shown must be `7 % (-3)`,
      // and `2 * (-3)` reads more plainly than `2 * -3` anyway.
      const wrapR = n.right.kind === 'neg' || (rightAssoc ? prec(n.right) < p : prec(n.right) <= p);
      return `${wrapL ? `(${l})` : l} ${n.op} ${wrapR ? `(${r})` : r}`;
    }
  }
}

/** At and above this, 15 significant digits no longer reach the units digit. */
const EXPONENT_FROM = 1e15;

/**
 * Float noise off (0.1 + 0.2 → 0.3): 15 significant digits, which a double
 * holds exactly. Safe integers are returned untouched.
 *
 * Anything else from 1e15 up is a 15-digit approximation, and as a plain
 * number it would print padded with zeros (2^60 → 1152921504606850000, where
 * the exact value is 1152921504606846976) that the model would pass on as
 * exact. So it comes back as a string in exponent form instead:
 * "1.15292150460685e+18".
 */
function tidy(x: number): number | string {
  if (x === 0) return 0; // no -0
  if (Number.isInteger(x) && Math.abs(x) <= Number.MAX_SAFE_INTEGER) return x;
  const rounded = x.toPrecision(15);
  if (Math.abs(Number(rounded)) < EXPONENT_FROM) return Number(rounded);
  // toPrecision is already in exponent form here (the exponent is ≥ the
  // precision, rounding included); only the mantissa's trailing zeros go.
  const [mantissa = rounded, exponent] = rounded.split('e');
  const short = mantissa.includes('.') ? mantissa.replace(/\.?0+$/, '') : mantissa;
  return exponent === undefined ? short : `${short}e${exponent}`;
}

// ---------------------------------------------------------------------------
// public surface

export type Calculation =
  /** `result` is a string (exponent form, 15 significant digits) only when it is not exact and at least 1e15 in size. */
  | { ok: true; expression: string; result: number | string }
  | { ok: false; error: string };

/** Evaluate one expression. Never throws; never runs anything but the grammar above. */
export function calculate(input: unknown): Calculation {
  if (typeof input !== 'string') return { ok: false, error: 'expression must be a string' };
  const src = input.trim();
  if (!src) return { ok: false, error: 'empty expression' };
  if (src.length > MAX_EXPRESSION_LENGTH) {
    return { ok: false, error: `expression is ${src.length} characters; the limit is ${MAX_EXPRESSION_LENGTH}` };
  }
  try {
    const tree = new Parser(tokenize(src)).parse();
    return { ok: true, expression: render(tree), result: tidy(evalNode(tree)) };
  } catch (err) {
    if (err instanceof CalcError) return { ok: false, error: err.message };
    throw err;
  }
}

/** The tool Flint registers. The description ships in every prompt, so it's one line. */
export function calculateTool(): Tool {
  return {
    definition: {
      name: 'calculate',
      description:
        'Evaluate arithmetic: + - * / % ^, parentheses, sqrt ln log10 log2 exp abs round floor ceil min max, pi, e. Use it for any non-trivial math instead of working it out in your head.',
      inputSchema: {
        type: 'object',
        properties: { expression: { type: 'string', description: 'e.g. 10000 * 1.07^30' } },
        required: ['expression'],
      },
      idempotent: true,
    },
    handler: (call) => {
      const out = calculate((call.args as { expression?: unknown } | null)?.expression);
      return out.ok ? { expression: out.expression, result: out.result } : { isError: true, error: out.error };
    },
  };
}
