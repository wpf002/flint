import { describe, it, expect } from 'vitest';
import { assembleContext } from '../../src/core/context.js';
import { isFlintError } from '../../src/index.js';
import type { Message } from '../../src/index.js';

function msg(role: Message['role'], content: string, id: string): Message {
  return { id, role, content, timestamp: 0 };
}

// Estimate: 1 token per character, so budgets are easy to reason about.
const estimate = (ms: Message[]) => ms.reduce((n, m) => n + m.content.length, 0);

describe('assembleContext', () => {
  it('passes everything through when it fits', () => {
    const messages = [msg('user', 'hello', 'a')];
    const result = assembleContext({ messages, budgetTokens: 100, strategy: 'full', estimate });
    expect(result.dropped).toBe(0);
    expect(result.messages).toEqual(messages);
  });

  it('throws context_overflow under the "full" strategy when over budget', () => {
    const messages = [msg('user', 'x'.repeat(50), 'a')];
    try {
      assembleContext({ messages, budgetTokens: 10, strategy: 'full', estimate });
      throw new Error('expected throw');
    } catch (err) {
      expect(isFlintError(err)).toBe(true);
      if (isFlintError(err)) expect(err.error.kind).toBe('context_overflow');
    }
  });

  it('drops oldest non-system messages under "truncate_oldest", never the system', () => {
    const messages = [
      msg('system', 'SYS', 's'),
      msg('user', 'oldest', 'a'),
      msg('user', 'newest', 'b'),
    ];
    // Budget fits SYS + 'newest' (3 + 6 = 9) but not 'oldest' too.
    const result = assembleContext({
      messages,
      budgetTokens: 10,
      strategy: 'truncate_oldest',
      estimate,
    });
    expect(result.dropped).toBe(1);
    expect(result.messages[0]?.content).toBe('SYS');
    expect(result.messages.some((m) => m.content === 'oldest')).toBe(false);
    expect(result.messages.some((m) => m.content === 'newest')).toBe(true);
  });

  it('leaves a synthetic note under "summarize"', () => {
    const messages = [
      msg('user', 'x'.repeat(100), 'a'),
      msg('user', 'y'.repeat(20), 'b'),
    ];
    // Total is 120; budget 90 forces dropping 'a' but leaves room for the note + 'b'.
    const result = assembleContext({
      messages,
      budgetTokens: 90,
      strategy: 'summarize',
      estimate,
    });
    expect(result.dropped).toBeGreaterThan(0);
    expect(result.messages.some((m) => m.role === 'system' && /omitted/.test(m.content))).toBe(
      true,
    );
  });
});
