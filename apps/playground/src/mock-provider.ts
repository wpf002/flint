import type {
  ProviderAdapter,
  GenerateArgs,
  GenerateResult,
  Message,
  StreamEvent,
  ModelCapabilities,
} from '@flint/core';

/**
 * A consuming-app implementation of `ProviderAdapter`. Its mere existence
 * proves the provider seam is part of the published public surface and can be
 * implemented from OUTSIDE the package — the same way a real third-party
 * provider would. It scripts a two-step tool-calling exchange so the offline
 * playground exercises the full tool loop without a network.
 */
export class MockProvider implements ProviderAdapter {
  readonly name = 'mock';

  getCapabilities(_model: string): ModelCapabilities {
    return {
      toolCalling: 'native',
      structuredOutput: 'native',
      streaming: 'full',
      maxContextTokens: 100_000,
      maxOutputTokens: 4096,
    };
  }

  estimateTokens(messages: Message[], _model: string): number {
    return Math.ceil(messages.reduce((n, m) => n + m.content.length, 0) / 4);
  }

  async generate(args: GenerateArgs): Promise<GenerateResult> {
    let text = '';
    const collected: StreamEvent[] = [];
    for await (const ev of this.stream(args)) collected.push(ev);
    for (const ev of collected) if (ev.type === 'text') text += ev.delta;
    const done = collected.find((e) => e.type === 'done');
    return {
      message: { id: 'mock', role: 'assistant', content: text, timestamp: 0 },
      usage: done?.type === 'done' ? done.usage : { input: 0, output: 0 },
      reason: done?.type === 'done' ? done.reason : 'complete',
    };
  }

  async *stream(args: GenerateArgs): AsyncIterable<StreamEvent> {
    const firstTool = args.tools?.[0];
    const alreadyRanTool = args.messages.some((m) => m.role === 'tool_result');

    if (firstTool && !alreadyRanTool) {
      // Step 1: ask to call the tool.
      yield { type: 'text', delta: 'Let me check that for you. ' };
      yield {
        type: 'tool_call',
        call: { id: 'mock_call_1', toolName: firstTool.name, args: {} },
      };
      yield { type: 'done', reason: 'tool_call', usage: { input: 12, output: 6 } };
      return;
    }

    // Step 2 (or no tools): answer, echoing any tool result we were handed.
    const lastResult = [...args.messages].reverse().find((m) => m.role === 'tool_result');
    const detail = lastResult ? ` (the tool returned: ${lastResult.content})` : '';
    yield { type: 'text', delta: `Here is your answer${detail}.` };
    yield { type: 'done', reason: 'complete', usage: { input: 20, output: 9 } };
  }
}
