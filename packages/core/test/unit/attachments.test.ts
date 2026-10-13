import { describe, it, expect } from 'vitest';
import { mapMessages as mapAnthropic } from '../../src/provider/anthropic/mapping.js';
import { mapMessages as mapOpenAi } from '../../src/provider/openai/mapping.js';
import { mapMessages as mapOllama } from '../../src/provider/ollama/mapping.js';
import { OpenAiProvider } from '../../src/provider/openai/index.js';
import { PerplexityProvider } from '../../src/provider/perplexity/index.js';
import { AnthropicProvider } from '../../src/provider/anthropic/index.js';
import { anthropicCapabilities } from '../../src/provider/anthropic/capabilities.js';
import { openAiCapabilities } from '../../src/provider/openai/capabilities.js';
import { MessageSchema, estimateMessageTokens, type Message } from '../../src/types/message.js';
import { shedPayload, type Attachment } from '../../src/types/attachment.js';

const PNG: Attachment = { kind: 'image', mediaType: 'image/png', name: 'shot.png', data: 'iVBORw0KGgo=', bytes: 8 };
const PDF: Attachment = { kind: 'document', mediaType: 'application/pdf', name: 'plan.pdf', data: 'JVBERi0xLjQ=', bytes: 8 };
const TXT: Attachment = { kind: 'text', mediaType: 'text/markdown', name: 'notes.md', text: '# hi\nthere', bytes: 10 };

function user(content: string, attachments?: Attachment[]): Message {
  return { id: 'u1', role: 'user', content, timestamp: 0, ...(attachments ? { attachments } : {}) };
}

describe('canonical attachments', () => {
  it('round-trips through the Message schema, and is optional', () => {
    const m = user('look', [PNG, PDF, TXT]);
    expect(MessageSchema.parse(m)).toEqual(m);
    expect(MessageSchema.parse(user('plain'))).not.toHaveProperty('attachments');
  });

  it('rejects an unknown attachment kind', () => {
    expect(() => MessageSchema.parse(user('x', [{ ...PNG, kind: 'video' as 'image' }]))).toThrow();
  });

  it('budgets attachments instead of treating them as free', () => {
    const plain = estimateMessageTokens([user('abcd')]);
    expect(plain).toBe(1);
    expect(estimateMessageTokens([user('abcd', [PNG])])).toBeGreaterThan(1000);
    // A shed attachment is just its note.
    expect(estimateMessageTokens([user('abcd', [shedPayload(PNG)])])).toBeLessThan(100);
  });

  it('shedPayload keeps the metadata and drops the body', () => {
    expect(shedPayload(PNG)).toEqual({ kind: 'image', mediaType: 'image/png', name: 'shot.png', bytes: 8 });
    expect(shedPayload(TXT)).not.toHaveProperty('text');
  });
});

describe('anthropic mapping', () => {
  it('leaves a plain user message exactly as before', () => {
    const { messages } = mapAnthropic([user('hi')], undefined);
    expect(messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
  });

  it('sends images as image blocks and PDFs as document blocks, text last', () => {
    const { messages } = mapAnthropic([user('what is this?', [PNG, PDF, TXT])], undefined);
    const blocks = messages[0]!.content as unknown as Array<Record<string, unknown>>;
    expect(blocks.map((b) => b.type)).toEqual(['image', 'document', 'text', 'text']);
    expect(blocks[0]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: PNG.data },
    });
    expect(blocks[1]).toEqual({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: PDF.data },
      title: 'plan.pdf',
    });
    expect(String(blocks[2]!.text)).toContain('<attached_file name="notes.md"');
    expect(String(blocks[2]!.text)).toContain('# hi\nthere');
    expect(blocks[3]).toEqual({ type: 'text', text: 'what is this?' });
  });

  it('omits an empty text block when only a file was sent', () => {
    const { messages } = mapAnthropic([user('  ', [PNG])], undefined);
    expect((messages[0]!.content as unknown[]).length).toBe(1);
  });

  it('renders a shed attachment as a note, not an empty image', () => {
    const { messages } = mapAnthropic([user('again', [shedPayload(PNG)])], undefined);
    const blocks = messages[0]!.content as Array<{ type: string; text?: string }>;
    expect(blocks[0]!.type).toBe('text');
    expect(blocks[0]!.text).toMatch(/attached earlier: shot\.png/);
  });

  it('claims vision + PDF in its capabilities', () => {
    expect(anthropicCapabilities('claude-sonnet-4-6')).toMatchObject({ vision: true, pdfInput: true });
    expect(anthropicCapabilities('some-future-model')).toMatchObject({ vision: true, pdfInput: true });
  });

  it('budgets attachments in estimateTokens', () => {
    const p = new AnthropicProvider({ apiKey: 'k' });
    expect(p.estimateTokens([user('hi', [PNG])], 'claude-sonnet-4-6')).toBeGreaterThan(1000);
  });
});

describe('openai mapping', () => {
  it('leaves a plain user message as a string', () => {
    expect(mapOpenAi([user('hi')], undefined, { vision: true, pdfInput: true })).toEqual([
      { role: 'user', content: 'hi' },
    ]);
  });

  it('uses image_url and file parts when the model supports them', () => {
    const [m] = mapOpenAi([user('q', [PNG, PDF, TXT])], undefined, { vision: true, pdfInput: true });
    const parts = m!.content as Array<Record<string, unknown>>;
    expect(parts.map((p) => p.type)).toEqual(['image_url', 'file', 'text', 'text']);
    expect(parts[0]).toEqual({ type: 'image_url', image_url: { url: `data:image/png;base64,${PNG.data}` } });
    expect(parts[1]).toEqual({
      type: 'file',
      file: { filename: 'plan.pdf', file_data: `data:application/pdf;base64,${PDF.data}` },
    });
  });

  it('falls back to notes, collapsed to one string, when the model is text-only', () => {
    const [m] = mapOpenAi([user('q', [PNG, PDF])], undefined, {});
    expect(typeof m!.content).toBe('string');
    expect(m!.content).toMatch(/cannot read images/);
    expect(m!.content).toMatch(/plan\.pdf/);
    expect(String(m!.content).endsWith('q')).toBe(true);
  });

  it('only claims media support for the known multimodal families', () => {
    expect(openAiCapabilities('gpt-4o')).toMatchObject({ vision: true, pdfInput: true });
    expect(openAiCapabilities('mystery-model')).toMatchObject({ vision: false, pdfInput: false });
  });

  it('wires capabilities into the request body (vision model vs Perplexity)', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchStub = (async (_u: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    await new OpenAiProvider({ apiKey: 'k', fetch: fetchStub }).generate({
      model: 'gpt-4o',
      messages: [user('see', [PNG])],
    });
    await new PerplexityProvider({ apiKey: 'k', fetch: fetchStub }).generate({
      model: 'sonar',
      messages: [user('see', [PNG])],
    });

    const openaiUser = (bodies[0]!.messages as Array<{ content: unknown }>)[0]!;
    expect(Array.isArray(openaiUser.content)).toBe(true);
    const pplxUser = (bodies[1]!.messages as Array<{ content: unknown }>)[0]!;
    expect(typeof pplxUser.content).toBe('string');
  });
});

describe('ollama mapping', () => {
  it('inlines text files and notes images/PDFs it cannot see', () => {
    const [m] = mapOllama([user('q', [TXT, PNG, PDF])]);
    expect(m!.content).toContain('<attached_file name="notes.md"');
    expect(m!.content).toMatch(/shot\.png.*cannot read images/);
    expect(m!.content).toMatch(/plan\.pdf.*cannot read this file type/);
    expect(m!.content.endsWith('q')).toBe(true);
  });

  it('leaves a plain user message unchanged', () => {
    expect(mapOllama([user('hi')])).toEqual([{ role: 'user', content: 'hi' }]);
    expect(mapOllama([user('hi')], undefined, { images: true })).toEqual([{ role: 'user', content: 'hi' }]);
  });

  // Local vision. A model that can see is sent the picture itself, as Ollama's /api/chat takes it.
  describe('for a model that can see (`images`)', () => {
    const JPG: Attachment = { kind: 'image', mediaType: 'image/jpeg', name: 'photo.jpg', data: '/9j/4AAQSkZJRg==', bytes: 12 };
    const GIF: Attachment = { kind: 'image', mediaType: 'image/gif', name: 'anim.gif', data: 'R0lGODlh', bytes: 6 };
    const WEBP: Attachment = { kind: 'image', mediaType: 'image/webp', name: 'pic.webp', data: 'UklGRg==', bytes: 4 };

    it('a PNG, a JPEG, a GIF or a WebP goes in the message’s `images`, base64 as it came, in order, and no note says it cannot be seen', () => {
      const [m] = mapOllama([user('what is this?', [PNG, JPG, GIF, WEBP])], undefined, { images: true });
      expect(m).toEqual({ role: 'user', content: 'what is this?', images: ['iVBORw0KGgo=', '/9j/4AAQSkZJRg==', 'R0lGODlh', 'UklGRg=='] });
    });

    it('a picture with no words is still a message: the text is empty and the picture is there', () => {
      expect(mapOllama([user('', [PNG])], undefined, { images: true })).toEqual([{ role: 'user', content: '', images: ['iVBORw0KGgo='] }]);
    });

    it('a text file is still inlined, and a PDF is still said to be unreadable: only pictures are sent', () => {
      const [m] = mapOllama([user('q', [TXT, PNG, PDF])], undefined, { images: true });
      expect(m!.images).toEqual(['iVBORw0KGgo=']);
      expect(m!.content).toContain('<attached_file name="notes.md"');
      expect(m!.content).toMatch(/plan\.pdf.*cannot read this file type/);
      expect(m!.content).not.toContain('shot.png');
      expect(m!.content.endsWith('q')).toBe(true);
    });

    it('a picture of any other kind is not sent, and the model is told it is there', () => {
      const TIFF: Attachment = { kind: 'image', mediaType: 'image/tiff', name: 'scan.tiff', data: 'SUkqAA==', bytes: 4 };
      const [m] = mapOllama([user('q', [TIFF, PNG])], undefined, { images: true });
      expect(m!.images).toEqual(['iVBORw0KGgo=']);
      expect(m!.content).toMatch(/scan\.tiff.*cannot read images/);
    });

    it('a picture whose body was shed from history is a note, never an empty picture', () => {
      const [m] = mapOllama([user('and now?', [shedPayload(PNG)])], undefined, { images: true });
      expect(m!.images).toBeUndefined();
      expect(m!.content).toMatch(/attached earlier: shot\.png/);
    });

    it('every user turn carries its own pictures, in order; no other message carries any', () => {
      const out = mapOllama(
        [user('first', [PNG]), { id: 'a1', role: 'assistant', content: 'a cat', timestamp: 0 }, user('second', [JPG, PNG])],
        'be brief',
        { images: true },
      );
      expect(out.map((m) => [m.role, m.images])).toEqual([
        ['system', undefined],
        ['user', ['iVBORw0KGgo=']],
        ['assistant', undefined],
        ['user', ['/9j/4AAQSkZJRg==', 'iVBORw0KGgo=']],
      ]);
    });

    it('without it, as by default, nothing is sent: the note it has always been', () => {
      for (const media of [undefined, {}, { images: false }]) {
        const [m] = mapOllama([user('q', [PNG])], undefined, media);
        expect(m).toEqual({ role: 'user', content: expect.stringMatching(/shot\.png.*cannot read images[\s\S]*q$/) });
        expect(m).not.toHaveProperty('images');
      }
    });
  });
});
