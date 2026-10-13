import { describe, it, expect } from 'vitest';
import { OllamaProvider } from '../../src/provider/ollama/index.js';
import type { Attachment, Message, StreamEvent } from '../../src/index.js';

/**
 * Pictures on Ollama's own wire. A model is sent a picture only when the
 * caller says it can see (`capabilities`, which the server feeds from the
 * model server's own report): Ollama drops a picture sent to a model that
 * cannot see, without a word, and the model then answers about a picture it
 * never saw. Unset, as by default, every request body is what it always was.
 * A stub fetch records the raw bodies; nothing touches a real Ollama.
 */

const PNG: Attachment = { kind: 'image', mediaType: 'image/png', name: 'shot.png', data: 'iVBORw0KGgo=', bytes: 8 };
const user = (content: string, attachments?: Attachment[]): Message => ({ id: 'u1', role: 'user', content, timestamp: 0, ...(attachments ? { attachments } : {}) });

function recordingFetch() {
  const bodies: string[] = [];
  const impl = (async (_url: string, init: { body: string }) => {
    bodies.push(init.body);
    const final = { done: true, done_reason: 'stop', prompt_eval_count: 5, eval_count: 3 };
    if ((JSON.parse(init.body) as { stream: boolean }).stream) {
      const lines = [{ message: { role: 'assistant', content: 'a red square' } }, { message: { role: 'assistant', content: '' }, ...final }];
      return new Response(lines.map((l) => JSON.stringify(l)).join('\n') + '\n', { status: 200 });
    }
    return new Response(JSON.stringify({ message: { role: 'assistant', content: 'a red square' }, ...final }), { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, bodies, parsed: () => bodies.map((b) => JSON.parse(b) as { model: string; messages: Array<{ role: string; content: string; images?: string[] }> }) };
}
async function drain(it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

describe('OllamaProvider and a model that can see', () => {
  const sees = (m: string) => (m === 'eyes:30b' ? { vision: true } : undefined);

  it('generate and stream send the picture in the user message’s `images`, for the model the caller says can see', async () => {
    const f = recordingFetch();
    const p = new OllamaProvider({ fetch: f.impl, capabilities: sees });
    await p.generate({ model: 'eyes:30b', messages: [user('what is this?', [PNG])] });
    await drain(p.stream({ model: 'eyes:30b', messages: [user('what is this?', [PNG])] }));
    for (const body of f.parsed()) {
      expect(body.messages).toEqual([{ role: 'user', content: 'what is this?', images: ['iVBORw0KGgo='] }]);
    }
    expect(f.bodies).toHaveLength(2);
  });

  it('says so in its capabilities, and of no other model', () => {
    const p = new OllamaProvider({ capabilities: sees });
    expect(p.getCapabilities('eyes:30b').vision).toBe(true);
    expect(p.getCapabilities('blind:3b').vision).toBeUndefined();
    expect(new OllamaProvider().getCapabilities('eyes:30b').vision).toBeUndefined();
    // No Ollama model reads a PDF: nothing here ever says one does.
    expect(p.getCapabilities('eyes:30b').pdfInput).toBeUndefined();
  });

  it('another model on the same client is sent no picture: the note, as before', async () => {
    const f = recordingFetch();
    const p = new OllamaProvider({ fetch: f.impl, capabilities: sees });
    await p.generate({ model: 'blind:3b', messages: [user('what is this?', [PNG])] });
    const [body] = f.parsed();
    expect(body!.messages[0]).not.toHaveProperty('images');
    expect(body!.messages[0]!.content).toMatch(/shot\.png.*cannot read images/);
  });

  it('a caller that says nothing, or says the model cannot see, sends what was always sent: byte for byte', async () => {
    const messages = [user('what is this?', [PNG]), user('plain')];
    const plain = recordingFetch();
    await new OllamaProvider({ fetch: plain.impl }).generate({ model: 'eyes:30b', messages });
    for (const capabilities of [() => undefined, () => ({ vision: false }), () => ({ toolCalling: 'native' as const })]) {
      const f = recordingFetch();
      await new OllamaProvider({ fetch: f.impl, capabilities }).generate({ model: 'eyes:30b', messages });
      expect(f.bodies).toEqual(plain.bodies);
    }
    expect(plain.bodies[0]).not.toContain('"images"');
  });

  it('a turn with no picture is the same body whether or not the model can see', async () => {
    const a = recordingFetch();
    const b = recordingFetch();
    await new OllamaProvider({ fetch: a.impl }).generate({ model: 'eyes:30b', system: 'be brief', messages: [user('hello')] });
    await new OllamaProvider({ fetch: b.impl, capabilities: sees }).generate({ model: 'eyes:30b', system: 'be brief', messages: [user('hello')] });
    expect(b.bodies).toEqual(a.bodies);
  });
});
