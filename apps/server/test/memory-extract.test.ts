import { describe, it, expect } from 'vitest';
import { parseFacts } from '../src/memory-extract';

describe('parseFacts', () => {
  it('parses a bare JSON array', () => {
    expect(parseFacts('["Will bought a Mac Studio M4 Max with 64GB of memory."]')).toEqual([
      'Will bought a Mac Studio M4 Max with 64GB of memory.',
    ]);
  });

  it('parses a fenced array with surrounding prose', () => {
    const out = parseFacts(
      'Here are the facts:\n```json\n["Will runs Flint on a local Ollama model.", "Will owns the Vantage scoring system."]\n```\nThat is all.',
    );
    expect(out).toHaveLength(2);
    expect(out[1]).toBe('Will owns the Vantage scoring system.');
  });

  it('returns [] for an empty array — the common, correct answer', () => {
    expect(parseFacts('[]')).toEqual([]);
  });

  // Failing closed here would silently mean "memory never grows" — the exact bug
  // this module exists to fix — so malformed output must degrade, not throw.
  it('returns [] on malformed output instead of throwing', () => {
    for (const junk of ['not json at all', '', '{"facts": "nope"}', '[unclosed', '```json\n[bad,\n```']) {
      expect(() => parseFacts(junk)).not.toThrow();
      expect(parseFacts(junk)).toEqual([]);
    }
  });

  it('drops non-strings and junk-length entries', () => {
    const out = parseFacts('["ok", 42, null, "tiny", "' + 'x'.repeat(500) + '", "a real durable fact here"]');
    expect(out).toEqual(['a real durable fact here']);
  });
});
