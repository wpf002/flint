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
  /** The reviewer gave no verdict, so nothing was reviewed. Not the same as a failed review. */
  unavailable?: boolean;
}

export type ReviewScreens = (screens: Screen[], goal: string) => Promise<Review>;

/*
 * The bar is a finished product. The fourth product build passed a review that only
 * blocked defects: a small form at the top of an empty desktop screen, a plain table,
 * and a one-line empty state. Nothing in it was broken, and nobody would call it designed.
 */
const PROMPT = [
  'You are the design lead signing off a product page before it ships. You see screenshots at desktop',
  '(1280px) and phone (375px) width, in each state that was captured, such as empty and filled.',
  '',
  'Pass only a page that looks like a finished product a design team shipped. A working, tidy prototype',
  'is not enough. Ask for fixes when you see any of these:',
  '- Defects: anything cut off, overflowing, overlapping or out of reach. Text that is hard to read: low',
  '  contrast, too small, or lines too long.',
  '- Unfinished composition: controls stranded at the top of a mostly empty desktop screen, no header that',
  '  names the product and says what it does, or content that is not grouped into panels or cards.',
  '- Weak hierarchy: headings, labels and values at similar sizes and weights, or no obvious primary action.',
  '- Default-looking controls: inputs, selects or buttons that look like browser defaults, or that differ',
  '  from each other in height, radius or alignment.',
  '- Undesigned states: an empty, loading or error state that is a single line of plain text. The empty',
  '  state should invite the first action, and an error should read as an alert.',
  '- Raw data: results as a bare table or list with no container, and nothing that helps a person scan them,',
  '  such as emphasis on the most important value.',
  '- A phone layout that is the desktop squeezed: controls should stack full width, and tap targets should',
  '  be at least 44px tall.',
  '',
  'Reply with the first line exactly "VERDICT: PASS" or "VERDICT: FIX". Then at most 6 bullets, most',
  'important first, each naming the problem, where it is, and the concrete change. For example: "Desktop:',
  'the form sits in the top fifth of an empty screen. Put the header and form in a centered card, and give',
  'the empty state an icon and example searches." PASS only if you would ship it exactly as it is. On PASS,',
  'list at most 2 optional improvements.',
].join('\n');

export function anthropicReviewer(apiKey: string, model: string): ReviewScreens {
  const client = new Anthropic({ apiKey });
  return (screens, goal) =>
    withVerdict(async () => {
      const response = await client.messages.create({
        model,
        max_tokens: 2_000,
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
      return { text, tokensOut: response.usage.output_tokens, stop: response.stop_reason ?? null };
    });
}

/**
 * Asks again when a reply has no verdict, then says there was no review.
 *
 * The fourth product build's reviewer once returned no text at all. Read as a failed
 * review, it asked for fixes and listed none.
 */
export async function withVerdict(
  ask: () => Promise<{ text: string; tokensOut: number; stop: string | null }>,
  attempts = 2,
): Promise<Review> {
  let tokensOut = 0;
  let last: { text: string; stop: string | null } = { text: '', stop: null };
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const reply = await ask();
    tokensOut += reply.tokensOut;
    if (/VERDICT:\s*(PASS|FIX)/i.test(reply.text)) return { ...parseVerdict(reply.text), tokensOut };
    last = reply;
  }
  const said = last.text.trim().slice(0, 200) || 'an empty reply';
  return {
    pass: false,
    unavailable: true,
    tokensOut,
    notes: `No verdict after ${attempts} attempts (stop reason: ${last.stop ?? 'unknown'}), only ${said}`,
  };
}

/** A missing verdict is a failed review: a page nobody would sign off on doesn't ship. */
export function parseVerdict(text: string): { pass: boolean; notes: string } {
  const verdict = /VERDICT:\s*(PASS|FIX)/i.exec(text)?.[1]?.toUpperCase();
  const notes = text.replace(/^[\s\S]*?VERDICT:\s*(PASS|FIX)\s*/i, '').trim();
  if (!verdict) return { pass: false, notes: `The review gave no verdict: ${text.trim().slice(0, 400)}` };
  return { pass: verdict === 'PASS', notes: notes || (verdict === 'PASS' ? 'Ship it.' : 'Fix requested, with no detail.') };
}
