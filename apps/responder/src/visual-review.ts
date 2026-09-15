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
  /** The address the page was captured at, when it is known. */
  path?: string;
}

/**
 * Which address each screenshot was taken at, read from the sandbox's "Rendered" lines.
 *
 * The sandbox names a shot by its size alone, so captures of four addresses reached the
 * reviewer as "desktop" and "mobile" four times over. In the first build the chat apps
 * reviewed, every capture showed the empty page, /?city=Denver included, and the review
 * passed: nothing told it that three of the four should have shown something else.
 */
export function withPaths(images: Screen[], outputs: string[]): Screen[] {
  const paths: string[] = [];
  for (const output of outputs) {
    const rendered = /^Rendered (.+?): (\w+ \d+x\d+(?:, \w+ \d+x\d+)*)\.$/m.exec(output);
    if (!rendered) continue;
    for (const _size of rendered[2]!.split(', ')) paths.push(rendered[1]!);
  }
  // Shots and lines disagree only if the sandbox changed its wording; unlabeled beats mislabeled.
  if (paths.length !== images.length) return images;
  return images.map((screen, i) => ({ ...screen, path: paths[i]! }));
}

export interface Review {
  pass: boolean;
  notes: string;
  tokensOut: number;
  /** The reviewer gave no verdict, so nothing was reviewed. Not the same as a failed review. */
  unavailable?: boolean;
}

/** What the reviewer said before, so a round of fixes is judged against it. */
export interface PriorReview {
  /** How many reviews in this thread have asked for fixes. */
  fixRounds: number;
  /** The newest review's notes, or null before any review. */
  notes: string | null;
}

export type ReviewScreens = (screens: Screen[], goal: string, prior?: PriorReview) => Promise<Review>;

/*
 * After this many rounds of fixes, only defects block. The fifth product build went
 * five rounds and the sixth six, each one raising something new: the hint wraps, then
 * the hint overflows, then the header contrast. Two rounds is enough to get the design
 * right; after that a review that keeps finding things is spending more than it saves.
 */
export const DEFECTS_ONLY_AFTER = 2;

type Block = { type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: 'image/png'; data: string } };

/** The user turn put to the reviewer: the screenshots, the goal, and what it said last time. */
export function reviewRequest(screens: Screen[], goal: string, prior?: PriorReview): Block[] {
  const blocks: Block[] = screens.flatMap((s): Block[] => [
    { type: 'text', text: `${s.name} view${s.path ? ` of ${s.path}` : ''}, ${s.width}px wide:` },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: s.base64 } },
  ]);
  blocks.push({ type: 'text', text: `What the page is for: ${goal}` });
  if (prior?.notes) {
    blocks.push({
      type: 'text',
      text: `Your previous review asked for:\n${prior.notes}\nThe page has been revised since. Say which of those are fixed and which are not.`,
    });
  }
  if (prior && prior.fixRounds >= DEFECTS_ONLY_AFTER) {
    blocks.push({
      type: 'text',
      text:
        `This page has been through ${prior.fixRounds} rounds of fixes. From here, block only on defects: something cut off, ` +
        'overflowing, overlapping, unreadable, a state that looks broken, or a capture that shows a different state ' +
        'than its address asks for. If there is no defect the verdict is PASS, ' +
        'and anything else you would still change goes under optional improvements.',
    });
  }
  return blocks;
}

/*
 * The bar is a finished product. The fourth product build passed a review that only
 * blocked defects: a small form at the top of an empty desktop screen, a plain table,
 * and a one-line empty state. Nothing in it was broken, and nobody would call it designed.
 */
const PROMPT = [
  'You are the design lead signing off a product page before it ships. You see screenshots at desktop',
  '(1280px, light mode) and phone (375px, dark mode) width, in each state that was captured, such as empty',
  'and filled. People use both colour schemes, so each one has to hold up on its own.',
  '',
  'Pass only a page that looks like a finished product a design team shipped. A working, tidy prototype',
  'is not enough. Ask for fixes when you see any of these:',
  '- Defects: anything cut off, overflowing, overlapping or out of reach. Text that is hard to read: low',
  '  contrast (dark text on a dark background counts, on buttons and chips too), too small, or lines too',
  '  long. A text field squashed shorter than the button beside or below it.',
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
  '- The wrong state: each capture names the address it was taken at. When the address asks for something,',
  '  such as a search (?city=), an error or a demo state, and the capture shows the empty or starting page',
  '  instead, that state failed to render. That is a defect however clean the page looks.',
  '',
  'Reply with the first line exactly "VERDICT: PASS" or "VERDICT: FIX". Then at most 6 bullets, most',
  'important first, each naming the problem, where it is, and the concrete change. For example: "Desktop:',
  'the form sits in the top fifth of an empty screen. Put the header and form in a centered card, and give',
  'the empty state an icon and example searches." PASS only if you would ship it exactly as it is. On PASS,',
  'list at most 2 optional improvements.',
].join('\n');

export function anthropicReviewer(apiKey: string, model: string): ReviewScreens {
  const client = new Anthropic({ apiKey });
  return (screens, goal, prior) =>
    withVerdict(async () => {
      const response = await client.messages.create({
        model,
        /*
         * Twice in the fifth product build the reply was empty at the token cap: the
         * output was spent before any text. Thinking is off, because a verdict on four
         * screenshots does not need it, and the cap is high enough that it cannot be
         * the reason there is no text.
         */
        max_tokens: 4_000,
        thinking: { type: 'disabled' },
        system: PROMPT,
        messages: [{ role: 'user', content: reviewRequest(screens, goal, prior) }],
      });
      const text = response.content
        .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
      return {
        text,
        tokensOut: response.usage.output_tokens,
        stop: response.stop_reason ?? null,
        blocks: response.content.map((block) => block.type),
      };
    });
}

/**
 * Asks again when a reply has no verdict, then says there was no review.
 *
 * The fourth product build's reviewer once returned no text at all. Read as a failed
 * review, it asked for fixes and listed none.
 */
export async function withVerdict(
  ask: () => Promise<{ text: string; tokensOut: number; stop: string | null; blocks?: string[] }>,
  attempts = 2,
): Promise<Review> {
  let tokensOut = 0;
  let last: { text: string; stop: string | null; blocks?: string[] } = { text: '', stop: null };
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const reply = await ask();
    tokensOut += reply.tokensOut;
    if (/VERDICT:\s*(PASS|FIX)/i.test(reply.text)) return { ...parseVerdict(reply.text), tokensOut };
    last = reply;
  }
  const said = last.text.trim().slice(0, 200) || 'an empty reply';
  // What the reply was made of, so an empty one can be explained rather than guessed at.
  const made = last.blocks?.length ? `, blocks: ${last.blocks.join(',')}` : '';
  return {
    pass: false,
    unavailable: true,
    tokensOut,
    notes: `No verdict after ${attempts} attempts (stop reason: ${last.stop ?? 'unknown'}${made}), only ${said}`,
  };
}

/** A missing verdict is a failed review: a page nobody would sign off on doesn't ship. */
export function parseVerdict(text: string): { pass: boolean; notes: string } {
  const verdict = /VERDICT:\s*(PASS|FIX)/i.exec(text)?.[1]?.toUpperCase();
  const notes = text.replace(/^[\s\S]*?VERDICT:\s*(PASS|FIX)\s*/i, '').trim();
  if (!verdict) return { pass: false, notes: `The review gave no verdict: ${text.trim().slice(0, 400)}` };
  return { pass: verdict === 'PASS', notes: notes || (verdict === 'PASS' ? 'Ship it.' : 'Fix requested, with no detail.') };
}
