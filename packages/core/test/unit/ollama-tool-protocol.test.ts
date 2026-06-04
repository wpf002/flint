import { describe, it, expect } from 'vitest';
import { extractToolCall } from '../../src/provider/ollama/tool-protocol.js';

describe('ollama prompted tool-protocol: extractToolCall', () => {
  it('parses a clean tool call', () => {
    const r = extractToolCall('{"tool_call": {"name": "f", "arguments": {"a": 1}}}');
    expect(r).toEqual({ name: 'f', arguments: { a: 1 } });
  });

  it('strips markdown code fences', () => {
    const r = extractToolCall('```json\n{"tool_call":{"name":"f","arguments":{}}}\n```');
    expect(r?.name).toBe('f');
  });

  it('ignores prose before and after the JSON', () => {
    const r = extractToolCall('Sure! {"tool_call": {"name": "f", "arguments": {"x": 2}}} done.');
    expect(r?.arguments).toEqual({ x: 2 });
  });

  it('repairs trailing commas and single quotes', () => {
    const r = extractToolCall("{'tool_call': {'name': 'f', 'arguments': {'x': 1,},}}");
    expect(r).toEqual({ name: 'f', arguments: { x: 1 } });
  });

  it('defaults missing arguments to {}', () => {
    const r = extractToolCall('{"tool_call": {"name": "f"}}');
    expect(r).toEqual({ name: 'f', arguments: {} });
  });

  it('returns null for plain prose', () => {
    expect(extractToolCall('The weather is sunny today.')).toBeNull();
  });

  it('returns null when JSON has no tool_call key', () => {
    expect(extractToolCall('{"answer": 42}')).toBeNull();
  });
});
