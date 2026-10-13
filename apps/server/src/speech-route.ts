/**
 * `/speak`: a reply as audio, from whichever provider speaks (./voice), and
 * the rule for which replies a provider that is NOT on this Mac may be given.
 *
 * THE RULE IS THE SERVER'S, and it is the one `/speak` has always had
 * (./goals-chat speechStaysHere, ./inference cloudRefused). What the seam adds
 * is where it applies: to a provider that sends the words to somebody else's
 * service, and to no other.
 *
 *   speech is off (`off`)                          503, the client's own voice
 *   the provider is on this Mac (`say`, a local speech server)
 *       every reply is spoken: the words go nowhere.
 *   the provider is an outside service (OpenAI), and
 *     Flint is in Local mode                       503, the client's own voice
 *     the reply stays on this Mac                  409, the client's own voice
 *     otherwise                                    spoken, under its vendor's budget
 *
 * "The reply stays on this Mac" is one question, asked of the conversation
 * store by the turn the client names and the words it sends: a private turn's
 * reply, any turn's from Local mode, one answered with Will's goals, a request
 * that names no turn the store can place. A provider on this Mac is never
 * asked it, because nothing it is given leaves; an outside one always is, so a
 * client that asks for such a reply (an older client, a mistake) gets its own
 * voice and the words are not sent.
 *
 * 409, not 503, for a reply that must stay here: a client reads a 503 as "the
 * neural voice is out" and stops asking for ten minutes.
 *
 * Kept free of index.ts so it is unit-testable (index.ts runs main() on import).
 */
import { speakWithinBudget, type SpendGuard } from './spend';
import { TTS_MAX_CHARS, type AudioType, type Speech, type TtsProvider } from './voice';

/** What `/speak` answers when no speech is made on the server at all. The client then speaks with its own voice. */
export const SPEECH_OFF = 'speech is off on this server, so it is spoken with this device’s own voice';

/** Is this provider's speech made on this Mac, so that nothing it is given leaves? */
export function speechMadeHere(tts: Pick<TtsProvider, 'name' | 'local'>): boolean {
  return tts.local && tts.name !== 'off';
}

export interface SpeakDeps {
  tts: TtsProvider;
  /** Why an outside service may not be called at all right now (./inference cloudRefused: Local mode), or undefined. */
  localMode: () => string | undefined;
  /** Must this reply be spoken on the device (./goals-chat speechStaysHere)? Asked only for an outside provider. */
  mustStay: (said: { conversationId?: unknown; turnId?: unknown; text?: unknown }) => boolean;
  /** What a reply that stays here is refused with. */
  mustStaySentence: string;
  guard: SpendGuard;
}

export type SpeakResult =
  | { status: 200; audio: Buffer; contentType: AudioType }
  | { status: 400 | 409 | 503; body: { error: string; fallback?: 'browser'; budget?: true } };

/**
 * Handle one `/speak` body. Every refusal is a result; it throws only what
 * the provider throws (the route answers 502 with a reference).
 */
export async function speak(body: Record<string, unknown>, deps: SpeakDeps): Promise<SpeakResult> {
  const text = String(body.text ?? '').trim();
  if (!text) return { status: 400, body: { error: 'text required' } };
  const { tts } = deps;
  if (tts.name === 'off') return { status: 503, body: { error: SPEECH_OFF, fallback: 'browser' } };
  if (!tts.local) {
    // Speech by an outside service is a cloud call, and Local mode makes none: the client speaks with its own voice.
    const noCloud = deps.localMode();
    if (noCloud) return { status: 503, body: { error: noCloud, fallback: 'browser' } };
    // ...and a reply that stays on this Mac is never sent to it, in any mode.
    if (deps.mustStay({ conversationId: body.conversationId, turnId: body.turnId, text })) return { status: 409, body: { error: deps.mustStaySentence, fallback: 'browser' } };
  }

  let speech: Speech | null;
  if (tts.vendor) {
    // A billed provider speaks under its vendor's budget (./spend), and is charged per character sent.
    let made: Speech | null = null;
    const spoken = await speakWithinBudget(text, {
      guard: deps.guard,
      model: tts.model ?? '',
      maxChars: TTS_MAX_CHARS,
      synth: async (t) => {
        made = await tts.synthesize(t);
        return made ? (made as Speech).audio : null;
      },
    });
    if (spoken.status === 'no-key') return { status: 503, body: { error: 'no tts key' } };
    if (spoken.status === 'budget') return { status: 503, body: { error: spoken.message, budget: true, fallback: 'browser' } };
    speech = made;
  } else {
    speech = await tts.synthesize(text);
  }
  if (!speech) return { status: 503, body: { error: SPEECH_OFF, fallback: 'browser' } };
  return { status: 200, audio: speech.audio, contentType: speech.contentType };
}
