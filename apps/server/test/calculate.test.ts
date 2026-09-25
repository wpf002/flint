import { describe, it, expect } from 'vitest';
import { calculate, calculateTool, MAX_EXPRESSION_LENGTH } from '../src/calculate';

/** The result of an expression that must evaluate. */
function value(expr: string): number {
  const out = calculate(expr);
  if (!out.ok) throw new Error(`${expr}: ${out.error}`);
  return out.result;
}

/** The error of an expression that must be rejected. */
function rejection(expr: unknown): string {
  const out = calculate(expr);
  if (out.ok) throw new Error(`${String(expr)} should be rejected, got ${out.result}`);
  return out.error;
}

describe('calculate: the numbers that motivated it', () => {
  it('1.03^500 ≈ 2.62e6', () => {
    const r = value('1.03^500');
    expect(r).toBeCloseTo(2621877.2, 0);
    expect(r / 2.62e6).toBeCloseTo(1, 2);
  });

  it('4^4 = 256', () => {
    expect(value('4^4')).toBe(256);
  });

  it('compound growth and loan-style arithmetic', () => {
    expect(value('10000 * 1.07^30')).toBeCloseTo(76122.55, 2);
    expect(value('1000 * (1 + 0.05/12)^(12*10)')).toBeCloseTo(1647.01, 2);
    expect(value('round(250000 * 0.005 / (1 - (1 + 0.005)^-360), 2)')).toBe(1498.88);
  });
});

describe('calculate: precedence and associativity', () => {
  it.each([
    ['2 + 3 * 4', 14],
    ['(2 + 3) * 4', 20],
    ['10 - 4 - 3', 3], // left-assoc
    ['100 / 10 / 5', 2], // left-assoc
    ['2 ^ 3 ^ 2', 512], // right-assoc: 2^(3^2)
    ['(2 ^ 3) ^ 2', 64],
    ['-2 ^ 2', -4], // the power binds tighter than the sign
    ['(-2) ^ 2', 4],
    ['2 ^ -1', 0.5],
    ['2 * -3', -6],
    ['--2', 2],
    ['+5', 5],
    ['7 % 3', 1],
    ['2 + 7 % 3 * 2', 4], // % sits with * and /
    ['7 % (-3)', 1],
    ['2 * 3 ^ 2', 18],
    ['-3 ^ 2 + 1', -8],
    ['2 ** 10', 1024], // ** is accepted as ^
    ['6 × 7 ÷ 2 − 1', 20], // typographic operators
  ])('%s = %d', (expr, expected) => {
    expect(value(expr)).toBe(expected);
  });

  it('reports how it read the expression, with the structure made explicit', () => {
    const out = (expr: string) => {
      const r = calculate(expr);
      return r.ok ? r.expression : r.error;
    };
    expect(out('2+3*4')).toBe('2 + 3 * 4');
    expect(out('(2+3)*4')).toBe('(2 + 3) * 4');
    expect(out('2^3^2')).toBe('2 ^ 3 ^ 2');
    expect(out('(2^3)^2')).toBe('(2 ^ 3) ^ 2');
    expect(out('-2^2')).toBe('-(2 ^ 2)');
    expect(out('(-2)^2')).toBe('(-2) ^ 2');
    expect(out('2^-1')).toBe('2 ^ (-1)');
    expect(out('10-(4-3)')).toBe('10 - (4 - 3)');
    expect(out('  1.030 **2 ')).toBe('1.03 ^ 2');
    expect(out('MAX(1,2 , PI)')).toBe('max(1, 2, pi)');
  });
});

describe('calculate: numbers, functions and constants', () => {
  it('reads decimal, leading-dot and exponent numbers', () => {
    expect(value('.5 + 1.')).toBe(1.5);
    expect(value('2.5e3')).toBe(2500);
    expect(value('1E-3 * 1000')).toBe(1);
  });

  it('has every documented function', () => {
    expect(value('sqrt(144)')).toBe(12);
    expect(value('ln(e)')).toBe(1);
    expect(value('log10(1000)')).toBe(3);
    expect(value('log2(1024)')).toBe(10);
    expect(value('exp(0)')).toBe(1);
    expect(value('abs(-3.5)')).toBe(3.5);
    expect(value('floor(-2.5)')).toBe(-3);
    expect(value('ceil(2.1)')).toBe(3);
    expect(value('min(3, -1, 2)')).toBe(-1);
    expect(value('max(3, -1, 2)')).toBe(3);
    expect(value('min(4)')).toBe(4);
  });

  it('rounds half away from zero, optionally to decimals', () => {
    expect(value('round(2.5)')).toBe(3);
    expect(value('round(-2.5)')).toBe(-3);
    expect(value('round(2.4)')).toBe(2);
    expect(value('round(3.14159, 2)')).toBe(3.14);
    expect(value('round(2 / 3, 4)')).toBe(0.6667);
    expect(rejection('round(1, 2.5)')).toMatch(/whole number of digits/);
    expect(rejection('round(1, 16)')).toMatch(/0 to 15/);
  });

  it('knows pi and e, case-insensitively', () => {
    expect(value('pi')).toBeCloseTo(Math.PI, 12);
    expect(value('2 * PI')).toBeCloseTo(2 * Math.PI, 12);
    expect(value('E')).toBeCloseTo(Math.E, 12);
    expect(value('π')).toBeCloseTo(Math.PI, 12);
  });

  it('strips float noise but keeps safe integers exact', () => {
    expect(value('0.1 + 0.2')).toBe(0.3);
    expect(value('2^53 - 1')).toBe(Number.MAX_SAFE_INTEGER);
    expect(value('0 * -1')).toBe(0);
    expect(Object.is(value('0 * -1'), -0)).toBe(false);
  });
});

describe('calculate: rejects anything else', () => {
  it.each([
    // code, not arithmetic
    ['process.exit(1)', /unexpected|unknown name/],
    ['constructor', /unknown name "constructor"/],
    ['__proto__', /unknown name "__proto__"/],
    ['toString(1)', /unknown name "tostring"/],
    ['Math.PI', /unexpected character "\."|unknown name "math"/],
    ['alert(1)', /unknown name "alert"/],
    ['x = 2', /unexpected character "="/],
    ['2; 3', /unexpected character ";"/],
    ['[1, 2]', /unexpected character "\["/],
    ['"2" + 2', /unexpected character/],
    ['`2`', /unexpected character/],
    ['2 & 3', /unexpected character "&"/],
    ['1 < 2', /unexpected character "<"/],
    ['2 == 2', /unexpected character "="/],
    ['0x10', /unknown name|unexpected/],
    // malformed arithmetic
    ['', /empty expression/],
    ['   ', /empty expression/],
    ['2 +', /ends too early/],
    ['(2 + 3', /closing parenthesis/],
    ['2 + 3)', /unexpected "\)"/],
    ['* 3', /unexpected "\*"/],
    ['2 3', /missing operator/],
    ['2pi', /missing operator/],
    ['2(3)', /missing operator/],
    ['1,000 * 3', /commas only separate function arguments/],
    ['1.2.3', /missing operator/],
    // names used wrongly
    ['log(100)', /log is ambiguous/],
    ['sqrt 4', /sqrt needs parentheses/],
    ['sqrt', /sqrt needs parentheses/],
    ['pi(2)', /pi is a constant/],
    ['sqrt(1, 2)', /sqrt takes 1 argument, got 2/],
    ['round(1, 2, 3)', /round takes 1 or 2 arguments/],
    ['min()', /unexpected "\)"/],
    ['foo(2)', /unknown name "foo"/],
    // percent is not remainder
    ['15%', /remainder operator, not a percentage/],
    ['200 * 15% + 3', /remainder operator, not a percentage/],
    ['(15%)', /not a percentage/],
    // math with no real, finite answer
    ['1 / 0', /division by zero/],
    ['5 % 0', /remainder by zero/],
    ['sqrt(-1)', /sqrt of a negative number/],
    ['ln(0)', /ln of zero/],
    ['log10(-5)', /log10 of a negative number/],
    ['(-8) ^ (1/3)', /fractional power/],
    ['10 ^ 400', /overflows/],
    ['exp(1000) - exp(1000)', /exp\(1000\) overflows/],
    ['1e400', /too large/],
  ])('%s', (expr, error) => {
    expect(rejection(expr)).toMatch(error);
  });

  it('rejects a non-string and caps the length', () => {
    expect(rejection(42)).toMatch(/must be a string/);
    expect(rejection(undefined)).toMatch(/must be a string/);
    expect(rejection({ toString: () => '1+1' })).toMatch(/must be a string/);
    const long = Array.from({ length: MAX_EXPRESSION_LENGTH }, () => '1').join('+');
    expect(long.length).toBeGreaterThan(MAX_EXPRESSION_LENGTH);
    expect(rejection(long)).toMatch(/limit is 500/);
    const atLimit = '11' + '+1'.repeat(249);
    expect(atLimit.length).toBe(MAX_EXPRESSION_LENGTH);
    expect(value(atLimit)).toBe(260);
  });

  it('survives deep nesting within the cap', () => {
    const depth = 200;
    expect(value('('.repeat(depth) + '1' + ')'.repeat(depth))).toBe(1);
    expect(value('-'.repeat(400) + '2')).toBe(2);
  });

  it('never evaluates JavaScript', () => {
    let ran = false;
    (globalThis as { __calcProbe?: () => void }).__calcProbe = () => {
      ran = true;
    };
    expect(calculate('__calcProbe()').ok).toBe(false);
    expect(ran).toBe(false);
    delete (globalThis as { __calcProbe?: () => void }).__calcProbe;
  });
});

describe('calculateTool', () => {
  const tool = calculateTool();
  const run = (args: unknown) => tool.handler({ id: 't1', toolName: 'calculate', args });

  it('is a one-line, idempotent core tool named calculate', () => {
    expect(tool.definition.name).toBe('calculate');
    expect(tool.definition.idempotent).toBe(true);
    expect(tool.definition.description).not.toContain('\n');
    expect(tool.definition.description.length).toBeLessThan(220);
    expect(tool.definition.inputSchema).toMatchObject({ required: ['expression'] });
  });

  it('returns the normalized expression and the result', async () => {
    expect(await run({ expression: '1.03^500' })).toEqual({ expression: '1.03 ^ 500', result: expect.closeTo(2621877.2, 0) });
    expect(await run({ expression: '4^4' })).toEqual({ expression: '4 ^ 4', result: 256 });
  });

  it('reports a bad expression as a tool error the loop marks isError', async () => {
    expect(await run({ expression: '1/0' })).toEqual({ isError: true, error: 'division by zero' });
    expect(await run({})).toEqual({ isError: true, error: 'expression must be a string' });
    expect(await run(null)).toEqual({ isError: true, error: 'expression must be a string' });
  });
});
