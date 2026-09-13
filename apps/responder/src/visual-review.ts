import Anthropic from '@anthropic-ai/sdk';

/*
 * Showing a designer the page.
 *
 * Tests say a page works, and reading CSS says what was intended. Neither shows what a
 * person sees. The third product build had a clean stylesheet and a primary button that
 * ran off the edge of a phone screen. Every participant read that CSS, and none noticed.
 * The sandbox renders the page at desktop and phone width, and this puts the screenshots
 * in front of a model that can see them.
 *
 * Called directly rather than through a participant's provider: Flint's message contract
 * carries text only, and a review is a check on the work, not a turn in the conversation.
 */

export interface Screen {
  name: string;
  width: number;
  height: number;
  base64: string;
}

export interface Review {
  pass: boolean;
  notes: string;
  tokensOut: number;
}

export type ReviewScreens = (screens: Screen[], goal: string) => Promise<Review>;

const PROMPT = [
  'You are a product designer reviewing screenshots of a page before it ships. You see it at desktop and',
  'phone width. Block on what a careful designer would block on, not on taste:',
  '- anything cut off, overflowing, overlapping or out of reach at either width',
  '- text that is hard to read: low contrast, too small, lines too long',
  '- controls that look like browser defaults or give no sign they can be used',
  '- spacing or alignment that is inconsistent, or no clear order to look at things in',
  '- an empty, loading or error state that looks broken or blank instead of designed (judge the one shown)',
  '- anything that looks unfinished',
  '',
  'Reply with the first line exactly "VERDICT: PASS" or "VERDICT: FIX". Then at most 6 short bullets, each',
  'naming what is wrong, where, and the concrete fix, for example: "Phone: the button overflows the right',
  'edge. Stack the form controls below 480px." PASS only if you would ship it exactly as it is. On PASS, list',
  'at most 2 optional improvements.',
].join('\n');

export function anthropicReviewer(apiKey: string, model: string): ReviewScreens {
  const client = new Anthropic({ apiKey });
  return async (screens, goal) => {
    const response = await client.messages.create({
      model,
      max_tokens: 1_200,
      system: PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            ...screens.flatMap((s) => [
              { type: 'text' as const, text: `${s.name} view, ${s.width}px wide:` },
              { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: s.base64 } },
            ]),
            { type: 'text' as const, text: `What the page is for: ${goal}` },
          ],
        },
      ],
    });
    const text = response.content
      .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
    return { ...parseVerdict(text), tokensOut: response.usage.output_tokens };
  };
}

/** A missing verdict is a failed review: a page nobody would sign off on doesn't ship. */
export function parseVerdict(text: string): { pass: boolean; notes: string } {
  const verdict = /VERDICT:\s*(PASS|FIX)/i.exec(text)?.[1]?.toUpperCase();
  const notes = text.replace(/^[\s\S]*?VERDICT:\s*(PASS|FIX)\s*/i, '').trim();
  if (!verdict) return { pass: false, notes: `The review gave no verdict: ${text.trim().slice(0, 400)}` };
  return { pass: verdict === 'PASS', notes: notes || (verdict === 'PASS' ? 'Ship it.' : 'Fix requested, with no detail.') };
}
